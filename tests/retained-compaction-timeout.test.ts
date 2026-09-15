import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import {
  chatGptWebExecutionNamespace,
  createChatGptWebAdapter,
} from "../src/adapters/chatgpt-web/index";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  chatGptTurnExecutionKey,
  chatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function shortSocketTempRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

function request(compaction = false): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "user", content: "Original task", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Work completed" }], timestamp: 2 },
        { role: "user", content: "Continue with the next step", timestamp: 3 },
      ],
    },
    options: { reasoning: "high" },
    _compactionRequest: compaction,
    _rawBody: {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue with the next step" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
      }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_retained_timeout",
          turn_id: compaction ? "turn_compact" : "turn_source",
        }),
      },
    },
  };
}

test("timed-out retained compaction reports before the old browser physically retires", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-retained-timeout-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://retained-timeout-${Date.now()}-${Math.random()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      turnTimeoutMs: 200,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  const conversationKey = chatGptConversationKey(sourceRequest, namespace)!;
  let releasePhysical!: () => void;
  const sourcePhysicalSettlement = new Promise<void>(resolve => { releasePhysical = resolve; });

  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: sourcePhysicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey,
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  let handoffStarted!: () => void;
  const handoffReady = new Promise<void>(resolve => { handoffStarted = resolve; });
  let browserStarts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = turn => {
    browserStarts += 1;
    handoffStarted();
    expect(turn.requireRetainedConversation).toBeTrue();
    return new Promise<string>(resolve => {
      const settle = () => resolve("handoff helper acknowledged cancellation");
      if (turn.abortSignal?.aborted) settle();
      else turn.abortSignal?.addEventListener("abort", settle, { once: true });
    });
  };

  const compact = request(true);
  const events: AdapterEvent[] = [];
  let run: Promise<void> | undefined;
  try {
    run = createChatGptWebAdapter(provider).runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    await Promise.race([
      handoffReady,
      Bun.sleep(2_000).then(() => { throw new Error("retained compaction handoff did not start"); }),
    ]);
    await Bun.sleep(300);

    expect(browserStarts).toBe(1);
    expect(events.filter(event => event.type === "error")).toHaveLength(1);
    expect(events.some(event => event.type === "done")).toBeFalse();
  } finally {
    releasePhysical();
    if (run) await Promise.allSettled([run]);
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});
