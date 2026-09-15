import { AsyncLocalStorage } from "node:async_hooks";

export const CHATGPT_TURN_DOM_POLL_MIN_INTERVAL_MS = 125;
export const CHATGPT_RESPONSE_SNAPSHOT_MIN_INTERVAL_MS = 100;
export const CHATGPT_BROWSER_PERF_REPORT_INTERVAL_MS = 15_000;
export const CHATGPT_BROWSER_PERF_SLOW_OBSERVATION_MS = 1_000;

const HARDENING_INSTALLED = Symbol.for("codex-chatgpt-web.browser-perf-hardening");

type Sleep = (milliseconds: number) => Promise<void>;
type Clock = () => number;
type Logger = (message: string) => void;
type AsyncMethod = (...args: unknown[]) => Promise<unknown>;
type WorkerClass = { prototype: object };

export interface BrowserPerfHardeningOptions {
  now?: Clock;
  sleep?: Sleep;
  log?: Logger;
  turnDomIntervalMs?: number;
  responseSnapshotIntervalMs?: number;
  reportIntervalMs?: number;
  slowObservationMs?: number;
}

/**
 * Limits how frequently an observation may START for one browser surface/cache without serializing
 * unrelated tabs. Reserving the next slot before sleeping also prevents two simultaneous callers
 * from both claiming the same interval.
 */
export class BrowserObservationPacer {
  private readonly nextStart = new WeakMap<object, number>();

  constructor(
    readonly minimumIntervalMs: number,
    private readonly now: Clock = () => Date.now(),
    private readonly sleep: Sleep = async milliseconds => {
      await new Promise(resolve => setTimeout(resolve, milliseconds));
    },
  ) {
    if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) {
      throw new Error("Browser observation pacing interval must be a non-negative finite number");
    }
  }

  async wait(key: object): Promise<number> {
    const current = this.now();
    const eligibleAt = this.nextStart.get(key) ?? current;
    const startAt = Math.max(current, eligibleAt);
    const delay = Math.max(0, startAt - current);
    this.nextStart.set(key, startAt + this.minimumIntervalMs);
    if (delay > 0) await this.sleep(delay);
    return delay;
  }
}

type MetricName = "turnDomMutation" | "responseSnapshot" | "submissionState";

interface Metric {
  calls: number;
  totalMs: number;
  maxMs: number;
  pacingMs: number;
  fullScans: number;
  cacheHits: number;
}

function emptyMetric(): Metric {
  return {
    calls: 0,
    totalMs: 0,
    maxMs: 0,
    pacingMs: 0,
    fullScans: 0,
    cacheHits: 0,
  };
}

class BrowserPerfTelemetry {
  private windowStartedAt: number;
  private metrics: Record<MetricName, Metric> = {
    turnDomMutation: emptyMetric(),
    responseSnapshot: emptyMetric(),
    submissionState: emptyMetric(),
  };

  constructor(
    private readonly now: Clock,
    private readonly log: Logger,
    private readonly reportIntervalMs: number,
    private readonly slowObservationMs: number,
  ) {
    this.windowStartedAt = now();
  }

  record(
    name: MetricName,
    elapsedMs: number,
    detail: { pacingMs?: number; fullScans?: number; cacheHits?: number } = {},
  ): void {
    const metric = this.metrics[name];
    metric.calls += 1;
    metric.totalMs += elapsedMs;
    metric.maxMs = Math.max(metric.maxMs, elapsedMs);
    metric.pacingMs += detail.pacingMs ?? 0;
    metric.fullScans += detail.fullScans ?? 0;
    metric.cacheHits += detail.cacheHits ?? 0;

    if (elapsedMs >= this.slowObservationMs) {
      this.log(
        `[chatgpt-web] slow browser observation method=${name} elapsedMs=${Math.round(elapsedMs)}`,
      );
    }
    this.reportIfDue();
  }

  private reportIfDue(): void {
    const now = this.now();
    const elapsed = now - this.windowStartedAt;
    if (elapsed < this.reportIntervalMs) return;
    const totalCalls = Object.values(this.metrics).reduce((total, metric) => total + metric.calls, 0);
    if (totalCalls > 0) {
      const seconds = Math.max(0.001, elapsed / 1_000);
      const metricText = (name: MetricName): string => {
        const metric = this.metrics[name];
        const average = metric.calls > 0 ? metric.totalMs / metric.calls : 0;
        const rate = metric.calls / seconds;
        const cache = name === "submissionState"
          ? ` scans=${metric.fullScans} cacheHits=${metric.cacheHits}`
          : "";
        return `${name}=${metric.calls}(${rate.toFixed(1)}/s avg=${average.toFixed(1)}ms`
          + ` max=${Math.round(metric.maxMs)}ms paced=${Math.round(metric.pacingMs)}ms${cache})`;
      };
      this.log(
        `[chatgpt-web] browser perf window=${Math.round(elapsed)}ms `
        + `${metricText("turnDomMutation")} ${metricText("responseSnapshot")} ${metricText("submissionState")}`,
      );
    }
    this.windowStartedAt = now;
    this.metrics = {
      turnDomMutation: emptyMetric(),
      responseSnapshot: emptyMetric(),
      submissionState: emptyMetric(),
    };
  }
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
  return value;
}

function objectKey(value: unknown, fallback: object): object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? value as object
    : fallback;
}

function asyncMethod(prototype: Record<PropertyKey, unknown>, name: string): AsyncMethod {
  const method = prototype[name];
  if (typeof method !== "function") {
    throw new Error(`ChatGPT browser performance hardening could not find worker method ${name}`);
  }
  return method as AsyncMethod;
}

function optionalAsyncMethod(prototype: Record<PropertyKey, unknown>, name: string): AsyncMethod | undefined {
  const method = prototype[name];
  return typeof method === "function" ? method as AsyncMethod : undefined;
}

function browserTurnTraceId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const traceId = (value as { traceId?: unknown }).traceId;
  return typeof traceId === "string" && traceId.length > 0 ? traceId : undefined;
}

/**
 * Install helper-process-only pacing around the browser worker's hottest read-only DOM probes.
 *
 * The original DOM observers and semantic checks remain authoritative. This layer changes only how
 * frequently the helper asks Chromium to execute them, preventing React streaming churn from
 * turning Playwright/CDP into a near-frame-rate polling loop. Per-page/cache WeakMap keys preserve
 * the existing five-tab concurrency model.
 */
export function installChatGptBrowserPerfHardening(
  Worker: WorkerClass,
  options: BrowserPerfHardeningOptions = {},
): void {
  const prototype = Worker.prototype as Record<PropertyKey, unknown>;
  if (prototype[HARDENING_INSTALLED] === true) return;

  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? (async milliseconds => {
    await new Promise(resolve => setTimeout(resolve, milliseconds));
  });
  const log = options.log ?? (message => console.info(message));
  const turnDomIntervalMs = finiteNonNegative(
    options.turnDomIntervalMs ?? CHATGPT_TURN_DOM_POLL_MIN_INTERVAL_MS,
    "turnDomIntervalMs",
  );
  const responseSnapshotIntervalMs = finiteNonNegative(
    options.responseSnapshotIntervalMs ?? CHATGPT_RESPONSE_SNAPSHOT_MIN_INTERVAL_MS,
    "responseSnapshotIntervalMs",
  );
  const reportIntervalMs = finiteNonNegative(
    options.reportIntervalMs ?? CHATGPT_BROWSER_PERF_REPORT_INTERVAL_MS,
    "reportIntervalMs",
  );
  const slowObservationMs = finiteNonNegative(
    options.slowObservationMs ?? CHATGPT_BROWSER_PERF_SLOW_OBSERVATION_MS,
    "slowObservationMs",
  );
  const turnDomPacer = new BrowserObservationPacer(turnDomIntervalMs, now, sleep);
  const responseSnapshotPacer = new BrowserObservationPacer(responseSnapshotIntervalMs, now, sleep);
  const telemetry = new BrowserPerfTelemetry(now, log, reportIntervalMs, slowObservationMs);
  const traceContext = new AsyncLocalStorage<string>();

  const originalTurnDomMutation = asyncMethod(prototype, "waitForTurnDomMutation");
  const originalResponseDomSnapshot = asyncMethod(prototype, "responseDomSnapshot");
  const originalSubmissionDomState = asyncMethod(prototype, "submissionDomState");
  const originalRunBrowserTurn = optionalAsyncMethod(prototype, "runBrowserTurn");
  const originalSubmissionAcceptance = optionalAsyncMethod(prototype, "waitForSubmissionAcceptedWithRecovery");

  prototype.waitForTurnDomMutation = async function(this: object, ...args: unknown[]): Promise<unknown> {
    const key = objectKey(args[0], this);
    const pacingMs = await turnDomPacer.wait(key);
    const startedAt = now();
    try {
      return await originalTurnDomMutation.apply(this, args);
    } finally {
      telemetry.record("turnDomMutation", Math.max(0, now() - startedAt), { pacingMs });
    }
  };

  prototype.responseDomSnapshot = async function(this: object, ...args: unknown[]): Promise<unknown> {
    // Prefer the caller-owned response cache: a React rebind can replace the Locator object while
    // the same logical response continues. Calls without a cache fall back to the Locator itself.
    const key = objectKey(args[1], objectKey(args[0], this));
    const pacingMs = await responseSnapshotPacer.wait(key);
    const startedAt = now();
    try {
      return await originalResponseDomSnapshot.apply(this, args);
    } finally {
      telemetry.record("responseSnapshot", Math.max(0, now() - startedAt), { pacingMs });
    }
  };

  prototype.submissionDomState = async function(this: object, ...args: unknown[]): Promise<unknown> {
    const cache = typeof args[1] === "object" && args[1] !== null
      ? args[1] as { fullScans?: number; cacheHits?: number }
      : undefined;
    const fullScansBefore = cache?.fullScans ?? 0;
    const cacheHitsBefore = cache?.cacheHits ?? 0;
    const startedAt = now();
    try {
      return await originalSubmissionDomState.apply(this, args);
    } finally {
      telemetry.record("submissionState", Math.max(0, now() - startedAt), {
        fullScans: Math.max(0, (cache?.fullScans ?? fullScansBefore) - fullScansBefore),
        cacheHits: Math.max(0, (cache?.cacheHits ?? cacheHitsBefore) - cacheHitsBefore),
      });
    }
  };

  // Keep trace attribution concurrency-safe. One worker serves up to five browser turns at once,
  // so storing the current trace on `this` would cross-wire latency logs between tabs.
  if (originalRunBrowserTurn && originalSubmissionAcceptance) {
    prototype.runBrowserTurn = async function(this: object, ...args: unknown[]): Promise<unknown> {
      const traceId = browserTurnTraceId(args[0]);
      return traceId
        ? await traceContext.run(traceId, () => originalRunBrowserTurn.apply(this, args))
        : await originalRunBrowserTurn.apply(this, args);
    };

    prototype.waitForSubmissionAcceptedWithRecovery = async function(
      this: object,
      ...args: unknown[]
    ): Promise<unknown> {
      const traceId = traceContext.getStore();
      const startedAt = now();
      if (traceId) {
        log(`[chatgpt-web] browser turn ${traceId} phase=submission_evidence_wait started`);
      }
      try {
        const result = await originalSubmissionAcceptance.apply(this, args);
        if (traceId) {
          log(
            `[chatgpt-web] browser turn ${traceId} phase=submission_evidence_wait completed`
            + ` durationMs=${Math.round(Math.max(0, now() - startedAt))}`,
          );
        }
        return result;
      } catch (error) {
        if (traceId) {
          log(
            `[chatgpt-web] browser turn ${traceId} phase=submission_evidence_wait failed`
            + ` durationMs=${Math.round(Math.max(0, now() - startedAt))}`,
          );
        }
        throw error;
      }
    };
  }

  Object.defineProperty(prototype, HARDENING_INSTALLED, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  log(
    `[chatgpt-web] browser perf hardening installed turnDomIntervalMs=${turnDomIntervalMs}`
    + ` responseSnapshotIntervalMs=${responseSnapshotIntervalMs}`,
  );
}
