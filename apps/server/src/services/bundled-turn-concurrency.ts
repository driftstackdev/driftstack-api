// Billing-integrity hardening — per-account concurrent bundled-LLM-turn
// limiter.
//
// The bundled-LLM soft-cap gate in routes/agent-sessions.ts reads
// sumMonthlySpendCents() then compares spent >= cap, and the cost row is
// only inserted AFTER the turn completes (db/agent-decomposer-usage-
// recorder.ts). N concurrent turns for the same account therefore all
// read the same pre-increment spend, all pass the gate, and all run on
// the deployment's bundled Anthropic key — overspending the cap (the
// deployment's own Anthropic bill) by up to N turns (a TOCTOU race).
//
// This bounds N: only `maxConcurrentPerAccount` bundled turns may be
// in-flight for one account at once. The overshoot past the cap is then
// at most (maxConcurrent - 1) turns x the flat per-turn cost, instead of
// unbounded. A 429 ConcurrencyLimitError tells the client to retry once
// an in-flight turn finishes. This is the lower-risk fix from the audit
// (no migration, no transaction on the hot turn path, no reservation row
// to leak if a turn crashes).
//
// In-process + per-instance. Single-replica deploys today; a horizontal
// scale-out would want a Redis counter, but per-instance bounding still
// caps each instance's own overshoot and the slot is ALWAYS released in a
// finally (even on a thrown turn), so a crash can't leak a slot.

export class BundledTurnConcurrencyLimiter {
  private readonly inFlight = new Map<string, number>();
  private readonly maxConcurrentPerAccount: number;

  constructor(maxConcurrentPerAccount = 3) {
    if (maxConcurrentPerAccount < 1) {
      throw new Error('maxConcurrentPerAccount must be >= 1');
    }
    this.maxConcurrentPerAccount = maxConcurrentPerAccount;
  }

  /** The configured per-account ceiling (read-only; for the 429 detail). */
  get limit(): number {
    return this.maxConcurrentPerAccount;
  }

  /** Current in-flight bundled turns for an account (0 when none). */
  current(accountId: string): number {
    return this.inFlight.get(accountId) ?? 0;
  }

  /**
   * Atomically reserve a slot for one bundled turn. Returns true on
   * success (caller MUST call release(accountId) in a finally), or false
   * when the account is already at its ceiling (caller should 429 and
   * NOT run the turn / consume the bundled key). Synchronous so the
   * check-and-increment can't be interleaved by another awaited turn on
   * the same event-loop tick (Node is single-threaded; no await between
   * read and write here).
   */
  tryAcquire(accountId: string): boolean {
    const cur = this.inFlight.get(accountId) ?? 0;
    if (cur >= this.maxConcurrentPerAccount) return false;
    this.inFlight.set(accountId, cur + 1);
    return true;
  }

  /** Release a previously-acquired slot. Idempotent at zero (never goes
   *  negative); deletes the map entry at zero to bound memory. */
  release(accountId: string): void {
    const cur = this.inFlight.get(accountId) ?? 0;
    if (cur <= 1) {
      this.inFlight.delete(accountId);
      return;
    }
    this.inFlight.set(accountId, cur - 1);
  }
}
