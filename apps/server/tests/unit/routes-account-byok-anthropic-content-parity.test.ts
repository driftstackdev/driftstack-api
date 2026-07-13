// Drift guard for apps/server/src/routes/account-byok-anthropic.ts.
// Pins the AI-CHAT BYOK Anthropic customer-facing key-management
// surface. Tier-3 verdicts LOCKED 2026-05-17: Q3 account_owner-only
// for PUT/DELETE/POST-test. The GET-metadata-only never returns
// plaintext. Drift to surfacing plaintext on GET would defeat the
// whole point of the encrypted-at-rest envelope.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/account-byok-anthropic.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('routes/account-byok-anthropic content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("AI-CHAT BYOK Anthropic module-level framing pinned: 'customer-facing key-management routes. Tier-3 verdicts LOCKED 2026-05-17: Q3 team-scope: account_owner-only (members USE, can't SET/CLEAR/TEST). Surface: PUT /v1/account/me/byok-anthropic-key — set/rotate + DELETE /v1/account/me/byok-anthropic-key — clear + GET /v1/account/me/byok-anthropic-key — metadata only + POST /v1/account/me/byok-anthropic-key/test — connection test.' — pinned so the Tier-3-2026-05-17-LOCKED + Q3-account_owner-only + 4-endpoint surface roster + members-USE-cannot-MANAGE contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ AI-CHAT BYOK Anthropic — customer-facing key-management routes\.\s*\n?\s*\/\/ Tier-3 verdicts LOCKED 2026-05-17:\s*\n?\s*\/\/\s+Q3 team-scope: account_owner-only \(members USE, can't SET\/CLEAR\/TEST\)/,
    );
    expect(body).toMatch(
      /\/\/\s+PUT\s+\/v1\/account\/me\/byok-anthropic-key\s+— set\/rotate\s*\n?\s*\/\/\s+DELETE \/v1\/account\/me\/byok-anthropic-key\s+— clear\s*\n?\s*\/\/\s+GET\s+\/v1\/account\/me\/byok-anthropic-key\s+— metadata only\s*\n?\s*\/\/\s+POST\s+\/v1\/account\/me\/byok-anthropic-key\/test\s+— connection test/,
    );
  });

  it("Activation-gate 6th-gated-feature framing pinned: '(6th gated feature; matches billing / session-proxy / saved-proxies / agent-sessions / fleet-events). When byokAnthropicService is unset in AppDeps (i.e. MFA_ENCRYPTION_KEY env not configured), registerAccountByokAnthropicDisabledRoutes surfaces 503 + FeatureUnavailable on the same paths.' — pinned so the 6th-of-6 gated-feature roster cross-reference + MFA_ENCRYPTION_KEY-required-to-construct contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Activation-gate pattern \(6th gated feature; matches billing \/\s*\n?\s*\/\/ session-proxy \/ saved-proxies \/ agent-sessions \/ fleet-events\)\.\s*\n?\s*\/\/ When `byokAnthropicService` is unset in AppDeps \(i\.e\.\s*\n?\s*\/\/ MFA_ENCRYPTION_KEY env not configured\), `registerAccountByokAnthropicDisabledRoutes`\s*\n?\s*\/\/ surfaces 503 \+ FeatureUnavailable on the same paths\./,
    );
  });

  it("Q2 audit framing pinned: 'Audit log entries land in a follow-up slice — the V-216 AccountAuditAction enum needs 3 new additive values (account.byok_anthropic_key_{set,cleared,tested}) which is a Class-A schema change that ships separately. Per Q2 verdict, when audit DOES land, it records account_id + timestamp + event only; NO key-prefix fingerprint.' — pinned so the Class-A schema change + 3-additive-action-values + Q2-no-key-prefix-fingerprint contract all stay documented (drift to logging key-prefix would leak partial-key material into audit rows)", () => {
    expect(body).toMatch(
      /\/\/ Audit log entries land in a follow-up slice — the V-216\s*\n?\s*\/\/ `AccountAuditAction` enum needs 3 new additive values\s*\n?\s*\/\/ \(`account\.byok_anthropic_key_\{set,cleared,tested\}`\) which is a\s*\n?\s*\/\/ Class-A schema change that ships separately\. Per Q2 verdict, when\s*\n?\s*\/\/ audit DOES land, it records `account_id` \+ timestamp \+ event only;\s*\n?\s*\/\/ NO key-prefix fingerprint\./,
    );
  });

  it('classifyTestOutcome uses the typed tester outcome so customer copy cannot change metric cardinality', () => {
    expect(body).toMatch(
      /function classifyTestOutcome\(\s*\n?\s*result: AnthropicKeyTestResult,\s*\n?\s*\): 'ok' \| 'invalid' \| 'quota_exceeded' \| 'unknown' \{/,
    );
    expect(body).toMatch(/return result\.ok \? 'ok' : result\.outcome;/);
    expect(body).not.toContain("includes('not yet wired')");
  });

  it('uses the live no-inference Anthropic tester by default while retaining test injection', () => {
    expect(body).toContain(
      "import { testAnthropicKey, type AnthropicKeyTestResult } from '../services/anthropic-key-tester.js';",
    );
    expect(body).toMatch(/testConnection\?: \(key: string\) => Promise<AnthropicKeyTestResult>;/);
    expect(body).toMatch(/const testConnection = opts\.testConnection \?\? testAnthropicKey;/);
    expect(body).not.toContain('defaultTestConnection');
    expect(body).not.toContain('Connection tester not yet wired');
  });

  it("GET metadata-only-no-plaintext framing pinned: 'metadata only; NEVER returns plaintext. Read scope is sufficient (any account holder can see whether their account has a BYOK key set).' + 3-field response { has_key + set_at + last_used_at } — pinned so the no-plaintext + read-scope-sufficient + 3-field-metadata contract stays documented (drift to surfacing any key prefix/suffix on GET would defeat the encrypted-at-rest envelope)", () => {
    expect(body).toMatch(
      /\/\/ GET \/v1\/account\/me\/byok-anthropic-key — metadata only; NEVER\s*\n?\s*\/\/ returns plaintext\. Read scope is sufficient \(any account holder\s*\n?\s*\/\/ can see whether their account has a BYOK key set\)\./,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*has_key: meta\.hasKey,\s*\n?\s*set_at: meta\.setAt \? meta\.setAt\.toISOString\(\) : null,\s*\n?\s*last_used_at: meta\.lastUsedAt \? meta\.lastUsedAt\.toISOString\(\) : null,\s*\n?\s*\};/,
    );
  });

  it("PUT account_owner-scope framing pinned: 'set or rotate. account_owner scope required (Q3 verdict; team members may USE the resolved key but cannot manage it).' + app.requireScope('account_owner') + 'Body must include a non-empty `api_key` string.' BadRequest on missing/empty + InvalidKeyFormatError → BadRequestError catch — pinned so the Q3-owner-only + members-USE-cannot-MANAGE + InvalidKeyFormat-as-BadRequest contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ PUT \/v1\/account\/me\/byok-anthropic-key — set or rotate\. account_owner\s*\n?\s*\/\/ scope required \(Q3 verdict; team members may USE the resolved key\s*\n?\s*\/\/ but cannot manage it\)\./,
    );
    expect(body).toMatch(/app\.requireScope\('account_owner'\)/);
    expect(body).toMatch(
      /throw new BadRequestError\('Body must include a non-empty `api_key` string\.'\);/,
    );
    expect(body).toMatch(
      /if \(err instanceof InvalidKeyFormatError\) \{\s*\n?\s*throw new BadRequestError\(err\.message\);/,
    );
  });

  it("DELETE 204-no-content framing pinned: 'clear. account_owner scope required. 204 No Content on success.' + reply.code(204); return null — pinned so the 204-vs-200 + No-Content + account_owner-required contract stays documented (drift to 200-with-empty-body would change the customer SDK's expected response shape)", () => {
    expect(body).toMatch(
      /\/\/ DELETE \/v1\/account\/me\/byok-anthropic-key — clear\. account_owner\s*\n?\s*\/\/ scope required\. 204 No Content on success\./,
    );
    expect(body).toMatch(
      /await service\.clearKey\(\{ accountId: ctx\.account\.id, now: now\(\) \}\);/,
    );
    expect(body).toMatch(/reply\.code\(204\);\s*\n?\s*return null;/);
  });

  it("POST /test no-key-echo + team-quota-protection framing pinned: 'Returns ok/error WITHOUT echoing any part of the key. account_owner scope so team members can't burn the owner's quota.' + getPlaintext + 'No BYOK Anthropic key is set on this account. Use PUT /v1/account/me/byok-anthropic-key first.' BadRequest on null + metrics bump on each path (+ 2026-05-20 audit emit on each outcome) — pinned so the no-key-echo + account_owner-protects-team-quota + actionable-no-key-set guidance contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ POST \/v1\/account\/me\/byok-anthropic-key\/test — connection test\.\s*\n?\s*\/\/ Returns ok\/error WITHOUT echoing any part of the key\. account_owner\s*\n?\s*\/\/ scope so team members can't burn the owner's quota\./,
    );
    expect(body).toMatch(
      /throw new BadRequestError\(\s*\n?\s*'No BYOK Anthropic key is set on this account\. ' \+\s*\n?\s*'Use PUT \/v1\/account\/me\/byok-anthropic-key first\.',\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /metrics\?\.inc\(METRIC_NAMES\.byokAnthropicTestTotal, \{ outcome: 'not_set' \}\);/,
    );
    expect(body).toMatch(/const outcome = classifyTestOutcome\(result\);/);
    expect(body).toMatch(
      /metrics\?\.inc\(METRIC_NAMES\.byokAnthropicTestTotal, \{\s*\n?\s*outcome,\s*\n?\s*\}\);/,
    );
  });

  it("Disabled-stub 4-verb registration + customer-facing-docs-URL framing pinned: 'BYOK Anthropic key management is not yet enabled on this deployment. Once the operator configures the deployment, customers can store their own Anthropic key via PUT /v1/account/me/byok-anthropic-key. See https://docs.driftstack.dev/api/byok-anthropic/ for the full flow.' + app.get + app.put + app.delete + app.post all bound to the same stub — pinned so the agent-sessions-symmetric slice 87 / 6efc0a34 fix-shape + 4-verb-disabled contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Customer-facing detail\. Lands verbatim in the SDK's 503 problem\s*\n?\s*\/\/ body — point at the customer-facing docs URL, NOT the internal\s*\n?\s*\/\/ design doc\. Same fix shape as agent-sessions disabled-stub\s*\n?\s*\/\/ \(slice 87 \/ 6efc0a34\)\./,
    );
    expect(body).toMatch(
      /'BYOK Anthropic key management is not yet enabled on this deployment\. ' \+\s*\n?\s*'Once the operator configures the deployment, customers can store their ' \+\s*\n?\s*'own Anthropic key via PUT \/v1\/account\/me\/byok-anthropic-key\. See ' \+\s*\n?\s*'https:\/\/docs\.driftstack\.dev\/api\/byok-anthropic\/ for the full flow\.';/,
    );
    expect(body).toMatch(/app\.get\('\/v1\/account\/me\/byok-anthropic-key', stub\);/);
    expect(body).toMatch(/app\.put\('\/v1\/account\/me\/byok-anthropic-key', stub\);/);
    expect(body).toMatch(/app\.delete\('\/v1\/account\/me\/byok-anthropic-key', stub\);/);
    expect(body).toMatch(/app\.post\('\/v1\/account\/me\/byok-anthropic-key\/test', stub\);/);
  });
});
