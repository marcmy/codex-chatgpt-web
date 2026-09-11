import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { defaultBrokerEndpoint } from "../src/config";
import {
  callTurnBroker,
  TurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";

function shortSocketTempRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

test("post-compaction intercepted MCP invokes remain consumable without retiring the binding", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-post-compact-consume-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec_command",
        description: "Run one command",
        parameters: { type: "object" },
      }],
    }, 10_000, "trace_post_compact_consume");
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const compactionResult: BrokerToolResult = {
      content: [{ type: "text", text: "Stop ordinary tool work for retained compaction." }],
      isError: true,
    };
    expect(broker.requestCompaction(token, compactionResult)).toBe(0);

    const callId = "call_post_compaction_consumable_123456";
    await expect(callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      callId,
      wireName: "exec_command",
      arguments: { cmd: "must-not-run" },
    })).resolves.toEqual(compactionResult);

    await expect(callTurnBroker(broker.socketPath, {
      method: "consume_invocation",
      bindingId: claimed.bindingId,
      callId,
    })).resolves.toEqual({ consumed: true, duplicate: false });
    await expect(callTurnBroker(broker.socketPath, {
      method: "consume_invocation",
      bindingId: claimed.bindingId,
      callId,
    })).resolves.toEqual({ consumed: true, duplicate: true });

    await expect(callTurnBroker<{ environment: { cwd: string } }>(broker.socketPath, {
      method: "resolve",
      bindingId: claimed.bindingId,
    })).resolves.toMatchObject({ environment: { cwd: root } });
    expect(broker.compactionDeliveryCount(token)).toBe(1);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
