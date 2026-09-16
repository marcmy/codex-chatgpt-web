import { describe, expect, test } from "bun:test";
import * as backoffModule from "../src/adapters/chatgpt-web/rate-limit-backoff";

const MINUTE = 60_000;

function createPolicy(now = 1_000_000) {
  const Policy = (backoffModule as unknown as {
    ChatGptRateLimitBackoffPolicy?: new () => {
      recordRateLimit(now: number): unknown;
      snapshot(now: number): unknown;
      recordAction(now: number): void;
      nextAllowedActionAt(now: number): number;
    };
  }).ChatGptRateLimitBackoffPolicy;

  expect(Policy).toBeDefined();
  return { policy: new Policy!(), now };
}

describe("ChatGptRateLimitBackoffPolicy", () => {
  test("first incident enforces five minutes of total silence then one-minute spacing", () => {
    const { policy, now } = createPolicy();
    policy.recordRateLimit(now);

    expect(policy.nextAllowedActionAt(now)).toBe(now + 5 * MINUTE);
    expect(policy.snapshot(now)).toMatchObject({
      cooldownUntil: now + 5 * MINUTE,
      recoveryUntil: now + 30 * MINUTE,
      spacingMs: 1 * MINUTE,
      tier: 0,
      refreshRequired: true,
    });

    policy.recordAction(now + 5 * MINUTE);
    expect(policy.nextAllowedActionAt(now + 5 * MINUTE)).toBe(now + 6 * MINUTE);
  });

  test("new incidents inside the recovery window restart cooldown and escalate 1/3/5/7/10 minute spacing", () => {
    const { policy, now } = createPolicy();
    const expectedMinutes = [1, 3, 5, 7, 10, 10];
    let incidentAt = now;

    for (let index = 0; index < expectedMinutes.length; index += 1) {
      policy.recordRateLimit(incidentAt);
      expect(policy.snapshot(incidentAt)).toMatchObject({
        cooldownUntil: incidentAt + 5 * MINUTE,
        recoveryUntil: incidentAt + 30 * MINUTE,
        spacingMs: expectedMinutes[index]! * MINUTE,
        tier: Math.min(index, 4),
        refreshRequired: true,
      });
      incidentAt += 10 * MINUTE;
    }
  });

  test("the recovery window slides from the most recent incident and resets after 30 clean minutes", () => {
    const { policy, now } = createPolicy();
    policy.recordRateLimit(now);
    policy.recordRateLimit(now + 20 * MINUTE);

    expect(policy.snapshot(now + 49 * MINUTE)).toMatchObject({ spacingMs: 3 * MINUTE, tier: 1 });
    expect(policy.snapshot(now + 50 * MINUTE)).toMatchObject({ spacingMs: 0, tier: -1, refreshRequired: false });
  });

  test("repeated observation of one still-latched dialog does not escalate the incident tier", () => {
    const { policy, now } = createPolicy();
    policy.recordRateLimit(now);
    policy.recordRateLimit(now + 1_000);
    policy.recordRateLimit(now + 2_000);

    expect(policy.snapshot(now + 2_000)).toMatchObject({ spacingMs: 1 * MINUTE, tier: 0 });
  });
});
