import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "playwright-core";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { runChatGptMultipartAcknowledgementWithRecovery } from "../src/adapters/chatgpt-web/multipart-error-recovery";

const root = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

function upstreamError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT displayed an error for this response.",
    {
      status: 502,
      errorType: "server_error",
      code: "upstream_server_error",
      retryable: true,
    },
  );
}

function responseTurn(presses: { count: number }) {
  const retry = {
    last: () => retry,
    isVisible: async () => true,
    waitFor: async () => {},
    press: async () => { presses.count += 1; },
  };
  const locator = {
    getByTestId: () => retry,
  };
  return { locator: locator as unknown as Locator };
}

test("accepted multipart response errors retry the assistant acknowledgement on the same call", async () => {
  const presses = { count: 0 };
  let waits = 0;
  const args: unknown[] = [{}, responseTurn(presses), {}, {}, undefined, undefined, undefined, {}];
  const original = async () => {
    waits += 1;
    if (waits === 1) throw upstreamError();
  };

  await runChatGptMultipartAcknowledgementWithRecovery(
    original,
    {} as ChatGptBrowserWorker,
    args,
  );

  expect(waits).toBe(2);
  expect(presses.count).toBe(1);
  expect(args[7]).toBeUndefined();
});

test("persistent multipart response errors stop locally instead of replaying a new browser turn", async () => {
  const presses = { count: 0 };
  let waits = 0;
  const args: unknown[] = [{}, responseTurn(presses), {}, {}, undefined, undefined, undefined, {}];
  const original = async () => {
    waits += 1;
    throw upstreamError();
  };

  try {
    await runChatGptMultipartAcknowledgementWithRecovery(
      original,
      {} as ChatGptBrowserWorker,
      args,
    );
    throw new Error("expected multipart recovery to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatGptWebAdapterError);
    expect(error).toMatchObject({
      code: "multipart_acknowledgement_upstream_error",
      retryable: false,
    });
  }

  expect(waits).toBe(4);
  expect(presses.count).toBe(3);
});

test("accepted multipart response errors are wired into the helper while ordinary errors stay passive", () => {
  const entry = source("src/adapters/chatgpt-web/browser-helper-entry.ts");
  const recovery = source("src/adapters/chatgpt-web/multipart-error-recovery.ts");
  const worker = source("src/adapters/chatgpt-web/browser-worker.ts");

  expect(entry).toContain('import "./multipart-error-recovery"');
  expect(worker).toContain("private async waitForMultipartAcknowledgement(");
  expect(recovery).toContain('getByTestId("regenerate-thread-error-button")');
  expect(recovery).toContain("runChatGptMultipartAcknowledgementWithRecovery");
  expect(recovery).toContain('code: "multipart_acknowledgement_upstream_error"');
  expect(recovery).toContain("retryable: false");

  const terminalHelperStart = worker.indexOf("export async function throwIfChatGptTerminalErrorAlert");
  const terminalHelperEnd = worker.indexOf("\nexport async function resolveChatGptToolConfirmation", terminalHelperStart);
  const terminalHelper = worker.slice(terminalHelperStart, terminalHelperEnd);
  expect(terminalHelper).toContain('getByTestId("regenerate-thread-error-button")');
  expect(terminalHelper).not.toContain(".press(");
  expect(terminalHelper).not.toContain(".click(");
});
