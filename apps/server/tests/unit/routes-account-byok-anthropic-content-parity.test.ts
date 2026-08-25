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
      /\/\/ AI-CHAT BYOK Anthropic — customer-facing key-management routes\.\s*\/\/ Tier-3 verdicts LOCKED 2026-05-17:\s*\/\/\s+Q3 team-scope: account_owner-only \(members USE, can't SET\/CLEAR\/TEST\)/,
    );
    expect(body).toMatch(
      /\/\/\s+PUT\s+\/v1\/account\/me\/byok-anthropic-key\s+— set\/rotate\s*\/\/\s+DELETE \/v1\/account\/me\/byok-anthropic-key\s+— clear\s*\/\/\s+GET\s+\/v1\/account\/me\/byok-anthropic-key\s+— metadata only\s*\/\/\s+POST\s+\/v1\/account\/me\/byok-anthropic-key\/test\s+— connection test/,
    );
  });

  it("Activation-gate 6th-gated-feature framing pinned: '(6th gated feature; matches billing / session-proxy / saved-proxies / agent-sessions / fleet-events). When byokAnthropicService is unset in AppDeps (i.e. MFA_ENCRYPTION_KEY env not configured), registerAccountByokAnthropicDisabledRoutes surfaces 503 + FeatureUnavailable on the same paths.' — pinned so the 6th-of-6 gated-feature roster cross-reference + MFA_ENCRYPTION_KEY-required-to-construct contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Activation-gate pattern \(6th gated feature; matches billing \/\s*\/\/ session-proxy \/ saved-proxies \/ agent-sessions \/ fleet-events\)\.\s*\/\/ When `byokAnthropicService` is unset in AppDeps \(i\.e\.\s*\/\/ MFA_ENCRYPTION_KEY env not configured\), `registerAccountByokAnthropicDisabledRoutes`\s*\/\/ surfaces 503 \+ FeatureUnavailable on the same paths\./,
    );
  });

  it("Q2 audit framing pinned: 'Audit log entries land in a follow-up slice — the V-216 AccountAuditAction enum needs 3 new additive values (account.byok_anthropic_key_{set,cleared,tested}) which is a Class-A schema change that ships separately. Per Q2 verdict, when audit DOES land, it records account_id + timestamp + event only; NO key-prefix fingerprint.' — pinned so the Class-A schema change + 3-additive-action-values + Q2-no-key-prefix-fingerprint contract all stay documented (drift to logging key-prefix would leak partial-key material into audit rows)", () => {
    expect(body).toMatch(
      /\/\/ Audit log entries land in a follow-up slice — the V-216\s*\/\/ `AccountAuditAction` enum needs 3 new additive values\s*\/\/ \(`account\.byok_anthropic_key_\{set,cleared,tested\}`\) which is a\s*\/\/ Class-A schema change that ships separately\. Per Q2 verdict, when\s*\/\/ audit DOES land, it records `account_id` \+ timestamp \+ event only;\s*\/\/ NO key-prefix fingerprint\./,
    );
  });

  it('classifyTestOutcome uses the typed tester outcome so customer copy cannot change metric cardinality', () => {
    expect(body).toMatch(
      /function classifyTestOutcome\(\s*result: AnthropicKeyTestResult,\s*\): 'ok' \| 'invalid' \| 'quota_exceeded' \| 'unknown' \{/,
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

  it('GET metadata-only-no-plaintext framing pinned: broad read is required because timestamps are account-wide credential metadata; 3-field response never returns plaintext', () => {
    expect(body).toMatch(
      /\/\/ GET \/v1\/account\/me\/byok-anthropic-key — metadata only; NEVER\s*\/\/ returns plaintext\. Broad read is required because set\/use timestamps\s*\/\/ are account-wide credential metadata, not a resource-granular read\./,
    );
    expect(body).toMatch(
      /'\/v1\/account\/me\/byok-anthropic-key',\s*\{ preHandler: \[app\.requireAuth, app\.requireScope\('read'\), app\.rateLimit\('global'\)\] \}/,
    );
    expect(body).toMatch(
      /return \{\s*has_key: meta\.hasKey,\s*set_at: meta\.setAt \? meta\.setAt\.toISOString\(\) : null,\s*last_used_at: meta\.lastUsedAt \? meta\.lastUsedAt\.toISOString\(\) : null,\s*\};/,
    );
  });

  it("PUT account_owner-scope framing pinned: 'set or rotate. account_owner scope required (Q3 verdict; team members may USE the resolved key but cannot manage it).' + app.requireScope('account_owner') + 'Body must include a non-empty `api_key` string.' BadRequest on missing/empty + InvalidKeyFormatError → BadRequestError catch — pinned so the Q3-owner-only + members-USE-cannot-MANAGE + InvalidKeyFormat-as-BadRequest contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ PUT \/v1\/account\/me\/byok-anthropic-key — set or rotate\. account_owner\s*\/\/ scope required \(Q3 verdict; team members may USE the resolved key\s*\/\/ but cannot manage it\)\./,
    );
    expect(body).toMatch(/app\.requireScope\('account_owner'\)/);
    expect(body).toMatch(
      /throw new BadRequestError\('Body must include a non-empty `api_key` string\.'\);/,
    );
    expect(body).toMatch(
      /if \(err instanceof InvalidKeyFormatError\) \{\s*throw new BadRequestError\(err\.message\);/,
    );
  });

  it("DELETE 204-no-content framing pinned: 'clear. account_owner scope required. 204 No Content on success.' + reply.code(204); return null — pinned so the 204-vs-200 + No-Content + account_owner-required contract stays documented (drift to 200-with-empty-body would change the customer SDK's expected response shape)", () => {
    expect(body).toMatch(
      /\/\/ DELETE \/v1\/account\/me\/byok-anthropic-key — clear\. account_owner\s*\/\/ scope required\. 204 No Content on success\./,
    );
    expect(body).toMatch(
      /await service\.clearKey\(\{ accountId: ctx\.account\.id, now: now\(\) \}\);/,
    );
    expect(body).toMatch(/reply\.code\(204\);\s*return null;/);
  });

  it("POST /test no-key-echo + team-quota-protection framing pinned: 'Returns ok/error WITHOUT echoing any part of the key. account_owner scope so team members can't burn the owner's quota.' + getPlaintext + 'No BYOK Anthropic key is set on this account. Use PUT /v1/account/me/byok-anthropic-key first.' BadRequest on null + metrics bump on each path (+ 2026-05-20 audit emit on each outcome) — pinned so the no-key-echo + account_owner-protects-team-quota + actionable-no-key-set guidance contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ POST \/v1\/account\/me\/byok-anthropic-key\/test — connection test\.\s*\/\/ Returns ok\/error WITHOUT echoing any part of the key\. account_owner\s*\/\/ scope so team members can't burn the owner's quota\./,
    );
    expect(body).toMatch(
      /throw new BadRequestError\(\s*'No BYOK Anthropic key is set on this account\. ' \+\s*'Use PUT \/v1\/account\/me\/byok-anthropic-key first\.',\s*\);/,
    );
    expect(body).toMatch(
      /metrics\?\.inc\(METRIC_NAMES\.byokAnthropicTestTotal, \{ outcome: 'not_set' \}\);/,
    );
    expect(body).toMatch(/const outcome = classifyTestOutcome\(result\);/);
    expect(body).toMatch(
      /metrics\?\.inc\(METRIC_NAMES\.byokAnthropicTestTotal, \{\s*outcome,\s*\}\);/,
    );
  });

  it('Disabled-stub 4-verb registration + stable current-state detail and customer-facing docs URL are pinned', () => {
    expect(body).toMatch(
      /\/\/ Customer-facing detail\. Lands verbatim in the SDK's 503 problem\s*\/\/ body — point at the customer-facing docs URL, NOT the internal\s*\/\/ design doc\. Same fix shape as agent-sessions disabled-stub\s*\/\/ \(slice 87 \/ 6efc0a34\)\./,
    );
    expect(body).toMatch(
      /'BYOK Anthropic key management is unavailable on this deployment\. ' \+\s*"Use the deployment's configured AI provider, or contact its operator if customer-managed keys are required\. See " \+\s*'https:\/\/docs\.driftstack\.dev\/api\/byok-anthropic\/ for the supported key-management flow\.';/,
    );
    expect(body).toMatch(/app\.get\('\/v1\/account\/me\/byok-anthropic-key', stub\);/);
    expect(body).toMatch(/app\.put\('\/v1\/account\/me\/byok-anthropic-key', stub\);/);
    expect(body).toMatch(/app\.delete\('\/v1\/account\/me\/byok-anthropic-key', stub\);/);
    expect(body).toMatch(/app\.post\('\/v1\/account\/me\/byok-anthropic-key\/test', stub\);/);
  });
});
