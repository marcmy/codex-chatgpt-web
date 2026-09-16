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
  extraHighAvailable: false,
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

test("browser transport limits do not masquerade as model context exhaustion", () => {
  // Exact class of failure observed in the 7:46 PM diagnostic: one Bigger Context stage is too
  // large for every account-visible effort even though this is not a total transaction overflow.
  const staging = adapterError(() => resolveChatGptWebMultipartStagingMode(
    CHATGPT_WEB_MODEL_ID,
    plusCapabilities,
    81_808,
    300_000,
  ));
  expect(staging.code).toBe("chatgpt_browser_transport_limit");

  // An ordinary one-message composer boundary is likewise a browser transport failure, not a
  // statement that Codex's canonical model context has been exhausted.
  const inlineComposer = adapterError(() => assertChatGptWebInputWithinLimits(
    10_000,
    1_000,
    CHATGPT_WEB_MODEL_ID,
    "high",
    plusCapabilities,
    1_048_573,
  ));
  expect(inlineComposer.code).toBe("chatgpt_browser_transport_limit");
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
