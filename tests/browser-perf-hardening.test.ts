import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrowserObservationPacer,
  CHATGPT_RESPONSE_SNAPSHOT_MIN_INTERVAL_MS,
  CHATGPT_TURN_DOM_POLL_MIN_INTERVAL_MS,
  installChatGptBrowserPerfHardening,
} from "../src/adapters/chatgpt-web/browser-perf-hardening";

const helperMain = readFileSync(
  join(import.meta.dir, "../src/adapters/chatgpt-web/browser-helper-main.ts"),
  "utf8",
);
const helperEntry = readFileSync(
  join(import.meta.dir, "../src/adapters/chatgpt-web/browser-helper-entry.ts"),
  "utf8",
);

test("browser observation pacing caps repeated probes without coupling unrelated pages", async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  const pacer = new BrowserObservationPacer(
    125,
    () => now,
    async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  );

  const pageA = {};
  const pageB = {};

  expect(await pacer.wait(pageA)).toBe(0);
  now += 25;
  expect(await pacer.wait(pageA)).toBe(100);
  expect(sleeps).toEqual([100]);

  // A different browser surface owns an independent cadence.
  expect(await pacer.wait(pageB)).toBe(0);
  expect(sleeps).toEqual([100]);
});

test("browser hardening cadence stays well below frame-rate React churn", () => {
  expect(CHATGPT_TURN_DOM_POLL_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(100);
  expect(CHATGPT_RESPONSE_SNAPSHOT_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(75);
});

test("packaged browser helper installs perf hardening after diagnostic output owns stderr", () => {
  const diagnosticInstall = helperMain.indexOf("console.info = diagnostic;");
  const hardeningInstall = helperMain.indexOf("installChatGptBrowserPerfHardening(ChatGptBrowserWorker);");
  expect(diagnosticInstall).toBeGreaterThanOrEqual(0);
  expect(hardeningInstall).toBeGreaterThan(diagnosticInstall);
  expect(helperMain).toContain("browser-perf-hardening-v1");
  // The standalone entry may still load helper-main, but must not emit pre-protocol diagnostics
  // by installing the layer before helper-main redirects console output away from protocol stdout.
  expect(helperEntry).not.toContain("installChatGptBrowserPerfHardening(ChatGptBrowserWorker)");
});

test("browser hardening wraps hot observation paths once and preserves per-page isolation", async () => {
  let now = 10_000;
  const sleeps: number[] = [];
  const logs: string[] = [];
  const calls = { dom: 0, snapshot: 0, submission: 0 };

  class FakeWorker {
    async waitForTurnDomMutation(_page: object): Promise<void> {
      calls.dom += 1;
    }

    async responseDomSnapshot(_locator: object, _cache?: Record<string, unknown>): Promise<{ responsePresent: true }> {
      calls.snapshot += 1;
      return { responsePresent: true };
    }

    async submissionDomState(_page: object, cache?: { fullScans?: number; cacheHits?: number }): Promise<{ ok: true }> {
      calls.submission += 1;
      if (cache) cache.fullScans = (cache.fullScans ?? 0) + 1;
      return { ok: true };
    }
  }

  const options = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    log: (message: string) => logs.push(message),
    turnDomIntervalMs: 125,
    responseSnapshotIntervalMs: 100,
    reportIntervalMs: 60_000,
  };
  installChatGptBrowserPerfHardening(FakeWorker, options);
  // Installation is intentionally idempotent; helper entrypoints may be evaluated more than once
  // in tests without stacking another pacing layer around each browser operation.
  installChatGptBrowserPerfHardening(FakeWorker, options);

  const worker = new FakeWorker();
  const pageA = {};
  const pageB = {};
  const responseA = {};
  const responseB = {};
  const cacheA: { fullScans?: number; cacheHits?: number } = {};

  await worker.waitForTurnDomMutation(pageA);
  now += 25;
  await worker.waitForTurnDomMutation(pageA);
  await worker.waitForTurnDomMutation(pageB);

  await worker.responseDomSnapshot(responseA, cacheA);
  now += 20;
  await worker.responseDomSnapshot(responseA, cacheA);
  await worker.responseDomSnapshot(responseB, {});

  await worker.submissionDomState(pageA, cacheA);

  expect(calls).toEqual({ dom: 3, snapshot: 3, submission: 1 });
  expect(sleeps).toEqual([100, 80]);
  expect(cacheA.fullScans).toBe(1);
  expect(logs).toEqual([
    "[chatgpt-web] browser perf hardening installed turnDomIntervalMs=125 responseSnapshotIntervalMs=100",
  ]);
});

test("browser hardening attributes submission evidence latency to the active trace", async () => {
  let now = 20_000;
  const logs: string[] = [];

  class FakeWorker {
    async waitForTurnDomMutation(_page: object): Promise<void> {}
    async responseDomSnapshot(_locator: object, _cache?: Record<string, unknown>): Promise<{ responsePresent: true }> {
      return { responsePresent: true };
    }
    async submissionDomState(_page: object, _cache?: Record<string, unknown>): Promise<{ ok: true }> {
      return { ok: true };
    }
    async waitForSubmissionAcceptedWithRecovery(): Promise<"user_turn"> {
      now += 2_750;
      return "user_turn";
    }
    async runBrowserTurn(turn: { traceId: string }): Promise<"user_turn"> {
      return this.waitForSubmissionAcceptedWithRecovery().then(result => {
        now += 250;
        return result;
      });
    }
  }

  installChatGptBrowserPerfHardening(FakeWorker, {
    now: () => now,
    sleep: async () => {},
    log: message => logs.push(message),
    reportIntervalMs: 60_000,
  });

  const worker = new FakeWorker();
  await worker.runBrowserTurn({ traceId: "trace_submission_latency" });

  expect(logs).toContain(
    "[chatgpt-web] browser turn trace_submission_latency phase=submission_evidence_wait started",
  );
  expect(logs).toContain(
    "[chatgpt-web] browser turn trace_submission_latency phase=submission_evidence_wait completed durationMs=2750",
  );
});
