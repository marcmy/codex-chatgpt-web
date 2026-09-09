import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { CodexParsedRequest, CodexTool } from "../src/types";

const root = resolve(process.cwd());
const environmentXml = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;

function currentWire(): CodexParsedRequest {
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

describe("trusted steering environment continuity", () => {
  test("same-turn steering reuses cached authority when replay carries only a historical environment", () => {
    const store = new ChatGptThreadEnvironmentStore();
    expect(store.resolve(currentWire()).cwd).toBe(root);

    const steering = currentWire();
    const steeringTools: CodexTool[] = [{
      name: "apply_patch",
      description: "Apply a patch",
      parameters: { type: "object" },
    }];
    steering.context.tools = steeringTools;
    steering._rawBody = {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_current",
          turn_id: "turn_current",
        }),
      },
      input: [
        {
          type: "message",
          id: "msg_historical_environment",
          role: "user",
          content: [{ type: "input_text", text: environmentXml }],
        },
        {
          type: "message",
          id: "msg_assistant_progress",
          role: "assistant",
          content: [{ type: "output_text", text: "Working on the requested change." }],
        },
        {
          type: "message",
          id: "msg_steering",
          role: "user",
          content: [{ type: "input_text", text: "Change direction before applying that patch." }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
        },
      ],
    };

    expect(store.resolve(steering)).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: steeringTools,
    });

    const invalidCurrentClaim = structuredClone(steering);
    ((invalidCurrentClaim._rawBody as { input: Array<Record<string, unknown>> }).input).push({
      type: "message",
      id: "msg_invalid_current_environment",
      role: "user",
      content: [{ type: "input_text", text: "<environment_context><cwd/></environment_context>" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
    });
    expect(() => store.resolve(invalidCurrentClaim)).toThrow();
  });
});
