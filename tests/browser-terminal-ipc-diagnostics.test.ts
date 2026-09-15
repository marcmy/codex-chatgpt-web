import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const helperMain = readFileSync(
  join(import.meta.dir, "../src/adapters/chatgpt-web/browser-helper-main.ts"),
  "utf8",
);
const helperClient = readFileSync(
  join(import.meta.dir, "../src/adapters/chatgpt-web/launcher-helper-client.ts"),
  "utf8",
);

test("terminal browser IPC exposes every fence and result boundary", () => {
  for (const marker of [
    "phase=completion_fence_begin_requested",
    "phase=completion_fence_begin_acknowledged",
    "phase=completion_fence_commit_requested",
    "phase=completion_fence_commit_acknowledged",
    "phase=helper_result_emit",
  ]) {
    expect(helperMain).toContain(marker);
  }

  for (const marker of [
    "phase=completion_fence_begin_received",
    "phase=completion_fence_begin_resolved",
    "phase=completion_fence_commit_received",
    "phase=completion_fence_commit_resolved",
    "phase=helper_result_received",
  ]) {
    expect(helperClient).toContain(marker);
  }
});

test("helper startup identifies the terminal diagnostics build and errors preserve nested causes", () => {
  expect(helperMain).toContain("terminal-ipc-diagnostics-v1");
  expect(helperClient).toContain("browser helper ready features=");
  expect(helperMain).toContain("diagnosticErrorChain");
  expect(helperMain).toContain("AggregateError");
});
