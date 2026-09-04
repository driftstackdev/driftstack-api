// W402.B — drift guard for apps/server/src/services/cli-authorize.ts.
// V-266 browser-OAuth-style activation flow for CLI / GUI client.
// Pure-Redis storage with 5-minute TTL; one-shot semantics on
// exchange. Drift here either lets a bound code be re-delivered
// (plaintext leak via repeated exchange) or breaks state-mismatch
// timing-safe equality (state attack surface).
//
//   • V-266 framing: pure Redis backing, 5-min TTL, JSON-serialised
//     state+status+plaintext+accountId payload, key prefix
//     `cli-auth:code:<sha256(code)>`.
//   • One-shot exchange: deletes Redis key on bound retrieval; second
//     call returns expired.
//   • Pending-TTL-expiry naturally returns expired (Redis evicted).
//   • Browser URL built from dashboardOrigin (env wire — dev/staging/
//     prod all wire correctly).
//   • REDIS_KEY_PREFIX 'cli-auth:code:' + TTL_SECONDS = 5 * 60.
//   • InMemoryCliAuthorizeStore: test seam mirroring Redis SET EX
//     contract; expiry self-evicts on get.
//   • initiate: 32-byte base64url code; setEx with TTL; browser_url
//     constructed via URL class with code+state query params.
//   • bind: state mismatch + already_bound + not_found errors;
//     resets TTL on successful bind (5-minute fresh window covers
//     login latency).
//   • exchange: null-raw → expired; state mismatch throws; pending
//     short-circuit; bound deletes BEFORE returning (no leak on
//     JSON.stringify failure downstream).
//   • CliAuthorizeError 6-code union (invalid_code / state_mismatch /
//     user_code_mismatch / already_bound / not_found / expired).
//   • constantTimeStringEqual: byte-length check + timingSafeEqual buffer
//     comparison (mitigates state-parameter timing attack).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W402.B apps/server/src/services/cli-authorize.ts content parity', () => {
  const body = read(LIB);

  it('V-266 framing pins hashed Redis identifiers and encrypted bound values', () => {
    expect(body).toMatch(/V-266 — Browser-OAuth-style activation flow for the CLI \/ GUI client\./);
    expect(body).toMatch(
      /State storage: pure Redis with a 5-minute TTL on every code\. Keys use\s*\/\/\s*`cli-auth:code:<sha256\(code\)>`, keeping the live wire credential out of\s*\/\/\s*Redis key scans\/slowlogs\. The JSON value carries state, status, and the\s*\/\/\s*\(post-bind\) encrypted API key \+ accountId the GUI pulls on its next poll\./,
    );
  });

  it('One-shot exchange semantics + pending-TTL-expiry → expired (Redis evicted)', () => {
    expect(body).toMatch(
      /One-shot semantics: `exchange` deletes the key on successful\s*\/\/\s*retrieval, so a second call returns `expired`\. A code that's still\s*\/\/\s*`pending` after TTL expiry naturally returns `expired` because\s*\/\/\s*Redis evicted it\./,
    );
  });

  it('Browser URL framing pinned: built from dashboardOrigin (dev/staging/production all wire correctly)', () => {
    expect(body).toMatch(
      /Public-facing browser URL: built from the configured\s*\/\/\s*`dashboardOrigin` \(e\.g\. `https:\/\/app\.driftstack\.io`\) so dev \/\s*\/\/\s*staging \/ production all wire correctly\./,
    );
  });

  it('REDIS_KEY_PREFIX cli-auth:code: + TTL_SECONDS = 5 * 60 + BIND_TTL_SECONDS = 2 * 60 constants pinned', () => {
    expect(body).toMatch(/const REDIS_KEY_PREFIX = 'cli-auth:code:';/);
    expect(body).toMatch(/const TTL_SECONDS = 5 \* 60;/);
    // D1 — shorter post-bind window while the (encrypted) key waits in Redis.
    expect(body).toMatch(/const BIND_TTL_SECONDS = 2 \* 60;/);
  });

  it('cliAuthorizeRedisKey derives a fixed-length SHA-256 identifier', () => {
    expect(body).toMatch(/export function cliAuthorizeRedisKey\(code: string\): string \{/);
    expect(body).toMatch(/createHash\('sha256'\)\.update\(code\)\.digest\('hex'\)/);
    expect(body).toMatch(/return cliAuthorizeRedisKey\(code\);/);
  });

  it('CliAuthorizeStore: KV contract includes atomic compare-and-set bind and read-delete exchange', () => {
    expect(body).toMatch(/export interface CliAuthorizeStore \{/);
    expect(body).toMatch(/get\(key: string\): Promise<string \| null>;/);
    expect(body).toMatch(/setEx\(key: string, value: string, ttlSeconds: number\): Promise<void>;/);
    expect(body).toMatch(/compareAndSetEx\([\s\S]*?\): Promise<boolean>;/);
    expect(body).toMatch(/del\(key: string\): Promise<void>;/);
    // C2 — atomic read-and-delete backs the one-shot exchange claim.
    expect(body).toMatch(/getDel\(key: string\): Promise<string \| null>;/);
  });

  it('RedisStore: SET EX plus Lua compare-set bind and get-delete exchange', () => {
    expect(body).toMatch(/class RedisStore implements CliAuthorizeStore \{/);
    expect(body).toMatch(/return this\.redis\.get\(key\);/);
    expect(body).toMatch(/await this\.redis\.set\(key, value, 'EX', ttlSeconds\);/);
    expect(body).toMatch(/current ~= ARGV\[1\]/);
    expect(body).toMatch(/redis\.call\('set', KEYS\[1\], ARGV\[2\], 'EX', ARGV\[3\]\)/);
    expect(body).toMatch(/await this\.redis\.del\(key\);/);
    // C2 — Lua EVAL (not GETDEL) so we never depend on Redis >= 6.2.
    expect(body).toMatch(/const result = await this\.redis\.eval\(/);
    expect(body).toMatch(/redis\.call\('get', KEYS\[1\]\)/);
    expect(body).toMatch(/if v then redis\.call\('del', KEYS\[1\]\)/);
  });

  it('InMemoryCliAuthorizeStore: Map<key, {value, expiresAt}> + self-eviction on get', () => {
    expect(body).toMatch(/export class InMemoryCliAuthorizeStore implements CliAuthorizeStore \{/);
    expect(body).toMatch(
      /private readonly entries = new Map<string, \{ value: string; expiresAt: number \}>\(\);/,
    );
    expect(body).toMatch(
      /if \(entry\.expiresAt <= Date\.now\(\)\) \{\s*this\.entries\.delete\(key\);\s*return null;/,
    );
    expect(body).toMatch(
      /this\.entries\.set\(key, \{ value, expiresAt: Date\.now\(\) \+ ttlSeconds \* 1000 \}\);/,
    );
    expect(body).toMatch(/entry\.value !== expectedValue/);
    // C2 — atomic getDel: read, delete, then TTL-check (no await between
    // read and delete, so concurrent callers can't both see a value).
    expect(body).toMatch(
      /const entry = this\.entries\.get\(key\);\s*if \(!entry\) return null;\s*this\.entries\.delete\(key\);/,
    );
  });

  it('CliCodeStatus + runtime-validated StoredCode discriminated union keep pending plaintext-free and bound encrypted-only', () => {
    expect(body).toMatch(/export type CliCodeStatus = 'pending' \| 'bound';/);
    expect(body).toMatch(
      /interface StoredCodeBase \{\s*state: string;[\s\S]*?user_code_hash: string;\s*client_label: string \| null;\s*created_at: number;/,
    );
    expect(body).toMatch(
      /interface StoredPendingCode extends StoredCodeBase \{\s*status: 'pending';\s*secret_blob: null;\s*encrypted: false;\s*account_id: null;/,
    );
    expect(body).toMatch(
      /interface StoredBoundCode extends StoredCodeBase \{[\s\S]+?status: 'bound';[\s\S]+?secret_blob: string;[\s\S]+?encrypted: true;\s*account_id: string;/,
    );
    expect(body).toMatch(/type StoredCode = StoredPendingCode \| StoredBoundCode;/);
    expect(body).toMatch(
      /function parseStoredCode\(raw: string\): StoredCode \| null \{[\s\S]+?value = JSON\.parse\(raw\);[\s\S]+?Number\.isFinite\(record\.created_at\)[\s\S]+?record\.status === 'pending'[\s\S]+?record\.status === 'bound'/,
    );
  });

  it('CliAuthorizeError: 6-code union includes the device verification mismatch', () => {
    expect(body).toMatch(/export class CliAuthorizeError extends Error \{/);
    expect(body).toMatch(
      /public readonly code:\s*\| 'invalid_code'\s*\| 'state_mismatch'\s*\| 'user_code_mismatch'\s*\| 'already_bound'\s*\| 'not_found'\s*\| 'expired',/,
    );
    expect(body).toMatch(/this\.name = 'CliAuthorizeError';/);
  });

  it('Constructor: store/redis exclusive-or; required encryption key; origin/path normalization', () => {
    expect(body).toMatch(/if \(opts\.store !== undefined\) \{\s*this\.store = opts\.store;/);
    expect(body).toMatch(
      /\} else if \(opts\.redis !== undefined\) \{\s*this\.store = new RedisStore\(opts\.redis\);/,
    );
    expect(body).toMatch(
      /throw new Error\('CliAuthorizeService: either `store` or `redis` must be provided\.'\);/,
    );
    expect(body).toMatch(
      /this\.dashboardOrigin = opts\.dashboardOrigin\.replace\(\/\\\/\+\$\/, ''\);/,
    );
    expect(body).toMatch(/this\.dashboardPath = opts\.dashboardPath \?\? '\/cli\/authorize';/);
    expect(body).toMatch(/secretEncryptionKeyBase64: string;/);
    expect(body).toMatch(/this\.secretEncryptionKey = opts\.secretEncryptionKeyBase64;/);
  });

  it('initiate: 32-byte randomBytes base64url code + setEx with TTL + browser URL via URL class with code+state params', () => {
    expect(body).toMatch(/const code = randomBytes\(32\)\.toString\('base64url'\);/);
    expect(body).toMatch(/status: 'pending',/);
    expect(body).toMatch(/created_at: Date\.now\(\),/);
    expect(body).toMatch(
      /await this\.store\.setEx\(this\.key\(code\), JSON\.stringify\(stored\), TTL_SECONDS\);/,
    );
    expect(body).toMatch(
      /const browserUrl = new URL\(this\.dashboardPath, this\.dashboardOrigin\);/,
    );
    expect(body).toMatch(/browserUrl\.searchParams\.set\('code', code\);/);
    expect(body).toMatch(/browserUrl\.searchParams\.set\('state', input\.state\);/);
  });

  it('bind: not_found → state_mismatch → already_bound → TTL reset on success (covers user-took-4:30-to-click latency)', () => {
    expect(body).toMatch(
      /if \(raw === null\) \{\s*throw new CliAuthorizeError\('not_found', 'Authorization code not found or expired\.'\);/,
    );
    expect(body).toMatch(
      /const stored = parseStoredCode\(raw\);\s*if \(stored === null\) \{[\s\S]+?await this\.store\.del\(key\);\s*throw new CliAuthorizeError\('invalid_code', 'Authorization code state is invalid\.'\);/,
    );
    expect(body).toMatch(
      /if \(!constantTimeStringEqual\(stored\.state, input\.state\)\) \{\s*throw new CliAuthorizeError\('state_mismatch', 'State parameter does not match\.'\);/,
    );
    expect(body).toMatch(
      /if \(stored\.status === 'bound'\) \{\s*throw new CliAuthorizeError\(\s*'already_bound',\s*'Authorization code has already been bound to an account\.',\s*\);/,
    );
    expect(body).toMatch(
      /\/\/ Reset the TTL from bind time so the GUI has the full post-bind\s*\/\/ window to poll exchange even if the user took ~4:30 to log in and\s*\/\/ click Authorize\. The post-bind window \(D1\) is deliberately shorter\s*\/\/ than the pre-bind one — the client is now actively polling\./,
    );
    expect(body).toMatch(/const didBind = await this\.store\.compareAndSetEx\(/);
    expect(body).toMatch(/if \(!didBind\) \{/);
    expect(body).toContain('const secretBlob = `${CLI_AUTHORIZE_SECRET_ENVELOPE_PREFIX}');
    expect(body).toMatch(/encrypted: true,/);
  });

  it('bound credentials use an explicit v2 envelope and record-bound authenticated context', () => {
    expect(body).toContain(
      "const CLI_AUTHORIZE_SECRET_ENVELOPE_PREFIX = 'driftstack:cli-authorize-secret:v2:';",
    );
    expect(body).toContain(
      "const CLI_AUTHORIZE_SECRET_PURPOSE = 'driftstack.cli-authorize.api-key.v2';",
    );
    expect(body).toContain('function cliAuthorizeSecretContext(input: {');
    for (const field of ['input.code', 'input.state', 'input.userCodeHash', 'input.accountId']) {
      expect(body).toContain(field);
    }
    expect(body).toContain(
      'if (!claimed.secret_blob.startsWith(CLI_AUTHORIZE_SECRET_ENVELOPE_PREFIX))',
    );
    expect(body).toContain('cliAuthorizeSecretContext({');
  });

  it('exchange: raw=null → expired; pending short-circuit; bound uses atomic getDel claim + D1 decrypt (no leak, no double-deliver)', () => {
    expect(body).toMatch(
      /if \(raw === null\) \{\s*\/\/ Either never existed OR Redis evicted on TTL — treat both as\s*\/\/ expired from the CLI \/ GUI's perspective\.\s*return \{ status: 'expired' \};/,
    );
    expect(body).toMatch(
      /if \(stored\.status === 'pending'\) \{\s*return \{ status: 'pending' \};\s*\}/,
    );
    // C2 — atomic getDel claim replaced the non-atomic store.del: exactly
    // one concurrent bound poll wins; the loser sees null → expired.
    expect(body).toMatch(/const claimedRaw = await this\.store\.getDel\(key\);/);
    expect(body).toMatch(/if \(claimedRaw === null\) \{\s*return \{ status: 'expired' \};/);
    // Claimed bytes are immutable and must still parse as encrypted bound state;
    // decrypt the at-rest blob only at delivery; decrypt failure → expired.
    expect(body).toMatch(/const claimed = parseStoredCode\(claimedRaw\);/);
    expect(body).toMatch(
      /if \(claimedRaw !== raw \|\| claimed\?\.status !== 'bound'\) \{\s*throw new CliAuthorizeError\('invalid_code', 'Authorization code state is invalid\.'\);/,
    );
    expect(body).toMatch(/apiKey = decryptPlatformSecret\(/);
    expect(body).toMatch(
      /return \{\s*status: 'bound',\s*api_key: apiKey,\s*account_id: claimed\.account_id,\s*\};/,
    );
  });

  it('constantTimeStringEqual compares UTF-8 buffer lengths before timingSafeEqual', () => {
    expect(body).toMatch(
      /function constantTimeStringEqual\(a: string, b: string\): boolean \{\s*const aBytes = Buffer\.from\(a\);\s*const bBytes = Buffer\.from\(b\);\s*if \(aBytes\.length !== bBytes\.length\) return false;\s*return timingSafeEqual\(aBytes, bBytes\);\s*\}/,
    );
  });

  it('ExchangeResult 3-state union: pending | bound (api_key+account_id) | expired', () => {
    expect(body).toMatch(
      /export type ExchangeResult =\s*\| \{ status: 'pending' \}\s*\| \{ status: 'bound'; api_key: string; account_id: string \}\s*\| \{ status: 'expired' \};/,
    );
  });

  it('imports: createHash+randomBytes+timingSafeEqual from node:crypto + Redis type; no dead scope dependency', () => {
    expect(body).toMatch(
      /import \{ createHash, randomBytes, timingSafeEqual \} from 'node:crypto';/,
    );
    expect(body).toMatch(/import type \{ Redis \} from 'ioredis';/);
    expect(body).not.toMatch(/import type \{ ApiKeyScope \} from '@driftstack\/api-types';/);
    // D1 — at-rest encryption of the minted key uses the shared platform-secret envelope.
    expect(body).toMatch(
      /import \{[\s\S]*?decryptPlatformSecret,[\s\S]*?encryptPlatformSecret,?[\s\S]*?\} from '\.\.\/lib\/platform-secret-encryption\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
