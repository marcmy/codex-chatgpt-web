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

test("oversized Bigger Context compaction preserves history through record fragmentation", () => {
  const parsed = oversizedRequest(true);
  const oversizedOldHistory = parsed.context.messages[0]!.content as string;

  const compiled = compileChatGptWebPrompt(
    parsed,
    capabilities,
    undefined,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );

  expect(compiled.multipart).toBeDefined();
  expect(compiled.trimmedCompactionMessages).toBeUndefined();

  const records = compiled.multipart!.parts.flatMap(part => (
    (JSON.parse(part) as { records: Array<Record<string, unknown>> }).records
  ));
  const fragments = records.filter(record => (
    record.kind === "record_fragment" && record.record_index === 0
  )) as Array<{
    fragment_index: number;
    final: boolean;
    json_fragment: string;
  }>;

  expect(fragments.length).toBeGreaterThan(1);
  expect(fragments.map(fragment => fragment.fragment_index)).toEqual(
    Array.from({ length: fragments.length }, (_unused, index) => index),
  );
  expect(fragments.at(-1)?.final).toBe(true);
  expect(JSON.parse(fragments.map(fragment => fragment.json_fragment).join(""))).toEqual({
    kind: "message",
    message_index: 0,
    message: { role: "user", content: oversizedOldHistory },
  });
  expect(records).toContainEqual({
    kind: "message",
    message_index: 1,
    message: { role: "user", content: "Continue after compaction" },
  });
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
