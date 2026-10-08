import type { Page, Route } from "playwright-core";

const SUBMISSION_URL = "https://chatgpt.com/backend-api/f/conversation";

/** Preserve the composer-verified transport, rather than its Markdown serialization. */
export function canonicalChatGptSubmission(body: string, prompt: string): string | undefined {
  let request;
  try { request = JSON.parse(body); } catch {
    throw new Error("ChatGPT submission body was not valid JSON");
  }
  if (!Array.isArray(request.messages) || request.messages.length !== 1) {
    throw new Error("ChatGPT submission did not contain exactly one new message");
  }
  const message = request.messages[0];
  if (message.author?.role !== "user" || !Array.isArray(message.content?.parts)
    || message.content.parts.filter((part: unknown) => typeof part === "string").length !== 1) {
    throw new Error("ChatGPT submission did not contain one user text part");
  }
  const index = message.content.parts.findIndex((part: unknown) => typeof part === "string");
  const submitted = message.content.parts[index] as string;
  const prefix = submitted.match(/^\[\$[^\]\r\n]+\]\(app:\/\/[^)\s]+\)[ \t]*/)?.[0] ?? "";
  const canonical = prefix + prompt;
  if (submitted === canonical) return undefined;
  if (message.metadata?.serialization_metadata?.render_format !== "markdown") {
    throw new Error("ChatGPT changed the prompt outside its Markdown serializer");
  }
  // Bind the rewrite to the current transaction/capability, not another user submission.
  const anchor = prompt.match(/transaction_id: (ctx_[A-Za-z0-9_]+)/)?.[1]
    ?? prompt.match(/Pass turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
  const checkpointInstruction = "Produce the requested checkpoint summary now without calling tools.";
  const tokenFreeCheckpoint = !anchor
    && prompt.startsWith("Act as the model backend for the Codex task encoded below.")
    && prompt.includes(checkpointInstruction) && submitted.includes(checkpointInstruction)
    && submitted.includes("<codex_context_json>");
  if (!(anchor ? submitted.includes(anchor) : tokenFreeCheckpoint)) {
    throw new Error("ChatGPT serialized submission could not be bound to the current prompt");
  }
  message.content.parts[index] = canonical;
  return JSON.stringify(request);
}

/** Scoped to one Send on the owned page. Never issue an independent API request. */
export async function guardChatGptSubmissionText(page: Page, prompt: string, onFailure: () => void): Promise<{
  dispose(): Promise<void>;
  failure(): Error | undefined;
}> {
  let failure: Error | undefined;
  let handled = false;
  const handler = async (route: Route): Promise<void> => {
    try {
      const request = route.request();
      if (request.method() !== "POST" || request.frame() !== page.mainFrame()) {
        await route.fallback();
        return;
      }
      if (handled) throw new Error("ChatGPT issued a second submission for the same Send");
      handled = true;
      const body = request.postData();
      if (!body) throw new Error("ChatGPT submission had no readable message body");
      const restored = canonicalChatGptSubmission(body, prompt);
      await route.continue(restored ? { postData: restored } : undefined);
    } catch (error) {
      failure = error instanceof Error ? error : new Error("ChatGPT submission text validation failed");
      onFailure();
      await route.abort("failed");
    }
  };
  await page.route(SUBMISSION_URL, handler);
  return { failure: () => failure, dispose: () => page.unroute(SUBMISSION_URL, handler) };
}
