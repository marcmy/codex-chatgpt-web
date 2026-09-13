import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import type { CodexParsedRequest } from "../src/types";

const capabilities = {
  localToolsEnabled: false,
  solAvailable: true,
  proAvailable: true,
};

test("oversized Bigger Context compaction preserves history through record fragmentation", () => {
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
