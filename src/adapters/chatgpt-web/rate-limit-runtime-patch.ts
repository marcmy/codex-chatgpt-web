import type { Browser, Page } from "playwright-core";
import {
  connectLauncherBrowserHost,
  LauncherBrowserTurnCancelledError,
  LauncherRetainedConversationUnavailableError,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  notifyLauncherTurn,
} from "../../launcher-browser-host";
import {
  browserStageTimeouts,
  chatGptSuspensionClock,
  ChatGptBrowserWorker,
  type BrowserTurn,
  type ResolvedBrowserConfig,
} from "./browser-worker";
import {
  ChatGptCompactionHandoffAccepted,
  ChatGptWebAdapterError,
  chatGptBrowserTabClosedError,
  chatGptRetainedConversationUnavailableError,
} from "./adapter-error";
import {
  chatGptRateLimitBackoffPolicy,
  chatGptWebsiteActionGate,
} from "./rate-limit-backoff";
import { isChatGptRateLimitError } from "./rate-limit-dialog";
import {
  installChatGptWebsiteActionInterceptors,
  runChatGptRecoveryRefresh,
} from "./rate-limit-website-actions";

const RATE_LIMIT_PATCH_MARK = Symbol.for("codex-chatgpt-web.rate-limit-backoff-installed");

type SuspensionClockLike = Pick<typeof chatGptSuspensionClock, "suspendedMs">;

interface WorkerInternals {
  config: ResolvedBrowserConfig;
  runBrowserTurn(
    turn: BrowserTurn,
    launcherSurfaceId?: string,
    maintenancePage?: Page,
    reuseConversation?: boolean,
  ): Promise<string>;
}

interface PatchableWorkerPrototype {
  runExclusive(turn: BrowserTurn): Promise<string>;
  runStage<T>(
    traceId: string,
    stage: string,
    timeoutMs: number,
    action: (abortSignal: AbortSignal) => Promise<T>,
    suspensionClock?: SuspensionClockLike,
    awaitAbortedActionSettlement?: boolean,
  ): Promise<T>;
  [RATE_LIMIT_PATCH_MARK]?: boolean;
}

/** Runs in the ChatGPT renderer and only changes the local acknowledgement button's presentation. */
function installPassiveRateLimitGuardInPage(): void {
  const state = globalThis as typeof globalThis & {
    __CODEX_WEB_GPT_RATE_LIMIT_PASSIVE_GUARD__?: boolean;
  };
  if (state.__CODEX_WEB_GPT_RATE_LIMIT_PASSIVE_GUARD__) return;
  state.__CODEX_WEB_GPT_RATE_LIMIT_PASSIVE_GUARD__ = true;

  const scan = () => {
    for (const candidate of document.querySelectorAll('[role="dialog"]')) {
      const text = (candidate.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!/(?:Too many requests|太多要求|太多请求|リクエストが多すぎます)/i.test(text)) continue;
      if (!/(?:making requests too quickly|過於頻繁|过于频繁|リクエストの頻度が高すぎます)/i.test(text)) continue;
      for (const button of candidate.querySelectorAll("button")) {
        const label = (button.getAttribute("aria-label") ?? button.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
        if (!/^(?:Got it|知道了|了解)$/i.test(label)) continue;
        (button as HTMLElement).style.setProperty("display", "none", "important");
        button.setAttribute("data-codex-rate-limit-passive", "true");
      }
    }
  };

  const start = () => {
    scan();
    if (!document.documentElement) return;
    new MutationObserver(scan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };
  if (document.documentElement) start();
  else addEventListener("DOMContentLoaded", start, { once: true });
}

async function armPassiveRateLimitGuard(page: Page): Promise<void> {
  await page.addInitScript(installPassiveRateLimitGuardInPage);
  await page.evaluate(installPassiveRateLimitGuardInPage);
}

async function withLauncherSurface<T>(
  descriptorPath: string,
  surfaceId: string,
  abortSignal: AbortSignal | undefined,
  action: (page: Page) => Promise<T>,
): Promise<T> {
  let browser: Browser | undefined;
  try {
    const connection = await connectLauncherBrowserHost(
      descriptorPath,
      browserStageTimeouts.browserPage,
      surfaceId,
      abortSignal,
    );
    browser = connection.browser;
    installChatGptWebsiteActionInterceptors(connection.page);
    return await action(connection.page);
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function armLauncherRateLimitGuard(
  descriptorPath: string,
  surfaceId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  await withLauncherSurface(descriptorPath, surfaceId, abortSignal, armPassiveRateLimitGuard);
}

/**
 * Perform exactly the one refresh allowed after hard cooldown. The action gate owns the full wait
 * and refresh operation, so every competing active browser action remains blocked until it settles.
 */
async function refreshLauncherRateLimitedSurface(
  descriptorPath: string,
  surfaceId: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  return withLauncherSurface(descriptorPath, surfaceId, abortSignal, async page => {
    const refreshed = await runChatGptRecoveryRefresh(async () => {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    }, abortSignal);
    if (refreshed) {
      // The init script installed before the incident normally survives the navigation. Re-arm it
      // as defensive instrumentation after (never during) the hard-cooldown refresh.
      await armPassiveRateLimitGuard(page);
    }
    return refreshed;
  });
}

/** Complete only the mandatory hard-cooldown refresh. Ordinary actions acquire their own permits. */
async function ensureRateLimitRecoveryRefresh(
  descriptorPath: string,
  surfaceId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const snapshot = chatGptRateLimitBackoffPolicy.snapshot();
  if (snapshot.tier < 0 || !snapshot.refreshRequired) return;
  await refreshLauncherRateLimitedSurface(descriptorPath, surfaceId, abortSignal);
}

/**
 * Browser stage budgets use the existing suspension-clock seam. Adding the action gate's monotonic
 * deliberate-wait counter makes backoff sleep invisible to stage deadlines while leaving actual
 * Playwright operation time fully charged. Individual Playwright timeouts are naturally preserved
 * because their methods are not invoked until the gate finishes waiting.
 */
function recoveryAwareSuspensionClock(base: SuspensionClockLike): SuspensionClockLike {
  return {
    suspendedMs: () => base.suspendedMs() + chatGptWebsiteActionGate.throttledMs(),
  };
}

/**
 * The bundled launcher helper installs this patch before browser-helper-main starts. Keeping the
 * change at the helper boundary lets a rate-limited turn retain its launcher lease and heartbeats
 * while the website-action interceptor enforces recovery below the large browser worker.
 */
export function installChatGptRateLimitBackoffRuntime(): void {
  const prototype = ChatGptBrowserWorker.prototype as unknown as PatchableWorkerPrototype;
  if (prototype[RATE_LIMIT_PATCH_MARK]) return;
  prototype[RATE_LIMIT_PATCH_MARK] = true;

  const originalRunStage = prototype.runStage;
  prototype.runStage = function rateLimitAwareRunStage<T>(
    this: ChatGptBrowserWorker,
    traceId: string,
    stage: string,
    timeoutMs: number,
    action: (abortSignal: AbortSignal) => Promise<T>,
    suspensionClock: SuspensionClockLike = chatGptSuspensionClock,
    awaitAbortedActionSettlement = false,
  ): Promise<T> {
    return originalRunStage.call(
      this,
      traceId,
      stage,
      timeoutMs,
      action,
      recoveryAwareSuspensionClock(suspensionClock),
      awaitAbortedActionSettlement,
    ) as Promise<T>;
  };

  const originalRunExclusive = prototype.runExclusive;
  prototype.runExclusive = async function rateLimitAwareRunExclusive(
    this: ChatGptBrowserWorker,
    turn: BrowserTurn,
  ): Promise<string> {
    const worker = this as unknown as WorkerInternals;
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (worker.config.browserHost !== "launcher") {
      return originalRunExclusive.call(this, turn);
    }

    const descriptorPath = worker.config.browserHostDescriptorPath!;
    const lease = await notifyLauncherTurn(descriptorPath, {
      phase: "start",
      traceId: turn.traceId,
      helperPid: process.pid,
      ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
      ...((turn.conversationKey
        && (turn.nativeConnector || turn.capabilities.localToolsEnabled || turn.requireRetainedConversation))
        ? { connectorIdentity: worker.config.appName }
        : {}),
      ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
    }).catch(error => {
      if (error instanceof LauncherBrowserTurnCancelledError) throw chatGptBrowserTabClosedError();
      if (error instanceof LauncherRetainedConversationUnavailableError) {
        throw chatGptRetainedConversationUnavailableError();
      }
      throw error;
    });
    const surfaceId = lease.surfaceId;
    const reused = lease.reused === true;
    let terminal: "completed" | "failed" | "aborted" = "completed";
    let terminalMessage: string | undefined;
    let originalError: unknown;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    let lastHeartbeatFailureAt = 0;
    let sendActivated = false;

    const trackedTurn: BrowserTurn = {
      ...turn,
      onSendActivated: async () => {
        sendActivated = true;
        await turn.onSendActivated?.();
      },
    };
    const sendHeartbeat = () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void notifyLauncherTurn(descriptorPath, {
        phase: "heartbeat",
        traceId: turn.traceId,
        helperPid: process.pid,
      }, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS).catch(error => {
        const now = Date.now();
        if (now - lastHeartbeatFailureAt < 30_000) return;
        lastHeartbeatFailureAt = now;
        console.warn(
          `[chatgpt-web] launcher turn heartbeat failed for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }).finally(() => {
        heartbeatInFlight = false;
      });
    };

    try {
      if (!surfaceId) throw new Error("Launcher did not lease a browser tab for the ChatGPT turn");
      if (turn.requireRetainedConversation && !reused) {
        throw chatGptRetainedConversationUnavailableError();
      }
      if (reused && !turn.prepareResume) {
        throw new Error("Launcher reused a ChatGPT conversation without a continuation prompt");
      }
      await turn.onPreparedSelected?.(reused);
      heartbeatTimer = setInterval(sendHeartbeat, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();

      // Connecting/instrumenting is passive. If a prior incident is still in hard cooldown, perform
      // only its one required refresh here; the first real UI action later acquires its own spacing.
      await ensureRateLimitRecoveryRefresh(descriptorPath, surfaceId, turn.abortSignal);
      await armLauncherRateLimitGuard(descriptorPath, surfaceId, turn.abortSignal);

      for (;;) {
        try {
          return await worker.runBrowserTurn(trackedTurn, surfaceId, undefined, reused);
        } catch (error) {
          if (!isChatGptRateLimitError(error)) throw error;

          const detectedAt = Date.now();
          const newIncident = chatGptRateLimitBackoffPolicy.recordRateLimit(detectedAt);
          const snapshot = chatGptRateLimitBackoffPolicy.snapshot(detectedAt);
          console.warn(
            `[chatgpt-web] ChatGPT rate limit detected for ${turn.traceId};`
            + ` incident=${newIncident ? "new" : "latched"}`
            + ` tier=${snapshot.tier + 1}`
            + ` cooldownMs=${Math.max(0, snapshot.cooldownUntil - detectedAt)}`
            + ` spacingMs=${snapshot.spacingMs}`,
          );

          // The hard cooldown owns the account: no ordinary UI action is permitted until this one
          // refresh settles. Later clicks/keys/fills acquire their own completion-based spacing.
          await ensureRateLimitRecoveryRefresh(descriptorPath, surfaceId, turn.abortSignal);

          // Once Send may have fired, replaying the prompt is unsafe. We still complete cooldown +
          // refresh, but fail this turn without consuming a phantom ordinary-action permit.
          if (sendActivated) throw error;
        }
      }
    } catch (error) {
      originalError = error;
      terminal = error instanceof ChatGptCompactionHandoffAccepted
        ? "completed"
        : (error instanceof DOMException && error.name === "AbortError")
        || (error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")
        ? "aborted"
        : "failed";
      terminalMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      throw error;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try {
        const release = await notifyLauncherTurn(descriptorPath, {
          phase: "end",
          traceId: turn.traceId,
          helperPid: process.pid,
          status: terminal,
          ...(terminalMessage ? { message: terminalMessage } : {}),
          ...(terminal === "completed" && turn.retainConversation ? { retain: true } : {}),
          ...(terminal === "completed" && (turn.nativeConnector || turn.capabilities.localToolsEnabled)
            ? { connectorBound: true }
            : {}),
        });
        if (release.cancelledByUser) throw chatGptBrowserTabClosedError();
      } catch (controlError) {
        if (controlError instanceof ChatGptWebAdapterError && controlError.code === "client_cancelled") {
          throw controlError;
        }
        if (!originalError) throw controlError;
        console.error(
          `[chatgpt-web] launcher turn-end notification failed after browser error: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
        );
      }
    }
  };
}

installChatGptRateLimitBackoffRuntime();
