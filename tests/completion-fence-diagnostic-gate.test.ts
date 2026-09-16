import { expect, test } from "bun:test";
import {
  CompletionFenceDiagnosticGate,
  compactHelperCompletionFenceDiagnostic,
} from "../src/adapters/chatgpt-web/completion-fence-diagnostics";

test("repeated blocked completion-fence attempts collapse until the fence becomes available", () => {
  const gate = new CompletionFenceDiagnosticGate();
  const turn = "trace_stop_steer";

  expect(gate.beginAttempt(turn)).toBe(true);
  expect(gate.resolveAttempt(turn, false)).toEqual({ log: true, suppressedRetries: 0 });

  expect(gate.beginAttempt(turn)).toBe(false);
  expect(gate.resolveAttempt(turn, false)).toEqual({ log: false, suppressedRetries: 1 });
  expect(gate.beginAttempt(turn)).toBe(false);
  expect(gate.resolveAttempt(turn, false)).toEqual({ log: false, suppressedRetries: 2 });

  expect(gate.resolveAttempt(turn, true)).toEqual({ log: true, suppressedRetries: 2 });
  expect(gate.beginAttempt(turn)).toBe(true);
});

test("helper stderr keeps the first blocked fence and the later recovery, not every retry", () => {
  const gate = new CompletionFenceDiagnosticGate();
  const turn = "d097d024ff9b";
  const requested = `[chatgpt-web] browser turn ${turn} phase=completion_fence_begin_requested requestId=13`;
  const blocked = `[chatgpt-web] browser turn ${turn} phase=completion_fence_begin_acknowledged requestId=13 revision=none`;

  expect(compactHelperCompletionFenceDiagnostic(requested, gate)).toBe(requested);
  expect(compactHelperCompletionFenceDiagnostic(blocked, gate)).toBe(blocked);
  expect(compactHelperCompletionFenceDiagnostic(requested.replace("13", "14"), gate)).toBeUndefined();
  expect(compactHelperCompletionFenceDiagnostic(blocked.replace("13", "14"), gate)).toBeUndefined();

  const recovered = `[chatgpt-web] browser turn ${turn} phase=completion_fence_begin_acknowledged requestId=15 revision=42`;
  expect(compactHelperCompletionFenceDiagnostic(recovered, gate)).toBe(`${recovered} suppressedRetries=1`);

  const unrelated = `[chatgpt-web] browser turn ${turn} stage=send completed durationMs=100`;
  expect(compactHelperCompletionFenceDiagnostic(unrelated, gate)).toBe(unrelated);
});

test("reset prevents a reused trace id from inheriting blocked diagnostic state", () => {
  const gate = new CompletionFenceDiagnosticGate();
  const turn = "repeatable_trace";
  gate.beginAttempt(turn);
  gate.resolveAttempt(turn, false);
  expect(gate.beginAttempt(turn)).toBe(false);

  gate.reset(turn);
  expect(gate.beginAttempt(turn)).toBe(true);
});
