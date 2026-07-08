// Transient-infrastructure error classification.
//
// Some code paths must distinguish a TRANSIENT infra failure (a Postgres
// connectivity/contention blip, a network timeout) from a PERMANENT one (a
// validation error, a deterministic code bug). The canonical use is the
// Stripe webhook dispatcher: a permanent error is swallowed + recorded so
// Stripe stops retrying a doomed event, but a transient error must be
// RE-THROWN so the route returns non-2xx and Stripe re-delivers (its retry
// window is ~3 days) — otherwise a one-second DB blip during
// checkout.session.completed leaves a paying customer un-upgraded with no
// automated recovery.
//
// The check walks `err` AND its `.cause` chain (drizzle-orm 0.45 and
// undici both wrap the original error under `.cause`), mirroring the
// bounded cause-walk in lib/pg-error.ts. It is an explicit ALLOWLIST: only
// codes/names known to be retry-safe transient return true, so an
// unclassified error still falls to the caller's default (swallow), never
// a blind retry storm.

// Postgres SQLSTATE classes/values that are transient + retry-safe:
//   08xxx connection_exception, 53xxx insufficient_resources,
//   57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now,
//   40001 serialization_failure, 40P01 deadlock_detected,
//   55P03 lock_not_available.
const TRANSIENT_SQLSTATE_PREFIXES = ['08', '53'];
const TRANSIENT_SQLSTATE_EXACT = new Set(['57P01', '57P02', '57P03', '40001', '40P01', '55P03']);

// postgres-js driver + node/undici network error codes.
const TRANSIENT_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const TRANSIENT_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'ConnectTimeoutError',
  'SocketError',
]);

function codeIsTransient(code: string): boolean {
  if (TRANSIENT_CODES.has(code)) return true;
  if (TRANSIENT_SQLSTATE_EXACT.has(code)) return true;
  return TRANSIENT_SQLSTATE_PREFIXES.some((p) => code.startsWith(p) && /^[0-9A-Z]{5}$/.test(code));
}

/**
 * True iff `err` (or anything in its bounded `.cause` chain) is a known
 * transient infrastructure failure that is safe to retry. Allowlist-only:
 * an unrecognised error returns false so the caller keeps its default
 * handling rather than retrying blindly.
 */
export function isTransientInfraError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const obj = current as Record<string, unknown>;
    const code = obj.code;
    if (typeof code === 'string' && codeIsTransient(code)) return true;
    const name = obj.name;
    if (typeof name === 'string' && TRANSIENT_NAMES.has(name)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
