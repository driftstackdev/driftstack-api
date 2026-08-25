// Drift guard for apps/server/src/services/agent-pair-mode-lock.ts.
// Pins the Arc 2 sub-slice 8.8 Redis-backed pair-mode takeover lock —
// founder verdict Q4=A LOCKED 2026-05-18, SET NX EX implementation,
// atomic CAS-DEL release via Lua, in-memory variant for tests, and
// the 30s default TTL stuck-client insurance.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/agent-pair-mode-lock.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/agent-pair-mode-lock content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Arc 2 sub-slice 8.8 module-level framing pinned: 'Redis-backed lock for pair-mode takeover contention. Founder verdict Q4=A LOCKED 2026-05-18: route-layer Redis lock (the transition into takeover-pending is the only contention point that matters; subsequent transitions are serialized by the per-row UPDATE in setPairModeState).' — pinned so the Q4=A verdict + lock-only-on-takeover-pending-transition rationale + the per-row-UPDATE-serialization cross-reference all stay documented", () => {
    expect(body).toMatch(/\/\/ Arc 2 sub-slice 8\.8 \(v2-#8 AI chat \+ manual side-by-side\)\./);
    expect(body).toMatch(
      /\/\/ Redis-backed lock for pair-mode takeover contention\. Founder\s*\/\/ verdict Q4=A LOCKED 2026-05-18: route-layer Redis lock \(the\s*\/\/ transition into 'takeover-pending' is the only contention point\s*\/\/ that matters; subsequent transitions are serialized by the\s*\/\/ per-row UPDATE in setPairModeState\)\./,
    );
  });

  it("SET NX EX framing pinned: 'Two clients racing both win different Redis keys' acquire calls, but only one wins the per-session pair_lock:{sessionId} key. The loser gets a typed 409 Conflict + the winner's client_id in the body so the dashboard can render \"user X is taking over — your request was declined\".' — pinned so the implementation choice (SET NX EX) + the per-session key pattern (pair_lock:<sessionId>) + the user-visible loser-UX commitment stay documented", () => {
    expect(body).toMatch(
      /\/\/ Implementation: SET NX EX\. Two clients racing both win different\s*\/\/ Redis keys' acquire calls, but only one wins the per-session\s*\/\/ `pair_lock:\{sessionId\}` key\. The loser gets a typed 409 Conflict\s*\/\/ \+ the winner's client_id in the body so the dashboard can render\s*\/\/ "user X is taking over — your request was declined"\./,
    );
  });

  it("PairModeTakeoverLock interface 2-method surface pinned: tryAcquire (returns winner discriminator) + release (no-op when not held). Drift to dropping the winnerClientId in the return would break the dashboard's 'user X is taking over' message", () => {
    expect(body).toMatch(/export interface PairModeTakeoverLock \{/);
    expect(body).toMatch(
      /tryAcquire\(args: \{\s*sessionId: string;\s*clientId: string;\s*ttlSeconds\?: number;\s*\}\): Promise<\{ acquired: boolean; winnerClientId: string \}>;/,
    );
    expect(body).toMatch(
      /release\(args: \{ sessionId: string; clientId: string \}\): Promise<void>;/,
    );
  });

  it("tryAcquire TTL framing pinned: 'TTL bounds the maximum hold time (30s by default; the route layer's transition path is much faster, so the TTL is insurance against a stuck client). Returns the winner — when the caller wins, the winner equals clientId; otherwise it's whoever holds the live lock.' — pinned so the 30s-as-insurance rationale + the winner-discriminator semantics survive", () => {
    expect(body).toMatch(
      /TTL bounds the maximum hold time \(30s by default;\s*\*\s+the route layer's transition path is much faster, so the TTL is\s*\*\s+insurance against a stuck client\)\./,
    );
    expect(body).toMatch(
      /Returns the winner — when the\s*\*\s+caller wins, the winner equals `clientId`; otherwise it's whoever\s*\*\s+holds the live lock\./,
    );
  });

  it('InMemoryPairModeTakeoverLock variant pinned: 30s default TTL + expiresAtMs computed as nowMs + ttl*1000 + expiry-based-overwrite (existing && expiresAtMs > nowMs means still-held). Drift to a different TTL would diverge from RedisPairModeTakeoverLock; drift to skipping the expiry check would let stale locks block new acquirers indefinitely', () => {
    expect(body).toMatch(
      /export class InMemoryPairModeTakeoverLock implements PairModeTakeoverLock \{/,
    );
    expect(body).toMatch(/const ttl = args\.ttlSeconds \?\? 30;/);
    expect(body).toMatch(
      /if \(existing && existing\.expiresAtMs > nowMs\) \{\s*return Promise\.resolve\(\{ acquired: false, winnerClientId: existing\.clientId \}\);\s*\}/,
    );
    expect(body).toMatch(/expiresAtMs: nowMs \+ ttl \* 1000,/);
  });

  it("InMemoryPairModeTakeoverLock release() owner-check pinned: 'if (existing.clientId === args.clientId) { this.locks.delete(args.sessionId); }'. Drift to dropping the owner-check would let client B release client A's lock (a privilege escalation in pair-mode contention)", () => {
    expect(body).toMatch(
      /release\(args: \{ sessionId: string; clientId: string \}\): Promise<void> \{\s*const existing = this\.locks\.get\(args\.sessionId\);\s*if \(!existing\) return Promise\.resolve\(\);\s*if \(existing\.clientId === args\.clientId\) \{\s*this\.locks\.delete\(args\.sessionId\);\s*\}/,
    );
  });

  it("RedisLikeClient minimal-subset framing pinned: set (NX EX returns OK or null) + get + del + eval. + 'Atomic Lua eval for the CAS-DEL on release. Returns 1 when the delete fired, 0 when the GET-equality check failed (lock no longer held by the caller). The release path needs this to avoid a GET-then-DEL race window where another client could acquire the key between the two operations.' — pinned so the minimal-ioredis-subset contract + the race-window-avoidance rationale stay documented", () => {
    expect(body).toMatch(/export interface RedisLikeClient \{/);
    expect(body).toMatch(
      /set\(\s*key: string,\s*value: string,\s*nxFlag: 'NX',\s*expiryFlag: 'EX',\s*ttlSeconds: number,\s*\): Promise<'OK' \| null>;/,
    );
    expect(body).toMatch(/get\(key: string\): Promise<string \| null>;/);
    expect(body).toMatch(/del\(key: string\): Promise<number>;/);
    expect(body).toMatch(
      /eval\(script: string, numKeys: number, \.\.\.args: string\[\]\): Promise<number \| string \| null>;/,
    );
    expect(body).toMatch(
      /\/\*\* Atomic Lua eval for the CAS-DEL on release\. Returns 1 when the\s*\*\s+delete fired, 0 when the GET-equality check failed \(lock no\s*\*\s+longer held by the caller\)\. The release path needs this to\s*\*\s+avoid a GET-then-DEL race window where another client could\s*\*\s+acquire the key between the two operations\. \*\//,
    );
  });

  it("RedisPairModeTakeoverLock SET NX EX implementation pinned: 'this.redis.set(key, args.clientId, NX, EX, ttl)' + 'pair_lock:{sessionId}' key pattern + winner-resolution-on-NX-failure (await this.redis.get(key) ?? 'unknown'). Drift to a different key pattern would diverge from the module-level documentation; drift to dropping the 'unknown' fallback would crash on a stale-lock-with-no-value", () => {
    expect(body).toMatch(/const key = `pair_lock:\$\{args\.sessionId\}`;/);
    expect(body).toMatch(
      /const ok = await this\.redis\.set\(key, args\.clientId, 'NX', 'EX', ttl\);/,
    );
    expect(body).toMatch(
      /if \(ok === 'OK'\) \{\s*return \{ acquired: true, winnerClientId: args\.clientId \};\s*\}\s*const winner = \(await this\.redis\.get\(key\)\) \?\? 'unknown';/,
    );
  });

  it('RedisPairModeTakeoverLock.release() uses CAS-DEL Lua script via eval (NOT a get-then-del two-call). Drift to the two-call pattern would re-introduce the race window the comment explicitly defends against', () => {
    expect(body).toMatch(/await this\.redis\.eval\(RELEASE_SCRIPT, 1, key, args\.clientId\);/);
    expect(body).toMatch(
      /\/\/ Atomic CAS-DEL via Lua: GET-then-equality-then-DEL collapses\s*\/\/ into one Redis op so a second client can't acquire the lock in\s*\/\/ the race window\. The canonical Redlock release recipe — used by\s*\/\/ the official redis-lock libraries across every language\./,
    );
  });

  it('RELEASE_SCRIPT Lua pinned: \'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end\'. This is the canonical Redlock CAS-DEL script. Drift to a different script would break the atomic-release guarantee', () => {
    expect(body).toMatch(
      /const RELEASE_SCRIPT =\s*'if redis\.call\("get", KEYS\[1\]\) == ARGV\[1\] then return redis\.call\("del", KEYS\[1\]\) else return 0 end';/,
    );
  });
});
