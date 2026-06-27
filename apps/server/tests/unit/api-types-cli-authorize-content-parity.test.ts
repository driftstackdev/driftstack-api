// W433.B — drift guard for packages/api-types/src/cli-authorize.ts.
// V-266 browser-based CLI/GUI activation handshake. Drift here is
// a security regression: the 4-step flow + state CSRF nonce echo +
// one-shot bound/expired/pending discriminated union are all
// load-bearing for "the CLI/GUI can't accidentally bind to the
// wrong account or replay a stolen code".
//
//   • V-266 4-step flow rationale pinned: initiate (code +
//     browser_url) → user signs in → dashboard bind (mints key) →
//     CLI/GUI polls exchange (pending → bound → expired).
//   • state CSRF nonce: 16+ chars URL-safe entropy; echoed in
//     browser URL; verified by dashboard on bind; re-verified by
//     CLI/GUI on exchange.
//   • code: 32+ byte random URL-safe; never displayed to user.
//   • CliAuthorizeInitiateRequest: state 16..128 + optional
//     client_label 1..120.
//   • CliAuthorizeBindRequest (web-session-auth): code 16..128 +
//     state 16..128 + optional scopes .min(1); defaults to
//     ["account_owner"] server-side.
//   • CliAuthorizeBindResponse: ok:true literal + account_id (no
//     plaintext key — only via /exchange).
//   • CliAuthorizeExchangeStatus enum: pending | bound | expired.
//   • Exchange response: discriminated-union on status; bound
//     carries api_key + account_id (one-shot; subsequent calls 404).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/cli-authorize.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W433.B packages/api-types/src/cli-authorize.ts content parity', () => {
  const body = read(LIB);

  it('V-266 framing pinned: replaces paste-key flow with OAuth-style browser handshake; 4-step rationale', () => {
    expect(body).toMatch(/\/\/ V-266 — Browser-based CLI \/ GUI authorization flow\./);
    expect(body).toMatch(
      /\/\/ Replaces the "find your API key in the dashboard, paste it into the\s*\n?\s*\/\/ GUI" flow with an OAuth-style browser handshake:/,
    );
    expect(body).toMatch(
      /\/\/\s*1\. CLI\/GUI calls \/v1\/auth\/cli-authorize\/initiate, gets a one-shot\s*\n?\s*\/\/\s+`code` \+ a `browser_url` to open\./,
    );
    expect(body).toMatch(
      /\/\/\s*2\. CLI\/GUI opens browser_url; user signs in to the dashboard if\s*\n?\s*\/\/\s+not already, sees a confirmation screen, clicks Authorize\./,
    );
    expect(body).toMatch(
      /\/\/\s*3\. Dashboard calls \/v1\/auth\/cli-authorize\/bind with web-session\s*\n?\s*\/\/\s+bearer auth; server mints a scoped API key and stores the\s*\n?\s*\/\/\s+plaintext keyed by `code` \(Redis, 5-minute TTL\)\./,
    );
    expect(body).toMatch(
      /\/\/\s*4\. CLI\/GUI polls \/v1\/auth\/cli-authorize\/exchange until status\s*\n?\s*\/\/\s+flips from `pending` → `bound` → returns plaintext API key\./,
    );
  });

  it('code + state CSRF rationale pinned: code 32+ byte URL-safe; state CSRF nonce supplied on initiate, echoed in browser_url, verified at bind, re-verified at exchange (defends against wrong-session binding)', () => {
    expect(body).toMatch(
      /\/\/ `code` is a 32\+ byte random URL-safe string\. `state` is a CSRF nonce\s*\n?\s*\/\/ supplied by the CLI\/GUI on initiate, echoed in the browser URL,\s*\n?\s*\/\/ verified by the dashboard on bind, and re-verified by the CLI\/GUI\s*\n?\s*\/\/ on exchange — defends against the dashboard binding a code that\s*\n?\s*\/\/ wasn't issued in the same session\./,
    );
  });

  it("imports: z + ApiKeyScopeSchema + Iso8601Schema from './common.js'", () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(/import \{ ApiKeyScopeSchema, Iso8601Schema \} from '\.\/common\.js';/);
  });

  it('CliAuthorizeInitiateRequest: state 16..128 (CSRF nonce) + optional client_label 1..120 ("Driftstack desktop app on John\'s MacBook Pro" rationale)', () => {
    expect(body).toMatch(
      /\/\*\* Client-supplied CSRF nonce — echoed back in the browser URL and\s*\n?\s*\*\s*re-verified at exchange time\. Min 16 chars of URL-safe entropy\s*\n?\s*\*\s*\(the CLI\/GUI generates this via crypto-random\)\. \*\/\s*\n?\s*state: z\.string\(\)\.min\(16\)\.max\(128\),/,
    );
    expect(body).toMatch(
      /\/\*\* Human-friendly label that appears on the dashboard's confirmation\s*\n?\s*\*\s*screen \("Driftstack desktop app on John's MacBook Pro"\) so the\s*\n?\s*\*\s*user knows what they're authorizing\. \*\/\s*\n?\s*client_label: z\.string\(\)\.min\(1\)\.max\(120\)\.optional\(\),/,
    );
  });

  it('CliAuthorizeInitiateResponse: one-shot opaque code (never displayed) + browser_url URL + expires_at wall-clock', () => {
    expect(body).toMatch(
      /\/\*\* One-shot opaque code; never displayed to the user\. \*\/\s*\n?\s*code: z\.string\(\),\s*\n?\s*\/\*\* URL the CLI\/GUI opens in the system browser\. The dashboard's\s*\n?\s*\*\s*\/cli\/authorize page reads `code` \+ `state` from the query string\. \*\/\s*\n?\s*browser_url: z\.string\(\)\.url\(\),\s*\n?\s*\/\*\* Wall-clock expiry of the code; the CLI\/GUI gives up polling after this\. \*\/\s*\n?\s*expires_at: Iso8601Schema,/,
    );
  });

  it('CliAuthorizeBindRequest (web-session auth required): code/state 16..128 + optional scopes .min(1); defaults to ["account_owner"] server-side rationale', () => {
    expect(body).toMatch(
      /\/\/ ─── \/v1\/auth\/cli-authorize\/bind \(web-session auth required\) ───────/,
    );
    expect(body).toMatch(
      /export const CliAuthorizeBindRequestSchema = z\.object\(\{\s*\n?\s*code: z\.string\(\)\.min\(16\)\.max\(128\),\s*\n?\s*state: z\.string\(\)\.min\(16\)\.max\(128\),\s*\n?\s*\/\*\* Scopes to attach to the minted API key\. Defaults to\s*\n?\s*\*\s*\["account_owner"\] server-side if omitted\. \*\/\s*\n?\s*scopes: z\.array\(ApiKeyScopeSchema\)\.min\(1\)\.optional\(\),\s*\n?\s*\}\);/,
    );
  });

  it('CliAuthorizeBindResponse: ok literal true + account_id (echoed for dashboard confirmation UI; plaintext key NEVER returned here — only via /exchange) + expires_at', () => {
    expect(body).toMatch(
      /export const CliAuthorizeBindResponseSchema = z\.object\(\{\s*\n?\s*ok: z\.literal\(true\),\s*\n?\s*\/\*\* Echoed for the dashboard's confirmation UI \("Authorized as\s*\n?\s*\*\s*acc_…"\)\. The plaintext key NEVER returns through this endpoint —\s*\n?\s*\*\s*only the CLI\/GUI receives it via \/exchange\. \*\/\s*\n?\s*account_id: z\.string\(\),\s*\n?\s*expires_at: Iso8601Schema,\s*\n?\s*\}\);/,
    );
  });

  it('CliAuthorizeExchangeStatus enum pinned: pending | bound | expired; status transition rationale comment', () => {
    expect(body).toMatch(
      /`pending` → keep polling\. `bound` → key delivered \(one-shot;[\s\S]*?subsequent poll returns[\s\S]*?`\{ status: 'expired' \}` with HTTP 200\)\. `expired` → user took too[\s\S]*?restart the flow\./,
    );
    expect(body).toMatch(
      /export const CliAuthorizeExchangeStatusSchema = z\.enum\(\['pending', 'bound', 'expired'\]\);/,
    );
  });

  it('CliAuthorizeExchangeResponse: discriminated-union on status; pending branch (status only); bound branch (api_key + account_id one-shot); expired branch (status only)', () => {
    expect(body).toMatch(
      /export const CliAuthorizeExchangePendingResponseSchema = z\.object\(\{\s*\n?\s*status: z\.literal\('pending'\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const CliAuthorizeExchangeBoundResponseSchema = z\.object\(\{\s*\n?\s*status: z\.literal\('bound'\),\s*\n?\s*api_key: z\.string\(\),\s*\n?\s*account_id: z\.string\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const CliAuthorizeExchangeExpiredResponseSchema = z\.object\(\{\s*\n?\s*status: z\.literal\('expired'\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const CliAuthorizeExchangeResponseSchema = z\.discriminatedUnion\('status', \[\s*\n?\s*CliAuthorizeExchangePendingResponseSchema,\s*\n?\s*CliAuthorizeExchangeBoundResponseSchema,\s*\n?\s*CliAuthorizeExchangeExpiredResponseSchema,\s*\n?\s*\]\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
