import { expect, spyOn, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { compactRequest, responseRequest } from "../src/server";
import { formatErrorResponse } from "../src/bridge";
import type { ProviderAdapter } from "../src/adapters/base";

test("a server-produced Web checkpoint is converted before a native model receives either endpoint and encoding", async () => {
  const summary = "The workspace baseline was reviewed; continue with the requested task.";
  const config = defaultConfig("full");
  const web = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ model: "chatgpt-web/gpt-6-sol", stream: false, input: [{ type: "compaction_trigger" }] }),
  }), config, (): ProviderAdapter => ({
    name: "fixture-web-compactor",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed._chatgptModelFamily).toBe("6");
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }), { rememberState: false });
  expect(web.status).toBe(200);
  const checkpoint = (await web.json() as { output: Array<Record<string, unknown>> }).output[0]!;
  expect(checkpoint.type).toBe("compaction");
  expect(String(checkpoint.encrypted_content)).toStartWith("ocx1:");

  const forwarded: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL) => {
    const request = input as Request;
    const wire = Buffer.from(await request.arrayBuffer());
    const decoded = request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(wire) : wire;
    forwarded.push({ url: request.url, body: JSON.parse(Buffer.from(decoded).toString("utf8")) });
    return Response.json({ status: "completed", output: [] });
  }, { preconnect: fetch.preconnect }));
  try {
    for (const endpoint of ["responses", "responses/compact"] as const) {
      for (const encoding of ["identity", "zstd"] as const) {
        const json = JSON.stringify({ model: "gpt-6.1-sol", stream: false, input: [checkpoint] });
        const bytes = encoding === "zstd" ? Bun.zstdCompressSync(Buffer.from(json)) : Buffer.from(json);
        const body = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(body).set(bytes);
        const request = new Request(`http://127.0.0.1/v1/${endpoint}`, {
          method: "POST", headers: { "content-type": "application/json", "content-encoding": encoding, authorization: "Bearer fixture" }, body,
        });
        const result = endpoint === "responses" ? await responseRequest(request, config) : await compactRequest(request, config);
        expect(result.status).toBe(200);
        const native = forwarded.at(-1)!;
        expect(native.url).toBe(`https://chatgpt.com/backend-api/codex/${endpoint}`);
        expect(native.body.model).toBe("gpt-6.1-sol");
        const text = JSON.stringify(native.body);
        expect(text).toContain(summary);
        expect(text).not.toContain("ocx1:");
        expect(text).not.toContain("encrypted_content");
        expect(text).not.toContain(String(checkpoint.id));
      }
    }
    expect(forwarded).toHaveLength(4);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("public errors preserve the first line without exposing multiline details", async () => {
  const response = formatErrorResponse(502, "upstream_error", "Backend failed\n/private/diagnostic\ncredential detail");
  expect(response.status).toBe(502);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toBe("Backend failed");
});
