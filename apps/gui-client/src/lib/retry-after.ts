// How long a response asks the client to wait before asking again.
//
// GUI audit #8 / #12 — a 429 (or a 503 with Retry-After) is the server saying
// "slow down", not "stop". Pollers that ignored it either gave up on the first
// one (browser sign-in) or kept firing on their own schedule, which keeps the
// account limited. Every poller reads the header through this one parser.

/** Longest wait honoured from a single header; a larger value is clamped. */
export const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * The `Retry-After` of `res` in milliseconds — either form the header allows:
 * delta-seconds (`120`) or an HTTP date — or null when absent or unreadable.
 * Never negative; clamped to MAX_RETRY_AFTER_MS.
 */
export function retryAfterMs(res: Pick<Response, 'headers'>, nowMs = Date.now()): number | null {
  // A real Response always has headers; a structural test double may not, and
  // an unreadable header is simply "no stated wait".
  const headers = (res as { headers?: Headers | null }).headers;
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  if (raw === null) return null;
  const value = raw.trim();
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - nowMs), MAX_RETRY_AFTER_MS);
}

/** A response that means "ask again later" rather than "no". */
export function isSlowDown(res: Pick<Response, 'status' | 'headers'>): boolean {
  return res.status === 429 || (res.status === 503 && retryAfterMs(res) !== null);
}
