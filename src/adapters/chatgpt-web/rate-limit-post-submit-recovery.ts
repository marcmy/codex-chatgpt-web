import type { Page } from "playwright-core";
import { ChatGptBrowserWorker } from "./browser-worker";
import {
  chatGptRateLimitBackoffPolicy,
  chatGptWebsiteActionGate,
} from "./rate-limit-backoff";
import { isChatGptRateLimitError } from "./rate-limit-dialog";
import {
  runChatGptRecoveryRefresh,
  runChatGptWebsiteAction,
} from "./rate-limit-website-actions";

const POST_SUBMIT_RATE_LIMIT_PATCH_MARK = Symbol.for(
  "codex-chatgpt-web.rate-limit-post-submit-recovery-installed",
);

interface PatchableWorkerPrototype {
  waitForNewAssistantTurn(...args: unknown[]): Promise<unknown>;
  [POST_SUBMIT_RATE_LIMIT_PATCH_MARK]?: boolean;
}

function resetSubmissionDomCache(value: unknown): void {
  if (!value || typeof value !== "object" || !("domCache" in value)) return;
  (value as { domCache: unknown }).domCache = {};
}

function pageArgument(args: readonly unknown[]): Page {
  const page = args[0] as Partial<Page> | undefined;
  if (!page || typeof page.reload !== "function") {
    throw new Error("ChatGPT post-submit rate-limit recovery did not receive a browser page");
  }
  return page as Page;
}

function abortSignalArgument(args: readonly unknown[]): AbortSignal | undefined {
  const signal = args[3];
  return signal instanceof AbortSignal ? signal : undefined;
}

function refundThrottleWait(args: unknown[], beforeMs: number): void {
  const deadline = args[2];
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) return;
  const waitedMs = Math.max(0, chatGptWebsiteActionGate.throttledMs() - beforeMs);
  args[2] = deadline + waitedMs;
}

async function reloadAcceptedTurnAfterRecovery(
  page: Page,
  signal?: AbortSignal,
): Promise<"recovery-refresh" | "paced-refresh"> {
  const refreshed = await runChatGptRecoveryRefresh(async () => {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  }, signal);
  if (refreshed) return "recovery-refresh";

  // Another tab may have owned the account-wide recovery refresh. This page can still be showing
  // the stale modal, so clear it with an ordinary action after the shared spacing gate permits it.
  await runChatGptWebsiteAction(async () => {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  }, signal);
  return "paced-refresh";
}

/**
 * An accepted prompt must never escape as a retryable 429 merely because ChatGPT showed its
 * account-wide rate-limit modal before the assistant turn became observable. Keep ownership of the
 * same launcher surface, wait through the existing recovery gate, refresh that page, then resume
 * binding the already-submitted assistant turn instead of creating a new browser attempt.
 */
export function installChatGptPostSubmitRateLimitRecovery(): void {
  const prototype = ChatGptBrowserWorker.prototype as unknown as PatchableWorkerPrototype;
  if (prototype[POST_SUBMIT_RATE_LIMIT_PATCH_MARK]) return;

  const originalWaitForNewAssistantTurn = prototype.waitForNewAssistantTurn;
  if (typeof originalWaitForNewAssistantTurn !== "function") {
    throw new Error("ChatGPT browser worker no longer exposes waitForNewAssistantTurn");
  }
  prototype[POST_SUBMIT_RATE_LIMIT_PATCH_MARK] = true;

  prototype.waitForNewAssistantTurn = async function rateLimitAwareWaitForNewAssistantTurn(
    this: ChatGptBrowserWorker,
    ...args: unknown[]
  ): Promise<unknown> {
    const page = pageArgument(args);
    const signal = abortSignalArgument(args);

    for (;;) {
      try {
        return await originalWaitForNewAssistantTurn.apply(this, args);
      } catch (error) {
        if (!isChatGptRateLimitError(error)) throw error;

        const detectedAt = Date.now();
        const newIncident = chatGptRateLimitBackoffPolicy.recordRateLimit(detectedAt);
        const snapshot = chatGptRateLimitBackoffPolicy.snapshot(detectedAt);
        console.warn(
          `[chatgpt-web] post-submit ChatGPT rate limit detected;`
          + ` incident=${newIncident ? "new" : "latched"}`
          + ` tier=${snapshot.tier + 1}`
          + ` cooldownMs=${Math.max(0, snapshot.cooldownUntil - detectedAt)}`
          + ` spacingMs=${snapshot.spacingMs}; retaining current launcher surface`,
        );

        const throttledBefore = chatGptWebsiteActionGate.throttledMs();
        const refreshMode = await reloadAcceptedTurnAfterRecovery(page, signal);
        refundThrottleWait(args, throttledBefore);
        resetSubmissionDomCache(args[1]);
        console.info(
          `[chatgpt-web] resumed accepted ChatGPT turn in-place after rate-limit ${refreshMode}`,
        );
      }
    }
  };
}

installChatGptPostSubmitRateLimitRecovery();
