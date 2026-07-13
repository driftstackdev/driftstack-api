// W917 — V-353d MFA challenge store cross-source invariant. Two-
// hundred-forty-third in the drift-guard series. Pins the short-
// lived MFA-login-hand-off challenge-token store:
//
//   V-353d anchor — 'short-lived ("challenge_token") store for the
//   MFA login hand-off. Issued at /v1/auth/login when the account
//   has MFA enrolled; consumed at /v1/auth/mfa/challenge to exchange
//   the token + 6-digit code (or recovery code) for the real
//   session'.
//
//   Storage: Redis SET … EX 300 in production; in-memory Map in
//   tests. One-shot consumption via GETDEL.
//
//   TTL: 5 * 60 = 300 seconds.
//
//   REDIS_KEY_PREFIX: 'mfa-challenge:'.
//
//   Token format: 32 bytes → 43 url-safe chars (base64url, no
//   padding). No scrypt — entropy alone is sufficient for 5-min
//   single-use.
//
//   MfaChallengePayload (5 fields, all V-353d defense-in-depth):
//     - account_id  (which account to challenge).
//     - email       (sanity-check caller claim).
//     - source_ip   (IP-mismatch refusal; "best-effort, not load-
//                    bearing security").
//     - issued_at   (audit reconstruction on success).
//     - issued_user_agent (carried into web_session row).
//
//   MfaChallengeStore challenge payload methods plus attempt reservations:
//     - consume(key) — atomic GETDEL; returns null when missing or
//       already consumed. One-shot.
//     - set(key, value, ttlSeconds) — idempotent overwrite.
//     - peek(key) — non-consuming read for IP-mismatch refusal path
//       (legit customer can still retry).
//     - incrAttempts/releaseAttempt — reserve before verification; release
//       successful/error reservations without erasing concurrent failures.
//
//   Failed challenges DO NOT consume the token — caller retries up
//   to maxAttempts + rate-limit then abandons.
//
// stays in lockstep across
// apps/server/src/services/mfa-challenge-store.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateChallengeToken,
  redisKey,
  MFA_CHALLENGE_TTL_SECONDS,
  InMemoryMfaChallengeStore,
} from '../../src/services/mfa-challenge-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W917 V-353d MFA challenge store cross-source invariant', () => {
  // ─── V-353d anchor + login hand-off framing ──────────────────

  it('CRITICAL apps/server/src/services/mfa-challenge-store.ts header pins V-353d anchor — \'V-353d — short-lived ("challenge_token") store for the MFA login hand-off. Issued at /v1/auth/login when the account has MFA enrolled; consumed at /v1/auth/mfa/challenge to exchange the token + 6-digit code (or recovery code) for the real session\'. The V-353d anchor + 2-endpoint flow are the policy provenance.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts'));
    expect(p).toMatch(/V-353d — short-lived \("challenge_token"\) store for the MFA login/);
    expect(p).toMatch(/hand-off\. Issued at \/v1\/auth\/login when the account has MFA/);
    expect(p).toMatch(/enrolled; consumed at \/v1\/auth\/mfa\/challenge to exchange the token/);
    expect(p).toMatch(/\+ 6-digit code \(or recovery code\) for the real session/);
  });

  // ─── 5-min TTL ───────────────────────────────────────────────

  it('CRITICAL TTL_SECONDS = 5 * 60 (= 300 seconds). The 5-min window is wide enough for the customer to switch to authenticator app + type a code but narrow enough to bound replay.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts'));
    expect(p).toMatch(/const TTL_SECONDS = 5 \* 60;/);
    expect(MFA_CHALLENGE_TTL_SECONDS).toBe(300);
  });

  it("CRITICAL Storage framing — 'Redis SET … EX 300 in production; in-memory Map in tests'. The dual-impl pattern is the same V-353d Redis/Memory parity used by rate-limit + mfa-challenge.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts'));
    expect(p).toMatch(/Storage: Redis SET … EX 300 in production; in-memory Map in tests/);
  });

  // ─── REDIS_KEY_PREFIX + redisKey() ───────────────────────────

  it("CRITICAL REDIS_KEY_PREFIX = 'mfa-challenge:'. The namespaced prefix prevents collision with other Redis keyspace tenants (rate-limit:, idemp:, sessions:, etc).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts'));
    expect(p).toMatch(/const REDIS_KEY_PREFIX = 'mfa-challenge:';/);
    expect(redisKey('abc')).toBe('mfa-challenge:abc');
    expect(redisKey('')).toBe('mfa-challenge:');
  });

  // ─── 32-byte / base64url token format ────────────────────────

  it("CRITICAL generateChallengeToken framing — '32 bytes → 43 url-safe chars (base64url, no padding). Plenty of entropy for a 5-minute single-use code; doesn't need scrypt'. The 256-bit entropy + base64url no-padding format is the contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts'));
    expect(p).toMatch(/32 bytes → 43 url-safe chars \(base64url, no padding\)\. Plenty of/);
    expect(p).toMatch(/entropy for a 5-minute single-use code; doesn't need scrypt/);
    expect(p).toMatch(/return randomBytes\(32\)\.toString\('base64url'\);/);
  });

  it('CRITICAL generateChallengeToken returns 43-char base64url string (32 bytes → 43 chars unpadded). The exact char count is what URL routing + Redis key length depend on.', () => {
    const token = generateChallengeToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('CRITICAL generateChallengeToken returns distinct tokens on each call (no collisions in 10 samples). The randomness is what makes the 5-min single-use safe.', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 10; i++) tokens.add(generateChallengeToken());
    expect(tokens.size).toBe(10);
  });

  // ─── MfaChallengePayload 5-field defense-in-depth ────────────

  it('CRITICAL MfaChallengePayload has 5 fields — account_id + email + source_ip (nullable) + issued_at + issued_user_agent (nullable). The 5-field bind is what binds the challenge_token to the originating request, not just to an account.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts'));
    expect(p).toMatch(/export interface MfaChallengePayload \{/);
    expect(p).toMatch(/account_id: string;/);
    expect(p).toMatch(/email: string;/);
    expect(p).toMatch(/source_ip: string \| null;/);
    expect(p).toMatch(/issued_at: number;/);
    expect(p).toMatch(/issued_user_agent: string \| null;/);
  });

  it("CRITICAL source_ip framing — 'defense-in-depth: if attacker steals the challenge_token from a Slack paste, their IP differs and we refuse — best-effort, not load-bearing security'. The Slack-paste attack model + 'best-effort' caveat is the threat-model documentation.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts'));
    expect(p).toMatch(/source_ip \(defense-in-depth: if attacker steals the/);
    expect(p).toMatch(/challenge_token from a Slack paste, their IP differs and we/);
    expect(p).toMatch(/refuse — best-effort, not load-bearing security\)/);
  });

  it("CRITICAL issued_user_agent framing — 'carried into the eventual web_session row so the user-agent comes from the login attempt, not the challenge attempt — avoids \"all sessions look like curl\"'. The login-vs-challenge UA distinction prevents the dashboard's session-table from showing only API-client UAs.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts'));
    expect(p).toMatch(/issued_user_agent \(carried into the eventual web_session row/);
    expect(p).toMatch(/so the user-agent comes from the login attempt, not the/);
    expect(p).toMatch(/challenge attempt — avoids "all sessions look like curl"/);
  });

  // ─── MfaChallengeStore interface ─────────────────────────────

  it('CRITICAL MfaChallengeStore separates payload consume/peek from attempt reserve/release.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts'));
    expect(p).toMatch(/export interface MfaChallengeStore \{/);
    expect(p).toMatch(/consume\(key: string\): Promise<string \| null>;/);
    expect(p).toMatch(/set\(key: string, value: string, ttlSeconds: number\): Promise<void>;/);
    expect(p).toMatch(/peek\(key: string\): Promise<string \| null>;/);
    expect(p).toMatch(/incrAttempts\(key: string, ttlSeconds: number\): Promise<number>;/);
    expect(p).toMatch(/releaseAttempt\(key: string\): Promise<void>;/);
  });

  it("CRITICAL consume() JSDoc pins 'Atomically read + delete (single-use). Returns null when missing or already consumed'. The atomic-GETDEL is what makes one-shot consumption safe under concurrent requests.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts'));
    expect(p).toMatch(/Atomically read \+ delete \(single-use\)\. Returns null when missing/);
    expect(p).toMatch(/or already consumed/);
  });

  it("CRITICAL peek() JSDoc pins 'Read without consuming. Used by IP-mismatch refusal so the legit customer can still retry'. The peek-on-mismatch is what makes IP-mismatch refusal user-friendly without dropping the token.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts'));
    expect(p).toMatch(/Read without consuming\. Used by IP-mismatch refusal so the legit/);
    expect(p).toMatch(/customer can still retry/);
  });

  // ─── Redis 6.2+ GETDEL assumption ────────────────────────────

  it("CRITICAL Redis GETDEL framing — 'GETDEL is atomic in Redis 6.2+; falls back to GET + DEL pipeline for older Redis. We assume 6.2+ (Upstash + modern Hetzner-managed builds both run 7.x)'. The 6.2+ assumption is the V-353d Redis-version requirement.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts'));
    expect(p).toMatch(/GETDEL is atomic in Redis 6\.2\+; falls back to GET \+ DEL pipeline/);
    expect(p).toMatch(/for older Redis\. We assume 6\.2\+ \(Upstash \+ modern Hetzner-managed/);
    expect(p).toMatch(/builds both run 7\.x\)/);
  });

  // ─── Failed challenges do not consume token ──────────────────

  it("CRITICAL failed-challenges framing — 'Failed challenges DO NOT consume the token (caller can retry up to maxAttempts; rate-limit + abandon)'. The non-consuming-failure contract is what makes typo-retry possible without re-issuing.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts'));
    expect(p).toMatch(/Failed challenges DO NOT consume the/);
    expect(p).toMatch(/token \(caller can retry up to maxAttempts; rate-limit \+ abandon\)/);
  });

  // ─── InMemory store consume + peek round-trips ───────────────

  it('CRITICAL InMemoryMfaChallengeStore.consume returns the stored value AND deletes it (one-shot). The deletion-on-read is what mirrors Redis GETDEL semantics for tests.', async () => {
    const store = new InMemoryMfaChallengeStore();
    await store.set('k', 'payload-json', 60);
    expect(await store.consume('k')).toBe('payload-json');
    expect(await store.consume('k')).toBeNull(); // gone on second read
  });

  it('CRITICAL InMemoryMfaChallengeStore.peek returns value WITHOUT deleting (re-readable). The non-consuming-read is what mirrors Redis GET semantics for tests.', async () => {
    const store = new InMemoryMfaChallengeStore();
    await store.set('k', 'payload-json', 60);
    expect(await store.peek('k')).toBe('payload-json');
    expect(await store.peek('k')).toBe('payload-json'); // still there
    expect(await store.consume('k')).toBe('payload-json');
    expect(await store.peek('k')).toBeNull(); // now gone
  });

  it('CRITICAL InMemoryMfaChallengeStore.consume returns null for expired entries. The TTL-respecting consume is what mirrors Redis EX semantics for tests.', async () => {
    const store = new InMemoryMfaChallengeStore();
    await store.set('k', 'val', 0); // ttl=0 → already expired by Date.now() check
    expect(await store.consume('k')).toBeNull();
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/mfa-challenge-store-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
