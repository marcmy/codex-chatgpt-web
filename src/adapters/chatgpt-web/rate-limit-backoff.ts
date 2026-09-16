export interface ChatGptRateLimitBackoffSnapshot {
  cooldownUntil: number;
  recoveryUntil: number;
  spacingMs: number;
  tier: number;
  refreshRequired: boolean;
}

export class ChatGptRateLimitBackoffPolicy {
  recordRateLimit(_now = Date.now()): void {}

  snapshot(_now = Date.now()): ChatGptRateLimitBackoffSnapshot {
    return {
      cooldownUntil: 0,
      recoveryUntil: 0,
      spacingMs: 0,
      tier: -1,
      refreshRequired: false,
    };
  }

  recordAction(_now = Date.now()): void {}

  nextAllowedActionAt(now = Date.now()): number {
    return now;
  }
}
