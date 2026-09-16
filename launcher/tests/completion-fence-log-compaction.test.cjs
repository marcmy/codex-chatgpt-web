const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CompletionFenceDiagnosticGate,
  compactCompletionFenceDiagnosticRecord,
} = require("../electron/completion-fence-diagnostics.cjs");

function stdout(line) {
  return { event: "runtime.daemon_stdout", detail: { line } };
}

test("blocked completion-fence stdout collapses until the fence becomes available", () => {
  const gate = new CompletionFenceDiagnosticGate();
  const turn = "d097d024ff9b";
  const requested = `[chatgpt-web-helper] [chatgpt-web] browser turn ${turn} phase=completion_fence_begin_requested requestId=13`;
  const received = `[chatgpt-web] browser turn ${turn} phase=completion_fence_begin_received requestId=13`;
  const resolved = `[chatgpt-web] browser turn ${turn} phase=completion_fence_begin_resolved requestId=13 revision=none`;
  const acknowledged = `[chatgpt-web-helper] [chatgpt-web] browser turn ${turn} phase=completion_fence_begin_acknowledged requestId=13 revision=none`;

  for (const line of [requested, received, resolved, acknowledged]) {
    assert.deepEqual(compactCompletionFenceDiagnosticRecord(stdout(line), gate), stdout(line));
  }

  for (const line of [
    requested.replaceAll("13", "14"),
    received.replaceAll("13", "14"),
    resolved.replaceAll("13", "14"),
    acknowledged.replaceAll("13", "14"),
  ]) {
    assert.equal(compactCompletionFenceDiagnosticRecord(stdout(line), gate), undefined);
  }

  const recovered = `[chatgpt-web] browser turn ${turn} phase=completion_fence_begin_resolved requestId=15 revision=42`;
  assert.deepEqual(compactCompletionFenceDiagnosticRecord(stdout(recovered), gate), stdout(`${recovered} suppressedRetries=1`));

  const unrelated = stdout(`[chatgpt-web] browser turn ${turn} stage=send completed durationMs=100`);
  assert.deepEqual(compactCompletionFenceDiagnosticRecord(unrelated, gate), unrelated);
});

test("non-daemon records and reused trace ids are not accidentally suppressed", () => {
  const gate = new CompletionFenceDiagnosticGate();
  const turn = "repeatable_trace";
  const blocked = stdout(`[chatgpt-web] browser turn ${turn} phase=completion_fence_begin_resolved requestId=1 revision=none`);
  assert.deepEqual(compactCompletionFenceDiagnosticRecord(blocked, gate), blocked);

  const unrelatedEvent = { event: "launcher.ready", detail: { line: blocked.detail.line } };
  assert.deepEqual(compactCompletionFenceDiagnosticRecord(unrelatedEvent, gate), unrelatedEvent);

  gate.reset(turn);
  assert.deepEqual(compactCompletionFenceDiagnosticRecord(blocked, gate), blocked);
});
