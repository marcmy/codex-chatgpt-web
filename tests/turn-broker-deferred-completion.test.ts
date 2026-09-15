import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

test("terminal fence keeps waiting while a deferred Codex result is still unresolved", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-unresolved-deferred-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const callId = "call_unresolved_deferred_1234567890";
  let token: string | undefined;
  try {
    token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
    const claimed = await callTurnBroker<{ bindingId: string; activityId: string }>(socketPath, {
      method: "claim",
      token,
    });
    const timedOut = expect(callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId,
      wireName: "exec_command",
      arguments: { cmd: "still awaiting user approval" },
    }, 50)).rejects.toThrow("timed out");
    const [request] = await broker.nextToolBatch(token);
    expect(request).toMatchObject({ callId, wireName: "exec_command" });
    await timedOut;
    await callTurnBroker(socketPath, {
      method: "activity_complete",
      token,
      activityId: claimed.activityId,
    });

    expect(broker.beginCompletionFence(token!)).toBeUndefined();
  } finally {
    if (token) broker.revoke(token);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal fence fails closed instead of polling forever behind an abandoned deferred result", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-abandoned-deferred-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const callId = "call_abandoned_deferred_1234567890";
  let token: string | undefined;
  try {
    token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
    const claimed = await callTurnBroker<{ bindingId: string; activityId: string }>(socketPath, {
      method: "claim",
      token,
    });
    const timedOut = expect(callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId,
      wireName: "exec_command",
      arguments: { cmd: "finishes after the transport timeout" },
    }, 50)).rejects.toThrow("timed out");
    const [request] = await broker.nextToolBatch(token);
    expect(request).toMatchObject({ callId, wireName: "exec_command" });
    await timedOut;

    broker.completeTool(token, callId, {
      content: [{ type: "text", text: "late but valid result" }],
    });
    await callTurnBroker(socketPath, {
      method: "activity_complete",
      token,
      activityId: claimed.activityId,
    });

    expect(() => broker.beginCompletionFence(token!))
      .toThrow("unconsumed deferred Codex tool result");

    const result = await callTurnBroker<{ content: Array<{ text: string }> }>(socketPath, {
      method: "collect_invocation",
      bindingId: claimed.bindingId,
      callId,
    });
    expect(result.content[0]?.text).toBe("late but valid result");
    await callTurnBroker(socketPath, {
      method: "consume_invocation",
      bindingId: claimed.bindingId,
      callId,
    });
    expect(broker.beginCompletionFence(token!)).toBeNumber();
  } finally {
    if (token) broker.revoke(token);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
