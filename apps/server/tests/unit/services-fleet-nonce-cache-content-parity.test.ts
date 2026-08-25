// Drift guard for apps/server/src/services/fleet-nonce-cache.ts.
// Pins the V-820 fleet-node JWT replay-defense nonce cache —
// FleetNonceCache interface + InMemory variant + per-(nodeId,nonce)
// scoping + NUL-byte key delimiter + TTL-matches-JWT-lifetime.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/fleet-nonce-cache.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/fleet-nonce-cache content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-820 nonce-cache foundation framing pinned: 'nonce cache for fleet-node JWT replay defense (foundation slice; production impl is Redis-backed and lands with the /v1/fleet/events WebSocket route).' — pinned so the V-820 anchor + foundation-slice posture + production-Redis-backed + WebSocket-route deferred dependency stay documented", () => {
    expect(body).toMatch(
      /\/\/ V-820 — nonce cache for fleet-node JWT replay defense \(foundation\s*\/\/ slice; production impl is Redis-backed and lands with the\s*\/\/ `\/v1\/fleet\/events` WebSocket route\)\./,
    );
  });

  it("3-step replay-defense framing pinned: '1. Every JWT carries a per-request nonce (per docs/network-architecture.md §What the JWT carries). 2. The verifier checks the nonce hasn't been seen for this nodeId within the JWT's lifetime. 3. If seen → reject as replay; if unseen → record + accept.' — pinned so the per-request-nonce + nodeId-scoped-check + reject-or-record-decision contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ {3}1\. Every JWT carries a per-request `nonce` \(per\s*\/\/ {6}docs\/network-architecture\.md §"What the JWT carries"\)\./,
    );
    expect(body).toMatch(
      /\/\/ {3}2\. The verifier checks the nonce hasn't been seen for this\s*\/\/ {6}`nodeId` within the JWT's lifetime\./,
    );
    expect(body).toMatch(/\/\/ {3}3\. If seen → reject as replay; if unseen → record \+ accept\./);
  });

  it("Redis-backed-prod-vs-in-memory-dev framing pinned: 'Production wires a Redis SET with TTL = JWT lifetime (5 min); the in-memory variant here is for tests + dev mode. They share this exact interface so the WebSocket route handler never has to know which backend it's talking to.' — pinned so the dual-backend + backend-agnostic-WebSocket-route contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Production wires a Redis SET with TTL = JWT lifetime \(5 min\); the\s*\/\/ in-memory variant here is for tests \+ dev mode\. They share this\s*\/\/ exact interface so the WebSocket route handler never has to know\s*\/\/ which backend it's talking to\./,
    );
  });

  it("Per-(nodeId, nonce) scoping framing pinned: 'the cache scopes nonces by nodeId (a single nonce value MAY be reused across different nodes — they have separate keys + separate threat models). Scope-by-(nodeId, nonce) is the minimum needed to defeat replay without rejecting legitimate per-node nonce-counter resets.' — pinned so the deliberate-per-node-scoping rationale stays documented (drift to global-scope would reject legitimate nonces from sibling nodes)", () => {
    expect(body).toMatch(
      /\/\/ Scope: the cache scopes nonces by `nodeId` \(a single nonce value\s*\/\/ MAY be reused across different nodes — they have separate keys\s*\/\/ \+ separate threat models\)\. Scope-by-\(nodeId, nonce\) is the\s*\/\/ minimum needed to defeat replay without rejecting legitimate\s*\/\/ per-node nonce-counter resets\./,
    );
  });

  it("FleetNonceCache.checkAndRecord framing pinned: 'Returns true if this is the FIRST time the (nodeId, nonce) pair has been seen within the TTL window — and records the pair. Returns false if the pair has been seen (replay attempt).' + ttlSeconds-matches-JWT-lifetime framing — pinned so the atomic check-and-record semantics + true=first-sight + false=replay return contract stay documented (drift to a separate check + record would re-introduce the same race window that the FleetNodeAuthImpl release-script Lua defends against)", () => {
    expect(body).toMatch(
      /\* Returns true if this is the FIRST time the \(nodeId, nonce\) pair\s*\*\s+has been seen within the TTL window — and records the pair\.\s*\*\s+Returns false if the pair has been seen \(replay attempt\)\./,
    );
    expect(body).toMatch(
      /\*\s+`ttlSeconds` matches the JWT's lifetime; the cache evicts after\s*\*\s+that so a replay much later isn't flagged \(the JWT itself would\s*\*\s+have expired by then anyway, but defence-in-depth\)\./,
    );
    expect(body).toMatch(
      /checkAndRecord\(nodeId: string, nonce: string, ttlSeconds: number\): Promise<boolean>;/,
    );
  });

  it("InMemoryFleetNonceCache periodic-eviction-on-write framing pinned: 'Each entry's expiry is tracked alongside; periodic-eviction-on-write keeps the map size bounded without a separate timer.' — pinned so the no-separate-timer rationale + bounded-on-write contract stay documented (drift to lazy-only eviction would let the Map grow unbounded for nodes that never check-and-record again after a burst)", () => {
    expect(body).toMatch(
      /\* In-memory FleetNonceCache for tests \+ dev\. Each entry's expiry is\s*\* tracked alongside; periodic-eviction-on-write keeps the map size\s*\* bounded without a separate timer\./,
    );
  });

  it("Thread-safety framing pinned: 'intended for single-threaded use (Node event loop). Concurrent calls for the same key are serialized by the loop; Redis impl in production handles cross-instance contention via SET NX + EXPIRE primitives.' — pinned so the Node-event-loop-serialization + Redis-SET-NX-EXPIRE-for-prod cross-reference stay documented", () => {
    expect(body).toMatch(
      /\* Thread-safety: intended for single-threaded use \(Node event loop\)\.\s*\* Concurrent calls for the same key are serialized by the loop;\s*\* Redis impl in production handles cross-instance contention via\s*\* SET NX \+ EXPIRE primitives\./,
    );
  });

  it("NUL-byte key delimiter pinned: 'const key = nodeId + \\x00 + nonce;'. Drift to a different delimiter would let collision attacks where an attacker crafts a nodeId that overlaps with another node's (nodeId+nonce) tuple. NUL is unrepresentable in valid UUID + base64url so it's a safe separator", () => {
    expect(body).toMatch(/const key = nodeId \+ '\\x00' \+ nonce;/);
  });

  it("checkAndRecord ordering pinned: evictExpired(nowMs) BEFORE the lookup so stale entries don't false-positive a replay. Drift to checking before evicting would let an expired-but-not-yet-evicted entry block a legitimate retry after TTL", () => {
    expect(body).toMatch(
      /const nowMs = this\.clock\(\)\.getTime\(\);\s*this\.evictExpired\(nowMs\);\s*const key = nodeId \+ '\\x00' \+ nonce;\s*const existing = this\.entries\.get\(key\);\s*if \(existing !== undefined && existing > nowMs\) \{/,
    );
  });

  it("Seen-within-window → return false (replay) pinned: 'Seen within window → replay.' framing + return Promise.resolve(false). Drift to throwing on replay would force callers to wrap each call in try/catch; the false-return discriminator is the cleaner API", () => {
    expect(body).toMatch(/\/\/ Seen within window → replay\.\s*return Promise\.resolve\(false\);/);
  });

  it("Record-on-first-sight uses TTL conversion (* 1000) for milliseconds + return Promise.resolve(true). Drift to forgetting * 1000 would silently treat ttlSeconds as ttlMs, making entries evict 1000x sooner — defeats the replay defense within the JWT's 5-min window", () => {
    expect(body).toMatch(
      /this\.entries\.set\(key, nowMs \+ ttlSeconds \* 1000\);\s*return Promise\.resolve\(true\);/,
    );
  });

  it('size() test/inspection helper pinned. Drift to dropping size() would break the test fixtures that assert post-eviction Map bounds', () => {
    expect(body).toMatch(
      /\/\*\* Test\/inspection helper — current cache size\. \*\/\s*size\(\): number/,
    );
  });
});
