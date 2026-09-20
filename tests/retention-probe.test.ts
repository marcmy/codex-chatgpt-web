import { expect, test } from "bun:test";
import {
  CHATGPT_RETENTION_REPORT_PREFIX,
  ChatGptRetentionReportStream,
  chatGptRetentionCanary,
  chatGptRetentionProbeCommitContract,
  inspectChatGptRetentionReport,
} from "../src/adapters/chatgpt-web/retention-probe";

test("retention probe v2 uses Markdown-inert tokens and exact staged-part placeholders", () => {
  const hex = "a".repeat(32);
  const transactionId = "ctx_" + hex;
  const canary = chatGptRetentionCanary(1, hex);
  expect(CHATGPT_RETENTION_REPORT_PREFIX).toBe("CODEXRETENTIONREPORT");
  expect(canary).toBe("ctxret1x" + hex);
  expect(canary).not.toContain("_");

  const contract = chatGptRetentionProbeCommitContract(transactionId, 1).join("\n");
  expect(contract).toContain("CODEXRETENTIONREPORT ctx" + hex + " <part-1-canary>");
  expect(contract).not.toContain("<part-2-canary>");
  expect(contract).toContain("CODEX_RETENTION_REPORT");
});

test("retention probe v2 parses and strips the Markdown-inert report", () => {
  const hex = "b".repeat(32);
  const transactionId = "ctx_" + hex;
  const canaries = [
    chatGptRetentionCanary(1, "1".repeat(32)),
    chatGptRetentionCanary(2, "2".repeat(32)),
  ];
  const line = "CODEXRETENTIONREPORT ctx" + hex + " " + canaries.join(" ") + "\nActual answer";

  expect(inspectChatGptRetentionReport(line, { transactionId, canaries })).toEqual({
    passed: true,
    visibleMarkdown: "Actual answer",
    missingParts: [],
    unexpected: [],
  });

  const stream = new ChatGptRetentionReportStream();
  expect(stream.push("CODEXRETENTIONREPORT ctx" + hex + " " + canaries[0] + " ")).toBe("");
  expect(stream.push(canaries[1] + "\nActual ")).toBe("Actual ");
  expect(stream.push("answer")).toBe("answer");
  expect(stream.finish()).toBe("");
});

test("retention probe remains compatible with escaped legacy Markdown reports", () => {
  const hex = "c".repeat(32);
  const transactionId = "ctx_" + hex;
  const legacyCanary = "ctxret_1_" + "d".repeat(32);
  const escaped = "CODEX\\_RETENTION\\_REPORT ctx\\_" + hex
    + " ctxret\\_1\\_" + "d".repeat(32) + "\nLegacy answer";

  expect(inspectChatGptRetentionReport(escaped, {
    transactionId,
    canaries: [legacyCanary],
  })).toMatchObject({
    passed: true,
    visibleMarkdown: "Legacy answer",
    missingParts: [],
    unexpected: [],
  });

  const stream = new ChatGptRetentionReportStream();
  expect(stream.push(escaped)).toBe("Legacy answer");
  expect(stream.finish()).toBe("");
});

test("retention probe diagnostics preserve the observed first line on malformed reports", () => {
  const transactionId = "ctx_" + "e".repeat(32);
  const canaries = [chatGptRetentionCanary(1, "f".repeat(32))];

  expect(inspectChatGptRetentionReport("Normal answer\ncontinues", {
    transactionId,
    canaries,
  })).toMatchObject({
    passed: false,
    reason: "missing_report",
    missingParts: [1],
    unexpected: [],
    observedFirstLine: "Normal answer",
    visibleMarkdown: "Normal answer\ncontinues",
  });

  expect(inspectChatGptRetentionReport(
    "CODEXRETENTIONREPORT ctx" + "e".repeat(32) + " MISSING\nActual answer",
    { transactionId, canaries },
  )).toMatchObject({
    passed: false,
    reason: "canary_mismatch",
    missingParts: [1],
    observedFirstLine: "CODEXRETENTIONREPORT ctx" + "e".repeat(32) + " MISSING",
    visibleMarkdown: "Actual answer",
  });
});
