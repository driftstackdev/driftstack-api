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
