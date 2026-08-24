// V-667.C — unit tests for OAuth-client state-token sign/verify.

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signOauthClientState, verifyOauthClientState } from '../../src/lib/oauth-client-state.js';

const SECRET = 'x'.repeat(48); // ≥32 chars per lib min
const BASE = {
  provider: 'google' as const,
  redirectTo: 'https://app.driftstack.dev/billing',
  signingSecret: SECRET,
  nowMs: 1_715_000_000_000,
  nonce: 'fixed-nonce-1234',
};

describe('signOauthClientState', () => {
  it('produces a 2-part base64url.signature string', () => {
    const token = signOauthClientState(BASE);
    const parts = token.split('.');
    expect(parts.length).toBe(2);
    expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('deterministic when nowMs + nonce are fixed', () => {
    const t1 = signOauthClientState(BASE);
    const t2 = signOauthClientState(BASE);
    expect(t1).toBe(t2);
  });

  it('different nonce → different signature', () => {
    const t1 = signOauthClientState({ ...BASE, nonce: 'a' });
    const t2 = signOauthClientState({ ...BASE, nonce: 'b' });
    expect(t1).not.toBe(t2);
  });

  it('rejects short signing secret (<32 chars)', () => {
    expect(() => signOauthClientState({ ...BASE, signingSecret: 'short' })).toThrow(TypeError);
  });
});

describe('verifyOauthClientState', () => {
  it('round-trips a fresh token to payload', () => {
    const token = signOauthClientState(BASE);
    const res = verifyOauthClientState({ token, signingSecret: SECRET, nowMs: BASE.nowMs });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.payload.provider).toBe('google');
      expect(res.payload.redirectTo).toBe(BASE.redirectTo);
      expect(res.payload.nonce).toBe(BASE.nonce);
      expect(res.payload.iat).toBe(1_715_000_000);
    }
  });

  it('malformed token (no dot) → kind: malformed', () => {
    const res = verifyOauthClientState({ token: 'notatoken', signingSecret: SECRET });
    expect(res.kind).toBe('malformed');
  });

  it('tampered payload → kind: bad-signature', () => {
    const token = signOauthClientState(BASE);
    const [_, sig] = token.split('.');
    const tampered = 'eyJtYWxpY2lvdXMiOnRydWV9' + '.' + sig; // valid base64url but different payload
    const res = verifyOauthClientState({ token: tampered, signingSecret: SECRET });
    expect(res.kind).toBe('bad-signature');
  });

  // V-1466 — the VERIFYING half now enforces the same secret rule the signing
  // half always has. Node's HMAC accepts an empty key and returns a good digest,
  // so a state forged as `HMAC-SHA256('', payload)` used to return
  // `{ kind: 'ok' }` with attacker-chosen provider, redirectTo and nonce — the
  // CSRF token for the OAuth callback. The arm named "rejects short signing
  // secret" covers only the SIGNING side, which throws.
  it('CRITICAL an absent or short signing secret refuses a state forged with that same key', () => {
    const payload = {
      provider: 'google',
      redirectTo: '/dashboard',
      nonce: 'abcdef0123456789',
      iat: Math.floor(Date.now() / 1000),
    };
    const b64u = (b: Buffer): string =>
      b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const encoded = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));

    for (const weak of ['', 'x'.repeat(31)]) {
      const forged = `${encoded}.${b64u(createHmac('sha256', weak).update(encoded).digest())}`;
      expect(
        verifyOauthClientState({ token: forged, signingSecret: weak }).kind,
        `a ${weak.length}-char signing secret must not validate a state signed with it`,
      ).toBe('bad-signature');
    }
  });

  it('signed with wrong secret → kind: bad-signature', () => {
    const token = signOauthClientState(BASE);
    const res = verifyOauthClientState({ token, signingSecret: 'wrong'.repeat(10) });
    expect(res.kind).toBe('bad-signature');
  });

  it('expired token (>5min by default) → kind: expired', () => {
    const token = signOauthClientState(BASE);
    const sixMinLater = BASE.nowMs + 6 * 60 * 1000;
    const res = verifyOauthClientState({ token, signingSecret: SECRET, nowMs: sixMinLater });
    expect(res.kind).toBe('expired');
  });

  it('respects custom ttlSeconds (10s example, 30s later → expired)', () => {
    const token = signOauthClientState(BASE);
    const thirtySecLater = BASE.nowMs + 30 * 1000;
    const res = verifyOauthClientState({
      token,
      signingSecret: SECRET,
      nowMs: thirtySecLater,
      ttlSeconds: 10,
    });
    expect(res.kind).toBe('expired');
  });

  it('provider narrow type preserved through round-trip', () => {
    const token = signOauthClientState({ ...BASE, provider: 'github' });
    const res = verifyOauthClientState({ token, signingSecret: SECRET, nowMs: BASE.nowMs });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.payload.provider).toBe('github');
  });
});

// V-1403 — a signature of the WRONG LENGTH, which is the one shape the arms above
// never produce. "tampered payload" keeps the signature intact and "wrong secret"
// still yields a full-width HMAC, so both reach the compare with 32 bytes on each
// side. Branch coverage agreed: the length guard one line above that compare had
// never been taken.
//
// It is not redundant. `fromBase64Url` ends in `Buffer.from(s, 'base64')`, which does
// not reject out-of-alphabet or short input — it decodes what it can and returns a
// shorter Buffer. So the signature part of a `state` query parameter, which is chosen
// by whoever sends the browser to the callback, decides the length of `received`. The
// line below it is `timingSafeEqual`, which raises `RangeError: Input buffers must
// have the same byte length` rather than returning false.
//
// What the guard protects is this module's stated contract, quoted from its own doc:
// the result is "a tagged union so the route layer can map each failure mode to a
// distinct response (404 vs 401 vs explicit retry-prompt) without the lib leaking the
// difference via thrown exception types". A RangeError escaping verify IS that leak,
// and it arrives on the callback path as a 500.
describe('verifyOauthClientState — a signature that decodes to the wrong length', () => {
  const payloadOf = (): string => {
    const part = signOauthClientState(BASE).split('.')[0];
    if (part === undefined)
      throw new Error('unreachable: signOauthClientState returned no payload');
    return part;
  };

  it('CONTROL the genuine token still verifies, so the arms below are not satisfied by a verifier that refuses everything', () => {
    const res = verifyOauthClientState({
      token: signOauthClientState(BASE),
      signingSecret: SECRET,
      nowMs: BASE.nowMs,
    });
    expect(res.kind).toBe('ok');
  });

  it.each([
    ['decodes to zero bytes', 'A'],
    ['decodes to three bytes', 'AAAA'],
    ['decodes to 31 — one short of the digest', 'A'.repeat(42)],
    ['decodes to 48 — longer than the digest', 'A'.repeat(64)],
    ['is a single padding-only character', '_'],
  ])(
    'CRITICAL a state token whose signature %s is refused as bad-signature by RETURNING. The signature part comes off the wire, `Buffer.from(..., base64)` shortens rather than rejects, and timingSafeEqual raises on a length mismatch — so without the length guard the callback answers a crafted state parameter with a 500 instead of the tagged union this module promises.',
    (_label, sig) => {
      let threw: unknown = null;
      let kind: string | null = null;
      try {
        kind = verifyOauthClientState({
          token: `${payloadOf()}.${sig}`,
          signingSecret: SECRET,
          nowMs: BASE.nowMs,
        }).kind;
      } catch (err) {
        threw = err;
      }

      expect(
        threw,
        'the module doc promises the route layer sees a tagged union, never a thrown exception type; a raise here is that promise broken on attacker-chosen input',
      ).toBeNull();
      expect(kind, 'and a wrong-length signature is a bad signature, not a malformed token').toBe(
        'bad-signature',
      );
    },
  );
});
