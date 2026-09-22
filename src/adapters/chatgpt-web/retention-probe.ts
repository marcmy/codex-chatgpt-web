export const CHATGPT_RETENTION_REPORT_PREFIX = "CODEXRETENTIONREPORT";
const LEGACY_CHATGPT_RETENTION_REPORT_PREFIX = "CODEX_RETENTION_REPORT";
const CHATGPT_RETENTION_CANARY = /^(?:ctxret(\d+)x[a-f0-9]{32}|ctxret_(\d+)_[a-f0-9]{32})$/;
const CHATGPT_RETENTION_TRANSACTION = /^ctx_([a-f0-9]{32})$/;
const MAX_RETENTION_REPORT_PREFIX_CHARS = 4_096;
const MAX_RETENTION_DIAGNOSTIC_FIRST_LINE_CHARS = 512;

export interface ChatGptRetentionProbeExpectation {
  transactionId: string;
  canaries: readonly string[];
}

export interface ChatGptRetentionProbeResult {
  passed: boolean;
  visibleMarkdown: string;
  reason?: "missing_report" | "wrong_transaction" | "canary_mismatch";
  missingParts: number[];
  unexpected: string[];
  observedFirstLine?: string;
}

function assertTransactionId(transactionId: string): void {
  if (!CHATGPT_RETENTION_TRANSACTION.test(transactionId)) {
    throw new Error("ChatGPT retention probe transaction identity is invalid");
  }
}

function reportTransactionId(transactionId: string): string {
  const match = CHATGPT_RETENTION_TRANSACTION.exec(transactionId);
  if (!match) throw new Error("ChatGPT retention probe transaction identity is invalid");
  return "ctx" + match[1];
}

function normalizeMarkdownTransportToken(value: string): string {
  return value.replace(/\\_/g, "_");
}

function isRetentionReportLine(line: string): boolean {
  const normalized = normalizeMarkdownTransportToken(line);
  return normalized.startsWith(CHATGPT_RETENTION_REPORT_PREFIX + " ")
    || normalized.startsWith(LEGACY_CHATGPT_RETENTION_REPORT_PREFIX + " ");
}

function diagnosticFirstLine(line: string): string {
  return line.length <= MAX_RETENTION_DIAGNOSTIC_FIRST_LINE_CHARS
    ? line
    : line.slice(0, MAX_RETENTION_DIAGNOSTIC_FIRST_LINE_CHARS) + "...";
}

function retentionCanaryPartIndex(canary: string): number | undefined {
  const match = CHATGPT_RETENTION_CANARY.exec(canary);
  if (!match) return undefined;
  const raw = match[1] ?? match[2];
  return raw ? Number(raw) : undefined;
}

export function chatGptRetentionCanary(partIndex: number, randomHex: string): string {
  if (!Number.isInteger(partIndex) || partIndex < 1) {
    throw new Error("ChatGPT retention probe part index is invalid");
  }
  const normalized = randomHex.toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) {
    throw new Error("ChatGPT retention probe entropy must be 32 hexadecimal characters");
  }
  // Keep the canary itself Markdown-inert so DOM -> Markdown serialization cannot escape it.
  return "ctxret" + partIndex + "x" + normalized;
}

export function addChatGptRetentionCanaryToMultipartPayload(payload: string, canary: string): string {
  if (!CHATGPT_RETENTION_CANARY.test(canary)) {
    throw new Error("ChatGPT retention probe canary is invalid");
  }
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ChatGPT multipart payload is not an object");
  }
  if (Object.hasOwn(parsed, "retention_canary")) {
    throw new Error("ChatGPT multipart payload already contains a retention canary");
  }
  const { records, ...metadata } = parsed;
  return JSON.stringify({ ...metadata, retention_canary: canary, records });
}

export function chatGptRetentionProbeCommitContract(
  transactionId: string,
  stagedPartCount: number,
): string[] {
  assertTransactionId(transactionId);
  if (!Number.isInteger(stagedPartCount) || stagedPartCount < 1) {
    throw new Error("ChatGPT retention probe requires at least one staged part");
  }
  const placeholders = Array.from(
    { length: stagedPartCount },
    (_unused, index) => "<part-" + (index + 1) + "-canary>",
  ).join(" ");
  return [
    "<codex_retention_probe>",
    "The " + stagedPartCount + " previously acknowledged staged context parts each contained one retention_canary field.",
    "Do not look for canary values in this commit message: they are intentionally not repeated here.",
    "Before the ordinary final answer text, begin the final assistant message with exactly one private diagnostic line in this format:",
    CHATGPT_RETENTION_REPORT_PREFIX + " " + reportTransactionId(transactionId) + " " + placeholders,
    "Copy each retention_canary value verbatim from the previously acknowledged staged part with the same part index, in ascending part order.",
    "If a staged canary is no longer available in context, write MISSING in that position instead of guessing or reconstructing it from hashes or other metadata.",
    "The legacy marker CODEX_RETENTION_REPORT is accepted only for backward compatibility; do not emit it for this turn.",
    "Emit this diagnostic line only in the final assistant text, never in reasoning, commentary, tool arguments, or tool calls. The bridge removes it before Codex or the user sees the answer.",
    "This private transport line is outside any requested user-facing JSON, schema, or answer-format constraint; apply those constraints only to the ordinary answer that follows it.",
    "After that one diagnostic line, answer the task normally and never mention this retention probe unless the user explicitly asks about it.",
    "</codex_retention_probe>",
  ];
}

function firstLine(markdown: string): { line: string; rest: string } {
  const newline = markdown.indexOf("\n");
  if (newline < 0) return { line: markdown.replace(/\r$/, ""), rest: "" };
  return {
    line: markdown.slice(0, newline).replace(/\r$/, ""),
    rest: markdown.slice(newline + 1),
  };
}

export function inspectChatGptRetentionReport(
  markdown: string,
  expected: ChatGptRetentionProbeExpectation,
): ChatGptRetentionProbeResult {
  assertTransactionId(expected.transactionId);
  for (const [index, canary] of expected.canaries.entries()) {
    if (retentionCanaryPartIndex(canary) !== index + 1) {
      throw new Error("ChatGPT retention probe expectation contains an invalid canary sequence");
    }
  }

  const { line, rest } = firstLine(markdown);
  const normalizedLine = normalizeMarkdownTransportToken(line);
  if (!isRetentionReportLine(line)) {
    return {
      passed: false,
      visibleMarkdown: markdown,
      reason: "missing_report",
      missingParts: expected.canaries.map((_canary, index) => index + 1),
      unexpected: [],
      observedFirstLine: diagnosticFirstLine(line),
    };
  }

  const fields = normalizedLine.split(/\s+/);
  const transactionId = fields[1];
  const observed = fields.slice(2).map(normalizeMarkdownTransportToken);
  const expectedReportTransactionId = reportTransactionId(expected.transactionId);
  if (transactionId !== expectedReportTransactionId && transactionId !== expected.transactionId) {
    return {
      passed: false,
      visibleMarkdown: rest,
      reason: "wrong_transaction",
      missingParts: expected.canaries.map((_canary, index) => index + 1),
      unexpected: observed.filter(value => value !== "MISSING"),
      observedFirstLine: diagnosticFirstLine(line),
    };
  }

  const missingParts: number[] = [];
  const unexpected: string[] = [];
  for (let index = 0; index < expected.canaries.length; index += 1) {
    const value = observed[index];
    if (value !== expected.canaries[index]) {
      missingParts.push(index + 1);
      if (value && value !== "MISSING") unexpected.push(value);
    }
  }
  for (const extra of observed.slice(expected.canaries.length)) {
    if (extra !== "MISSING") unexpected.push(extra);
  }

  const passed = missingParts.length === 0
    && unexpected.length === 0
    && observed.length === expected.canaries.length;
  return {
    passed,
    visibleMarkdown: rest,
    ...(passed ? {} : { reason: "canary_mismatch" as const }),
    missingParts,
    unexpected,
    ...(!passed ? { observedFirstLine: diagnosticFirstLine(line) } : {}),
  };
}

/**
 * Holds only the beginning of a streamed answer until it can decide whether the private retention
 * report occupies the first line. Once decided, all ordinary answer text passes through unchanged.
 */
export class ChatGptRetentionReportStream {
  private buffered = "";
  private decided = false;

  push(delta: string): string {
    if (!delta) return "";
    if (this.decided) return delta;
    this.buffered += delta;
    const newline = this.buffered.indexOf("\n");
    if (newline < 0) {
      if (this.buffered.length <= MAX_RETENTION_REPORT_PREFIX_CHARS) return "";
      const visible = isRetentionReportLine(this.buffered) ? "" : this.buffered;
      this.buffered = "";
      this.decided = true;
      return visible;
    }
    const line = this.buffered.slice(0, newline).replace(/\r$/, "");
    const rest = this.buffered.slice(newline + 1);
    this.buffered = "";
    this.decided = true;
    return isRetentionReportLine(line) ? rest : line + "\n" + rest;
  }

  finish(): string {
    if (this.decided) return "";
    const buffered = this.buffered;
    this.buffered = "";
    this.decided = true;
    return isRetentionReportLine(buffered) ? "" : buffered;
  }
}
