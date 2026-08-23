// V-820 — unit tests for the FleetNodeAuth JWT verifier (foundation
// slice; route + Drizzle backing land in follow-up).

import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { FleetNodeAuthImpl, InMemoryFleetNodesRepo } from '../../src/services/fleet-node-auth.js';
import { InMemoryFleetNonceCache } from '../../src/services/fleet-nonce-cache.js';

const subtle = webcrypto.subtle;

function base64UrlFromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlFromString(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

type EdKey = Awaited<ReturnType<typeof subtle.importKey>>;

interface KeyPair {
  publicKeyBase64Url: string;
  privateKey: EdKey;
}

async function makeKeyPair(): Promise<KeyPair> {
  const pair = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as {
    publicKey: EdKey;
    privateKey: EdKey;
  };
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { publicKeyBase64Url: base64UrlFromBytes(pub), privateKey: pair.privateKey };
}

async function signJwt(privateKey: EdKey, claims: Record<string, unknown>): Promise<string> {
  const header = base64UrlFromString(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const payload = base64UrlFromString(JSON.stringify(claims));
  const message = new TextEncoder().encode(`${header}.${payload}`);
  const sig = new Uint8Array(await subtle.sign('Ed25519', privateKey, message));
  return `${header}.${payload}.${base64UrlFromBytes(sig)}`;
}

describe('V-820 FleetNodeAuthImpl.verify', () => {
  const NODE_ID = '00000000-0000-4000-8000-000000000fff';
  const NOW = new Date('2026-05-16T00:00:00Z');
  const NOW_S = Math.floor(NOW.getTime() / 1000);

  let repo: InMemoryFleetNodesRepo;
  let auth: FleetNodeAuthImpl;
  let pair: KeyPair;

  beforeAll(async () => {
    pair = await makeKeyPair();
    repo = new InMemoryFleetNodesRepo();
    repo.register(NODE_ID, pair.publicKeyBase64Url);
    auth = new FleetNodeAuthImpl(repo);
  });

  it('valid signed JWT → ok=true + decoded claims', async () => {
    const jwt = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S,
      exp: NOW_S + 60,
      nonce: 'abc',
    });
    const res = await auth.verify(jwt, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('type narrow');
    expect(res.claims.iss).toBe(NODE_ID);
    expect(res.claims.nonce).toBe('abc');
  });

  it('malformed (not 3 parts) → ok=false reason malformed', async () => {
    const res = await auth.verify('not.a.real.jwt', NOW);
    expect(res).toEqual({ ok: false, reason: 'malformed' });
  });

  it('unknown node_id → ok=false reason unknown_node', async () => {
    const jwt = await signJwt(pair.privateKey, {
      iss: '00000000-0000-4000-8000-deadbeefdead',
      sub: '00000000-0000-4000-8000-deadbeefdead',
      iat: NOW_S,
      exp: NOW_S + 60,
      nonce: 'x',
    });
    const res = await auth.verify(jwt, NOW);
    expect(res).toEqual({ ok: false, reason: 'unknown_node' });
  });

  it('revoked node → ok=false reason revoked_node', async () => {
    const revokedId = '00000000-0000-4000-8000-000000000aaa';
    repo.register(revokedId, pair.publicKeyBase64Url);
    repo.revoke(revokedId, new Date('2026-05-15T00:00:00Z'));
    const jwt = await signJwt(pair.privateKey, {
      iss: revokedId,
      sub: revokedId,
      iat: NOW_S,
      exp: NOW_S + 60,
      nonce: 'x',
    });
    const res = await auth.verify(jwt, NOW);
    expect(res).toEqual({ ok: false, reason: 'revoked_node' });
  });

  it('iss/sub mismatch → ok=false reason iss_sub_mismatch', async () => {
    const jwt = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: '00000000-0000-4000-8000-000000000bbb',
      iat: NOW_S,
      exp: NOW_S + 60,
      nonce: 'x',
    });
    const res = await auth.verify(jwt, NOW);
    expect(res).toEqual({ ok: false, reason: 'iss_sub_mismatch' });
  });

  it('expired JWT → ok=false reason expired', async () => {
    const jwt = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S - 200, // 200s ago — well within the 300s cap
      exp: NOW_S - 1, // expired 1s ago
      nonce: 'x',
    });
    const res = await auth.verify(jwt, NOW);
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  it('too-long-lived JWT (exp - iat > 300s) → ok=false reason too_long_lived (defeats fleet-node compromise via stolen long-lived JWT)', async () => {
    const jwt = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S,
      exp: NOW_S + 3600, // 1 hour — over the 300s cap.
      nonce: 'x',
    });
    const res = await auth.verify(jwt, NOW);
    expect(res).toEqual({ ok: false, reason: 'too_long_lived' });
  });

  it('future-dated iat with exp=iat+300 (delta passes) → ok=false reason future_iat (cannot disguise a far-future long-lived token as fresh)', async () => {
    const jwt = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S + 3600, // minted "1 hour ahead"
      exp: NOW_S + 3600 + 300, // exp - iat = 300 (within the delta cap) but far from NOW
      nonce: 'x',
    });
    const res = await auth.verify(jwt, NOW);
    expect(res).toEqual({ ok: false, reason: 'future_iat' });
  });

  it('exp more than the lifetime cap from NOW, even with a not-future iat → ok=false too_long_lived', async () => {
    const jwt = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S - 100, // valid (past) iat
      // V-1393 — this token's DELTA is 3700s, so the iat→exp cap answers first. The
      // comment here used to credit the absolute-window check; measured, that check is
      // unreachable (see the arm at the end of this block).
      exp: NOW_S + 3600,
      nonce: 'x',
    });
    const res = await auth.verify(jwt, NOW);
    expect(res).toEqual({ ok: false, reason: 'too_long_lived' });
  });

  // ── the edges of the two lifetime checks ────────────────────────────────────
  //
  // The arms above accept at exp = NOW + 60 and reject at a delta of 3600, against a
  // 300-second cap. 240 seconds inside and 3300 outside — nowhere near either edge.
  //
  // MEASURED: raising MAX_JWT_LIFETIME_SECONDS from 300 to 3000, a TENFOLD widening of
  // the window a stolen node JWT stays usable in, left all 24 fleet-node auth tests
  // green. 60 is still under 3000 and 3600 is still over it, so every existing arm
  // agrees with a cap ten times too generous.
  //
  // There are TWO caps and each has its own edge: the iat→exp DELTA
  // (`exp - iat > MAX`) and the absolute window from now
  // (`exp - now > MAX + CLOCK_SKEW`). Both comparisons are exclusive, so the edge
  // itself is inside. Widening either one lengthens how long a compromised node
  // keeps authenticating off one signature.
  it('a JWT whose lifetime is EXACTLY the cap is accepted. The comparison is exclusive, so 300 is legal — pinning it means a narrowing to 299 fails here rather than quietly rejecting nodes that are behaving correctly.', async () => {
    const jwt = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S,
      exp: NOW_S + 300,
      nonce: 'edge-ok',
    });
    const res = await auth.verify(jwt, NOW);
    expect(res.ok, 'a JWT with exactly the maximum lifetime was refused').toBe(true);
  });

  it('one second OVER the cap is refused. With the arm above this brackets the delta check — and a widened cap is the direction that matters, because it extends the window a stolen node JWT stays usable in.', async () => {
    const jwt = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S,
      exp: NOW_S + 301,
      nonce: 'edge-bad',
    });
    const res = await auth.verify(jwt, NOW);
    expect(res).toEqual({ ok: false, reason: 'too_long_lived' });
  });

  // ⚠️ The ABSOLUTE window's own edge interlocks with the other two checks, and the
  // first attempt at this arm failed because of it. To sit exactly at
  // `exp - now == MAX + CLOCK_SKEW` the token needs `iat == now + CLOCK_SKEW`: any
  // earlier iat pushes the iat→exp DELTA over its own cap and the delta check fires
  // first, any later one trips `future_iat`. So there is exactly ONE shape at that
  // edge, and one second beyond it is unreachable in isolation — the delta check or
  // future_iat always decides first. The out-from-further arm above
  // ("exp more than the lifetime cap from NOW") is what covers the absolute check's
  // reject side; this covers its accept side, which nothing did.
  it('the ABSOLUTE window edge is accepted in its one reachable shape: iat exactly at the clock-skew allowance and exp exactly MAX + CLOCK_SKEW from now. Narrowing either constant refuses a node that is behaving correctly, and this is the only token that can prove the boundary is where the constants say.', async () => {
    const jwt = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S + 60, // exactly CLOCK_SKEW_SECONDS ahead — future_iat is exclusive
      exp: NOW_S + 60 + 300, // delta exactly MAX; exp - now exactly MAX + CLOCK_SKEW
      nonce: 'abs-edge',
    });
    const res = await auth.verify(jwt, NOW);
    expect(res.ok, 'a JWT at the absolute-window edge was refused').toBe(true);
  });

  // CLOCK_SKEW_SECONDS needs its own bracket, and the accept-side arm above cannot
  // provide it: a token at iat = now + 60 stays inside a WIDER allowance too, so
  // widening the skew tenfold left it green. This is the reject side, one second past
  // the allowance — the arm that makes the skew constant mean 60 rather than "some
  // number at least 60". A generous skew is a real weakening: it is how far into the
  // future a node may date a token, and every second of it extends the window a
  // pre-minted token stays usable in.
  it('an iat ONE SECOND past the clock-skew allowance is refused as future_iat. The existing future-iat arm dates the token an hour ahead, which passes any skew under an hour — this is the one that pins the allowance itself.', async () => {
    const jwt = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S + 61, // CLOCK_SKEW_SECONDS is 60, and the check is exclusive
      exp: NOW_S + 61 + 300, // delta exactly at the cap, so the delta check passes first
      nonce: 'skew-bad',
    });
    const res = await auth.verify(jwt, NOW);
    expect(res).toEqual({ ok: false, reason: 'future_iat' });
  });

  // V-1393 — and the absolute-window check cannot fire at all.
  //
  // Measured: replacing `exp - now > MAX + CLOCK_SKEW` with `false` leaves all 22 arms in
  // this file green. That is not a coverage gap, it is arithmetic. Anything reaching that
  // line has already cleared the two checks above it:
  //
  //     exp - iat <= MAX        (the delta cap)
  //     iat       <= now + SKEW (the future-iat allowance)
  //   ⟹ exp - now <= MAX + SKEW
  //
  // which is exactly the threshold it tests with `>`. The comment beside it argues for its
  // existence against a future-dated iat — a case the future-iat check now takes first.
  //
  // So the property worth holding is not that it fires; it is that no route to it exists.
  // This arm walks both directions out of the extremal accepted token.
  //
  // ⚠️ Only ONE of the two is attributable, and the reason is the subsumption itself.
  // Pushing `iat` is answered by `future_iat`, a distinct reason — measured, widening
  // CLOCK_SKEW_SECONDS reds that half. Pushing `exp` is answered by `too_long_lived`, which
  // is the reason BOTH lifetime checks return: disabling the delta cap leaves this arm green
  // because the absolute check then answers with the same string. That indistinguishability
  // is what "subsumed" looks like from outside, so the arm asserts the refusal without
  // claiming to name which line produced it.
  it('CRITICAL from the extremal accepted token, every direction that would push exp past the absolute window is already refused. Pushing iat is refused as future_iat specifically, which pins the skew allowance; pushing exp is refused as too_long_lived, the reason BOTH lifetime checks share — so that half brackets the boundary without attributing it.', async () => {
    // The accepted edge, as the arm above establishes: iat at the skew allowance, delta at
    // the cap, so exp - now is exactly MAX + CLOCK_SKEW.
    const oneSecondMoreExp = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S + 60,
      exp: NOW_S + 60 + 301, // exp - now = MAX + SKEW + 1, but the DELTA is now 301
      nonce: 'window-exp',
    });
    expect(
      await auth.verify(oneSecondMoreExp, NOW),
      'pushing exp past the window must be refused; either lifetime check answers too_long_lived',
    ).toEqual({ ok: false, reason: 'too_long_lived' });

    const oneSecondMoreIat = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S + 61, // one past the skew allowance
      exp: NOW_S + 61 + 300, // delta still exactly at the cap
      nonce: 'window-iat',
    });
    expect(
      await auth.verify(oneSecondMoreIat, NOW),
      'pushing iat is answered by the skew allowance, a reason no lifetime check returns',
    ).toEqual({ ok: false, reason: 'future_iat' });
  });

  it('signature signed by a different key → ok=false reason signature_invalid', async () => {
    const otherPair = await makeKeyPair();
    const jwt = await signJwt(otherPair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S,
      exp: NOW_S + 60,
      nonce: 'x',
    });
    const res = await auth.verify(jwt, NOW);
    expect(res).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('replay defence: with FleetNonceCache wired, a second JWT carrying the same (iss, nonce) → ok=false reason replayed_nonce; first JWT still passes', async () => {
    const nonceCache = new InMemoryFleetNonceCache(() => NOW);
    const replayAuth = new FleetNodeAuthImpl(repo, nonceCache);
    const jwt = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S,
      exp: NOW_S + 60,
      nonce: 'replay-target',
    });
    const first = await replayAuth.verify(jwt, NOW);
    expect(first.ok).toBe(true);
    // Same JWT again → replay rejected.
    const second = await replayAuth.verify(jwt, NOW);
    expect(second).toEqual({ ok: false, reason: 'replayed_nonce' });
  });

  it('replay defence: a DIFFERENT nonce from the same node still accepts (cache scope is per-(iss, nonce), not per-node)', async () => {
    const nonceCache = new InMemoryFleetNonceCache(() => NOW);
    const replayAuth = new FleetNodeAuthImpl(repo, nonceCache);
    const jwtA = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S,
      exp: NOW_S + 60,
      nonce: 'fresh-1',
    });
    const jwtB = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S,
      exp: NOW_S + 60,
      nonce: 'fresh-2',
    });
    expect((await replayAuth.verify(jwtA, NOW)).ok).toBe(true);
    expect((await replayAuth.verify(jwtB, NOW)).ok).toBe(true);
  });

  it('replay defence: nonce-cache write happens AFTER signature verification (a JWT that fails signature does not poison the cache; a subsequent valid JWT with the same nonce still passes)', async () => {
    const nonceCache = new InMemoryFleetNonceCache(() => NOW);
    const replayAuth = new FleetNodeAuthImpl(repo, nonceCache);

    // First: a JWT signed by the WRONG key → signature_invalid.
    const otherPair = await makeKeyPair();
    const wrongSigJwt = await signJwt(otherPair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S,
      exp: NOW_S + 60,
      nonce: 'poisoned-test',
    });
    expect((await replayAuth.verify(wrongSigJwt, NOW)).ok).toBe(false);

    // Second: the SAME nonce but properly signed → passes (cache was
    // never written for the failing signature path).
    const validJwt = await signJwt(pair.privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: NOW_S,
      exp: NOW_S + 60,
      nonce: 'poisoned-test',
    });
    expect((await replayAuth.verify(validJwt, NOW)).ok).toBe(true);
  });
});
