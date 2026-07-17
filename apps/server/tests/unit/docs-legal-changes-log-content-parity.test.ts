// W574.A — drift guard for /docs/legal/changes-log.md.
// Authoritative record of legal-document changes. Drift here either
// removes the V-293 methodology (every legal-touching feature commit
// MUST append an entry), drops a dated cycle entry, or unsets the
// V-271 sub-processor mirror linter cross-reference.
//
//   • Authoritative legal-doc changelog per V-293.
//   • V-271 CI sub-processor mirror linter catches DPA Annex 3 vs
//     marketing-site sub-processor table drift.
//   • Dated entries: 2026-05-07 (V-295c + V-295c2 + V-295c3) +
//     2026-05-08 (V-352b + V-313 + V-306a + V-308a + V-297 + V-327) +
//     2026-05-09 (V-353 + V-359 + V-298a + V-352b cycle).
//   • Privacy Policy §15 anchors customer-readable update entries.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/legal/changes-log.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W574.A /docs/legal/changes-log.md content parity', () => {
  const body = read(LIB);

  it('Header + V-293-methodology + V-271 mirror-linter + Privacy-Policy-§15 framing pinned', () => {
    expect(body).toMatch(/^# Driftstack — Legal-document changes log$/m);
    expect(body).toMatch(/This file is the authoritative record of every change to a Driftstack/);
    expect(body).toMatch(/legal document \(Privacy Policy, Terms of Service, DPA, Acceptable Use/);
    expect(body).toMatch(
      /Policy, Definitions\)\. Each entry MUST be added in the same commit that/,
    );
    expect(body).toMatch(/makes the legal change\./);
    expect(body).toMatch(/The format is intentionally lightweight — Section number \+ one-line/);
    expect(body).toMatch(/summary \+ the V-NNN engineering slice that drove it\./);
    expect(body).toMatch(/Per V-293 methodology, every feature commit that touches a legal/);
    expect(body).toMatch(/surface \(PII, sub-processor, data-transfer, retention, security/);
    expect(body).toMatch(/posture, customer-facing service description\) MUST also append an/);
    expect(body).toMatch(/entry here\./);
    expect(body).toMatch(/The CI sub-processor mirror linter \(V-271\) catches DPA/);
    expect(body).toMatch(/Annex 3 ↔ marketing-site sub-processor table drift; this changelog/);
    expect(body).toMatch(/catches everything else\./);
    expect(body).toMatch(/When the next material revision ships, the \*\*Privacy Policy Section/);
    expect(body).toMatch(/15\*\* "Updates to this Privacy Policy" gets a new dated entry that/);
    expect(body).toMatch(/references the corresponding rows in this log\./);
  });

  it('2026-07-17 legal v1.1 product/storage truth correction includes Definitions and included-service AI accounting', () => {
    expect(body).toMatch(
      /## 2026-07-17 — Privacy, DPA, Terms, and Definitions v1\.1 \(product \+ storage truth\)/,
    );
    expect(body).toMatch(
      /advance together from version 1\.0 to version 1\.1, effective\s+2026-07-17/,
    );
    expect(body).toMatch(/Desktop recordings are local NDJSON files/);
    expect(body).toMatch(/not\s+uploaded to Driftstack's API, control plane, or Cloudflare R2/);
    expect(body).toMatch(/no API recording endpoint and no cloud recording-/);
    expect(body).toMatch(/screenshot, DOM snapshot, and PDF Capture/);
    expect(body).toMatch(/returned inline and are not retained by the Capture/);
    expect(body).toMatch(/Live-session media remains ephemeral and is dropped on/);
    expect(body).toMatch(/removed the nonexistent\s+optional cloud-Recording processing purpose/);
    expect(body).toMatch(/Controller \/ Processor allocation, Special Category/);
    expect(body).toMatch(/API now promises Session and Capture\s+artifacts only/);
    expect(body).toMatch(/encrypted-in-\s+transit commitments/);
    expect(body).toMatch(/former unimplemented application-level end-to-end-encryption claim/);
    expect(body).toMatch(/LiveKit receives, processes, and forwards the media as a Sub-/);
    expect(body).toMatch(/does not currently provide application-level/);
    expect(body).toMatch(/\*\*Shared Definitions:\*\*/);
    expect(body).toMatch(
      /pending-API placeholder, obsolete\s+price and API-key-scope enumerations/,
    );
    expect(body).toMatch(/included-service budget rather than inventing a separately itemized/);
    expect(body).toMatch(/\*\*Bundled-LLM commercial wording:\*\*/);
    expect(body).toMatch(
      /No price, budget enforcement, provider\s+data flow, consent gate, BYOK contract, or invoice was changed/,
    );
    expect(body).toMatch(
      /no Sub-processor, transfer\s+mechanism, or R2 processing category changed/,
    );
    expect(body).toMatch(/subject to final counsel review before launch/);
    expect(body).not.toMatch(/E2EE (?:on|is enabled by) default/i);
    expect(body).not.toMatch(/end-to-end encryption is enabled by default/i);
    expect(body).not.toMatch(/cannot decrypt/i);
  });

  it('2026-05-09 V-353+V-359+V-298a+V-352b + 2026-05-08 V-352b + 2026-05-07 V-295c entries framing pinned', () => {
    expect(body).toMatch(
      /## 2026-05-09 — V-353 \+ V-359 \+ V-298a \+ V-352b cycle disclosure refresh/,
    );
    expect(body).toMatch(
      /- \*\*Privacy Policy §3\.2 \(Authentication data\)\*\*: extended the "What"/,
    );
    expect(body).toMatch(/list to disclose the optional second-factor enrollment state when/);
    expect(body).toMatch(/Customer opts into MFA\. Specifically: AES-256-GCM-encrypted TOTP/);
    expect(body).toMatch(/secret \(plaintext exists only in memory during verification\),/);
    expect(body).toMatch(/10 scrypt-hashed single-use recovery codes \(raw codes shown once/);
    expect(body).toMatch(/at enrollment\), and the per-session `mfa_satisfied_at` timestamp/);
    expect(body).toMatch(
      /- \*\*No DPA \/ sub-processor change\*\*: MFA data lives entirely in the/,
    );
    expect(body).toMatch(/existing Postgres sub-processor \(Neon, EU Frankfurt\)\./);
    expect(body).toMatch(/## 2026-05-08 — V-352b \(customer-uploaded avatars\)/);
    expect(body).toMatch(
      /- \*\*Privacy Policy §3\.1 \(Account data\)\*\*: extended the "What" list to/,
    );
    expect(body).toMatch(/include the optional Customer-uploaded profile avatar/);
    expect(body).toMatch(
      /- \*\*DPA Annex 3 \/ sub-processor register\*\*: Cloudflare R2 row purpose/,
    );
    expect(body).toMatch(/text expanded from an earlier, inaccurate browser-media storage/);
    expect(body).toMatch(/description to also cover public status-page snapshots and/);
    expect(body).toMatch(/customer-uploaded profile avatars/);
    expect(body).toMatch(/did not reflect implemented storage and is superseded by the/);
    expect(body).toMatch(/2026-07-17 v1\.1 correction/);
    expect(body).not.toMatch(/session recordings and screenshots/i);
    expect(body).toMatch(/Per V-294 methodology this counts as a disclosure-\s*scope/);
    expect(body).toMatch(/update on an already-disclosed sub-processor, not a new sub-/);
    expect(body).toMatch(/processor; no Art 28\(2\) 30-day notice is triggered\./);
    expect(body).toMatch(/- `SUB_PROCESSOR_REGISTER_LAST_UPDATED` bumped to 2026-05-08\./);
    expect(body).toMatch(/## 2026-05-07 — V-295c \(status page launch\)/);
    expect(body).toMatch(
      /- \*\*Privacy Policy §3\.9 \(new\)\*\*: added "Status-page data" subsection/,
    );
    expect(body).toMatch(
      /describing the access-log scope, legal basis \(Art 6\(1\)\(f\) legitimate/,
    );
    expect(body).toMatch(/interest\), the no-PII-shown promise of the status page itself, the/);
    expect(body).toMatch(/probe-history retention \(30 days\), and the no-cookies posture for/);
    expect(body).toMatch(/status\.driftstack\.dev\./);
    expect(body).toMatch(/## 2026-05-07 — V-295c2 \(R2 fallback\)/);
    expect(body).toMatch(/- \*\*No legal-document text changes\*\*\./);
    expect(body).toMatch(/V-295c2 introduces a separate/);
    expect(body).toMatch(
      /R2 bucket \(`R2_BUCKET_PUBLIC`\) holding `status\/incidents-public\.json`/,
    );
    expect(body).toMatch(/## 2026-05-07 — V-295c3 \(status-page email subscriptions\)/);
    expect(body).toMatch(/- \*\*Privacy Policy §3\.10 \(new\)\*\*: added "Status-page email/);
    expect(body).toMatch(/subscriptions" subsection\./);
    expect(body).toMatch(/Documents: data shape \(email \+ opaque/);
    expect(body).toMatch(/tokens\), legal basis \(Art 6\(1\)\(a\) consent via double-opt-in\),/);
    expect(body).toMatch(/source, retention \(active subscription \+ 90 days post-unsubscribe/);
    expect(body).toMatch(/tombstone\), recipients \(Postmark for delivery\), no-cookies posture\./);
  });

  it('2026-05-08 V-313 + V-306a LiveKit + V-308a NowPayments + V-297 + V-327 entries framing pinned', () => {
    expect(body).toMatch(/## 2026-05-08 — V-313 \(legal placeholder cleanup post-V-295 launch\)/);
    expect(body).toMatch(
      /- \*\*ToS §9\.3 \(Maintenance\)\*\*: replaced `\(placeholder: status\.driftstack\.dev\)`/,
    );
    expect(body).toMatch(/with the live URL `<https:\/\/status\.driftstack\.dev>` plus a sentence/);
    expect(body).toMatch(
      /- \*\*AUP §4 \(Reporting \+ abuse mechanism\)\*\*: removed the parenthetical/,
    );
    expect(body).toMatch(/"\(placeholder address; production address may differ\)" qualifier on/);
    expect(body).toMatch(/`abuse@driftstack\.dev`/);
    expect(body).toMatch(
      /## 2026-05-08 — V-306a \(LiveKit live-session sub-processor \+ Privacy \+ ToS\)/,
    );
    expect(body).toMatch(/- \*\*DPA Annex 3 \(sub-processors table\)\*\*: added "LiveKit, Inc\./);
    expect(body).toMatch(/\(US, Delaware\) — conditional, opt-in only" row\./);
    expect(body).toMatch(/Role: WebRTC live-/);
    expect(body).toMatch(/session signaling \+ media SFU\./);
    expect(body).toMatch(/Transfer mechanism: 2021 SCCs Module/);
    expect(body).toMatch(/2 \+ EU-US DPF\./);
    expect(body).toMatch(/Engaged only when Customer or Driftstack support/);
    expect(body).toMatch(/explicitly initiates a live-session view; disabled by default\./);
    expect(body).toMatch(
      /- \*\*Privacy Policy §3\.11 \(new\)\*\*: "Live-session media \(optional,/,
    );
    expect(body).toMatch(/opt-in only\)"/);
    expect(body).toMatch(/application-level end-to-end encryption as enabled, but that/);
    expect(body).toMatch(/configuration was not implemented/);
    expect(body).toMatch(/supersedes both claims with desktop-local recording and encrypted-/);
    expect(body).toMatch(/original application-level encryption wording is superseded/);
    expect(body).toMatch(/- \*\*Marketing-site sub-processors data\*\*: matching public-facing/);
    expect(body).toMatch(/entry\. V-271 mirror linter passes at 12 ↔ 13\./);
    expect(body).toMatch(
      /## 2026-05-08 — V-308a \(NowPayments crypto sub-processor \+ ToS clause\)/,
    );
    expect(body).toMatch(/- \*\*DPA Annex 3 \(sub-processors table\)\*\*: added "NowPayments OÜ/);
    expect(body).toMatch(/\(Estonia\) — conditional, opt-in only" row\./);
    expect(body).toMatch(/Role: cryptocurrency/);
    expect(body).toMatch(/payment processing \(BTC, LTC, USDT, USDC, ETH, XMR\)\./);
    expect(body).toMatch(/Transfer/);
    expect(body).toMatch(/mechanism: EEA-internal \(Estonia\)\./);
    expect(body).toMatch(/- \*\*Privacy Policy §3\.6 \(Billing data\)\*\*: extended with a/);
    expect(body).toMatch(/"Cryptocurrency payments \(optional, opt-in only\)" subsection\./);
    expect(body).toMatch(
      /- \*\*Terms of Service §8\.3\*\*: extended with §8\.3\(5\) crypto-payment/,
    );
    expect(body).toMatch(/terms covering rate-quote window, finality, network-fee/);
    expect(body).toMatch(/responsibility, refund policy \(original currency to original/);
    expect(body).toMatch(/sender\), under-payment handling, switch-payment-method\./);
    expect(body).toMatch(/## 2026-05-08 — V-297 \(audit-log export for data portability\)/);
    expect(body).toMatch(/- \*\*Privacy Policy §10 \(data subject rights\)\*\* updated\./);
    expect(body).toMatch(/Article 20/);
    expect(body).toMatch(/paragraph extended with concrete language describing the new/);
    expect(body).toMatch(
      /self-service export at `\/v1\/account\/audit-log\/export` \(CSV \+ JSON,/,
    );
    expect(body).toMatch(/10,000-row ceiling per export\)\./);
    expect(body).toMatch(/## 2026-05-08 — V-327 \(renewal-reminder email lifecycle dispatch\)/);
    expect(body).toMatch(/- \*\*Privacy Policy §3\.6 \(Billing data\)\*\* extended with a/);
    expect(body).toMatch(/"Renewal-reminder emails" paragraph disclosing the new outbound/);
    expect(body).toMatch(/trigger: Stripe's `invoice\.upcoming` webhook \(~7 days before each/);
    expect(body).toMatch(/recurring invoice generates\) fans out one `billing-renewal-reminder`/);
    expect(body).toMatch(/email per upcoming invoice via Postmark\./);
    expect(body).toMatch(/Customers can opt out via/);
    expect(body).toMatch(/the dashboard email preferences page; Stripe's contractual/);
    expect(body).toMatch(/notification \(actual charge confirmation\) remains non-opt-outable\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
