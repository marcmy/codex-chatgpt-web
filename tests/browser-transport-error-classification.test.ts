import { expect, test } from "bun:test";
import {
  assertChatGptWebInputWithinLimits,
  resolveChatGptWebMultipartStagingMode,
} from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

const plusCapabilities = {
  localToolsEnabled: false,
  solAvailable: true,
  proAvailable: false,
};

function adapterError(action: () => void): ChatGptWebAdapterError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ChatGptWebAdapterError);
    return error as ChatGptWebAdapterError;
  }
  throw new Error("expected ChatGPT Web preflight to reject the input");
}

test("browser message transport limits do not masquerade as model context exhaustion", () => {
  const staging = adapterError(() => resolveChatGptWebMultipartStagingMode(
    CHATGPT_WEB_MODEL_ID,
    plusCapabilities,
    81_808,
    300_000,
  ));
  expect(staging.code).toBe("chatgpt_browser_transport_limit");

  const inlineMessage = adapterError(() => assertChatGptWebInputWithinLimits(
    81_808,
    81_808,
    CHATGPT_WEB_MODEL_ID,
    "high",
    plusCapabilities,
  ));
  expect(inlineMessage.code).toBe("chatgpt_browser_transport_limit");
});

test("genuine total model context overflow keeps the canonical context error", () => {
  const context = adapterError(() => assertChatGptWebInputWithinLimits(
    90_000,
    1_000,
    CHATGPT_WEB_MODEL_ID,
    "high",
    plusCapabilities,
  ));
  expect(context.code).toBe("context_length_exceeded");
});
