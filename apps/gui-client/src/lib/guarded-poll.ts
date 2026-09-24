// A poll that never overlaps itself and slows down when the server asks.
//
// GUI audit #12 — the status polls were bare `setInterval`s: each tick fired
// whether or not the previous request had come back, over an SDK that itself
// retries a 429 up to three times. Against a limited account every 5 s tick
// started a chain lasting 30 s or more, so chains piled up and the request rate
// ROSE exactly when the server asked it to fall — keeping the account limited
// and failing every other call the app made.
//
// The cadence is unchanged (the same interval, the same first tick), with two
// guards: a tick is skipped while the previous request is still out (the
// in-flight guard), and after a slow-down answer — 429, or a 503 that carries
// Retry-After — every tick is skipped until at least the server's wait has
// passed, doubling while the slow-downs continue. Any other failure keeps the
// normal cadence: a transient error is not a reason to look away for minutes.

/** The longest a poll ever holds off after slow-downs. */
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * How long a failed tick's error asks the poll to wait, in ms: 0 when it is a
 * slow-down without a stated wait, null when it is not a slow-down at all.
 * Reads the SDK's `RateLimitError.retryAfterSeconds` and the control API's
 * `AgentSessionControlError.retryAfterMs` by shape, so either module's error
 * works without importing it.
 */
export function slowDownDelayMs(err: unknown): number | null {
  if (err === null || typeof err !== 'object') return null;
  const e = err as { status?: unknown; retryAfterSeconds?: unknown; retryAfterMs?: unknown };
  const stated =
    typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0
      ? e.retryAfterMs
      : typeof e.retryAfterSeconds === 'number' &&
          Number.isFinite(e.retryAfterSeconds) &&
          e.retryAfterSeconds > 0
        ? e.retryAfterSeconds * 1000
        : null;
  if (e.status === 429) return stated ?? 0;
  if (e.status === 503 && stated !== null) return stated;
  return null;
}

export interface GuardedPollOptions {
  /** The poll's cadence. */
  intervalMs: number;
  /** Cap on a backed-off hold (default 5 min). */
  maxBackoffMs?: number;
}

/**
 * Run `tick` now and then every `intervalMs` — except while the previous tick is
 * still running, and until max(the server's wait, intervalMs × 2^n) has passed
 * after the n-th consecutive slow-down. A tick's failure is swallowed (a poll is
 * best-effort). Returns a stop function; after it no further tick starts.
 */
export function startGuardedPoll(
  tick: () => Promise<unknown>,
  opts: GuardedPollOptions,
): () => void {
  const maxBackoff = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
  let stopped = false;
  let inFlight = false;
  let notBefore = 0;
  let slowDowns = 0;
  const run = (): void => {
    if (stopped || inFlight || Date.now() < notBefore) return;
    inFlight = true;
    let pending: Promise<unknown>;
    try {
      pending = tick();
    } catch (err) {
      pending = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    void pending
      .then(
        () => {
          slowDowns = 0;
        },
        (err: unknown) => {
          const wait = slowDownDelayMs(err);
          if (wait === null) {
            slowDowns = 0;
            return;
          }
          slowDowns += 1;
          notBefore =
            Date.now() + Math.min(Math.max(wait, opts.intervalMs * 2 ** slowDowns), maxBackoff);
        },
      )
      .finally(() => {
        inFlight = false;
      });
  };
  run();
  const handle = setInterval(run, opts.intervalMs);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
