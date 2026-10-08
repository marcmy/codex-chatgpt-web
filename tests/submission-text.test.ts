import { expect, test } from "bun:test";
import { canonicalChatGptSubmission, guardChatGptSubmissionText } from "../src/adapters/chatgpt-web/submission-text";
import type { Page, Route } from "playwright-core";

const prompt = 'transaction_id: ctx_fixture\n<probe>\n```json\n' + JSON.stringify({
  text: "**bold** C:\\Probe\\file.txt", nested: JSON.stringify({ sample: '"quote"' }),
}) + '\n```\n</probe>';
const prefix = "[$codex-native2](app://fixture)  ";
function body(text: string, markdown = true) {
  return JSON.stringify({ action: "next", messages: [{ author: { role: "user" },
    content: { content_type: "multimodal_text", parts: [text, { content_type: "image_asset_pointer", asset_pointer: "fixture-image" }] },
    metadata: markdown ? { serialization_metadata: { render_format: "markdown" }, system_hints: ["plugin:fixture"] } : {},
  }] });
}

test("restores connector Markdown escaping and preserves images and connector metadata", () => {
  const serialized = prefix + prompt.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("`", "\\`").replaceAll("<", "\\<");
  const original = JSON.parse(body(serialized));
  const restored = JSON.parse(canonicalChatGptSubmission(body(serialized), prompt)!);
  expect(restored.messages[0].content.parts[0]).toBe(prefix + prompt);
  expect(restored.messages[0].content.parts[1]).toEqual(original.messages[0].content.parts[1]);
  expect(restored.messages[0].metadata).toEqual(original.messages[0].metadata);
  expect(restored.action).toBe("next");
});
test("leaves exact submissions untouched with and without a connector", () => {
  expect(canonicalChatGptSubmission(body(prompt, false), prompt)).toBeUndefined();
  expect(canonicalChatGptSubmission(body(prefix + prompt), prompt)).toBeUndefined();
});
test("rejects a foreign transaction or unclassified mutation", () => {
  expect(() => canonicalChatGptSubmission(body("foreign text"), prompt)).toThrow("bound");
  expect(() => canonicalChatGptSubmission(body(prompt + "changed", false), prompt)).toThrow("outside");
});
test("rejects ambiguous batches and text parts", () => {
  const batch = JSON.parse(body(prompt)); batch.messages.push(batch.messages[0]);
  expect(() => canonicalChatGptSubmission(JSON.stringify(batch), prompt)).toThrow("exactly one");
  const parts = JSON.parse(body(prompt)); parts.messages[0].content.parts.push("other text");
  expect(() => canonicalChatGptSubmission(JSON.stringify(parts), prompt)).toThrow("one user text");
});

test("tool-free compaction is bound to the owned checkpoint submission without inventing a tool capability", () => {
  const checkpoint = 'Act as the model backend for the Codex task encoded below.\n<codex_context_json>\n{"text":"**sample**"}\n</codex_context_json>\nProduce the requested checkpoint summary now without calling tools.';
  const serialized = checkpoint.replaceAll("*", "\\*").replaceAll("<", "\\<");
  const restored = JSON.parse(canonicalChatGptSubmission(body(serialized), checkpoint)!);
  expect(restored.messages[0].content.parts[0]).toBe(checkpoint);
  expect(restored.messages[0].content.parts[0]).not.toContain("turn_token");
  expect(() => canonicalChatGptSubmission(body("foreign text"), checkpoint)).toThrow("bound");
});

test("the scoped guard restores the owned request and releases only its own route", async () => {
  const frame = {};
  let handler!: (route: Route) => Promise<void>;
  const calls: unknown[] = [];
  const page = {
    mainFrame: () => frame,
    route: async (url: string, callback: typeof handler) => { calls.push(url); handler = callback; },
    unroute: async (url: string, callback: typeof handler) => { expect(callback).toBe(handler); calls.push(url); },
  } as unknown as Page;
  let failures = 0;
  const guard = await guardChatGptSubmissionText(page, prompt, () => { failures++; });
  const serialized = prefix + prompt.replaceAll("*", "\\*");
  const makeRoute = (owned: boolean) => ({
    request: () => ({ method: () => "POST", frame: () => owned ? frame : {}, postData: () => body(serialized) }),
    fallback: async () => { calls.push("foreign-frame-fallback"); },
    continue: async (options: { postData: string }) => { calls.push(JSON.parse(options.postData).messages[0].content.parts[0]); },
    abort: async () => { calls.push("abort"); },
  }) as unknown as Route;
  await handler(makeRoute(false));
  await handler(makeRoute(true));
  expect(guard.failure()).toBeUndefined();
  expect(failures).toBe(0);
  await guard.dispose();
  expect(calls).toEqual(["https://chatgpt.com/backend-api/f/conversation", "foreign-frame-fallback", prefix + prompt,
    "https://chatgpt.com/backend-api/f/conversation"]);
});

test("an unbound submission aborts and signals the owning Send without exporting its text", async () => {
  const frame = {};
  let handler!: (route: Route) => Promise<void>;
  let aborted = false;
  let notified = false;
  const page = { mainFrame: () => frame, route: async (_url: string, callback: typeof handler) => { handler = callback; }, unroute: async () => {} } as unknown as Page;
  const guard = await guardChatGptSubmissionText(page, prompt, () => { notified = true; });
  await handler({ request: () => ({ method: () => "POST", frame: () => frame, postData: () => body("private foreign text") }),
    continue: async () => { throw new Error("must not send"); }, abort: async () => { aborted = true; },
  } as unknown as Route);
  expect(aborted).toBeTrue();
  expect(notified).toBeTrue();
  expect(guard.failure()?.message).not.toContain("private foreign text");
  await guard.dispose();
});
