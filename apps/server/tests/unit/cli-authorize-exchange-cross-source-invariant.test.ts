// W881 — V-266 CliAuthorizeExchange 3-status discriminated
// cross-source invariant. Two-hundred-seventh in the drift-guard
// series. Pins the V-266 browser-based CLI/GUI authorize flow's
// /v1/auth/cli-authorize/exchange 3-status discriminated-union:
//
//   1. pending — keep polling.
//   2. bound   — one-shot delivery; api_key + account_id present.
//                Code deleted on delivery → a re-poll returns expired
//                (HTTP 200).
//   3. expired — user took too long; restart the flow.
//
// stays in lockstep across:
//   - packages/api-types/src/cli-authorize.ts (Zod discriminated-
//     union of 3 variant schemas).
//   - packages/sdk-go/types.go (CliAuthorizeExchangeResponse
//     struct + 'discriminated on Status' inline doc).
//   - apps/gui-client/src/lib/browser-sign-in.ts (poll loop
//     branches on body.status === 'pending'/'expired'/'bound').
//
// Drift would silently break:
//   * CLI/GUI poll loop stuck waiting for a status the server
//     doesn't emit.
//   * Server emitting an unknown 4th status the client can't
//     decode.
//   * V-266 security model (one-shot key delivery).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const EXCHANGE_STATUSES = ['pending', 'bound', 'expired'] as const;

describe('W881 CliAuthorizeExchange cross-source invariant', () => {
  // ─── api-types: 3 variant schemas + discriminated-union ──────

  it("CRITICAL packages/api-types/src/cli-authorize.ts CliAuthorizeExchangeStatusSchema = z.enum(['pending', 'bound', 'expired']). The 3-status enum is the canonical poll-state set.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/cli-authorize.ts'));
    expect(p).toMatch(
      /export const CliAuthorizeExchangeStatusSchema = z\.enum\(\['pending', 'bound', 'expired'\]\);/,
    );
  });

  it("CRITICAL 3 variant response schemas declared — CliAuthorizeExchangePendingResponseSchema + CliAuthorizeExchangeBoundResponseSchema + CliAuthorizeExchangeExpiredResponseSchema. Only 'bound' carries api_key + account_id; pending/expired have status only.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/cli-authorize.ts'));
    expect(p).toMatch(
      /CliAuthorizeExchangePendingResponseSchema = z\.object\(\{\s*\n\s*status: z\.literal\('pending'\),\s*\n\s*\}\);/,
    );
    expect(p).toMatch(
      /CliAuthorizeExchangeBoundResponseSchema = z\.object\(\{\s*\n\s*status: z\.literal\('bound'\),\s*\n\s*api_key: z\.string\(\),\s*\n\s*account_id: z\.string\(\),\s*\n\s*\}\);/,
    );
    expect(p).toMatch(
      /CliAuthorizeExchangeExpiredResponseSchema = z\.object\(\{\s*\n\s*status: z\.literal\('expired'\),\s*\n\s*\}\);/,
    );
  });

  it("CRITICAL CliAuthorizeExchangeResponseSchema = z.discriminatedUnion('status', [3 variants]). The discriminated-union ensures Zod parse narrows correctly + the api_key field is only ever present on bound responses.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/cli-authorize.ts'));
    expect(p).toMatch(
      /export const CliAuthorizeExchangeResponseSchema = z\.discriminatedUnion\('status', \[\s*\n\s*CliAuthorizeExchangePendingResponseSchema,\s*\n\s*CliAuthorizeExchangeBoundResponseSchema,\s*\n\s*CliAuthorizeExchangeExpiredResponseSchema,\s*\n\s*\]\);/,
    );
  });

  // ─── V-266 anchor + status meanings doc ──────────────────────

  it("CRITICAL V-266 anchor pinned at file header. The 'Browser-based CLI / GUI authorization flow' framing pins the OAuth-style-handshake provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/cli-authorize.ts'));
    expect(p).toMatch(/V-266 — Browser-based CLI \/ GUI authorization flow/);
  });

  it("CRITICAL CliAuthorizeExchangeStatusSchema JSDoc pins the 3 status semantics — 'pending → keep polling. bound → key delivered (one-shot; code deleted on delivery → re-poll returns expired, HTTP 200). expired → user took too long; restart the flow.' The doc teaches consumers what each branch means.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/cli-authorize.ts'));
    expect(p).toMatch(/`pending` → keep polling/);
    // JSDoc wraps across lines; check the key phrases separately.
    expect(p).toMatch(/`bound` → key delivered \(one-shot;/);
    expect(p).toMatch(/`\{ status: 'expired' \}` with HTTP 200/);
    expect(p).toMatch(/`expired` → user took too\s*\n?\s*\*?\s*long/);
  });

  // ─── 4-step flow framing ────────────────────────────────────

  it('CRITICAL packages/api-types/src/cli-authorize.ts file header pins the 4-step flow — 1. CLI/GUI calls initiate; 2. user signs in; 3. dashboard binds; 4. CLI/GUI polls exchange. The 4-step doc is the canonical OAuth-handshake walkthrough.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/cli-authorize.ts'));
    expect(p).toMatch(/1\. CLI\/GUI calls \/v1\/auth\/cli-authorize\/initiate/);
    expect(p).toMatch(
      /3\. Dashboard calls \/v1\/auth\/cli-authorize\/bind-device-code with web-session/,
    );
    expect(p).toMatch(
      /4\. CLI\/GUI polls \/v1\/auth\/cli-authorize\/exchange until status\s*\n\/\/\s+flips from `pending` → `bound` → returns plaintext API key/,
    );
  });

  // ─── Go SDK: 'discriminated on Status' framing ────────────────

  it("CRITICAL packages/sdk-go/types.go CliAuthorizeExchangeResponse pins the 'discriminated on Status' inline doc + 3 status meanings + 'one-shot delivery; APIKey + AccountID populated. Code deleted on delivery → a re-poll returns Status expired (HTTP 200)' framing.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/CliAuthorizeExchangeResponse — discriminated on Status/);
    expect(p).toMatch(/"pending" — keep polling/);
    expect(p).toMatch(
      /"bound"\s+— one-shot delivery; APIKey \+ AccountID populated\.\s*\n\/\/\s+The server deletes the code on delivery, so a subsequent poll\s*\n\/\/\s+returns Status "expired" with HTTP 200\./,
    );
    expect(p).toMatch(/"expired" — user took too long/);
  });

  it("CRITICAL Go SDK CliAuthorizeExchangeResponse struct has 3 fields — Status (required) + APIKey (omitempty) + AccountID (omitempty). The omitempty on api_key + account_id is what makes Go's parsing match the api-types discriminated-union semantics (fields ONLY appear on bound).", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(
      /type CliAuthorizeExchangeResponse struct \{\s*\n\s*Status\s+string `json:"status"`\s*\n\s*APIKey\s+string `json:"api_key,omitempty"`\s*\n\s*AccountID string `json:"account_id,omitempty"`/,
    );
  });

  // ─── gui-client browser-sign-in poll loop ────────────────────

  it("CRITICAL apps/gui-client/src/lib/browser-sign-in.ts declares the 3-status union as 'status: pending | bound | expired'. The gui-client TS type matches the api-types Zod enum exactly.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/gui-client/src/lib/browser-sign-in.ts'));
    expect(p).toMatch(/status: 'pending' \| 'bound' \| 'expired';/);
  });

  it("CRITICAL apps/gui-client/src/lib/browser-sign-in.ts poll loop branches on all 3 statuses — 'pending' (return; keep polling), 'expired' (fail), 'bound' (verify api_key + account_id then return key). The exhaustive branching is what makes the poll loop robust.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/gui-client/src/lib/browser-sign-in.ts'));
    expect(p).toMatch(/if \(body\.status === 'pending'\) return;/);
    expect(p).toMatch(/if \(body\.status === 'expired'\)/);
    expect(p).toMatch(/if \(body\.status === 'bound' && body\.api_key && body\.account_id\)/);
  });

  // ─── 3-status cardinality + literal-discriminator ────────────

  it("CRITICAL CliAuthorizeExchange status = EXACTLY 3 values + each variant uses z.literal('pending'/'bound'/'expired'). The literals are what z.discriminatedUnion narrows on.", () => {
    expect(EXCHANGE_STATUSES.length).toBe(3);
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/cli-authorize.ts'));
    for (const s of EXCHANGE_STATUSES) {
      expect(p, `must have z.literal('${s}')`).toMatch(
        new RegExp(`status: z\\.literal\\('${s}'\\)`),
      );
    }
  });

  // ─── api_key + account_id ONLY on 'bound' ────────────────────

  it("CRITICAL api_key + account_id ONLY appear on the 'bound' variant — pending + expired variants have status field only. The narrow shape is what prevents accidentally leaking partial state on poll-while-pending.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/cli-authorize.ts'));
    // pending variant body has ONLY status — no api_key.
    const pendingMatch = p.match(
      /CliAuthorizeExchangePendingResponseSchema = z\.object\(\{([\s\S]+?)\}\)/,
    );
    expect(pendingMatch).not.toBeNull();
    expect(pendingMatch![1], 'pending variant MUST NOT contain api_key').not.toMatch(/api_key/);
    expect(pendingMatch![1], 'pending variant MUST NOT contain account_id').not.toMatch(
      /account_id/,
    );
    // expired variant body has ONLY status — no api_key.
    const expiredMatch = p.match(
      /CliAuthorizeExchangeExpiredResponseSchema = z\.object\(\{([\s\S]+?)\}\)/,
    );
    expect(expiredMatch).not.toBeNull();
    expect(expiredMatch![1], 'expired variant MUST NOT contain api_key').not.toMatch(/api_key/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/cli-authorize-exchange-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
