import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHATGPT_ACTIVE_KEYBOARD_METHODS,
  CHATGPT_ACTIVE_LOCATOR_METHODS,
  CHATGPT_ACTIVE_MOUSE_METHODS,
  CHATGPT_ACTIVE_PAGE_METHODS,
} from "../src/adapters/chatgpt-web/rate-limit-website-actions";

const root = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("the action interceptor covers every explicit active Playwright operation used by ChatGPT code", () => {
  const activeMethods = new Set<string>([
    ...CHATGPT_ACTIVE_LOCATOR_METHODS,
    ...CHATGPT_ACTIVE_PAGE_METHODS,
    ...CHATGPT_ACTIVE_KEYBOARD_METHODS,
    ...CHATGPT_ACTIVE_MOUSE_METHODS,
    "tap",
    "setContent",
  ]);
  const patterns = [
    /\.(click|press|pressSequentially|focus|fill|hover|goto|reload|setInputFiles|dispatchEvent)\s*\(/g,
  ];

  for (const path of [
    "src/adapters/chatgpt-web/browser-worker.ts",
    "src/chatgpt-session.ts",
  ]) {
    const text = source(path);
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        expect(activeMethods.has(match[1]!), `${path} uses unclassified active method ${match[1]}`).toBe(true);
      }
    }
  }
});

test("the known mutating composer evaluate is explicitly classified while passive evaluate remains available", () => {
  const worker = source("src/adapters/chatgpt-web/browser-worker.ts");
  const interceptor = source("src/adapters/chatgpt-web/rate-limit-website-actions.ts");
  expect(worker).toContain("export function insertPlainTextIntoComposer");
  expect(worker).toContain("composer.evaluate(insertPlainTextIntoComposer");
  expect(interceptor).toContain('pageFunction.name !== "insertPlainTextIntoComposer"');
});

test("runtime recovery uses the per-action gate instead of one coarse turn permit", () => {
  const runtime = source("src/adapters/chatgpt-web/rate-limit-runtime-patch.ts");
  expect(runtime).toContain("installChatGptWebsiteActionInterceptors");
  expect(runtime).toContain("runChatGptRecoveryRefresh");
  expect(runtime).not.toContain("nextAllowedActionAt");
  expect(runtime).not.toContain("recordAction(");
});

test("browser stage budgets refund live deliberate backoff wait and propagate the stage abort signal", () => {
  const runtime = source("src/adapters/chatgpt-web/rate-limit-runtime-patch.ts");
  expect(runtime).toContain("base.suspendedMs() + chatGptWebsiteActionGate.throttledMs()");
  expect(runtime).toContain("recoveryAwareSuspensionClock(suspensionClock)");
  expect(runtime).toContain("abortSignal => runWithChatGptWebsiteActionAbortSignal(");
  expect(runtime).toContain("() => action(abortSignal)");
});
