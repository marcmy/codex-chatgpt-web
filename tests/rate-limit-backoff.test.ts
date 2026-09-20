import { describe, expect, test } from "bun:test";
import {
  ChatGptRateLimitBackoffPolicy,
  ChatGptRateLimitSerialGate,
  ChatGptWebsiteActionGate,
  CHATGPT_RATE_LIMIT_COOLDOWN_MS,
  CHATGPT_RATE_LIMIT_RECOVERY_MS,
  waitForChatGptRateLimitDeadline,
} from "../src/adapters/chatgpt-web/rate-limit-backoff";

const MINUTE = 60_000;

function createPolicy(now = 1_000_000) {
  return { policy: new ChatGptRateLimitBackoffPolicy(), now };
}

describe("ChatGptRateLimitBackoffPolicy", () => {
  test("first incident enforces five minutes of total silence then one-minute spacing", () => {
    const { policy, now } = createPolicy();
    policy.recordRateLimit(now);

    expect(policy.nextAllowedActionAt(now)).toBe(now + CHATGPT_RATE_LIMIT_COOLDOWN_MS);
    expect(policy.snapshot(now)).toMatchObject({
      cooldownUntil: now + CHATGPT_RATE_LIMIT_COOLDOWN_MS,
      recoveryUntil: now + CHATGPT_RATE_LIMIT_COOLDOWN_MS + CHATGPT_RATE_LIMIT_RECOVERY_MS,
      spacingMs: MINUTE,
      tier: 0,
      refreshRequired: true,
    });

    policy.recordRefresh(now + CHATGPT_RATE_LIMIT_COOLDOWN_MS);
    expect(policy.nextAllowedActionAt(now + CHATGPT_RATE_LIMIT_COOLDOWN_MS)).toBe(
      now + CHATGPT_RATE_LIMIT_COOLDOWN_MS + MINUTE,
    );
  });

  test("new incidents inside recovery restart cooldown and escalate 1/3/5/7/10 minute spacing", () => {
    const { policy, now } = createPolicy();
    const expectedMinutes = [1, 3, 5, 7, 10, 10];
    let incidentAt = now;

    for (let index = 0; index < expectedMinutes.length; index += 1) {
      expect(policy.recordRateLimit(incidentAt)).toBe(true);
      expect(policy.snapshot(incidentAt)).toMatchObject({
        cooldownUntil: incidentAt + CHATGPT_RATE_LIMIT_COOLDOWN_MS,
        recoveryUntil: incidentAt + CHATGPT_RATE_LIMIT_COOLDOWN_MS + CHATGPT_RATE_LIMIT_RECOVERY_MS,
        spacingMs: expectedMinutes[index]! * MINUTE,
        tier: Math.min(index, 4),
        refreshRequired: true,
      });

      const refreshAt = incidentAt + CHATGPT_RATE_LIMIT_COOLDOWN_MS;
      policy.recordRefresh(refreshAt);
      const resumedAt = refreshAt + expectedMinutes[index]! * MINUTE;
      policy.recordAction(resumedAt);
      incidentAt = resumedAt + 10_000;
    }
  });

  test("the recovery window slides and lasts 30 minutes after the hard cooldown", () => {
    const { policy, now } = createPolicy();
    policy.recordRateLimit(now);
    const refreshAt = now + CHATGPT_RATE_LIMIT_COOLDOWN_MS;
    policy.recordRefresh(refreshAt);
    policy.recordAction(refreshAt + MINUTE);
    policy.recordRateLimit(now + 20 * MINUTE);

    expect(policy.snapshot(now + 54 * MINUTE)).toMatchObject({ spacingMs: 3 * MINUTE, tier: 1 });
    expect(policy.snapshot(now + 55 * MINUTE)).toMatchObject({ spacingMs: 0, tier: -1, refreshRequired: false });
  });

  test("repeated observation of one still-latched dialog does not escalate the incident tier", () => {
    const { policy, now } = createPolicy();
    policy.recordRateLimit(now);
    policy.recordRateLimit(now + 1_000);
    policy.recordRateLimit(now + 2_000);

    expect(policy.snapshot(now + 2_000)).toMatchObject({ spacingMs: MINUTE, tier: 0 });
  });

  test("refresh alone keeps the incident latched until an ordinary action resumes", () => {
    const { policy, now } = createPolicy();
    policy.recordRateLimit(now);
    const refreshAt = now + CHATGPT_RATE_LIMIT_COOLDOWN_MS;
    policy.recordRefresh(refreshAt);

    expect(policy.recordRateLimit(refreshAt + 1_000)).toBe(false);
    expect(policy.snapshot(refreshAt + 1_000)).toMatchObject({ tier: 0, spacingMs: MINUTE });

    const resumedAt = refreshAt + MINUTE;
    policy.recordAction(resumedAt);
    expect(policy.recordRateLimit(resumedAt + 1_000)).toBe(true);
    expect(policy.snapshot(resumedAt + 1_000)).toMatchObject({ tier: 1, spacingMs: 3 * MINUTE });
  });

  test("the required refresh is the only website action permitted immediately after hard cooldown", () => {
    const { policy, now } = createPolicy();
    policy.recordRateLimit(now);

    const refreshAt = now + CHATGPT_RATE_LIMIT_COOLDOWN_MS;
    expect(policy.nextAllowedActionAt(refreshAt)).toBe(refreshAt);
    expect(policy.snapshot(refreshAt)).toMatchObject({ refreshRequired: true });

    policy.recordRefresh(refreshAt);
    expect(policy.snapshot(refreshAt)).toMatchObject({ refreshRequired: false });
    expect(policy.nextAllowedActionAt(refreshAt)).toBe(refreshAt + MINUTE);
  });
});

describe("ChatGptRateLimitSerialGate", () => {
  test("concurrent recovery owners run one at a time in arrival order", async () => {
    const gate = new ChatGptRateLimitSerialGate();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = gate.runExclusive(async () => {
      events.push("first:start");
      await firstBlocked;
      events.push("first:end");
    });
    const second = gate.runExclusive(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  test("a failed recovery owner still releases the next waiter", async () => {
    const gate = new ChatGptRateLimitSerialGate();
    const events: string[] = [];

    const first = gate.runExclusive(async () => {
      events.push("first");
      throw new Error("boom");
    });
    const second = gate.runExclusive(async () => {
      events.push("second");
    });

    await expect(first).rejects.toThrow("boom");
    await second;
    expect(events).toEqual(["first", "second"]);
  });

  test("a cancelled queued owner is removed without blocking later owners", async () => {
    const gate = new ChatGptRateLimitSerialGate();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    const controller = new AbortController();

    const first = gate.runExclusive(async () => {
      events.push("first:start");
      await firstBlocked;
      events.push("first:end");
    });
    const cancelled = gate.runExclusive(async () => {
      events.push("cancelled:ran");
    }, controller.signal);
    const third = gate.runExclusive(async () => {
      events.push("third:start");
    });

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, third]);
    expect(events).toEqual(["first:start", "first:end", "third:start"]);
  });
});

class FakeRateLimitClock {
  readonly sleeps: number[] = [];

  constructor(public current: number) {}

  now = () => this.current;

  sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    this.sleeps.push(ms);
    this.current += ms;
  };

  advance(ms: number): void {
    this.current += ms;
  }
}

describe("ChatGptWebsiteActionGate", () => {
  test("does not serialize ordinary browser actions before recovery", async () => {
    const gate = new ChatGptWebsiteActionGate(new ChatGptRateLimitBackoffPolicy());
    const events: string[] = [];
    let releaseFirst!: () => void;
    const blocked = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = gate.runAction(async () => {
      events.push("first:start");
      await blocked;
      events.push("first:end");
    });
    const second = gate.runAction(async () => {
      events.push("second:start");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start", "second:start"]);
    releaseFirst();
    await Promise.all([first, second]);
  });

  test("spaces recovery actions from the previous action's completion", async () => {
    const now = 1_000_000;
    const policy = new ChatGptRateLimitBackoffPolicy();
    const gate = new ChatGptWebsiteActionGate(policy);
    const clock = new FakeRateLimitClock(now);
    policy.recordRateLimit(now);

    await gate.runRecoveryRefresh(async () => {
      clock.advance(5_000);
    }, undefined, clock);
    expect(clock.sleeps).toEqual([CHATGPT_RATE_LIMIT_COOLDOWN_MS]);

    await gate.runAction(async () => {
      clock.advance(7_000);
    }, undefined, clock);
    expect(clock.sleeps.at(-1)).toBe(MINUTE);

    const firstCompletion = clock.now();
    let secondStartedAt = 0;
    await gate.runAction(async () => {
      secondStartedAt = clock.now();
    }, undefined, clock);
    expect(secondStartedAt).toBe(firstCompletion + MINUTE);
  });

  test("a failed action still starts the next interval from its completion", async () => {
    const now = 2_000_000;
    const policy = new ChatGptRateLimitBackoffPolicy();
    const gate = new ChatGptWebsiteActionGate(policy);
    const clock = new FakeRateLimitClock(now);
    policy.recordRateLimit(now);
    await gate.runRecoveryRefresh(async () => {}, undefined, clock);

    await expect(gate.runAction(async () => {
      clock.advance(2_000);
      throw new Error("action failed");
    }, undefined, clock)).rejects.toThrow("action failed");
    const failedAt = clock.now();

    let nextStartedAt = 0;
    await gate.runAction(async () => {
      nextStartedAt = clock.now();
    }, undefined, clock);
    expect(nextStartedAt).toBe(failedAt + MINUTE);
  });

  test("serializes the recovery wait and active operation, not only permit acquisition", async () => {
    const now = 3_000_000;
    const policy = new ChatGptRateLimitBackoffPolicy();
    const gate = new ChatGptWebsiteActionGate(policy);
    const clock = new FakeRateLimitClock(now);
    policy.recordRateLimit(now);
    await gate.runRecoveryRefresh(async () => {}, undefined, clock);

    const events: string[] = [];
    let releaseFirst!: () => void;
    const blocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { signalFirstStarted = resolve; });
    const first = gate.runAction(async () => {
      events.push("first:start");
      signalFirstStarted();
      await blocked;
      events.push("first:end");
    }, undefined, clock);
    const second = gate.runAction(async () => {
      events.push("second:start");
    }, undefined, clock);

    await firstStarted;
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("ordinary actions queue behind the required hard-cooldown refresh", async () => {
    const now = 4_000_000;
    const policy = new ChatGptRateLimitBackoffPolicy();
    const gate = new ChatGptWebsiteActionGate(policy);
    const clock = new FakeRateLimitClock(now);
    policy.recordRateLimit(now);

    let actionStartedAt = 0;
    const queuedAction = gate.runAction(async () => {
      actionStartedAt = clock.now();
    }, undefined, clock);

    await Promise.resolve();
    expect(actionStartedAt).toBe(0);

    let refreshStartedAt = 0;
    expect(await gate.runRecoveryRefresh(async () => {
      refreshStartedAt = clock.now();
    }, undefined, clock)).toBe(true);
    await queuedAction;

    expect(refreshStartedAt).toBe(now + CHATGPT_RATE_LIMIT_COOLDOWN_MS);
    expect(actionStartedAt).toBe(refreshStartedAt + MINUTE);
  });

  test("a queued action can be cancelled while it waits for the required refresh", async () => {
    const now = 4_500_000;
    const policy = new ChatGptRateLimitBackoffPolicy();
    const gate = new ChatGptWebsiteActionGate(policy);
    const clock = new FakeRateLimitClock(now);
    const controller = new AbortController();
    policy.recordRateLimit(now);

    const action = gate.runAction(async () => {
      throw new Error("cancelled action must never run");
    }, controller.signal, clock);
    controller.abort();

    await expect(action).rejects.toMatchObject({ name: "AbortError" });
    expect(await gate.runRecoveryRefresh(async () => {}, undefined, clock)).toBe(true);
  });

  test("a throwing recovery refresh is consumed exactly once and becomes the spacing origin", async () => {
    const now = 5_000_000;
    const policy = new ChatGptRateLimitBackoffPolicy();
    const gate = new ChatGptWebsiteActionGate(policy);
    const clock = new FakeRateLimitClock(now);
    policy.recordRateLimit(now);
    let attempts = 0;

    await expect(gate.runRecoveryRefresh(async () => {
      attempts += 1;
      clock.advance(3_000);
      throw new Error("reload failed");
    }, undefined, clock)).rejects.toThrow("reload failed");
    const refreshFinishedAt = clock.now();
    expect(policy.snapshot(clock.now()).refreshRequired).toBe(false);
    expect(await gate.runRecoveryRefresh(async () => { attempts += 1; }, undefined, clock)).toBe(false);
    expect(attempts).toBe(1);

    let actionStartedAt = 0;
    await gate.runAction(async () => { actionStartedAt = clock.now(); }, undefined, clock);
    expect(actionStartedAt).toBe(refreshFinishedAt + MINUTE);
  });

  test("reports deliberate throttle waiting while the wait is still in progress", async () => {
    const now = 6_000_000;
    const policy = new ChatGptRateLimitBackoffPolicy();
    const gate = new ChatGptWebsiteActionGate(policy);
    let releaseSleep!: () => void;
    const clock = {
      current: now,
      now() { return this.current; },
      sleep: async (_ms: number) => new Promise<void>(resolve => { releaseSleep = resolve; }),
    };
    policy.recordRateLimit(now);

    const refresh = gate.runRecoveryRefresh(async () => {}, undefined, clock);
    await Promise.resolve();
    await Promise.resolve();
    clock.current += 20_000;
    expect(gate.throttledMs()).toBe(20_000);

    clock.current = now + CHATGPT_RATE_LIMIT_COOLDOWN_MS;
    releaseSleep();
    await refresh;
    expect(gate.throttledMs()).toBe(CHATGPT_RATE_LIMIT_COOLDOWN_MS);
  });
});

describe("waitForChatGptRateLimitDeadline", () => {
  test("uses an injected clock without real-minute sleeps", async () => {
    const sleeps: number[] = [];
    const clock = { now: () => 10_000, sleep: async (ms: number) => { sleeps.push(ms); } };
    await waitForChatGptRateLimitDeadline(310_000, undefined, clock);
    expect(sleeps).toEqual([300_000]);
  });
});
