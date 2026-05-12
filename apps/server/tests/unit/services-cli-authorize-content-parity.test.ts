// W402.B — drift guard for apps/server/src/services/cli-authorize.ts.
// V-266 browser-OAuth-style activation flow for CLI / GUI client.
// Pure-Redis storage with 5-minute TTL; one-shot semantics on
// exchange. Drift here either lets a bound code be re-delivered
// (plaintext leak via repeated exchange) or breaks state-mismatch
// timing-safe equality (state attack surface).
//
//   • V-266 framing: pure Redis backing, 5-min TTL, JSON-serialised
//     state+status+plaintext+accountId payload, key prefix
//     `cli-auth:code:`.
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
//   • CliAuthorizeError 5-code union (invalid_code / state_mismatch /
//     already_bound / not_found / expired).
//   • constantTimeStringEqual: length-check + timingSafeEqual buffer
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

  it('V-266 framing pinned: browser-OAuth-style activation + pure-Redis storage + 5-min TTL + cli-auth:code: prefix', () => {
    expect(body).toMatch(/V-266 — Browser-OAuth-style activation flow for the CLI \/ GUI client\./);
    expect(body).toMatch(
      /State storage: pure Redis with a 5-minute TTL on every code\. Keys\s*\n?\s*\/\/\s*follow `cli-auth:code:\{codeId\}`\. JSON-serialised value carries the\s*\n?\s*\/\/\s*state, status, and \(post-bind\) the API key plaintext \+ accountId\s*\n?\s*\/\/\s*the GUI will pull on its next poll\./,
    );
  });

  it('One-shot exchange semantics + pending-TTL-expiry → expired (Redis evicted)', () => {
    expect(body).toMatch(
      /One-shot semantics: `exchange` deletes the key on successful\s*\n?\s*\/\/\s*retrieval, so a second call returns `expired`\. A code that's still\s*\n?\s*\/\/\s*`pending` after TTL expiry naturally returns `expired` because\s*\n?\s*\/\/\s*Redis evicted it\./,
    );
  });

  it('Browser URL framing pinned: built from dashboardOrigin (dev/staging/production all wire correctly)', () => {
    expect(body).toMatch(
      /Public-facing browser URL: built from the configured\s*\n?\s*\/\/\s*`dashboardOrigin` \(e\.g\. `https:\/\/app\.driftstack\.dev`\) so dev \/\s*\n?\s*\/\/\s*staging \/ production all wire correctly\./,
    );
  });

  it('REDIS_KEY_PREFIX cli-auth:code: + TTL_SECONDS = 5 * 60 constants pinned', () => {
    expect(body).toMatch(/const REDIS_KEY_PREFIX = 'cli-auth:code:';/);
    expect(body).toMatch(/const TTL_SECONDS = 5 \* 60;/);
  });

  it('CliAuthorizeStore: 3-method KV contract (get/setEx/del)', () => {
    expect(body).toMatch(/export interface CliAuthorizeStore \{/);
    expect(body).toMatch(/get\(key: string\): Promise<string \| null>;/);
    expect(body).toMatch(/setEx\(key: string, value: string, ttlSeconds: number\): Promise<void>;/);
    expect(body).toMatch(/del\(key: string\): Promise<void>;/);
  });

  it('RedisStore: ioredis SET EX wrapper + del passthrough', () => {
    expect(body).toMatch(/class RedisStore implements CliAuthorizeStore \{/);
    expect(body).toMatch(/return this\.redis\.get\(key\);/);
    expect(body).toMatch(/await this\.redis\.set\(key, value, 'EX', ttlSeconds\);/);
    expect(body).toMatch(/await this\.redis\.del\(key\);/);
  });

  it('InMemoryCliAuthorizeStore: Map<key, {value, expiresAt}> + self-eviction on get', () => {
    expect(body).toMatch(/export class InMemoryCliAuthorizeStore implements CliAuthorizeStore \{/);
    expect(body).toMatch(
      /private readonly entries = new Map<string, \{ value: string; expiresAt: number \}>\(\);/,
    );
    expect(body).toMatch(
      /if \(entry\.expiresAt <= Date\.now\(\)\) \{\s*\n?\s*this\.entries\.delete\(key\);\s*\n?\s*return null;/,
    );
    expect(body).toMatch(
      /this\.entries\.set\(key, \{ value, expiresAt: Date\.now\(\) \+ ttlSeconds \* 1000 \}\);/,
    );
  });

  it('CliCodeStatus 2-literal union + StoredCode 6 fields with bound-only plaintext+account_id', () => {
    expect(body).toMatch(/export type CliCodeStatus = 'pending' \| 'bound';/);
    expect(body).toMatch(/interface StoredCode \{/);
    expect(body).toMatch(/state: string;/);
    expect(body).toMatch(/status: CliCodeStatus;/);
    expect(body).toMatch(/client_label: string \| null;/);
    expect(body).toMatch(
      /\/\*\* Set when status='bound'\. Plaintext API key the CLI \/ GUI receives\. \*\/\s*\n?\s*plaintext: string \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* Set when status='bound'\. \*\/\s*\n?\s*account_id: string \| null;/,
    );
    expect(body).toMatch(/created_at: number;/);
  });

  it('CliAuthorizeError: 5-code union (invalid_code / state_mismatch / already_bound / not_found / expired)', () => {
    expect(body).toMatch(/export class CliAuthorizeError extends Error \{/);
    expect(body).toMatch(
      /public readonly code:\s*\n?\s*\| 'invalid_code'\s*\n?\s*\| 'state_mismatch'\s*\n?\s*\| 'already_bound'\s*\n?\s*\| 'not_found'\s*\n?\s*\| 'expired',/,
    );
    expect(body).toMatch(/this\.name = 'CliAuthorizeError';/);
  });

  it('Constructor: store/redis exclusive-or; dashboardOrigin trailing-slash strip; dashboardPath default /cli/authorize', () => {
    expect(body).toMatch(/if \(opts\.store !== undefined\) \{\s*\n?\s*this\.store = opts\.store;/);
    expect(body).toMatch(
      /\} else if \(opts\.redis !== undefined\) \{\s*\n?\s*this\.store = new RedisStore\(opts\.redis\);/,
    );
    expect(body).toMatch(
      /throw new Error\('CliAuthorizeService: either `store` or `redis` must be provided\.'\);/,
    );
    expect(body).toMatch(
      /this\.dashboardOrigin = opts\.dashboardOrigin\.replace\(\/\\\/\+\$\/, ''\);/,
    );
    expect(body).toMatch(/this\.dashboardPath = opts\.dashboardPath \?\? '\/cli\/authorize';/);
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
      /if \(raw === null\) \{\s*\n?\s*throw new CliAuthorizeError\('not_found', 'Authorization code not found or expired\.'\);/,
    );
    expect(body).toMatch(
      /if \(!constantTimeStringEqual\(stored\.state, input\.state\)\) \{\s*\n?\s*throw new CliAuthorizeError\('state_mismatch', 'State parameter does not match\.'\);/,
    );
    expect(body).toMatch(
      /if \(stored\.status === 'bound'\) \{\s*\n?\s*throw new CliAuthorizeError\(\s*\n?\s*'already_bound',\s*\n?\s*'Authorization code has already been bound to an account\.',\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /\/\/ Reset TTL so the GUI has the full 5 minutes from bind time to\s*\n?\s*\/\/ poll exchange — covers the case where the user took 4:30 to log\s*\n?\s*\/\/ in \+ click Authorize, then the GUI polls 30s later only to find\s*\n?\s*\/\/ an expired code\./,
    );
  });

  it('exchange: raw=null → expired; state mismatch throws; pending short-circuit; bound deletes BEFORE returning (no leak on JSON.stringify failure)', () => {
    expect(body).toMatch(
      /if \(raw === null\) \{\s*\n?\s*\/\/ Either never existed OR Redis evicted on TTL — treat both as\s*\n?\s*\/\/ expired from the CLI \/ GUI's perspective\.\s*\n?\s*return \{ status: 'expired' \};/,
    );
    expect(body).toMatch(
      /if \(stored\.status === 'pending'\) \{\s*\n?\s*return \{ status: 'pending' \};\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ One-shot: delete the entry so subsequent calls return expired\.\s*\n?\s*\/\/ Done before returning so an exception during JSON\.stringify on\s*\n?\s*\/\/ the response side can't leak a re-deliverable plaintext\./,
    );
    expect(body).toMatch(/await this\.store\.del\(this\.key\(input\.code\)\);/);
    expect(body).toMatch(
      /return \{\s*\n?\s*status: 'bound',\s*\n?\s*api_key: stored\.plaintext,\s*\n?\s*account_id: stored\.account_id,\s*\n?\s*\};/,
    );
  });

  it('constantTimeStringEqual: length-check fast-path + timingSafeEqual buffer comparison', () => {
    expect(body).toMatch(
      /function constantTimeStringEqual\(a: string, b: string\): boolean \{\s*\n?\s*if \(a\.length !== b\.length\) return false;\s*\n?\s*return timingSafeEqual\(Buffer\.from\(a\), Buffer\.from\(b\)\);\s*\n?\s*\}/,
    );
  });

  it('ExchangeResult 3-state union: pending | bound (api_key+account_id) | expired', () => {
    expect(body).toMatch(
      /export type ExchangeResult =\s*\n?\s*\| \{ status: 'pending' \}\s*\n?\s*\| \{ status: 'bound'; api_key: string; account_id: string \}\s*\n?\s*\| \{ status: 'expired' \};/,
    );
  });

  it('imports: randomBytes+timingSafeEqual from node:crypto + Redis type + ApiKeyScope from api-types', () => {
    expect(body).toMatch(/import \{ randomBytes, timingSafeEqual \} from 'node:crypto';/);
    expect(body).toMatch(/import type \{ Redis \} from 'ioredis';/);
    expect(body).toMatch(/import type \{ ApiKeyScope \} from '@driftstack\/api-types';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
