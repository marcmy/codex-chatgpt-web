export const CHATGPT_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
export const CHATGPT_RATE_LIMIT_RECOVERY_MS = 30 * 60_000;
export const CHATGPT_RATE_LIMIT_SPACING_MS = [1, 3, 5, 7, 10].map(minutes => minutes * 60_000) as readonly number[];

export interface ChatGptRateLimitBackoffSnapshot {
  cooldownUntil: number;
  recoveryUntil: number;
  spacingMs: number;
  tier: number;
  refreshRequired: boolean;
}

/**
 * Account-wide recovery state for ChatGPT's "Too many requests" browser dialog.
 *
 * One visible dialog remains latched through the mandatory post-cooldown refresh. The incident is
 * unlatched only after an ordinary website action has actually resumed; a rate-limit observed after
 * that resumption is a new incident and advances the recovery spacing, capped at ten minutes.
 * Thirty clean minutes after the hard cooldown reset the policy completely.
 */
export class ChatGptRateLimitBackoffPolicy {
  private tier = -1;
  private cooldownUntil = 0;
  private recoveryUntil = 0;
  private lastActionAt: number | undefined;
  private refreshRequired = false;
  private incidentLatched = false;

  /** Returns true only when this observation starts a new rate-limit incident. */
  recordRateLimit(now = Date.now()): boolean {
    this.resetIfRecovered(now);
    if (this.incidentLatched) return false;

    this.tier = Math.min(this.tier + 1, CHATGPT_RATE_LIMIT_SPACING_MS.length - 1);
    this.cooldownUntil = now + CHATGPT_RATE_LIMIT_COOLDOWN_MS;
    this.recoveryUntil = now + CHATGPT_RATE_LIMIT_COOLDOWN_MS + CHATGPT_RATE_LIMIT_RECOVERY_MS;
    this.refreshRequired = true;
    this.incidentLatched = true;
    this.lastActionAt = undefined;
    return true;
  }

  /**
   * Records the one refresh that ends hard cooldown and arms recovery spacing.
   * The incident intentionally stays latched until an ordinary website action resumes.
   */
  recordRefresh(now = Date.now()): boolean {
    this.resetIfRecovered(now);
    if (this.tier < 0 || !this.refreshRequired) return false;
    if (now < this.cooldownUntil) {
      throw new Error("ChatGPT rate-limit recovery refresh cannot run during hard cooldown");
    }

    this.refreshRequired = false;
    this.lastActionAt = now;
    return true;
  }

  /** Records completion of an ordinary active ChatGPT website action. */
  recordAction(now = Date.now()): void {
    this.resetIfRecovered(now);
    if (this.tier < 0) return;
    if (this.refreshRequired) {
      throw new Error("ChatGPT rate-limit recovery requires its refresh before other website actions");
    }
    this.lastActionAt = now;
    this.incidentLatched = false;
  }

  /** Earliest time the next permitted ordinary active website action may begin. */
  nextAllowedActionAt(now = Date.now()): number {
    this.resetIfRecovered(now);
    if (this.tier < 0) return now;
    if (this.refreshRequired) return Math.max(now, this.cooldownUntil);
    const spacingMs = CHATGPT_RATE_LIMIT_SPACING_MS[this.tier]!;
    return Math.max(now, (this.lastActionAt ?? now) + spacingMs);
  }

  snapshot(now = Date.now()): ChatGptRateLimitBackoffSnapshot {
    this.resetIfRecovered(now);
    return {
      cooldownUntil: this.cooldownUntil,
      recoveryUntil: this.recoveryUntil,
      spacingMs: this.tier >= 0 ? CHATGPT_RATE_LIMIT_SPACING_MS[this.tier]! : 0,
      tier: this.tier,
      refreshRequired: this.refreshRequired,
    };
  }

  private resetIfRecovered(now: number): void {
    if (this.tier < 0 || now < this.recoveryUntil) return;
    this.tier = -1;
    this.cooldownUntil = 0;
    this.recoveryUntil = 0;
    this.lastActionAt = undefined;
    this.refreshRequired = false;
    this.incidentLatched = false;
  }
}

/** Serializes account-wide recovery work so concurrent tabs cannot resume together. */
export class ChatGptRateLimitSerialGate {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/** Wait without touching the browser page. The surrounding adapter/launcher heartbeats keep running. */
export interface ChatGptRateLimitWaitClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const systemRateLimitWaitClock: ChatGptRateLimitWaitClock = {
  now: Date.now,
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  }),
};

export async function waitForChatGptRateLimitDeadline(
  deadline: number,
  signal?: AbortSignal,
  clock: ChatGptRateLimitWaitClock = systemRateLimitWaitClock,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
  const remaining = deadline - clock.now();
  if (remaining <= 0) return;
  await clock.sleep(remaining, signal);
}

/**
 * Account-wide gate for active ChatGPT website operations during recovery.
 *
 * Normal operation remains fully concurrent. Once recovery is active, the gate owns both the
 * deliberate wait and the active operation itself, so spacing is measured from the previous
 * operation's completion to the next operation's start. An invoked operation counts even if it
 * throws because the website may already have observed it.
 */
export class ChatGptWebsiteActionGate {
  private throttleWaitTotalMs = 0;
  private activeWait: {
    startedAt: number;
    remainingMs: number;
    clock: ChatGptRateLimitWaitClock;
  } | undefined;

  constructor(
    private readonly policy: ChatGptRateLimitBackoffPolicy,
    private readonly serial: ChatGptRateLimitSerialGate = new ChatGptRateLimitSerialGate(),
  ) {}

  /** Monotonic deliberate recovery wait time, including a wait still in progress. */
  throttledMs(): number {
    const active = this.activeWait;
    if (!active) return this.throttleWaitTotalMs;
    const elapsed = Math.min(
      active.remainingMs,
      Math.max(0, active.clock.now() - active.startedAt),
    );
    return this.throttleWaitTotalMs + elapsed;
  }

  /** Run exactly one ordinary active website operation. */
  async runAction<T>(
    action: () => Promise<T>,
    signal?: AbortSignal,
    clock: ChatGptRateLimitWaitClock = systemRateLimitWaitClock,
  ): Promise<T> {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");

    // Do not serialize normal browser use. Once an incident is active every later action enters the
    // shared serial section, which owns the wait and the operation until completion.
    if (this.policy.snapshot(clock.now()).tier < 0) return action();

    return this.serial.runExclusive(async () => {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const snapshot = this.policy.snapshot(clock.now());
      if (snapshot.tier < 0) return action();
      if (snapshot.refreshRequired) {
        throw new Error("ChatGPT rate-limit recovery requires its refresh before other website actions");
      }

      await this.waitTracked(this.policy.nextAllowedActionAt(clock.now()), signal, clock);
      try {
        return await action();
      } finally {
        this.policy.recordAction(clock.now());
      }
    });
  }

  /**
   * Run the one refresh that ends hard cooldown. A refresh that throws is still consumed because
   * once invoked the browser/site may already have observed the navigation.
   */
  async runRecoveryRefresh(
    action: () => Promise<void>,
    signal?: AbortSignal,
    clock: ChatGptRateLimitWaitClock = systemRateLimitWaitClock,
  ): Promise<boolean> {
    return this.serial.runExclusive(async () => {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      let snapshot = this.policy.snapshot(clock.now());
      if (snapshot.tier < 0 || !snapshot.refreshRequired) return false;

      await this.waitTracked(snapshot.cooldownUntil, signal, clock);
      snapshot = this.policy.snapshot(clock.now());
      if (snapshot.tier < 0 || !snapshot.refreshRequired) return false;

      try {
        await action();
        return true;
      } finally {
        this.policy.recordRefresh(clock.now());
      }
    });
  }

  private async waitTracked(
    deadline: number,
    signal: AbortSignal | undefined,
    clock: ChatGptRateLimitWaitClock,
  ): Promise<void> {
    const remaining = deadline - clock.now();
    if (remaining <= 0) return;
    const startedAt = clock.now();
    this.activeWait = { startedAt, remainingMs: remaining, clock };
    try {
      await waitForChatGptRateLimitDeadline(deadline, signal, clock);
    } finally {
      // Count only deliberate waiting, not scheduler overrun beyond the requested deadline.
      this.throttleWaitTotalMs += Math.min(remaining, Math.max(0, clock.now() - startedAt));
      this.activeWait = undefined;
    }
  }
}

/** Shared by every browser worker in this process because ChatGPT throttles the signed-in account. */
export const chatGptRateLimitBackoffPolicy = new ChatGptRateLimitBackoffPolicy();
export const chatGptRateLimitSerialGate = new ChatGptRateLimitSerialGate();
export const chatGptWebsiteActionGate = new ChatGptWebsiteActionGate(
  chatGptRateLimitBackoffPolicy,
  chatGptRateLimitSerialGate,
);
