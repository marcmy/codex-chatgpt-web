import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { throwIfChatGptRateLimitDialogPassive } from "../src/adapters/chatgpt-web/rate-limit-dialog";

function rateLimitDialogPage(): { page: Page; presses: string[] } {
  const presses: string[] = [];
  let matches = true;
  let buttonMatches = true;
  const button = {
    last: () => button,
    isVisible: async () => matches && buttonMatches,
    press: async (key: string) => { presses.push(key); },
  };
  const dialog = {
    filter: ({ hasText }: { hasText: string | RegExp }) => {
      const text = "Too many requests. You're making requests too quickly. We've temporarily limited access to your conversations to protect your data. Please wait a few minutes before trying again.";
      matches &&= typeof hasText === "string" ? text.includes(hasText) : hasText.test(text);
      return dialog;
    },
    last: () => dialog,
    isVisible: async () => matches,
    getByRole: (_role: string, options?: { name?: string | RegExp }) => {
      const name = options?.name;
      buttonMatches = name === undefined
        || (typeof name === "string" ? name === "Got it" : name.test("Got it"));
      return button;
    },
  };
  return { page: { locator: () => dialog } as unknown as Page, presses };
}

test("rate-limit detection never acknowledges the dialog", async () => {
  const fixture = rateLimitDialogPage();

  await expect(throwIfChatGptRateLimitDialogPassive(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
  expect(fixture.presses).toEqual([]);
});
