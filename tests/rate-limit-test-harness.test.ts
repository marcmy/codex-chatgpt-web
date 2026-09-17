import { describe, expect, test } from "bun:test";
import {
  ChatGptRateLimitBackoffPolicy,
  CHATGPT_RATE_LIMIT_COOLDOWN_MS,
  CHATGPT_RATE_LIMIT_PRODUCTION_CONFIG,
  CHATGPT_RATE_LIMIT_RECOVERY_MS,
  CHATGPT_RATE_LIMIT_SPACING_MS,
  CHATGPT_RATE_LIMIT_TEST_CONFIG,
  CHATGPT_RATE_LIMIT_TEST_COOLDOWN_MS,
  CHATGPT_RATE_LIMIT_TEST_RECOVERY_MS,
  CHATGPT_RATE_LIMIT_TEST_SPACING_MS,
  resolveChatGptRateLimitRuntimeConfig,
  resolveChatGptRateLimitTestTriggerMode,
} from "../src/adapters/chatgpt-web/rate-limit-backoff";

describe("synthetic ChatGPT rate-limit harness", () => {
  test("production timings remain the default and exported constants are unchanged", () => {
    const config = resolveChatGptRateLimitRuntimeConfig({});

    expect(config).toBe(CHATGPT_RATE_LIMIT_PRODUCTION_CONFIG);
    expect(config).toEqual({
      cooldownMs: CHATGPT_RATE_LIMIT_COOLDOWN_MS,
      recoveryMs: CHATGPT_RATE_LIMIT_RECOVERY_MS,
      spacingMs: CHATGPT_RATE_LIMIT_SPACING_MS,
      testMode: false,
    });
    expect(CHATGPT_RATE_LIMIT_COOLDOWN_MS).toBe(5 * 60_000);
    expect(CHATGPT_RATE_LIMIT_RECOVERY_MS).toBe(30 * 60_000);
    expect(CHATGPT_RATE_LIMIT_SPACING_MS).toEqual([1, 3, 5, 7, 10].map(minutes => minutes * 60_000));
  });

  test("test mode selects the fixed short preset only when explicitly enabled", () => {
    expect(resolveChatGptRateLimitRuntimeConfig({ CODEX_WEB_RATE_LIMIT_TEST: "0" }))
      .toBe(CHATGPT_RATE_LIMIT_PRODUCTION_CONFIG);

    const config = resolveChatGptRateLimitRuntimeConfig({ CODEX_WEB_RATE_LIMIT_TEST: "1" });
    expect(config).toBe(CHATGPT_RATE_LIMIT_TEST_CONFIG);
    expect(config).toEqual({
      cooldownMs: CHATGPT_RATE_LIMIT_TEST_COOLDOWN_MS,
      recoveryMs: CHATGPT_RATE_LIMIT_TEST_RECOVERY_MS,
      spacingMs: CHATGPT_RATE_LIMIT_TEST_SPACING_MS,
      testMode: true,
    });
    expect(config.cooldownMs).toBe(5_000);
    expect(config.recoveryMs).toBe(60_000);
    expect(config.spacingMs).toEqual([1_000, 3_000, 5_000, 7_000, 10_000]);
  });

  test("synthetic triggers are impossible unless test mode is enabled", () => {
    expect(resolveChatGptRateLimitTestTriggerMode({
      CODEX_WEB_RATE_LIMIT_TEST_TRIGGER: "once",
    })).toBe("off");
    expect(resolveChatGptRateLimitTestTriggerMode({
      CODEX_WEB_RATE_LIMIT_TEST: "0",
      CODEX_WEB_RATE_LIMIT_TEST_TRIGGER: "each-turn",
    })).toBe("off");
  });

  test("accepts only the explicit once and each-turn trigger modes", () => {
    const base = { CODEX_WEB_RATE_LIMIT_TEST: "1" };
    expect(resolveChatGptRateLimitTestTriggerMode({ ...base, CODEX_WEB_RATE_LIMIT_TEST_TRIGGER: "once" }))
      .toBe("once");
    expect(resolveChatGptRateLimitTestTriggerMode({ ...base, CODEX_WEB_RATE_LIMIT_TEST_TRIGGER: " EACH-TURN " }))
      .toBe("each-turn");
    expect(resolveChatGptRateLimitTestTriggerMode({ ...base, CODEX_WEB_RATE_LIMIT_TEST_TRIGGER: "always" }))
      .toBe("off");
    expect(resolveChatGptRateLimitTestTriggerMode(base)).toBe("off");
  });

  test("the real policy honors the short preset without changing policy semantics", () => {
    const now = 10_000;
    const policy = new ChatGptRateLimitBackoffPolicy(CHATGPT_RATE_LIMIT_TEST_CONFIG);

    expect(policy.recordRateLimit(now)).toBe(true);
    expect(policy.snapshot(now)).toMatchObject({
      cooldownUntil: now + 5_000,
      recoveryUntil: now + 65_000,
      spacingMs: 1_000,
      tier: 0,
      refreshRequired: true,
    });

    policy.recordRefresh(now + 5_000);
    expect(policy.nextAllowedActionAt(now + 5_000)).toBe(now + 6_000);
    policy.recordAction(now + 6_000);

    expect(policy.recordRateLimit(now + 7_000)).toBe(true);
    expect(policy.snapshot(now + 7_000)).toMatchObject({
      cooldownUntil: now + 12_000,
      recoveryUntil: now + 72_000,
      spacingMs: 3_000,
      tier: 1,
      refreshRequired: true,
    });
  });
});
