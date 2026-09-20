import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("accepted rate limits retain the current surface and resume assistant binding in-place", () => {
  const entry = source("src/adapters/chatgpt-web/browser-helper-entry.ts");
  const recovery = source("src/adapters/chatgpt-web/rate-limit-post-submit-recovery.ts");

  expect(entry).toContain('import "./rate-limit-post-submit-recovery"');
  expect(recovery).toContain("waitForNewAssistantTurn");
  expect(recovery).toContain("isChatGptRateLimitError");
  expect(recovery).toContain("chatGptRateLimitBackoffPolicy.recordRateLimit");
  expect(recovery).toContain("runChatGptRecoveryRefresh");
  expect(recovery).toContain("runChatGptWebsiteAction");
  expect(recovery).toContain('page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 })');
  expect(recovery).toContain("refundThrottleWait(args, throttledBefore)");
  expect(recovery).toContain("resetSubmissionDomCache(observationBaseline)");
  expect(recovery).toContain("const originalRecovery = typeof args[7]");
  expect(recovery).toContain("observationPage = requirePage(recovered.page)");
  expect(recovery).toContain("observationBaseline = recovered.baseline");
  expect(recovery).toContain("retaining current launcher surface");
});
