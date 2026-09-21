import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { CodexParsedRequest, CodexTool } from "../src/types";

const root = resolve(process.cwd());
const environmentXml = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;

function initialRequest(): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: { messages: [{ role: "user", content: "Inspect the workspace", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_current",
          turn_id: "turn_current",
          sandbox: "none",
          workspaces: { [root]: { has_changes: true } },
        }),
      },
      input: [
        {
          type: "message",
          id: "msg_context",
          role: "user",
          content: [
            { type: "input_text", text: "<app-context>native app context</app-context>" },
            { type: "input_text", text: environmentXml },
          ],
        },
        {
          type: "message",
          id: "msg_active",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the workspace" }],
        },
      ],
    },
  };
}

function replayRequest(environmentText = environmentXml): CodexParsedRequest {
  const request = initialRequest();
  const tools: CodexTool[] = [{ name: "replay_tool", description: "replay", parameters: { type: "object" } }];
  request.context.tools = tools;
  const body = request._rawBody as { input: Array<Record<string, unknown>> };
  body.input[0] = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: environmentText }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
  };
  body.input.push({
    type: "function_call",
    id: "call_replayed_tool",
    call_id: "call_replayed_tool",
    name: "exec_command",
    arguments: "{}",
  });
  return request;
}

test("same-turn post-tool continuation accepts an exact native environment replay without an item id", () => {
  const store = new ChatGptThreadEnvironmentStore();
  store.resolve(initialRequest());

  const replay = replayRequest();
  expect(store.resolve(replay)).toEqual({
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: replay.context.tools,
  });
});

test("same-turn post-tool continuation still rejects a changed id-less environment replay", () => {
  const store = new ChatGptThreadEnvironmentStore();
  store.resolve(initialRequest());

  const changed = environmentXml.replace(`<cwd>${root}</cwd>`, `<cwd>${resolve(root, "other")}</cwd>`);
  expect(() => store.resolve(replayRequest(changed))).toThrow();
});
