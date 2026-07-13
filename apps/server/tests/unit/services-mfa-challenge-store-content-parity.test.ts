// W397.B — drift guard for apps/server/src/services/mfa-challenge-store.ts.
// V-353d short-lived challenge_token store for the MFA login hand-off.
// Issued at /v1/auth/login when MFA-enrolled; consumed at /v1/auth/mfa/
// challenge to exchange the token + 6-digit code (or recovery code) for
// the real session. Drift either breaks the MFA login flow (single-use
// turns into multi-use → replay) or expands the 5-minute window.
//
//   • V-353d framing + login → challenge_token → /mfa/challenge flow.
//   • Storage: Redis SET …EX 300 prod / in-memory Map tests.
//   • One-shot consume via GETDEL (Redis 6.2+); failed challenges DO
//     NOT consume (retry up to maxAttempts; caller rate-limits).
//   • REDIS_KEY_PREFIX = 'mfa-challenge:' + SHA-256 token identifiers.
//   • TTL_SECONDS = 5*60 (exported as MFA_CHALLENGE_TTL_SECONDS).
//   • MfaChallengePayload: 5 snake_case fields (account_id, email,
//     source_ip, issued_at, issued_user_agent).
//   • Source-IP framing: defense-in-depth, not load-bearing security
//     (attacker-stolen token from Slack-paste has different IP).
//   • Issued user-agent framing: carried into web_session row so UA
//     comes from login attempt, not challenge attempt (avoids "all
//     sessions look like curl").
//   • MfaChallengeStore: challenge payload operations plus atomic attempt
//     reservation/release.
//   • RedisMfaChallengeStore: getdel via unknown-cast (Redis 6.2+
//     atomic); peek = redis.get.
//   • InMemoryMfaChallengeStore: TTL expiry check in BOTH consume
//     AND peek.
//   • generateChallengeToken: randomBytes(32).toString('base64url')
//     — 43 url-safe chars, doesn't need scrypt for 5-min single-use.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/mfa-challenge-store.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W397.B apps/server/src/services/mfa-challenge-store.ts content parity', () => {
  const body = read(LIB);

  it('V-353d framing + login → challenge_token → /mfa/challenge flow pinned', () => {
    expect(body).toMatch(
      /V-353d — short-lived \("challenge_token"\) store for the MFA login\s*\n?\s*\/\/\s*hand-off\. Issued at \/v1\/auth\/login when the account has MFA\s*\n?\s*\/\/\s*enrolled; consumed at \/v1\/auth\/mfa\/challenge to exchange the token\s*\n?\s*\/\/\s*\+ 6-digit code \(or recovery code\) for the real session/,
    );
  });

  it('Storage framing: Redis SET …EX 300 prod / in-memory Map tests + one-shot GETDEL', () => {
    expect(body).toMatch(
      /Storage: Redis SET … EX 300 in production; in-memory Map in tests\.\s*\n?\s*\/\/\s*One-shot consumption via GETDEL — once the customer's challenge\s*\n?\s*\/\/\s*succeeds the token is gone/,
    );
    expect(body).toMatch(
      /Failed challenges DO NOT consume the\s*\n?\s*\/\/\s*token \(caller can retry up to maxAttempts; rate-limit \+ abandon\)/,
    );
  });

  it('Source-IP framing: defense-in-depth, not load-bearing security (best-effort)', () => {
    expect(body).toMatch(
      /source_ip \(defense-in-depth: if attacker steals the\s*\n?\s*\/\/\s*challenge_token from a Slack paste, their IP differs and we\s*\n?\s*\/\/\s*refuse — best-effort, not load-bearing security\)/,
    );
  });

  it('Issued-user-agent framing: carried into web_session row (not challenge UA — avoids "all sessions look like curl")', () => {
    expect(body).toMatch(
      /issued_user_agent \(carried into the eventual web_session row\s*\n?\s*\/\/\s*so the user-agent comes from the login attempt, not the\s*\n?\s*\/\/\s*challenge attempt — avoids "all sessions look like curl"\)/,
    );
  });

  it('Constants: REDIS_KEY_PREFIX="mfa-challenge:" + TTL_SECONDS=5*60', () => {
    expect(body).toMatch(/const REDIS_KEY_PREFIX = 'mfa-challenge:';/);
    expect(body).toMatch(/const TTL_SECONDS = 5 \* 60;/);
  });

  it('MfaChallengePayload: 5 snake_case fields (account_id / email / source_ip / issued_at / issued_user_agent)', () => {
    expect(body).toMatch(/export interface MfaChallengePayload \{/);
    expect(body).toMatch(/account_id: string;/);
    expect(body).toMatch(/email: string;/);
    expect(body).toMatch(/source_ip: string \| null;/);
    expect(body).toMatch(/issued_at: number;/);
    expect(body).toMatch(/issued_user_agent: string \| null;/);
  });

  it('MfaChallengeStore: payload operations plus attempt reserve/release', () => {
    expect(body).toMatch(/export interface MfaChallengeStore \{/);
    expect(body).toMatch(
      /Atomically read \+ delete \(single-use\)\. Returns null when missing\s*\n?\s*\*\s*or already consumed\./,
    );
    expect(body).toMatch(/consume\(key: string\): Promise<string \| null>;/);
    expect(body).toMatch(/Store a payload for `ttlSeconds`\. Idempotent overwrite\./);
    expect(body).toMatch(/set\(key: string, value: string, ttlSeconds: number\): Promise<void>;/);
    expect(body).toMatch(
      /Read without consuming\. Used by IP-mismatch refusal so the legit\s*\n?\s*\*\s*customer can still retry\./,
    );
    expect(body).toMatch(/peek\(key: string\): Promise<string \| null>;/);
    expect(body).toMatch(/incrAttempts\(key: string, ttlSeconds: number\): Promise<number>;/);
    expect(body).toMatch(/releaseAttempt\(key: string\): Promise<void>;/);
  });

  it('RedisMfaChallengeStore: GETDEL atomic Redis 6.2+ (Upstash + modern Hetzner-managed both run 7.x)', () => {
    expect(body).toMatch(/export class RedisMfaChallengeStore implements MfaChallengeStore \{/);
    expect(body).toMatch(
      /\/\/ GETDEL is atomic in Redis 6\.2\+; falls back to GET \+ DEL pipeline\s*\n?\s*\/\/\s*for older Redis\. We assume 6\.2\+ \(Upstash \+ modern Hetzner-managed\s*\n?\s*\/\/\s*builds both run 7\.x\)\./,
    );
    expect(body).toMatch(
      /const result = await \(\s*\n?\s*this\.redis as unknown as \{\s*\n?\s*getdel: \(k: string\) => Promise<string \| null>;\s*\n?\s*\}\s*\n?\s*\)\.getdel\(key\);/,
    );
  });

  it('RedisMfaChallengeStore: set uses SET …EX ttlSeconds; peek = redis.get', () => {
    expect(body).toMatch(
      /async set\(key: string, value: string, ttlSeconds: number\): Promise<void> \{\s*\n?\s*await this\.redis\.set\(key, value, 'EX', ttlSeconds\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async peek\(key: string\): Promise<string \| null> \{\s*\n?\s*return this\.redis\.get\(key\);\s*\n?\s*\}/,
    );
  });

  it('InMemoryMfaChallengeStore: consume deletes always + expiry check; peek deletes only if expired', () => {
    expect(body).toMatch(/export class InMemoryMfaChallengeStore implements MfaChallengeStore \{/);
    expect(body).toMatch(
      /private readonly entries = new Map<string, \{ value: string; expiresAt: number \}>\(\);/,
    );
    // consume: always delete, then check expiry
    expect(body).toMatch(
      /async consume\(key: string\): Promise<string \| null> \{\s*\n?\s*const entry = this\.entries\.get\(key\);\s*\n?\s*if \(!entry\) return null;\s*\n?\s*this\.entries\.delete\(key\);\s*\n?\s*if \(entry\.expiresAt <= Date\.now\(\)\) return null;\s*\n?\s*return entry\.value;\s*\n?\s*\}/,
    );
    // peek: only delete when expired
    expect(body).toMatch(
      /async peek\(key: string\): Promise<string \| null> \{\s*\n?\s*const entry = this\.entries\.get\(key\);\s*\n?\s*if \(!entry\) return null;\s*\n?\s*if \(entry\.expiresAt <= Date\.now\(\)\) \{\s*\n?\s*this\.entries\.delete\(key\);\s*\n?\s*return null;\s*\n?\s*\}\s*\n?\s*return entry\.value;/,
    );
  });

  it('V-353d.A attempt reservations and releases are expiry-safe Lua steps', () => {
    expect(body).toMatch(/incrAttempts\(key: string, ttlSeconds: number\): Promise<number>;/);
    // Redis: increment + missing-expiry attachment/repair are one atomic step.
    expect(body).toMatch(/const result = await this\.redis\.eval\(/);
    expect(body).toMatch(/redis\.call\('INCR', KEYS\[1\]\)/);
    expect(body).toMatch(/redis\.call\('TTL', KEYS\[1\]\)/);
    expect(body).toMatch(/if ttl < 0 then redis\.call\('EXPIRE', KEYS\[1\], ARGV\[1\]\) end/);
    expect(body).toMatch(/ttlSeconds\.toString\(\),/);
    expect(body).toMatch(/return Number\(result\);/);
    expect(body).toMatch(/async releaseAttempt\(key: string\): Promise<void> \{/);
    expect(body).toMatch(/await this\.redis\.eval\(/);
    expect(body).toMatch(/redis\.call\('DEL', KEYS\[1\]\)/);
    expect(body).toMatch(/redis\.call\('DECR', KEYS\[1\]\)/);
    // In-memory: separate attempts map.
    expect(body).toMatch(
      /private readonly attempts = new Map<string, \{ count: number; expiresAt: number \}>\(\);/,
    );
    expect(body).toMatch(/existing\.count -= 1;/);
    // Distinct key namespace + the cap constant.
    expect(body).toMatch(/export function attemptsKey\(token: string\): string \{/);
    expect(body).toMatch(/export const MAX_MFA_CHALLENGE_ATTEMPTS = 5;/);
  });

  it('generateChallengeToken: randomBytes(32).toString("base64url") — 43 url-safe chars, no scrypt', () => {
    expect(body).toMatch(
      /V-353d — generate a fresh challenge token\. The plaintext crosses the wire\s*\n?\s*\*\s*once; Redis key helpers store only its fixed-length SHA-256 identifier\./,
    );
    expect(body).toMatch(
      /\/\/ 32 bytes → 43 url-safe chars \(base64url, no padding\)\. Plenty of\s*\n?\s*\/\/\s*entropy for a 5-minute single-use code; doesn't need scrypt\./,
    );
    expect(body).toMatch(
      /export function generateChallengeToken\(\): string \{[\s\S]+?return randomBytes\(32\)\.toString\('base64url'\);\s*\n?\s*\}/,
    );
  });

  it('redisKey: prefix + SHA-256 identifier; MFA_CHALLENGE_TTL_SECONDS exported alias', () => {
    expect(body).toMatch(
      /export function redisKey\(token: string\): string \{\s*\n?\s*return `\$\{REDIS_KEY_PREFIX\}\$\{challengeTokenDigest\(token\)\}`;\s*\n?\s*\}/,
    );
    expect(body).toMatch(/return createHash\('sha256'\)\.update\(token\)\.digest\('hex'\);/);
    expect(body).toMatch(/export const MFA_CHALLENGE_TTL_SECONDS = TTL_SECONDS;/);
  });

  it('imports: createHash + randomBytes from node:crypto + Redis type from ioredis', () => {
    expect(body).toMatch(/import \{ createHash, randomBytes \} from 'node:crypto';/);
    expect(body).toMatch(/import type \{ Redis \} from 'ioredis';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
