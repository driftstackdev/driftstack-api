// W490.C — drift guard for apps/admin-panel/src/pages/accounts/[id].astro.
// V-191 + V-200 per-account detail page with manual-operations
// surface. Drift here either drops the V-200 SSR migration framing
// (regressing to getStaticPaths would re-introduce the 404-on-
// non-mock-UUID bug) or breaks the V-281 audit-only support
// tooling (record-refund could silently issue real refunds if the
// 'Stripe dashboard' framing is lost).
//
//   • V-191 + V-200 framing pinned: 'progressive-enhancement
//     against /v1/admin/accounts/:id + per-account audit slice +
//     admin-action POSTs' + 'converted from getStaticPaths static
//     enumeration to SSR via the @astrojs/cloudflare adapter'.
//   • export const prerender = false (SSR mode).
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
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/accounts/[id].astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W490.C apps/admin-panel/src/pages/accounts/[id].astro content parity', () => {
  const body = read(LIB);

  it("V-191 framing pinned: 'progressive-enhancement against /v1/admin/accounts/:id + per-account audit slice + admin-action POSTs (change tier, suspend, unsuspend).' — pinned so the 3 canonical admin actions stay enumerated in the source-of-truth comment (drift to '2 actions' or adding new actions without updating this list would create comment/code mismatch)", () => {
    expect(body).toMatch(
      /\/\/ V-191 — progressive-enhancement against \/v1\/admin\/accounts\/:id \+\s*\n?\s*\/\/ per-account audit slice \+ admin-action POSTs \(change tier, suspend,\s*\n?\s*\/\/ unsuspend\)\./,
    );
  });

  it("V-200 SSR migration framing pinned: 'converted from getStaticPaths static enumeration to SSR via the @astrojs/cloudflare adapter. The page now serves any UUID at request time; Cloudflare Pages routes /accounts/<uuid> to the Worker which renders this template with Astro.params.id set. Mock-id matching for the SSG paint shell is preserved when the URL id matches one of the mock entries; non-mock UUIDs render with minimal placeholder content that the inline script then replaces from /v1/admin/accounts/:id. No more 404 on direct deep-links to live (non-mock) UUIDs from /accounts list page.' — pinned so the SSR migration + the 'no more 404' fix stay documented (drift back to getStaticPaths would re-introduce the bug)", () => {
    expect(body).toMatch(
      /\/\/ V-200 — converted from `getStaticPaths` static enumeration to SSR\s*\n?\s*\/\/ via the @astrojs\/cloudflare adapter\. The page now serves any UUID\s*\n?\s*\/\/ at request time; Cloudflare Pages routes \/accounts\/<uuid> to the\s*\n?\s*\/\/ Worker which renders this template with `Astro\.params\.id` set\./,
    );
    expect(body).toMatch(/export const prerender = false;/);
  });

  it('Admin actions 6-button row: change-tier / suspend / unsuspend / set-override / add-note / record-refund — pinned so the canonical operator-action vocabulary stays complete (drift to dropping record-refund would lose V-281 audit-only support tooling)', () => {
    expect(body).toMatch(/data-action="change-tier"/);
    expect(body).toMatch(/data-action="suspend"/);
    expect(body).toMatch(/data-action="unsuspend"/);
    expect(body).toMatch(/data-action="set-override"/);
    expect(body).toMatch(/data-action="add-note"/);
    expect(body).toMatch(/data-action="record-refund"/);
  });

  it("Conditional visibility: suspend visible iff status === 'active' + unsuspend visible iff status === 'suspended' (SSG class:list 'hidden' toggle + inline classList.remove/add) — pinned so the active/suspended state machine doesn't show contradictory buttons (drift to showing both would let operators click 'Suspend' on an already-suspended account, which would 409)", () => {
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

  it('Override form fields: bucket_key 3-option (global/session_create/capture) + capacity number min=1 step=1 required + refill_per_second min=0.01 step=0.01 required + duration_seconds value=1209600 (14d default) + required reason textarea — pinned so the 14-day default (1209600 = 14×24×3600) stays consistent with the framing comment elsewhere in the codebase', () => {
    expect(body).toMatch(/<option value="global">global<\/option>/);
    expect(body).toMatch(/<option value="session_create">session_create<\/option>/);
    expect(body).toMatch(/<option value="capture">capture<\/option>/);
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
    expect(body).toMatch(
      /function addSupportNote\(\) \{\s*\n?\s*const note = window\.prompt\(\s*\n?\s*'Support note \(free-form, max 2000 chars\)\. Recorded on this customer\\'s audit log \+ admin audit:',\s*\n?\s*\);/,
    );
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

  it("path-derive accountUuid pattern: pathParts = location.pathname.split('/').filter(Boolean) + accountUuid = pathParts[pathParts.length - 1] + prefixedId = 'acc_' + accountUuid — pinned so the live UUID is read from the URL (not the SSG-baked attribute) so the script works on non-mock UUIDs in SSR mode + the 'acc_' prefix is applied consistently for the /v1/admin/accounts/:id endpoint", () => {
    expect(body).toMatch(
      /\/\/ Derive the live UUID from the URL path rather than the SSG-baked\s*\n?\s*\/\/ attribute so a fallback \/ SSR conversion works without changing\s*\n?\s*\/\/ this script\./,
    );
    expect(body).toMatch(
      /const pathParts = window\.location\.pathname\.split\('\/'\)\.filter\(Boolean\);\s*\n?\s*const accountUuid = pathParts\[pathParts\.length - 1\] \|\| '';\s*\n?\s*const prefixedId = 'acc_' \+ accountUuid;/,
    );
  });

  it("Banner state taxonomy: 'forbidden' (admin scope required) / 'not-found' ('Account not found. Showing preview shell.') / generic ('Couldn't load account (msg). Showing preview data below.') — pinned so the 3-state error vocabulary distinguishes 403-forbidden from 404-not-found (drift to merging them would obscure whether the operator lacks scope vs the account just doesn't exist)", () => {
    expect(body).toMatch(
      /if \(msg === 'forbidden'\) \{\s*\n?\s*showBanner\(\s*\n?\s*'Access denied — admin scope required\. You are signed in as a customer account\.',\s*\n?\s*\);\s*\n?\s*\} else if \(msg === 'not-found'\) \{\s*\n?\s*showBanner\('Account not found\. Showing preview shell\.'\);\s*\n?\s*\} else \{\s*\n?\s*showBanner\("Couldn't load account \(" \+ msg \+ '\)\. Showing preview data below\.'\);\s*\n?\s*\}/,
    );
  });

  it("Full-audit-log deep-link: /audit-log?account=acc_{account.id} — pinned so the 'Full audit log for this account →' anchor passes the prefixed account id (the audit-log page expects 'acc_'-prefixed form for filter) and clicking lands on the right pre-filtered audit-log view", () => {
    expect(body).toMatch(/href=\{`\/audit-log\?account=acc_\$\{account\.id\}`\}/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
