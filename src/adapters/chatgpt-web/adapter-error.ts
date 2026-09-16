export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
}

export const CHATGPT_BROWSER_TRANSPORT_LIMIT_CODE = "chatgpt_browser_transport_limit";
export const CHATGPT_DEFERRED_RESULT_UNCONSUMED_CODE = "chatgpt_deferred_result_unconsumed";

const UNCONSUMED_DEFERRED_RESULT_FENCE_ERROR =
  /^turn completion found \d+ unconsumed deferred Codex tool result\(s\) with no active MCP consumer$/;

/**
 * Older browser preflight call sites used the canonical OpenAI context-length code for two very
 * different failures: exhausting the model/transaction context, and exceeding one ChatGPT browser
 * request envelope. Codex treats `context_length_exceeded` as model-context state and may compact
 * or replace its canonical history, so a browser-only envelope failure must never use that code.
 *
 * Keep this compatibility normalization at the structured adapter boundary so every existing
 * browser path gets the same semantics. The fragments below are deliberately narrow descriptions
 * emitted only by transport/message checks; genuine context-window and multipart-total ceilings do
 * not match them and therefore retain `context_length_exceeded`.
 */
function normalizeChatGptWebAdapterErrorCode(message: string, code: string): string {
  if (code !== "context_length_exceeded") return code;
  const browserTransportFailure = [
    "browser transport budget",
    "ChatGPT composer boundary",
    "ChatGPT browser message boundary",
    "ChatGPT message boundary",
    "input budget after reserving space for ChatGPT and attachments",
    "No ChatGPT effort available to this account can carry a Bigger Context stage",
  ].some(fragment => message.includes(fragment));
  return browserTransportFailure ? CHATGPT_BROWSER_TRANSPORT_LIMIT_CODE : code;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = normalizeChatGptWebAdapterErrorCode(message, options.code);
    this.retryable = options.retryable;
  }
}

export function classifyChatGptCompletionFenceError(error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (!UNCONSUMED_DEFERRED_RESULT_FENCE_ERROR.test(normalized.message)) return normalized;
  return new ChatGptWebAdapterError(
    "ChatGPT finished before collecting a completed deferred Codex tool result.",
    {
      status: 502,
      errorType: "server_error",
      code: CHATGPT_DEFERRED_RESULT_UNCONSUMED_CODE,
      retryable: true,
      cause: normalized,
    },
  );
}

export function isChatGptDeferredResultUnconsumedError(
  error: unknown,
): error is ChatGptWebAdapterError {
  return error instanceof ChatGptWebAdapterError
    && error.code === CHATGPT_DEFERRED_RESULT_UNCONSUMED_CODE;
}

// Only the compaction owner may signal this after the broker accepts its one-shot handoff.
// It cancels browser observation, while the accepted summary remains the native result.
export class ChatGptCompactionHandoffAccepted extends DOMException {
  constructor() {
    super("Structured compaction handoff accepted", "AbortError");
  }
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

export function chatGptTurnSupersededError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "A newer Codex instruction superseded this ChatGPT response.",
    {
      // This is a deterministic stale-execution result, not a transport disconnect. Codex treats
      // client-cancelled streams as reconnect candidates, which can otherwise replay the obsolete
      // round repeatedly after native steering has already installed the newer instruction.
      status: 400,
      errorType: "invalid_request_error",
      code: "invalid_request_error",
      retryable: false,
    },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT displayed 'Stopped thinking' and could not continue this response. "
    + "A ChatGPT Web usage limit may have been reached. Check the ChatGPT tab for the exact reason before retrying.",
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_stopped_thinking",
      retryable: false,
    },
  );
}

export function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer available.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_source_unavailable",
      retryable: false,
    },
  );
}

export function chatGptRetainedCompactionHandoffNotStartedError(cause: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT compaction handoff failed before Send was activated.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_retained_handoff_not_started",
      retryable: false,
      cause,
    },
  );
}
