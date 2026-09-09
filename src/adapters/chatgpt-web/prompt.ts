import {
  chatGptWebImageTokenReserve,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import { estimateTokens } from "../../lib/token-estimate";
import type { CodexParsedRequest } from "../../types";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import {
  compileChatGptWebPrompt as compileChatGptWebPromptCore,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  type CompileChatGptWebPromptOptions,
  type CompiledChatGptWebPrompt,
} from "./prompt-core";

export * from "./prompt-core";

function multipartCompactionFitsAvailableMessages(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  compiled: CompiledChatGptWebPrompt,
): boolean {
  const multipart = compiled.multipart;
  if (!multipart) return true;

  const requestedMode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const stagingEffort = capabilities.proAvailable ? "max" as const : "medium" as const;
  const imageTokens = compiled.images.reduce(
    (sum, image) => sum + chatGptWebImageTokenReserve(image.detail),
    0,
  );
  const transactionId = `ctx_${"0".repeat(32)}`;

  return multipart.parts.every((payload, index) => {
    const final = index === multipart.parts.length - 1;
    const effort = final ? requestedMode.effort : stagingEffort;
    const text = final
      ? formatChatGptWebMultipartCommit(multipart, transactionId)
      : formatChatGptWebMultipartStage(payload, transactionId, index + 1, multipart.parts.length).text;
    const limits = resolveChatGptWebTransportLimits(parsed.modelId, effort, capabilities);
    const messageBudget = resolveChatGptWebMessageTokenBudget(
      parsed.modelId,
      effort,
      capabilities,
      final ? imageTokens : 0,
    );
    const messageTokens = estimateTokens(text, parsed.modelId);
    return messageTokens <= messageBudget
      && (limits.browserMessageTokenLimit === undefined || messageTokens <= limits.browserMessageTokenLimit)
      && (limits.browserComposerCharLimit === undefined || text.length <= limits.browserComposerCharLimit);
  });
}

/**
 * Compile a browser prompt and recover a fresh compaction rebuild before browser preflight when an
 * atomic Bigger Context stage cannot fit any account-visible message boundary. Fresh compaction is
 * allowed to discard oldest history; recompiling inline activates the core compiler's native-style
 * 110k compaction trimming instead of failing the entire Codex context handoff.
 */
export function compileChatGptWebPrompt(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  turnToken?: string,
  options?: CompileChatGptWebPromptOptions,
): CompiledChatGptWebPrompt {
  const compiled = compileChatGptWebPromptCore(parsed, capabilities, turnToken, options);
  if (!parsed._compactionRequest
    || !compiled.multipart
    || multipartCompactionFitsAvailableMessages(parsed, capabilities, compiled)) {
    return compiled;
  }

  const { experimentalMultipartParts: _multipart, ...singleMessageOptions } = options ?? {};
  return compileChatGptWebPromptCore(parsed, capabilities, turnToken, singleMessageOptions);
}
