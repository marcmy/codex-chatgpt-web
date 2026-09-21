import { ChatGptBrowserWorker } from "./browser-worker";
import {
  runChatGptMultipartAcknowledgementWithRecovery,
  type MultipartAcknowledgementWaiter,
} from "./multipart-error-recovery-core";

const MULTIPART_ERROR_RECOVERY_PATCH_MARK = Symbol.for(
  "codex-chatgpt-web.multipart-error-recovery-installed",
);

interface PatchableWorkerPrototype {
  waitForMultipartAcknowledgement(...args: unknown[]): Promise<void>;
  [MULTIPART_ERROR_RECOVERY_PATCH_MARK]?: boolean;
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

  const originalWaitForMultipartAcknowledgement =
    prototype.waitForMultipartAcknowledgement as MultipartAcknowledgementWaiter;
  if (typeof originalWaitForMultipartAcknowledgement !== "function") {
    throw new Error("ChatGPT browser worker no longer exposes waitForMultipartAcknowledgement");
  }
  prototype[MULTIPART_ERROR_RECOVERY_PATCH_MARK] = true;

  prototype.waitForMultipartAcknowledgement = async function retryableMultipartAcknowledgement(
    this: ChatGptBrowserWorker,
    ...args: unknown[]
  ): Promise<void> {
    return runChatGptMultipartAcknowledgementWithRecovery(
      originalWaitForMultipartAcknowledgement,
      this,
      args,
    );
  };
}

installChatGptMultipartErrorRecovery();
