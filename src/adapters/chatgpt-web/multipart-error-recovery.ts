import type { Locator } from "playwright-core";
import { ChatGptWebAdapterError } from "./adapter-error";
import { ChatGptBrowserWorker } from "./browser-worker";

const MULTIPART_ERROR_RECOVERY_PATCH_MARK = Symbol.for(
  "codex-chatgpt-web.multipart-error-recovery-installed",
);
const MAX_MULTIPART_RESPONSE_RETRIES = 3;
const MULTIPART_RETRY_CONTROL_GRACE_MS = 2_000;
const MULTIPART_RETRY_SETTLE_MS = 250;

interface MultipartResponseTurnLike {
  locator: Locator;
}

interface PatchableWorkerPrototype {
  waitForMultipartAcknowledgement(...args: unknown[]): Promise<void>;
  [MULTIPART_ERROR_RECOVERY_PATCH_MARK]?: boolean;
}

function isRetryableUpstreamResponseError(error: unknown): error is ChatGptWebAdapterError {
  return error instanceof ChatGptWebAdapterError
    && error.status === 502
    && error.errorType === "server_error"
    && error.code === "upstream_server_error"
    && error.retryable;
}

function responseTurnArgument(args: readonly unknown[]): MultipartResponseTurnLike | undefined {
  const candidate = args[1] as Partial<MultipartResponseTurnLike> | undefined;
  return candidate?.locator && typeof candidate.locator.getByTestId === "function"
    ? candidate as MultipartResponseTurnLike
    : undefined;
}

function abortSignalArgument(args: readonly unknown[]): AbortSignal | undefined {
  const signal = args[5];
  return signal instanceof AbortSignal ? signal : undefined;
}

async function waitForRetryControl(responseTurn: MultipartResponseTurnLike): Promise<Locator | undefined> {
  const retry = responseTurn.locator.getByTestId("regenerate-thread-error-button").last();
  if (await retry.isVisible().catch(() => false)) return retry;
  await retry.waitFor({ state: "visible", timeout: MULTIPART_RETRY_CONTROL_GRACE_MS }).catch(() => {});
  return await retry.isVisible().catch(() => false) ? retry : undefined;
}

async function retryAcceptedMultipartResponseInPlace(
  responseTurn: MultipartResponseTurnLike,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw new DOMException("ChatGPT multipart stage aborted", "AbortError");
  const retry = await waitForRetryControl(responseTurn);
  if (!retry) return false;
  await retry.press("Enter", {
    noWaitAfter: true,
    timeout: 10_000,
    ...(signal ? { signal } : {}),
  });
  await new Promise(resolve => setTimeout(resolve, MULTIPART_RETRY_SETTLE_MS));
  return true;
}

function exhaustedMultipartResponseError(error: ChatGptWebAdapterError): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT could not produce the Bigger Context acknowledgement after retrying the already-accepted stage in place. The staged context was not replayed in a new tab.",
    {
      status: 502,
      errorType: "server_error",
      code: "multipart_acknowledgement_upstream_error",
      retryable: false,
      cause: error,
    },
  );
}

/**
 * Bigger Context stage prompts are already accepted before acknowledgement observation begins.
 * Replaying the whole browser turn after ChatGPT's current assistant response hits its transient
 * error UI duplicates every preceding multipart stage and destroys the surface that owns the
 * accepted transaction. Retry only that assistant response on the same surface instead.
 */
export function installChatGptMultipartErrorRecovery(): void {
  const prototype = ChatGptBrowserWorker.prototype as unknown as PatchableWorkerPrototype;
  if (prototype[MULTIPART_ERROR_RECOVERY_PATCH_MARK]) return;

  const originalWaitForMultipartAcknowledgement = prototype.waitForMultipartAcknowledgement;
  if (typeof originalWaitForMultipartAcknowledgement !== "function") {
    throw new Error("ChatGPT browser worker no longer exposes waitForMultipartAcknowledgement");
  }
  prototype[MULTIPART_ERROR_RECOVERY_PATCH_MARK] = true;

  prototype.waitForMultipartAcknowledgement = async function retryableMultipartAcknowledgement(
    this: ChatGptBrowserWorker,
    ...args: unknown[]
  ): Promise<void> {
    const responseTurn = responseTurnArgument(args);
    const signal = abortSignalArgument(args);
    let retries = 0;

    for (;;) {
      try {
        return await originalWaitForMultipartAcknowledgement.apply(this, args);
      } catch (error) {
        if (!isRetryableUpstreamResponseError(error) || !responseTurn) throw error;

        if (retries < MAX_MULTIPART_RESPONSE_RETRIES
          && await retryAcceptedMultipartResponseInPlace(responseTurn, signal)) {
          retries += 1;
          // The original method's default completion tracker must start clean after regeneration.
          args[7] = undefined;
          console.warn(
            `[chatgpt-web] accepted Bigger Context stage hit ChatGPT response error; retrying assistant acknowledgement in-place attempt=${retries}/${MAX_MULTIPART_RESPONSE_RETRIES}`,
          );
          continue;
        }

        throw exhaustedMultipartResponseError(error);
      }
    }
  };
}

installChatGptMultipartErrorRecovery();
