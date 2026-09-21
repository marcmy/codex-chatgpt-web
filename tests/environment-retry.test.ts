import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const sockets: string[] = [];
afterAll(async () => {
  for (const socket of sockets) await TurnBroker.forSocket(socket).close();
});

function invalidEnvironmentRequest(): CodexParsedRequest {
  const root = process.cwd();
  const turnId = "turn_invalid_environment";
  const threadId = "thread_invalid_environment";
  const environment = `<environment_context>
  <cwd>${root}</cwd>
  <cwd>${join(root, "conflicting")}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      tools: [],
      messages: [{ role: "user", content: "Inspect the project", timestamp: 1 }],
    },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: [
        {
          type: "message",
          role: "user",
          id: "msg_environment",
          content: [{ type: "input_text", text: environment }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
        {
          type: "message",
          role: "user",
          id: "msg_instruction",
          content: [{ type: "input_text", text: "Inspect the project" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    },
  };
}

test("trusted environment validation failures are non-retryable and never start the browser", async () => {
  const socket = defaultBrokerEndpoint(
    join(tmpdir(), `cgw-invalid-environment-${process.pid}-${Date.now()}`),
    process.platform,
  );
  sockets.push(socket);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://invalid-environment-${Date.now()}`,
    chatgptWeb: {
      brokerSocketPath: socket,
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserStarts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async () => {
    browserStarts += 1;
    throw new Error("invalid environment unexpectedly reached the browser");
  };
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(provider).runTurn!(
        invalidEnvironmentRequest(),
        { headers: new Headers() },
        event => events.push(event),
      );
      expect(events.at(-1)).toMatchObject({
        type: "error",
        status: 400,
        errorType: "invalid_request_error",
        code: "codex_rollout_environment_invalid",
        retryable: false,
      });
      expect((events.at(-1) as Extract<AdapterEvent, { type: "error" }>).message)
        .toContain("conflicting trusted Codex cwd values");
    }
    expect(browserStarts).toBe(0);
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
  }
});
