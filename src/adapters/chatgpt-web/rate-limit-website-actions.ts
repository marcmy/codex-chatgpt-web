import { AsyncLocalStorage } from "node:async_hooks";
import type { Page } from "playwright-core";
import { chatGptWebsiteActionGate } from "./rate-limit-backoff";

const websiteActionContext = new AsyncLocalStorage<boolean>();
const websiteTurnContext = new AsyncLocalStorage<{ signal?: AbortSignal }>();
const patchedPrototypes = new WeakSet<object>();

/** Public Playwright methods that actively manipulate the ChatGPT website. */
export const CHATGPT_ACTIVE_LOCATOR_METHODS = [
  "check",
  "clear",
  "click",
  "dblclick",
  "dispatchEvent",
  "dragTo",
  "fill",
  "focus",
  "hover",
  "press",
  "pressSequentially",
  "selectOption",
  "setChecked",
  "setInputFiles",
  "tap",
  "type",
  "uncheck",
] as const;

export const CHATGPT_ACTIVE_PAGE_METHODS = [
  "goBack",
  "goForward",
  "goto",
  "reload",
] as const;

export const CHATGPT_ACTIVE_KEYBOARD_METHODS = [
  "insertText",
  "press",
  "type",
] as const;

export const CHATGPT_ACTIVE_MOUSE_METHODS = [
  "click",
  "dblclick",
  "wheel",
] as const;

function actionSignal(args: unknown[]): AbortSignal | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const candidate = args[index];
    if (!candidate || typeof candidate !== "object") continue;
    const signal = (candidate as { signal?: unknown }).signal;
    if (signal instanceof AbortSignal) return signal;
  }
  return websiteTurnContext.getStore()?.signal;
}

/** Bind intercepted actions to the owning browser turn so recovery queue waits remain cancellable. */
export function runWithChatGptWebsiteActionAbortSignal<T>(
  signal: AbortSignal | undefined,
  action: () => Promise<T>,
): Promise<T> {
  return websiteTurnContext.run({ signal }, action);
}

/**
 * Run one active website operation through the account-wide recovery gate. Nested Playwright public
 * methods inherit this async context and are not double-counted as separate website operations.
 */
export function runChatGptWebsiteAction<T>(
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (websiteActionContext.getStore()) return action();
  return chatGptWebsiteActionGate.runAction(
    () => websiteActionContext.run(true, action),
    signal ?? websiteTurnContext.getStore()?.signal,
  );
}

/** The mandatory post-cooldown refresh bypasses the ordinary-action wrapper but uses the same lock. */
export function runChatGptRecoveryRefresh(
  action: () => Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  return chatGptWebsiteActionGate.runRecoveryRefresh(
    () => websiteActionContext.run(true, action),
    signal ?? websiteTurnContext.getStore()?.signal,
  );
}

type AsyncMethod = (...args: unknown[]) => Promise<unknown>;

function patchActiveMethod(prototype: object, methodName: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
  if (!descriptor || typeof descriptor.value !== "function") return;
  const original = descriptor.value as AsyncMethod;
  Object.defineProperty(prototype, methodName, {
    ...descriptor,
    value: function rateLimitAwarePlaywrightAction(this: unknown, ...args: unknown[]) {
      return runChatGptWebsiteAction(
        () => original.apply(this, args),
        actionSignal(args),
      );
    },
  });
}

function patchPromptInsertionEvaluate(prototype: object): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "evaluate");
  if (!descriptor || typeof descriptor.value !== "function") return;
  const original = descriptor.value as AsyncMethod;
  Object.defineProperty(prototype, "evaluate", {
    ...descriptor,
    value: function rateLimitAwareLocatorEvaluate(this: unknown, ...args: unknown[]) {
      const pageFunction = args[0];
      // Most evaluate() calls are passive observations and must stay unthrottled. This one mutates
      // the composer and is therefore an ordinary active website operation.
      if (typeof pageFunction !== "function" || pageFunction.name !== "insertPlainTextIntoComposer") {
        return original.apply(this, args);
      }
      return runChatGptWebsiteAction(
        () => original.apply(this, args),
        actionSignal(args),
      );
    },
  });
}

function patchPrototype(
  value: object | undefined,
  methodNames: readonly string[],
  options: { promptInsertionEvaluate?: boolean } = {},
): void {
  if (!value) return;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (!prototype || patchedPrototypes.has(prototype)) return;
  patchedPrototypes.add(prototype);
  for (const methodName of methodNames) patchActiveMethod(prototype, methodName);
  if (options.promptInsertionEvaluate) patchPromptInsertionEvaluate(prototype);
}

/**
 * Instrument the Playwright object types used by a connected ChatGPT page. The patch is prototype
 * based, so every current/future page, locator and keyboard object from this Playwright runtime is
 * covered, including actions initiated from chatgpt-session.ts.
 */
export function installChatGptWebsiteActionInterceptors(page: Page): void {
  patchPrototype(page, CHATGPT_ACTIVE_PAGE_METHODS);
  patchPrototype(page.locator("body"), CHATGPT_ACTIVE_LOCATOR_METHODS, { promptInsertionEvaluate: true });
  patchPrototype(page.keyboard, CHATGPT_ACTIVE_KEYBOARD_METHODS);
  patchPrototype(page.mouse, CHATGPT_ACTIVE_MOUSE_METHODS);
  patchPrototype(page.touchscreen, ["tap"]);
  patchPrototype(page.mainFrame(), ["goto", "setContent"]);
}
