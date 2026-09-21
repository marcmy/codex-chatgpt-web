import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("accepted multipart response errors recover on the existing browser surface", () => {
  const entry = source("src/adapters/chatgpt-web/browser-helper-entry.ts");
  const recovery = source("src/adapters/chatgpt-web/multipart-error-recovery.ts");
  const worker = source("src/adapters/chatgpt-web/browser-worker.ts");

  expect(entry).toContain('import "./multipart-error-recovery"');
  expect(worker).toContain("private async waitForMultipartAcknowledgement(");
  expect(recovery).toContain("waitForMultipartAcknowledgement");
  expect(recovery).toContain('getByTestId("regenerate-thread-error-button")');
  expect(recovery).toContain('retry.press("Enter"');
  expect(recovery).toContain("MAX_MULTIPART_RESPONSE_RETRIES = 3");
  expect(recovery).toContain("args[7] = undefined");
  expect(recovery).toContain("retrying assistant acknowledgement in-place");
  expect(recovery).toContain('code: "multipart_acknowledgement_upstream_error"');
  expect(recovery).toContain("retryable: false");
  expect(recovery).toContain("The staged context was not replayed in a new tab.");
});

test("ordinary terminal response detection remains passive", () => {
  const worker = source("src/adapters/chatgpt-web/browser-worker.ts");
  const terminalHelperStart = worker.indexOf("export async function throwIfChatGptTerminalErrorAlert");
  const terminalHelperEnd = worker.indexOf("\nexport async function resolveChatGptToolConfirmation", terminalHelperStart);
  const terminalHelper = worker.slice(terminalHelperStart, terminalHelperEnd);

  expect(terminalHelper).toContain('getByTestId("regenerate-thread-error-button")');
  expect(terminalHelper).not.toContain(".press(");
  expect(terminalHelper).not.toContain(".click(");
});
