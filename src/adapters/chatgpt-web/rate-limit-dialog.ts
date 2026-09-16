import type { Locator, Page } from "playwright-core";
import { ChatGptWebAdapterError } from "./adapter-error";

export const chatGptRateLimitDialog = (page: Page): Locator => page.locator('[role="dialog"]')
  .filter({ hasText: /Too many requests|太多要求|太多请求|リクエストが多すぎます/i })
  .filter({ hasText: /making requests too quickly|過於頻繁|过于频繁|リクエストの頻度が高すぎます/i })
  .last();

export function isChatGptRateLimitError(error: unknown): error is ChatGptWebAdapterError {
  return error instanceof ChatGptWebAdapterError
    && error.status === 429
    && error.errorType === "rate_limit_error"
    && error.code === "rate_limit_exceeded";
}

/** Detect the known site throttle without clicking its acknowledgement button. */
export async function throwIfChatGptRateLimitDialogPassive(page: Page): Promise<void> {
  if (!await chatGptRateLimitDialog(page).isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT rate limit: too many requests. Try again in a few minutes.",
    { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
  );
}
