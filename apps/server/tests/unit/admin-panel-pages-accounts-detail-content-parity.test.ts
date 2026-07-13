// W490.C — drift guard for the static account-detail shell.
// V-191 + V-200 per-account manual-operations surface. Drift here
// either breaks the URL-preserving arbitrary-ID rewrite contract or
// breaks the V-281 audit-only support
// tooling (record-refund could silently issue real refunds if the
// 'Stripe dashboard' framing is lost).
//
//   • Deterministic static shell, exact two-segment URL derivation,
//     and `_redirects`-backed arbitrary account IDs.
//   • 6 admin actions: change-tier / suspend / unsuspend / set-
//     override / add-note / record-refund.
//   • Conditional visibility: suspend visible when status==='active';
//     unsuspend visible when status==='suspended'.
//   • V-196 inline override form: bucket_key 3-option / capacity
//     min=1 / refill_per_second min=0.01 step=0.01 /
//     duration_seconds default 1209600 (14d) / required reason.
//   • V-281 record-refund 'audit-only' framing + Stripe-dashboard
//     reminder.
//   • path-derive accountUuid pattern for live UUIDs not in mock.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/shells/account-detail.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W490.C admin account-detail static shell content parity', () => {
  const body = read(LIB);

  it("V-191 framing pinned: 'progressive-enhancement against /v1/admin/accounts/:id + per-account audit slice + admin-action POSTs (change tier, suspend, unsuspend).' — pinned so the 3 canonical admin actions stay enumerated in the source-of-truth comment (drift to '2 actions' or adding new actions without updating this list would create comment/code mismatch)", () => {
    expect(body).toMatch(
      /\/\/ V-191 — progressive-enhancement against \/v1\/admin\/accounts\/:id \+\s*\n?\s*\/\/ per-account audit slice \+ admin-action POSTs \(change tier, suspend,\s*\n?\s*\/\/ unsuspend\)\./,
    );
  });

  it('Static Pages shell framing is pinned: arbitrary account ids are served by an internal rewrite, the browser URL is preserved, and no SSR/Worker API is used', () => {
    expect(body).toMatch(/deterministic static shell/);
    expect(body).toMatch(/internally rewrites \/accounts\/<id>/);
    expect(body).toMatch(/preserving the\s*\n?\s*\/\/ browser URL/);
    expect(body).toMatch(/without a Pages Worker or SSR adapter/);
    expect(body).not.toMatch(/export const prerender = false/);
    expect(body).not.toMatch(/Astro\.params/);
  });

  it('Admin actions 6-button row: change-tier / suspend / unsuspend / set-override / add-note / record-refund — pinned so the canonical operator-action vocabulary stays complete (drift to dropping record-refund would lose V-281 audit-only support tooling)', () => {
    expect(body).toMatch(/data-action="change-tier"/);
    expect(body).toMatch(/data-action="suspend"/);
    expect(body).toMatch(/data-action="unsuspend"/);
    expect(body).toMatch(/data-action="set-override"/);
    expect(body).toMatch(/data-action="add-note"/);
    expect(body).toMatch(/data-action="record-refund"/);
  });

  it("Conditional visibility: suspend visible iff status === 'active' + unsuspend visible iff status === 'suspended' in both the static shell and live-data update", () => {
    expect(body).toMatch(/account\.status === 'active' \? '' : 'hidden',/);
    expect(body).toMatch(/account\.status === 'suspended' \? '' : 'hidden',/);
    expect(body).toMatch(
      /if \(a\.status === 'active'\) suspendBtn\.classList\.remove\('hidden'\);\s*\n?\s*else suspendBtn\.classList\.add\('hidden'\);/,
    );
    expect(body).toMatch(
      /if \(a\.status === 'suspended'\) unsuspendBtn\.classList\.remove\('hidden'\);\s*\n?\s*else unsuspendBtn\.classList\.add\('hidden'\);/,
    );
  });

  it("V-196 inline override form framing pinned: 'inline rate-limit-override form. Hidden by default; the Set-rate-limit-override button reveals it. Submit POSTs to /v1/admin/accounts/:id/quota-override; the audit row records admin id + key id + bucket + reason. Form intentionally lives on the per-account page (Decision 4 from founder review): canonical staff workflow is /accounts → detail → set, not a top-level form on /rate-limit-overrides.' — pinned so the Decision-4 workflow framing survives (drift to duplicating the form on /rate-limit-overrides would split operator muscle memory)", () => {
    expect(body).toMatch(
      /V-196 — inline rate-limit-override form\. Hidden by default; the\s*\n?\s*Set-rate-limit-override button reveals it\. Submit POSTs to\s*\n?\s*\/v1\/admin\/accounts\/:id\/quota-override; the audit row records\s*\n?\s*admin id \+ key id \+ bucket \+ reason\. Form intentionally lives\s*\n?\s*on the per-account page \(Decision 4 from founder review\):\s*\n?\s*canonical staff workflow is \/accounts → detail → set, not a\s*\n?\s*top-level form on \/rate-limit-overrides\./,
    );
  });

  it('Override form fields: bucket_key 3-option matching the canonical SetQuotaOverrideRequestSchema enum (global / sessions:create / agent_sessions:message — the server 400s on anything else; the prior session_create/capture values were rejected) + capacity number min=1 step=1 required + refill_per_second min=0.01 step=0.01 required + duration_seconds value=1209600 (14d default) + required reason textarea — pinned so the 14-day default (1209600 = 14×24×3600) stays consistent + the option values stay canonical so the POST passes validation', () => {
    expect(body).toMatch(/<option value="global">Global<\/option>/);
    expect(body).toMatch(/<option value="sessions:create">Sessions: create<\/option>/);
    expect(body).toMatch(
      /<option value="agent_sessions:message">Agent sessions: message<\/option>/,
    );
    expect(body).toMatch(
      /<input\s*\n?\s*type="number"\s*\n?\s*name="capacity"\s*\n?\s*min="1"\s*\n?\s*step="1"\s*\n?\s*required/,
    );
    expect(body).toMatch(
      /<input\s*\n?\s*type="number"\s*\n?\s*name="refill_per_second"\s*\n?\s*min="0\.01"\s*\n?\s*step="0\.01"\s*\n?\s*required/,
    );
    expect(body).toMatch(
      /<input\s*\n?\s*type="number"\s*\n?\s*name="duration_seconds"\s*\n?\s*min="60"\s*\n?\s*step="60"\s*\n?\s*value="1209600"/,
    );
  });

  it("Override submit validation: All fields required (bucket_key + Number.isFinite capacity + Number.isFinite refill_per_second + Number.isFinite duration_seconds + non-empty reason) → 'All fields required (reason is audited).' bail-banner — pinned so the form can't submit with NaN or empty reason (audit-log integrity)", () => {
    expect(body).toMatch(
      /if \(\s*\n?\s*!payload\.bucket_key \|\|\s*\n?\s*!Number\.isFinite\(payload\.capacity\) \|\|\s*\n?\s*!Number\.isFinite\(payload\.refill_per_second\) \|\|\s*\n?\s*!Number\.isFinite\(payload\.duration_seconds\) \|\|\s*\n?\s*!payload\.reason\s*\n?\s*\) \{\s*\n?\s*showBanner\('All fields required \(reason is audited\)\.'\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it("V-281 audit-only support tooling: addSupportNote prompts for free-form note (max 2000 chars) and POSTs to /audit-note; recordRefund prompts for external_reference (Stripe charge/payment_intent/invoice id) + amount_cents (positive int) + reason (required) and POSTs to /refund-record with 'Reminder: actual refund is issued via Stripe dashboard — this endpoint is audit-only.' confirmation — pinned so the audit-only framing survives (drift to actual refund integration would couple admin panel to Stripe API and could double-issue refunds)", () => {
    expect(body).toMatch(/async function addSupportNote\(\)/);
    expect(body).toMatch(/Support note \(free-form, max 2000 chars\)/);
    expect(body).toMatch(/\/audit-note'/);
    expect(body).toMatch(
      /'Refund recorded\. Reminder: actual refund is issued via Stripe dashboard — this endpoint is audit-only\.',/,
    );
    expect(body).toMatch(
      /authedFetch\('\/v1\/admin\/accounts\/' \+ encodeURIComponent\(prefixedId\) \+ '\/refund-record', \{/,
    );
  });

  it("Refund amount validation: const amount_cents = Number(amountStr) + !Number.isInteger(amount_cents) || amount_cents <= 0 → 'Refund amount must be a positive integer (cents).' bail-banner — pinned so non-integer or zero-cent refunds can't land in the audit log (drift to allowing floats would split the refund into fractional cents which doesn't match Stripe's billing model)", () => {
    expect(body).toMatch(
      /const amount_cents = Number\(amountStr\);\s*\n?\s*if \(!Number\.isInteger\(amount_cents\) \|\| amount_cents <= 0\) \{\s*\n?\s*showBanner\('Refund amount must be a positive integer \(cents\)\.'\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it("derives accountUuid from an exact two-segment /accounts/:id path and consistently applies the server's acc_ prefix", () => {
    expect(body).toMatch(
      /\/\/ The Pages rewrite preserves the requested URL, so the live UUID is\s*\n?\s*\/\/ available here even though every detail request shares one shell\./,
    );
    expect(body).toMatch(
      /const pathParts = window\.location\.pathname\.split\('\/'\)\.filter\(Boolean\);\s*\n?\s*const accountUuid =\s*\n?\s*pathParts\.length === 2 && pathParts\[0\] === 'accounts' \? pathParts\[1\] \|\| '' : '';\s*\n?\s*const prefixedId = 'acc_' \+ accountUuid;/,
    );
  });

  it('Banner state taxonomy distinguishes forbidden / not-found / generic failures while every branch neutralizes the account shell instead of presenting preview data as authoritative', () => {
    expect(body).toMatch(
      /if \(msg === 'forbidden'\) \{\s*renderUnavailable\('This account is unavailable with the current admin access\.'\);\s*showBanner\(\s*'Access denied — admin scope required\. You are signed in as a customer account\.',\s*\);\s*\} else if \(msg === 'not-found'\) \{\s*renderUnavailable\('No account was found for this link\.'\);\s*showBanner\('Account not found\.'\);\s*\} else \{\s*renderUnavailable\(\s*'Account data could not be loaded\. Resolve the error above and retry\.',\s*\);\s*showBanner\("Couldn't load account \(" \+ msg \+ '\)\.'\);\s*\}/,
    );
    expect(body).not.toMatch(/Showing preview(?: data)? below|Showing preview shell/);
  });

  it('The static shell starts inert and unavailable states neutralize identity, facts, status, cost, audit, account link, transition controls, and the override form', () => {
    expect(body).toMatch(
      /status: 'unavailable' as 'active' \| 'suspended' \| 'deleted' \| 'unavailable'/,
    );
    for (const action of [
      'change-tier',
      'suspend',
      'unsuspend',
      'set-override',
      'add-note',
      'record-refund',
    ]) {
      expect(body).toMatch(
        new RegExp(
          `<button[^>]*data-action="${action}"[^>]*disabled[^>]*aria-disabled="true"[^>]*>`,
        ),
      );
    }
    expect(body).toMatch(
      /<a\s*data-field="full-audit-link"\s*aria-disabled="true"\s*tabindex="-1"/,
    );
    expect(body).toMatch(/let accountDataAvailable = false;/);
    expect(body).toMatch(/renderUnavailable\('Account details are loading…'\);/);
    expect(body).toMatch(
      /function renderUnavailable\(message\) \{\s*accountDataAvailable = false;[\s\S]*?setText\('title-name', 'Account unavailable'\);[\s\S]*?setText\('title-email', message\);[\s\S]*?setText\('account-id', '—'\);[\s\S]*?setText\('tier', '—'\);[\s\S]*?setText\('status', '—'\);/,
    );
    expect(body).toMatch(/badge\.textContent = 'unavailable';/);
    expect(body).toMatch(/if \(suspendBtn\) suspendBtn\.classList\.add\('hidden'\);/);
    expect(body).toMatch(/if \(unsuspendBtn\) unsuspendBtn\.classList\.add\('hidden'\);/);
    expect(body).toMatch(/if \(override\) override\.classList\.add\('hidden'\);/);
    expect(body).toMatch(/Cost data is unavailable until account details load\./);
    expect(body).toMatch(/Audit entries are unavailable until account details load\./);
    expect(body).toMatch(
      /fullAuditLink\.removeAttribute\('href'\);\s*fullAuditLink\.setAttribute\('aria-disabled', 'true'\);\s*fullAuditLink\.setAttribute\('tabindex', '-1'\);/,
    );
  });

  it('Only a complete live read restores the scoped audit link and mutation controls; mutation cleanup cannot re-enable an unavailable account', () => {
    expect(body).toMatch(
      /Promise\.all\(\[accountP, auditP, costP\]\)[\s\S]*?markAccountAvailable\(\);\s*hideBanner\(\);\s*return true;/,
    );
    expect(body).toMatch(
      /function markAccountAvailable\(\) \{\s*accountDataAvailable = true;[\s\S]*?'\/audit-log\?target_id=' \+ encodeURIComponent\(prefixedId\)[\s\S]*?syncAccountActionAvailability\(\);\s*\}/,
    );
    expect(body).toMatch(
      /button\.disabled =\s*unavailable \|\| accountMutationInFlight \|\| auditBlocked;/,
    );
    expect(body).toMatch(
      /button\.title = 'Load an authoritative account record before performing actions\.';/,
    );
    expect(body).toMatch(
      /function beginAccountMutation\(activeButton\) \{\s*if \(!accountDataAvailable \|\| accountMutationInFlight\) return false;/,
    );
    expect(body).toMatch(
      /function endAccountMutation\(activeButton\) \{\s*accountMutationInFlight = false;[\s\S]*?syncAccountActionAvailability\(\);/,
    );
    expect(body).toMatch(
      /if \(!token\) \{\s*renderUnavailable\('Sign in with a staff admin account to load this account\.'\);\s*showBanner\('Sign in with a staff admin account to see live data\.'\);/,
    );
  });

  it("Full-audit-log deep-link: /audit-log?target_id=acc_{account.id} — pinned so the 'Full audit log for this account →' anchor uses the server's filter param name (`target_id`, which admin-audit-log.ts filters by; the prior `account=` param was ignored by both the server route AND the audit-log page) and clicking lands on a view scoped to this account; the server strips the acc_ prefix via maybeUuidFromInput", () => {
    expect(body).toMatch(/data-field="full-audit-link"/);
    expect(body).toMatch(/'\/audit-log\?target_id=' \+ encodeURIComponent\(prefixedId\)/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
