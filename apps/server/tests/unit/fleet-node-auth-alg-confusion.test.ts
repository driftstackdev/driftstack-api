// V-820 — algorithm-confusion + integrity regression suite for the
// FleetNodeAuth JWT verifier (apps/server/src/services/fleet-node-auth.ts).
//
// The verifier defends against the classic JWT attack family by HARDCODING
// `subtle.verify('Ed25519', ...)` and IGNORING the JWT header's `alg` field
// entirely — the algorithm can never be chosen by the attacker. The existing
// fleet-node-auth.test.ts covers every FleetJwtVerifyError reason + replay
// ordering, but nothing PINS the alg-confusion defense. This is the single
// most important property of any JWT verifier, and the fleet primitive is
// about to go live on the control plane (the /v1/fleet/events WSS handshake),
// so these regression tests guard against a future refactor silently
// reintroducing the vuln (e.g. `subtle.verify(headerAlg, ...)`).
//
// Pins, for a REGISTERED node (so verify() reaches the signature step):
//   1. alg:none with an empty signature segment → rejected (not accepted).
//   2. alg:none with the signature segment stripped entirely → malformed.
//   3. RS/HS-confusion: header alg "HS256" + an HMAC-SHA256 signature keyed
//      on the node's PUBLIC key bytes → rejected (verifier never does HMAC).
//   4. Integrity: a valid token whose payload is swapped after signing
//      (original signature retained) → rejected.

import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { FleetNodeAuthImpl, InMemoryFleetNodesRepo } from '../../src/services/fleet-node-auth.js';

const subtle = webcrypto.subtle;

function base64UrlFromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlFromString(s: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(s));
}

function base64UrlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

type EdKey = Awaited<ReturnType<typeof subtle.importKey>>;

describe('V-820 FleetNodeAuthImpl.verify — algorithm-confusion + integrity defense', () => {
  const NODE_ID = '00000000-0000-4000-8000-0000000000a1';
  const NOW = new Date('2026-05-16T00:00:00Z');
  const NOW_S = Math.floor(NOW.getTime() / 1000);

  let repo: InMemoryFleetNodesRepo;
  let auth: FleetNodeAuthImpl;
  let publicKeyBase64Url: string;
  let privateKey: EdKey;

  const claims = (): Record<string, unknown> => ({
    iss: NODE_ID,
    sub: NODE_ID,
    iat: NOW_S,
    exp: NOW_S + 60,
    nonce: 'alg-confusion-test',
  });

  beforeAll(async () => {
    const pair = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as {
      publicKey: EdKey;
      privateKey: EdKey;
    };
    privateKey = pair.privateKey;
    publicKeyBase64Url = base64UrlFromBytes(
      new Uint8Array(await subtle.exportKey('raw', pair.publicKey)),
    );
    repo = new InMemoryFleetNodesRepo();
    repo.register(NODE_ID, publicKeyBase64Url);
    auth = new FleetNodeAuthImpl(repo);
  });

  it('sanity: a genuine EdDSA-signed token for the registered node verifies', async () => {
    const header = base64UrlFromString(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
    const payload = base64UrlFromString(JSON.stringify(claims()));
    const sig = new Uint8Array(
      await subtle.sign('Ed25519', privateKey, new TextEncoder().encode(`${header}.${payload}`)),
    );
    const res = await auth.verify(`${header}.${payload}.${base64UrlFromBytes(sig)}`, NOW);
    expect(res.ok).toBe(true);
  });

  it('alg:none with an empty signature segment → ok=false signature_invalid (NOT accepted)', async () => {
    const header = base64UrlFromString(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = base64UrlFromString(JSON.stringify(claims()));
    // The classic alg:none forgery: header.payload. with an empty sig.
    const res = await auth.verify(`${header}.${payload}.`, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('alg:none token must never be accepted');
    expect(res.reason).toBe('signature_invalid');
  });

  it('alg:none with the signature segment stripped entirely (2 parts) → ok=false malformed', async () => {
    const header = base64UrlFromString(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = base64UrlFromString(JSON.stringify(claims()));
    const res = await auth.verify(`${header}.${payload}`, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('malformed');
  });

  it('HS256 confusion: header alg "HS256" + HMAC-SHA256 signed with the node PUBLIC key as the secret → ok=false signature_invalid', async () => {
    // The RS256→HS256 (here EdDSA→HS256) downgrade: an attacker who knows the
    // public key forges an HMAC keyed on those public bytes, betting the
    // verifier reads `alg` from the header and HMACs with the same key. The
    // verifier hardcodes Ed25519, so the HMAC is checked as an Ed25519 sig
    // (wrong length / not a valid sig) and rejected.
    const header = base64UrlFromString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64UrlFromString(JSON.stringify(claims()));
    const hmacKey = await subtle.importKey(
      'raw',
      base64UrlToBytes(publicKeyBase64Url),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const forgedSig = new Uint8Array(
      await subtle.sign('HMAC', hmacKey, new TextEncoder().encode(`${header}.${payload}`)),
    );
    const res = await auth.verify(`${header}.${payload}.${base64UrlFromBytes(forgedSig)}`, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('HS256-confusion token must never be accepted');
    expect(res.reason).toBe('signature_invalid');
  });

  it('integrity: payload swapped after signing (original signature retained) → ok=false signature_invalid', async () => {
    const header = base64UrlFromString(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
    const honestPayload = base64UrlFromString(JSON.stringify(claims()));
    const sig = new Uint8Array(
      await subtle.sign(
        'Ed25519',
        privateKey,
        new TextEncoder().encode(`${header}.${honestPayload}`),
      ),
    );
    // Tamper a field that still passes the cheap pre-signature claims gates
    // (iss===sub, exp-iat<=300, not expired) so the request actually REACHES
    // the signature step — proving the crypto, not a claims rule, rejects it.
    // (A tamper that breaks a claims rule, e.g. blowing the 300s lifetime cap,
    // is caught earlier by that rule — claims-gating precedes signature verify.)
    const tamperedPayload = base64UrlFromString(
      JSON.stringify({ ...claims(), nonce: 'tampered-after-signing' }),
    );
    const res = await auth.verify(`${header}.${tamperedPayload}.${base64UrlFromBytes(sig)}`, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('tampered payload must never be accepted');
    expect(res.reason).toBe('signature_invalid');
  });
});
