import { expect, test } from "bun:test";
import { bridgeToResponsesSSE, formatErrorResponse } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function* completedEvents(chunks = 1): AsyncGenerator<AdapterEvent> {
  for (let index = 0; index < chunks; index++) {
    yield { type: "text_delta", text: `chunk-${index}:` + "x".repeat(2_048) };
  }
  yield { type: "done", endTurn: true };
}

function responseStream(platform: NodeJS.Platform, chunks = 1): ReadableStream<Uint8Array> {
  return bridgeToResponsesSSE(
    completedEvents(chunks),
    "chatgpt-web/test",
    undefined,
    undefined,
    undefined,
    undefined,
    2_000,
    { streamPlatform: platform },
  );
}

test("Responses SSE completes through the Windows push stream", async () => {
  const body = await new Response(responseStream("win32")).text();

  expect(body).toContain("event: response.completed");
  expect(body).toEndWith("data: [DONE]\n\n");
});

test("Darwin SSE remains decodable through Bun.serve under sustained chunking", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(responseStream("darwin", 64), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    },
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(body).toContain("chunk-63:");
    expect(body).toContain("event: response.completed");
    expect(body).toEndWith("data: [DONE]\n\n");
  } finally {
    await server.stop(true);
  }
});

test("HTTP errors preserve Codex classification without exposing internal stack traces", async () => {
  const stack = [
    "Error: connection reset while reading D:\\\\private\\\\secrets.json",
    "    at loadConfig (D:\\\\internal\\\\server.ts:42:9)",
    "    at async processRequest (node:internal/process/task_queues:95:5)",
  ].join("\n");
  for (const status of [500, 502, 503]) {
    const response = formatErrorResponse(status, "upstream_error", stack);
    const body = await response.json() as { error: { message: string; code: string | null } };
    expect(response.status).toBe(status);
    expect(body.error.message).toBe(status === 503 ? "The server is temporarily unavailable" : "An upstream request failed");
    expect(JSON.stringify(body)).not.toContain("private");
    expect(JSON.stringify(body)).not.toContain("server.ts");
    expect(JSON.stringify(body)).not.toContain("node:internal");
  }
  const overloaded = await formatErrorResponse(503, "upstream_error", "upstream overloaded: \n    at secret.js:42").json() as { error: { message: string; code: string | null } };
  expect(overloaded.error.code).toBe("server_is_overloaded");
  expect(overloaded.error.message).toBe("The server is temporarily unavailable");

  const invalid = await formatErrorResponse(400, "invalid_request_error", "Missing required model\n    at parseRequest (/secret/server.ts:32)").json() as { error: { message: string } };
  expect(invalid.error.message).toBe("Request failed");
  expect(JSON.stringify(invalid)).not.toContain("/secret/server.ts");
});
