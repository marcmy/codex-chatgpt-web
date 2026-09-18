import { expect, test } from "bun:test";
import {
  CHATGPT_BIGGER_CONTEXT_PARTS,
  compileChatGptWebPrompt,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

const capabilities = {
  localToolsEnabled: false,
  solAvailable: true,
  extraHighAvailable: true,
  proAvailable: true,
};

function oversizedRequest(compaction: boolean): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      messages: [
        {
          role: "user",
          content: "0123456789abcdef".repeat(30_000),
          timestamp: 1,
        },
        {
          role: "user",
          content: "Continue after compaction",
          timestamp: 2,
        },
      ],
    },
    options: { reasoning: "high" },
    ...(compaction ? { _compactionRequest: true } : {}),
  };
}

test("oversized Bigger Context compaction stage falls back to inline history trimming", () => {
  const parsed = oversizedRequest(true);
  const oversizedOldHistory = parsed.context.messages[0]!.content as string;

  const compiled = compileChatGptWebPrompt(
    parsed,
    capabilities,
    undefined,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );

  expect(compiled.multipart).toBeUndefined();
  expect(compiled.trimmedCompactionMessages).toBe(1);
  expect(compiled.text).toContain("Continue after compaction");
  expect(compiled.text).not.toContain(oversizedOldHistory.slice(0, 1_000));
});

test("ordinary oversized Bigger Context turns are not silently trimmed by compaction recovery", () => {
  const compiled = compileChatGptWebPrompt(
    oversizedRequest(false),
    capabilities,
    undefined,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );

  expect(compiled.multipart).toBeDefined();
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
});
