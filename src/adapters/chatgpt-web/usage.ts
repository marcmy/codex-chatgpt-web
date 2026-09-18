import { skillFileTokens } from "./skill-attachments";
import { estimateTokens } from "../../lib/token-estimate";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  isChatGptWebZeroRiskBackendModel,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import type { CodexParsedRequest, CodexUsage } from "../../types";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import {
  CHATGPT_BIGGER_CONTEXT_MAX_TRANSPORT_PARTS,
  CHATGPT_BIGGER_CONTEXT_PARTS,
  compileChatGptWebPrompt,
  type ChatGptWebMultipartPartCount,
  type CompiledChatGptWebPrompt,
  type CompileChatGptWebPromptOptions,
} from "./prompt";
import { extractChatGptTurnIdentity } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import type { BrokerToolRequest } from "./turn-broker";

// The real capability has the same length. Keeping it out of usage accounting would make
// estimates differ slightly between the prepared browser prompt and later Codex tool rounds.
const ESTIMATE_TURN_TOKEN = "turn_00000000000000000000000000000000";

export interface ChatGptWebRoundEvidence {
  answer?: string;
  reasoning?: string[];
  toolRequests?: BrokerToolRequest[];
}

function conservativeTextTokens(text: string, modelId: string): number {
  return estimateTokens(text, modelId);
}

export function estimateChatGptWebInputTokens(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: CompileChatGptWebPromptOptions = {},
): number {
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  const mode = manual
    ? { localTools: true }
    : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const identity = extractChatGptTurnIdentity(parsed);
  const compiled = compileChatGptWebPrompt(
    parsed,
    capabilities,
    mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    {
      ...options,
      ...(manual ? { manualControl: true as const } : {}),
      captureLunaCheckpoint: parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
        && !parsed._compactionRequest
        && Boolean(identity.threadId && identity.turnId),
    },
  );
  return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
}

/**
 * The compaction threshold chooses the logical context width. Browser-message boundaries can
 * require one additional physical spill part even when the task remains inside the same three-window
 * Bigger Context ceiling. Plan that transport before submission; the fourth part never expands the
 * model context advertised to Codex.
 */
export function resolveBiggerContextMultipartParts(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalSkillAttachments = false,
): ChatGptWebMultipartPartCount | undefined {
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
    throw new Error("Bigger Context is unavailable for ChatGPT Zero Risk");
  }
  if (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error("Bigger Context is unavailable for Luna because its accumulated browser transcript still shares one 28,000-token transport budget");
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const { contextWindow, autoCompactTokenLimit } = resolveChatGptWebContextLimits(
    CHATGPT_WEB_BACKEND_MODEL,
    mode.effort,
    { ...capabilities, experimentalBiggerContext: false },
  );
  const compaction = parsed._compactionRequest === true;
  const compile = (parts?: ChatGptWebMultipartPartCount): CompiledChatGptWebPrompt => compileChatGptWebPrompt(
    parsed, capabilities, mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    {
      experimentalMultipartParts: parts,
      experimentalSkillAttachments,
      ...(parts !== undefined ? { multipartPlanningOnly: true } : {}),
    },
  );
  const inline = compaction ? undefined : compile();
  const initialParts = compaction
    ? CHATGPT_BIGGER_CONTEXT_PARTS
    : biggerContextPartCount(
      estimateCompiledChatGptWebInputTokens(inline!, parsed.modelId),
      autoCompactTokenLimit,
      false,
    );

  const fits = (compiled: CompiledChatGptWebPrompt): boolean => {
    const messages = compiledChatGptWebMessages(compiled);
    // Inert stages may use any explicitly available staging effort; execution keeps the chosen
    // effort. These are the widest stage modes used by the browser's existing selector.
    const stagingEffort = capabilities.proAvailable ? "max" : "medium";
    for (const [index, text] of messages.entries()) {
      const final = index === messages.length - 1;
      const effort = final ? mode.effort : stagingEffort;
      const { browserComposerCharLimit } = resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities);
      if (browserComposerCharLimit !== undefined && text.length > browserComposerCharLimit) return false;
      const budget = resolveChatGptWebMessageTokenBudget(
        CHATGPT_WEB_BACKEND_MODEL, effort, capabilities, final ? estimateChatGptWebImageTokens(compiled) + skillFileTokens(compiled.skillFiles, parsed.modelId) : 0,
      );
      if (estimateTokens(text, parsed.modelId) > budget) return false;
    }
    // A fourth physical part is transport spill only. Never let it raise the logical three-window
    // Bigger Context ceiling that the model catalog advertises to Codex.
    const logicalParts = Math.min(messages.length, CHATGPT_BIGGER_CONTEXT_PARTS);
    return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId) < contextWindow * logicalParts;
  };

  if (initialParts === undefined && inline && fits(inline)) return undefined;
  const minimumParts = initialParts ?? 2;
  for (const parts of [2, CHATGPT_BIGGER_CONTEXT_PARTS, CHATGPT_BIGGER_CONTEXT_MAX_TRANSPORT_PARTS] as const) {
    if (parts < minimumParts) continue;
    const candidate = compile(parts);
    // Compaction compilation may deliberately fall back inline when the requested multipart shape
    // cannot fit. Treat that as a failed candidate here so the planner can try the spill part first.
    if (candidate.multipart?.parts.length !== parts) continue;
    if (fits(candidate)) return parts;
  }
  // Keep the maximum transport shape so the normal compiler/browser diagnostics can report the
  // actual irreducible limit (or compaction can activate its existing inline-trimming fallback).
  return CHATGPT_BIGGER_CONTEXT_MAX_TRANSPORT_PARTS;
}

export function biggerContextPartCount(
  inputTokens: number,
  onePartLimit: number,
  compaction: boolean,
): ChatGptWebMultipartPartCount | undefined {
  if (compaction) return CHATGPT_BIGGER_CONTEXT_PARTS;
  if (inputTokens < onePartLimit) return undefined;
  if (inputTokens < onePartLimit * 2) return 2;
  return CHATGPT_BIGGER_CONTEXT_PARTS;
}

function roundEvidenceText(evidence: ChatGptWebRoundEvidence): string {
  return JSON.stringify({
    reasoning: evidence.reasoning ?? [],
    ...(evidence.answer !== undefined ? { answer: evidence.answer } : {}),
    ...(evidence.toolRequests ? {
      tool_calls: evidence.toolRequests.map(request => ({
        call_id: request.callId,
        name: request.wireName,
        ...(request.freeform
          ? { input: request.input ?? "" }
          : { arguments: request.arguments ?? {} }),
      })),
    } : {}),
  });
}

export function estimateChatGptWebUsage(
  parsed: CodexParsedRequest,
  evidence: ChatGptWebRoundEvidence,
  capabilities: ChatGptWebCapabilities,
  experimentalBiggerContext = false,
  experimentalSkillAttachments = false,
): CodexUsage {
  const inputTokens = estimateChatGptWebInputTokens(parsed, capabilities, {
    experimentalSkillAttachments,
    experimentalMultipartParts: experimentalBiggerContext
      ? resolveBiggerContextMultipartParts(parsed, capabilities, experimentalSkillAttachments)
      : undefined,
  });
  const outputTokens = conservativeTextTokens(roundEvidenceText(evidence), parsed.modelId);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
