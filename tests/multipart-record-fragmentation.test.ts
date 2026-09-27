import { expect, test } from "bun:test";
import {
  CHATGPT_BIGGER_CONTEXT_PARTS,
  CHATGPT_EVEN_BIGGER_CONTEXT_PARTS,
  CHATGPT_MULTIPART_JSON_BYTE_PLANNING_RESERVE,
  CHATGPT_WEB_PROMPT_JSON_BYTE_BUDGET,
  chatGptPromptJsonBytes,
  compileChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
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

test("Even Bigger Context fragments JSON-escape-heavy records before browser preflight", () => {
  const parsed = oversizedRequest(false);
  parsed.context.messages = [
    { role: "user", content: "\\".repeat(70_000), timestamp: 1 },
    { role: "user", content: "latest-request", timestamp: 2 },
  ];
  const compiled = compileChatGptWebPrompt(
    parsed,
    { ...capabilities, experimentalBiggerContext: true, experimentalEvenBiggerContext: true },
    undefined,
    { experimentalMultipartParts: CHATGPT_EVEN_BIGGER_CONTEXT_PARTS },
  );
  const records = compiled.multipart!.parts.flatMap(part => (
    (JSON.parse(part) as { records: Array<Record<string, unknown>> }).records
  ));
  const fragments = records.filter(record => (
    record.kind === "record_fragment" && record.record_index === 0
  ));
  expect(fragments.length).toBeGreaterThan(1);

  const transactionId = "ctx_" + "b".repeat(32);
  const byteLimit = CHATGPT_WEB_PROMPT_JSON_BYTE_BUDGET - CHATGPT_MULTIPART_JSON_BYTE_PLANNING_RESERVE;
  for (const [index, part] of compiled.multipart!.parts.slice(0, -1).entries()) {
    const stage = formatChatGptWebMultipartStage(part, transactionId, index + 1, CHATGPT_EVEN_BIGGER_CONTEXT_PARTS);
    expect(chatGptPromptJsonBytes(stage.text)).toBeLessThanOrEqual(byteLimit);
  }
  expect(chatGptPromptJsonBytes(formatChatGptWebMultipartCommit(compiled.multipart!, transactionId)))
    .toBeLessThanOrEqual(byteLimit);
});
