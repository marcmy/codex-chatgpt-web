import { expect, test } from "bun:test";
import { ChatGptMarkdownBuffer, ChatGptMarkdownConsistencyError, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { chatGptMarkdownConflictEvidence } from "../src/adapters/chatgpt-web/browser-worker";

test("an unaligned terminal remount records bounded evidence without weakening rejection", () => {
  const segment = (key: string, text: string, streamable: boolean): ChatGptMarkdownSegment => ({ key, tag: "p", text, html: `<p>${text}</p>`, streamable });
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const report = Array.from({ length: 100 }, (_, index) => segment(`key-${index}`, `PRIVATE REPORT ${index}`, index < 99));
  buffer.observe(report, 0);
  buffer.observe([segment("new-unanchored-key", "PRIVATE NEW BLOCK", false)], 1);
  try { buffer.finish(); throw new Error("Expected failure"); } catch (error) {
    expect(error).toBeInstanceOf(ChatGptMarkdownConsistencyError);
    const diagnostic = (error as ChatGptMarkdownConsistencyError).diagnostic!;
    expect(diagnostic.reason).toBe("unaligned_block");
    expect(diagnostic.committedCount).toBe(99);
    expect(diagnostic.pendingCount).toBe(1);
    expect(diagnostic.blocks!.length).toBeLessThanOrEqual(18);
    expect(diagnostic.blocks!.some(block => block.collection === "observed")).toBeTrue();
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
    expect(JSON.stringify(diagnostic)).not.toContain("key-98");
    const wrapped = new ChatGptWebAdapterError(error instanceof Error ? error.message : "failure", {
      status: 502, errorType: "server_error", code: "browser_stream_inconsistent", retryable: false, cause: error,
    });
    expect(chatGptMarkdownConflictEvidence(wrapped)).toEqual(diagnostic);
    expect(chatGptMarkdownConflictEvidence(new Error("unrelated"))).toBeUndefined();
  }
});

test("a remounted unchanged report still reconciles and emits the tail exactly once", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const first = { key: "a", tag: "p", text: "First", html: "<p>First</p>", streamable: true };
  const last = { key: "b", tag: "p", text: "Last", html: "<p>Last</p>", streamable: false };
  expect(buffer.observe([first, last], 0)).toBe("First");
  expect(buffer.observe([{ ...first, key: "remount-a" }, { ...last, key: "remount-b" }], 1)).toBe("");
  expect(buffer.finish()).toEqual({ markdown: "First\n\nLast", delta: "\n\nLast" });
});
