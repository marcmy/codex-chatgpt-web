import { describe, expect, test } from "bun:test";
import {
  ChatGptRateLimitBackoffPolicy,
  ChatGptRateLimitSerialGate,
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
      spacingMs: 1 * MINUTE,
      tier: 0,
      refreshRequired: true,
    });

    policy.recordRefresh(now + CHATGPT_RATE_LIMIT_COOLDOWN_MS);
    expect(policy.nextAllowedActionAt(now + CHATGPT_RATE_LIMIT_COOLDOWN_MS)).toBe(
      now + CHATGPT_RATE_LIMIT_COOLDOWN_MS + 1 * MINUTE,
    );
  });

  test("new incidents inside the recovery window restart cooldown and escalate 1/3/5/7/10 minute spacing", () => {
    const { policy, now } = createPolicy();
    const expectedMinutes = [1, 3, 5, 7, 10, 10];
    let incidentAt = now;

    for (let index = 0; index < expectedMinutes.length; index += 1) {
      policy.recordRateLimit(incidentAt);
      expect(policy.snapshot(incidentAt)).toMatchObject({
        cooldownUntil: incidentAt + CHATGPT_RATE_LIMIT_COOLDOWN_MS,
        recoveryUntil: incidentAt + CHATGPT_RATE_LIMIT_COOLDOWN_MS + CHATGPT_RATE_LIMIT_RECOVERY_MS,
        spacingMs: expectedMinutes[index]! * MINUTE,
        tier: Math.min(index, 4),
        refreshRequired: true,
      });

      const refreshAt = incidentAt + CHATGPT_RATE_LIMIT_COOLDOWN_MS;
      policy.recordRefresh(refreshAt);
      incidentAt = refreshAt + expectedMinutes[index]! * MINUTE + 10_000;
    }
  });

  test("the recovery window slides and lasts 30 minutes after the hard cooldown", () => {
    const { policy, now } = createPolicy();
    policy.recordRateLimit(now);
    policy.recordRefresh(now + CHATGPT_RATE_LIMIT_COOLDOWN_MS);
    policy.recordRateLimit(now + 20 * MINUTE);

    expect(policy.snapshot(now + 54 * MINUTE)).toMatchObject({ spacingMs: 3 * MINUTE, tier: 1 });
    expect(policy.snapshot(now + 55 * MINUTE)).toMatchObject({ spacingMs: 0, tier: -1, refreshRequired: false });
  });

  test("repeated observation of one still-latched dialog does not escalate the incident tier", () => {
    const { policy, now } = createPolicy();
    policy.recordRateLimit(now);
    policy.recordRateLimit(now + 1_000);
    policy.recordRateLimit(now + 2_000);

    expect(policy.snapshot(now + 2_000)).toMatchObject({ spacingMs: 1 * MINUTE, tier: 0 });
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
});


describe("waitForChatGptRateLimitDeadline", () => {
  test("uses an injected clock without real-minute sleeps", async () => {
    const sleeps: number[] = [];
    const clock = { now: () => 10_000, sleep: async (ms: number) => { sleeps.push(ms); } };
    await waitForChatGptRateLimitDeadline(310_000, undefined, clock);
    expect(sleeps).toEqual([300_000]);
  });
});
