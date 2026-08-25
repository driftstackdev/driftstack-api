// Drift guard for apps/server/src/services/fleet-node-auth.ts.
// Pins the V-820 fleet-node JWT verification surface — Ed25519
// signed JWT over mTLS (per docs/network-architecture.md) with
// 5-min max lifetime, iss=sub self-authentication, nonce-cache
// replay defence, and the 8-reason FleetJwtVerifyError catalog.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/fleet-node-auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/fleet-node-auth content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-820 / network-architecture.md framing pinned: 'fleet-node JWT verification. Foundation slice for the cross-agent mTLS endpoint (wss://fleet.driftstack.dev/v1/fleet/events). Agent 1 is waiting on Agent 2 to land the auth primitive; this is the autonomously-safe piece (no SQL migration, no Cloudflare config — just the JWT verification logic + interface).' — pinned so the V-820 anchor + cross-agent-mTLS-endpoint URL + Agent-1-waits-on-Agent-2 cross-agent dependency + autonomously-safe-piece scope all stay documented", () => {
    expect(body).toMatch(/\/\/ V-820 \/ network-architecture\.md — fleet-node JWT verification\./);
    expect(body).toMatch(
      /\/\/ Foundation slice for the cross-agent mTLS endpoint\s*\/\/ \(`wss:\/\/fleet\.driftstack\.dev\/v1\/fleet\/events`\)\. Agent 1 is waiting\s*\/\/ on Agent 2 to land the auth primitive; this is the autonomously-\s*\/\/ safe piece \(no SQL migration, no Cloudflare config — just the JWT\s*\/\/ verification logic \+ interface\)\./,
    );
  });

  it("3-step auth-flow framing pinned: '1. Each fleet node has a long-lived Ed25519 keypair issued at provisioning time. The public key + node_id is registered in the (future) fleet_nodes table. 2. On every connect, the fleet node generates a JWT signed with its private key (iss=sub=<node_id>, 5-min exp, per-request nonce). 3. The control plane verifies the JWT against the public key on record. Reject on mismatch, expiry, revocation, or replayed nonce.' — pinned so the 3-step Ed25519+iss=sub+5-min-exp+per-request-nonce contract stays documented (matches the v1 design in network-architecture.md)", () => {
    expect(body).toMatch(
      /\/\/ Auth flow per docs\/network-architecture\.md §"v1 design — signed JWT\s*\/\/ over mTLS":\s*\/\/ {3}1\. Each fleet node has a long-lived Ed25519 keypair issued at\s*\/\/ {6}provisioning time\. The public key \+ `node_id` is registered\s*\/\/ {6}in the \(future\) `fleet_nodes` table\./,
    );
    expect(body).toMatch(
      /\/\/ {3}2\. On every connect, the fleet node generates a JWT signed with\s*\/\/ {6}its private key \(`iss=sub=<node_id>`, 5-min `exp`, per-request\s*\/\/ {6}`nonce`\)\./,
    );
    expect(body).toMatch(
      /\/\/ {3}3\. The control plane verifies the JWT against the public key on\s*\/\/ {6}record\. Reject on mismatch, expiry, revocation, or replayed\s*\/\/ {6}nonce\./,
    );
  });

  it("Out-of-scope-follow-up framing pinned: 'fleet_nodes Drizzle schema + migration (Tier-2 founder review). Nonce cache (Redis-backed; trivial extension here). mTLS layer (Cloudflare Authenticated Origin Pulls — infra). The WebSocket /v1/fleet/events route itself (waits for the above).' — pinned so the 4-deferred-slices catalog + the Cloudflare-Authenticated-Origin-Pulls implementation detail + the Tier-2-founder-review gate on the schema stay documented", () => {
    expect(body).toMatch(
      /\/\/ Out of scope \(follow-up slices\):\s*\/\/ {3}- `fleet_nodes` Drizzle schema \+ migration \(Tier-2 founder review\)\.\s*\/\/ {3}- Nonce cache \(Redis-backed; trivial extension here\)\.\s*\/\/ {3}- mTLS layer \(Cloudflare Authenticated Origin Pulls — infra\)\.\s*\/\/ {3}- The WebSocket `\/v1\/fleet\/events` route itself \(waits for the\s*\/\/ {5}above\)\./,
    );
  });

  it('FleetNodeJwtClaims 5-field shape pinned: iss (node_id; issuer + subject) + sub + iat (seconds since epoch) + exp (MUST be <= iat + 300) + nonce (per-request random for replay defence). Drift to a different iss-vs-sub semantic would break the self-authenticating-JWT property the design relies on', () => {
    expect(body).toMatch(/export interface FleetNodeJwtClaims \{/);
    expect(body).toMatch(
      /\/\*\* `node_id` UUID — both issuer and subject \(self-authenticating\)\. \*\/\s*iss: string;\s*sub: string;/,
    );
    expect(body).toMatch(/\/\*\* Issue time \(seconds since epoch\)\. \*\/\s*iat: number;/);
    expect(body).toMatch(
      /\/\*\* Expiry time \(seconds since epoch\)\. MUST be `<= iat \+ 300`\. \*\/\s*exp: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Per-request random — control plane caches issued nonces for\s*\*\s+the JWT lifetime to defeat replay\. \*\/\s*nonce: string;/,
    );
  });

  it("FleetNodePublicKey 3-field shape pinned: publicKeyBase64Url (32-byte Ed25519) + registeredAt + revokedAt (nullable; non-null after operator-marks-revoked). + 'JWT verification always fails after this is non-null.' framing — pinned so the operator-revocation behavior stays documented (drift would let revoked nodes still authenticate)", () => {
    expect(body).toMatch(
      /export interface FleetNodePublicKey \{\s*\/\*\* Base64url-encoded 32-byte Ed25519 public key\. \*\/\s*publicKeyBase64Url: string;\s*\/\*\* When the node was provisioned\. \*\/\s*registeredAt: Date;\s*\/\*\* Set when an operator marks the node revoked — JWT verification\s*\*\s+always fails after this is non-null\. \*\/\s*revokedAt: Date \| null;\s*\}/,
    );
  });

  it('FleetJwtVerifyError 8-reason catalog pinned: malformed + unknown_node + revoked_node + signature_invalid + expired + too_long_lived + iss_sub_mismatch + replayed_nonce. Drift to dropping a reason would let an attack class through unnoticed (e.g. dropping too_long_lived would let attackers craft 7-day JWTs from compromised keys)', () => {
    expect(body).toMatch(/export type FleetJwtVerifyError =/);
    expect(body).toMatch(/\| 'malformed'/);
    expect(body).toMatch(/\| 'unknown_node'/);
    expect(body).toMatch(/\| 'revoked_node'/);
    expect(body).toMatch(/\| 'signature_invalid'/);
    expect(body).toMatch(/\| 'expired'/);
    expect(body).toMatch(/\| 'too_long_lived'/);
    expect(body).toMatch(/\| 'iss_sub_mismatch'/);
    expect(body).toMatch(/\| 'replayed_nonce';/);
  });

  it('MAX_JWT_LIFETIME_SECONDS = 300 (5 minutes per spec) pinned. Drift would diverge from the network-architecture.md spec; drift to weaken to e.g. 3600 (1h) would expand the replay window for stolen JWTs by 12x', () => {
    expect(body).toMatch(/const MAX_JWT_LIFETIME_SECONDS = 300; \/\/ 5 minutes per spec\./);
  });

  it("FleetNodeAuthImpl optional-nonce-cache framing pinned: 'When provided, verify() rejects any JWT whose (iss, nonce) pair has been seen within the JWT's lifetime. When omitted, verify() still rejects malformed / expired / wrong-signature JWTs but a stolen JWT within its 5-min window CAN be replayed — production deployments MUST inject the cache.' — pinned so the optional-but-MUST-in-prod contract + the stolen-JWT-replay-window threat model stay documented", () => {
    expect(body).toMatch(
      /\* Optional nonce cache for replay defence\. When provided, verify\(\)\s*\*\s+rejects any JWT whose `\(iss, nonce\)` pair has been seen within\s*\*\s+the JWT's lifetime\. When omitted, verify\(\) still rejects\s*\*\s+malformed \/ expired \/ wrong-signature JWTs but a stolen JWT\s*\*\s+within its 5-min window CAN be replayed — production deployments\s*\*\s+MUST inject the cache\./,
    );
  });

  it("verify() 7-check ordering pinned: 3-parts → payload-decode → claims-parse → iss=sub → exp-iat-<=300 → expired → unknown-node → revoked → signature-verify → replay-check. The replay check happens LAST so failed-signature JWTs don't burn nonce-cache writes. Drift to checking nonce before signature would let unsigned JWTs poison the cache", () => {
    expect(body).toMatch(/if \(parts\.length !== 3\) return \{ ok: false, reason: 'malformed' \};/);
    expect(body).toMatch(
      /if \(claims\.iss !== claims\.sub\) return \{ ok: false, reason: 'iss_sub_mismatch' \};/,
    );
    expect(body).toMatch(
      /if \(claims\.exp - claims\.iat > MAX_JWT_LIFETIME_SECONDS\) \{\s*return \{ ok: false, reason: 'too_long_lived' \};\s*\}/,
    );
    expect(body).toMatch(
      /if \(claims\.exp <= nowSeconds\) return \{ ok: false, reason: 'expired' \};/,
    );
    expect(body).toMatch(/if \(node === null\) return \{ ok: false, reason: 'unknown_node' \};/);
    expect(body).toMatch(
      /if \(node\.revokedAt !== null\) return \{ ok: false, reason: 'revoked_node' \};/,
    );
    expect(body).toMatch(/if \(!sigOk\) return \{ ok: false, reason: 'signature_invalid' \};/);
  });

  it("Replay-defence-AFTER-signature framing pinned: 'Replay defence — happens AFTER signature + expiry so we don't burn nonce-cache writes on garbage requests. TTL = remaining JWT lifetime (so even if the cache is asked about a JWT later than exp, the entry has already evicted).' — pinned so the order-of-checks rationale + TTL-tracks-jwt-lifetime contract stay documented", () => {
    expect(body).toMatch(
      /\/\/ Replay defence — happens AFTER signature \+ expiry so we don't\s*\/\/ burn nonce-cache writes on garbage requests\. TTL = remaining\s*\/\/ JWT lifetime \(so even if the cache is asked about a JWT later\s*\/\/ than `exp`, the entry has already evicted\)\./,
    );
    expect(body).toMatch(
      /const ttlSeconds = Math\.max\(1, claims\.exp - nowSeconds\);\s*const firstSight = await this\.nonceCache\.checkAndRecord\(claims\.iss, claims\.nonce, ttlSeconds\);/,
    );
  });

  it("Ed25519 importKey + subtle.verify pinned: 'name: \\'Ed25519\\'' algorithm on raw 32-byte public key + subtle.verify('Ed25519', ...). Drift to a different algorithm would diverge from the network-architecture.md Ed25519 commitment. Note: Node 18+ webcrypto Ed25519 support is what enables this; pre-Node-18 deployments would need a polyfill", () => {
    expect(body).toMatch(
      /publicKey = await subtle\.importKey\(\s*'raw',\s*base64UrlDecodeToBytes\(node\.publicKeyBase64Url\),\s*\{ name: 'Ed25519' \},\s*false,\s*\['verify'\],\s*\);/,
    );
    expect(body).toMatch(
      /const sigOk = await subtle\.verify\('Ed25519', publicKey, sigBytes, signed\);/,
    );
  });

  it("InMemoryFleetNodesRepo register + revoke + getPublicKey 3-method surface pinned. + 'Real impl is a Drizzle query against the future fleet_nodes table (separate slice).' — pinned so the dev-mode + future-DrizzleRepo cross-reference stays documented", () => {
    expect(body).toMatch(/export class InMemoryFleetNodesRepo implements FleetNodesRepo \{/);
    expect(body).toMatch(
      /register\(nodeId: string, publicKeyBase64Url: string, registeredAt: Date = new Date\(\)\): void/,
    );
    expect(body).toMatch(/revoke\(nodeId: string, revokedAt: Date = new Date\(\)\): void/);
    expect(body).toMatch(/getPublicKey\(nodeId: string\): Promise<FleetNodePublicKey \| null>/);
    expect(body).toMatch(
      /\/\*\* In-memory FleetNodesRepo for tests \+ dev\. Real impl is a Drizzle\s*\*\s+query against the future `fleet_nodes` table \(separate slice\)\. \*\//,
    );
  });
});
