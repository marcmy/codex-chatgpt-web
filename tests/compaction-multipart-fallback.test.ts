import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import type { CodexParsedRequest } from "../src/types";

const capabilities = {
  localToolsEnabled: false,
  solAvailable: true,
  proAvailable: true,
};

test("oversized Bigger Context compaction stage falls back to inline history trimming", () => {
  const oversizedOldHistory = "0123456789abcdef".repeat(30_000);
  const parsed: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "user", content: oversizedOldHistory, timestamp: 1 },
        { role: "user", content: "Continue after compaction", timestamp: 2 },
      ],
    },
    options: { reasoning: "high" },
    _compactionRequest: true,
  };

  const compiled = compileChatGptWebPrompt(
    parsed,
    capabilities,
    undefined,
    { experimentalMultipartParts: 3 },
  );

  expect(compiled.multipart).toBeUndefined();
  expect(compiled.trimmedCompactionMessages).toBe(1);
  expect(compiled.text).toContain("Continue after compaction");
  expect(compiled.text).not.toContain(oversizedOldHistory.slice(0, 1_000));
});
