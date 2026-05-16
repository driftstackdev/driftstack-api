// V-820 / network-architecture.md — fleet-node JWT verification.
//
// Foundation slice for the cross-agent mTLS endpoint
// (`wss://fleet.driftstack.dev/v1/fleet/events`). Agent 1 is waiting
// on Agent 2 to land the auth primitive; this is the autonomously-
// safe piece (no SQL migration, no Cloudflare config — just the JWT
// verification logic + interface).
//
// Auth flow per docs/network-architecture.md §"v1 design — signed JWT
// over mTLS":
//   1. Each fleet node has a long-lived Ed25519 keypair issued at
//      provisioning time. The public key + `node_id` is registered
//      in the (future) `fleet_nodes` table.
//   2. On every connect, the fleet node generates a JWT signed with
//      its private key (`iss=sub=<node_id>`, 5-min `exp`, per-request
//      `nonce`).
//   3. The control plane verifies the JWT against the public key on
//      record. Reject on mismatch, expiry, revocation, or replayed
//      nonce.
//
// Out of scope (follow-up slices):
//   - `fleet_nodes` Drizzle schema + migration (Tier-2 founder review).
//   - Nonce cache (Redis-backed; trivial extension here).
//   - mTLS layer (Cloudflare Authenticated Origin Pulls — infra).
//   - The WebSocket `/v1/fleet/events` route itself (waits for the
//     above).

import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;

/** Plain-JS shape of the JWT body. */
export interface FleetNodeJwtClaims {
  /** `node_id` UUID — both issuer and subject (self-authenticating). */
  iss: string;
  sub: string;
  /** Issue time (seconds since epoch). */
  iat: number;
  /** Expiry time (seconds since epoch). MUST be `<= iat + 300`. */
  exp: number;
  /** Per-request random — control plane caches issued nonces for
   *  the JWT lifetime to defeat replay. */
  nonce: string;
}

export interface FleetNodePublicKey {
  /** Base64url-encoded 32-byte Ed25519 public key. */
  publicKeyBase64Url: string;
  /** When the node was provisioned. */
  registeredAt: Date;
  /** Set when an operator marks the node revoked — JWT verification
   *  always fails after this is non-null. */
  revokedAt: Date | null;
}

/** Lookup hook the JWT verifier uses — backed by the future
 *  `fleet_nodes` table; an InMemory variant ships here for tests. */
export interface FleetNodesRepo {
  getPublicKey(nodeId: string): Promise<FleetNodePublicKey | null>;
}

export type FleetJwtVerifyError =
  | 'malformed'
  | 'unknown_node'
  | 'revoked_node'
  | 'signature_invalid'
  | 'expired'
  | 'too_long_lived'
  | 'iss_sub_mismatch';

export type FleetJwtVerifyResult =
  | { ok: true; claims: FleetNodeJwtClaims }
  | { ok: false; reason: FleetJwtVerifyError };

export interface FleetNodeAuth {
  verify(rawJwt: string, now?: Date): Promise<FleetJwtVerifyResult>;
}

const MAX_JWT_LIFETIME_SECONDS = 300; // 5 minutes per spec.

function base64UrlDecodeToBytes(s: string): Uint8Array {
  // Standard JWT base64url decode — RFC 7515 §2.
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = Buffer.from(padded, 'base64');
  return new Uint8Array(bin);
}

function tryParseClaims(payloadJson: string): FleetNodeJwtClaims | null {
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    if (
      typeof parsed.iss !== 'string' ||
      typeof parsed.sub !== 'string' ||
      typeof parsed.iat !== 'number' ||
      typeof parsed.exp !== 'number' ||
      typeof parsed.nonce !== 'string'
    ) {
      return null;
    }
    return {
      iss: parsed.iss,
      sub: parsed.sub,
      iat: parsed.iat,
      exp: parsed.exp,
      nonce: parsed.nonce,
    };
  } catch {
    return null;
  }
}

export class FleetNodeAuthImpl implements FleetNodeAuth {
  constructor(private readonly repo: FleetNodesRepo) {}

  async verify(rawJwt: string, now: Date = new Date()): Promise<FleetJwtVerifyResult> {
    const parts = rawJwt.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [encodedHeader, encodedPayload, encodedSig] = parts as [string, string, string];

    let payloadJson: string;
    try {
      payloadJson = Buffer.from(base64UrlDecodeToBytes(encodedPayload)).toString('utf8');
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    const claims = tryParseClaims(payloadJson);
    if (claims === null) return { ok: false, reason: 'malformed' };

    if (claims.iss !== claims.sub) return { ok: false, reason: 'iss_sub_mismatch' };

    if (claims.exp - claims.iat > MAX_JWT_LIFETIME_SECONDS) {
      return { ok: false, reason: 'too_long_lived' };
    }

    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (claims.exp <= nowSeconds) return { ok: false, reason: 'expired' };

    const node = await this.repo.getPublicKey(claims.iss);
    if (node === null) return { ok: false, reason: 'unknown_node' };
    if (node.revokedAt !== null) return { ok: false, reason: 'revoked_node' };

    let publicKey: Awaited<ReturnType<typeof subtle.importKey>>;
    try {
      publicKey = await subtle.importKey(
        'raw',
        base64UrlDecodeToBytes(node.publicKeyBase64Url),
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
    } catch {
      return { ok: false, reason: 'signature_invalid' };
    }

    const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
    let sigBytes: Uint8Array;
    try {
      sigBytes = base64UrlDecodeToBytes(encodedSig);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    const sigOk = await subtle.verify('Ed25519', publicKey, sigBytes, signed);
    if (!sigOk) return { ok: false, reason: 'signature_invalid' };

    return { ok: true, claims };
  }
}

/** In-memory FleetNodesRepo for tests + dev. Real impl is a Drizzle
 *  query against the future `fleet_nodes` table (separate slice). */
export class InMemoryFleetNodesRepo implements FleetNodesRepo {
  private nodes = new Map<string, FleetNodePublicKey>();

  register(nodeId: string, publicKeyBase64Url: string, registeredAt: Date = new Date()): void {
    this.nodes.set(nodeId, { publicKeyBase64Url, registeredAt, revokedAt: null });
  }

  revoke(nodeId: string, revokedAt: Date = new Date()): void {
    const existing = this.nodes.get(nodeId);
    if (existing) this.nodes.set(nodeId, { ...existing, revokedAt });
  }

  getPublicKey(nodeId: string): Promise<FleetNodePublicKey | null> {
    return Promise.resolve(this.nodes.get(nodeId) ?? null);
  }
}
