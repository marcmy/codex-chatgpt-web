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
 * One visible dialog is one incident until the post-cooldown refresh occurs. A later dialog after
 * that refresh is a new incident and advances the recovery spacing, capped at ten minutes. Thirty
 * clean minutes from the latest incident reset the policy completely.
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
    this.recoveryUntil = now + CHATGPT_RATE_LIMIT_RECOVERY_MS;
    this.refreshRequired = true;
    this.incidentLatched = true;
    this.lastActionAt = undefined;
    return true;
  }

  /** Records the single refresh that ends hard cooldown and arms recovery spacing. */
  recordRefresh(now = Date.now()): void {
    this.resetIfRecovered(now);
    if (this.tier < 0) return;
    if (!this.refreshRequired) {
      throw new Error("ChatGPT rate-limit recovery refresh was already recorded");
    }
    if (now < this.cooldownUntil) {
      throw new Error("ChatGPT rate-limit recovery refresh cannot run during hard cooldown");
    }

    this.refreshRequired = false;
    this.incidentLatched = false;
    this.lastActionAt = now;
  }

  /** Records a later ChatGPT website mutation after the required refresh. */
  recordAction(now = Date.now()): void {
    this.resetIfRecovered(now);
    if (this.tier < 0) return;
    if (this.refreshRequired) {
      throw new Error("ChatGPT rate-limit recovery requires its refresh before other website actions");
    }
    this.lastActionAt = now;
  }

  /** Earliest time the next permitted website mutation may begin. */
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

/** Shared by every browser worker in this process because ChatGPT throttles the signed-in account. */
export const chatGptRateLimitBackoffPolicy = new ChatGptRateLimitBackoffPolicy();
