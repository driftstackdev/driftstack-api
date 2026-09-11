// V-667.C — OAuth-CLIENT state-token sign/verify.
//
// The state parameter on the OAuth-authorize redirect serves two
// purposes: (1) CSRF defense — bind the in-flight authorize attempt
// to the calling browser session so an attacker can't replay a code
// they trick the user into requesting; (2) carry per-attempt
// metadata (which provider, where to redirect after success).
//
// Format: `<base64url-payload>.<base64url-hmac-sha256>`. The HMAC
// is keyed on `OAUTH_CLIENT_STATE_SIGNING_SECRET` (env-derived,
// same shape as the existing auth-token signing secrets).
//
// Why not the existing oauth-pkce.ts lib? That handles the
// challenge/verifier round-trip. The state token carries DIFFERENT
// data (provider id + redirect_to + nonce) and is OURS — both ends
// are server-side. PKCE binds the code; state binds the request.
//
// Lifetime: short (5 min default). The token is only in-flight
// between the authorize-redirect issue + the callback land. Anything
// longer is suspicious — the user's browser session shouldn't take
// more than a few minutes to round-trip an IDP authorize page.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OAuthClientProvider } from './oauth-client-providers.js';

const DEFAULT_TTL_SECONDS = 300; // 5 minutes

export interface OAuthClientStatePayload {
  /** Which IDP this authorize is targeting. */
  provider: OAuthClientProvider;
  /** Where to redirect the dashboard after success. Required (the
   *  dashboard's job is to know where to land after sign-in). */
  redirectTo: string;
  /** Random per-attempt nonce — defense against replay. */
  nonce: string;
  /** Unix-epoch-seconds issue time. The verifier rejects payloads
   *  older than ttlSeconds. */
  iat: number;
  /** 2026-09-11 (cookie-free OAuth v2) — base64url(SHA-256(flow_secret)).
   *  The dashboard mints `flow_secret` in first-party localStorage before
   *  navigating to the IDP and sends only this digest to /start; the
   *  top-level callback carries it into the hand-off record and /redeem
   *  proves the preimage. Its PRESENCE is the signed v2 marker: a state
   *  without it was minted for an old bundle's cookie flow and takes the
   *  legacy forward. Optional so states minted before the deploy still
   *  verify. */
  bind?: string;
}

export interface SignStateOpts {
  provider: OAuthClientProvider;
  redirectTo: string;
  signingSecret: string;
  /** Override for tests. */
  nowMs?: number;
  /** Override for tests — fixed nonce. */
  nonce?: string;
  /** v2 flow-secret digest; omitted for the legacy cookie flow. */
  bind?: string;
}

/**
 * Mint a signed state token. The returned string goes directly into
 * the authorize-URL's `state` param.
 */
/**
 * Minimum signing-secret length, shared by the signing and verifying halves.
 *
 * V-1466 — it was a bare `32` in the signing guard and the verifying half had no
 * guard at all. Now that both enforce it, one home rather than two literals: the
 * value is fixed by `config.oauthClient.signingSecret`'s `z.string().min(32)`,
 * and a copy that drifts from that schema is a bug in the copy.
 */
const MIN_SIGNING_SECRET_LENGTH = 32;

export function signOauthClientState(opts: SignStateOpts): string {
  if (!opts.signingSecret || opts.signingSecret.length < MIN_SIGNING_SECRET_LENGTH) {
    throw new TypeError('signingSecret must be ≥32 chars');
  }
  const payload: OAuthClientStatePayload = {
    provider: opts.provider,
    redirectTo: opts.redirectTo,
    nonce: opts.nonce ?? randomNonce(),
    iat: Math.floor((opts.nowMs ?? Date.now()) / 1000),
    ...(opts.bind !== undefined ? { bind: opts.bind } : {}),
  };
  const encodedPayload = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = createHmac('sha256', opts.signingSecret).update(encodedPayload).digest();
  return `${encodedPayload}.${toBase64Url(signature)}`;
}

export interface VerifyStateOpts {
  token: string;
  signingSecret: string;
  /** Override for tests. */
  nowMs?: number;
  /** TTL in seconds; default 300 (5 min). */
  ttlSeconds?: number;
}

export type VerifyStateResult =
  | { kind: 'ok'; payload: OAuthClientStatePayload }
  | { kind: 'malformed' }
  | { kind: 'bad-signature' }
  | { kind: 'expired' };

/**
 * Verify + decode a state token. The result is a tagged union so the
 * route layer can map each failure mode to a distinct response (404
 * vs 401 vs explicit retry-prompt) without the lib leaking the
 * difference via thrown exception types.
 */
export function verifyOauthClientState(opts: VerifyStateOpts): VerifyStateResult {
  const parts = opts.token.split('.');
  if (parts.length !== 2) return { kind: 'malformed' };
  const [encodedPayload, signaturePart] = parts;
  if (!encodedPayload || !signaturePart) return { kind: 'malformed' };

  // V-1466 — refuse before hashing when the signing secret is absent or too
  // short, matching `signOauthClientState` above.
  //
  // Node's HMAC accepts an EMPTY key and returns a good digest, so without this
  // a state forged as `HMAC-SHA256('', payload)` verified as genuine — measured,
  // it returned `{ kind: 'ok' }` with attacker-chosen `provider`, `redirectTo`
  // and `nonce`, which is the CSRF token for the OAuth callback.
  //
  // The signing half of this module has always enforced the same rule; only the
  // verifying half was missing it. `config.oauthClient.signingSecret` is
  // `z.string().min(32)`, so an empty value cannot arrive from the environment
  // today and this is defence in depth — but the function is exported and any
  // caller that does not route through that schema gets the guard now.
  //
  // Returns `bad-signature` rather than a new union member: the tagged union is
  // pinned across several files and the route maps each kind to a distinct
  // response, so widening it to describe a server misconfiguration would change
  // customer-visible behaviour for a case that should never reach a customer.
  if (!opts.signingSecret || opts.signingSecret.length < MIN_SIGNING_SECRET_LENGTH) {
    return { kind: 'bad-signature' };
  }

  // Recompute the HMAC and compare in constant time.
  const expected = createHmac('sha256', opts.signingSecret).update(encodedPayload).digest();
  let received: Buffer;
  try {
    received = fromBase64Url(signaturePart);
  } catch {
    return { kind: 'malformed' };
  }
  if (received.length !== expected.length) return { kind: 'bad-signature' };
  if (!timingSafeEqual(received, expected)) return { kind: 'bad-signature' };

  // Decode payload.
  let payload: OAuthClientStatePayload;
  try {
    const raw = fromBase64Url(encodedPayload).toString('utf8');
    payload = JSON.parse(raw) as OAuthClientStatePayload;
  } catch {
    return { kind: 'malformed' };
  }
  if (
    typeof payload.provider !== 'string' ||
    typeof payload.redirectTo !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.iat !== 'number'
  ) {
    return { kind: 'malformed' };
  }
  // v2 marker: absent (legacy) or a string. Checked apart from the block above
  // so the pinned 4-field shape stays byte-identical; a non-string `bind`
  // cannot be a signed digest and is refused rather than read as legacy.
  if (payload.bind !== undefined && typeof payload.bind !== 'string') {
    return { kind: 'malformed' };
  }

  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (nowSec > payload.iat + ttl) return { kind: 'expired' };

  return { kind: 'ok', payload };
}

// ─── helpers ──────────────────────────────────────────────────────

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Buffer {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function randomNonce(): string {
  return randomBytes(16).toString('hex');
}
