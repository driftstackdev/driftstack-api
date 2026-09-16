// W521.C — drift guard for apps/marketing-site/src/pages/docs/security-overview.astro.
// V-713 public security overview. Drift here either softens a security
// posture commitment (would mislead procurement reviewers) or breaks
// the action-based-no-script-eval commitment (would re-create the
// fictional /function bug for crypto/CDP reviewers).
//
//   • V-713 doc-comment framing.
//   • At-rest: Postgres encrypted volumes (Neon) + API key hash
//     scrypt logN=15 + OAuth client secret hashed + MFA seed AES-256
//     with MFA_ENCRYPTION_KEY.
//   • In-transit: TLS 1.2+ + HSTS max-age=63072000 + includeSubDomains
//     + preload.
//   • Object storage: S3-SSE on R2 + never-publicly-listable;
//     desktop-local recording and no-upload boundary.
//   • Payment details: card numbers never reach Driftstack systems
//     (Stripe tokenises under its own PCI-DSS scope) + error reports
//     scrubbed of personal data before they reach Sentry. These two
//     commitments used to ride on the hand-written shortlist's Stripe
//     and Sentry lines; the generated list quotes the register, which
//     does not make them, so they live in data handling now.
//   • Profile state: per-profile encrypted files on driver-host EU.
//   • Auth: read/write/account_owner scope ladder + least-privilege
//     default + 'create key' defaults to read + MFA TOTP + 15-min
//     step-up reprompt + driftstack_internal_admin separate scope +
//     login + key mint/revoke captured in audit log (V-074).
//   • Network: EU primary (Hetzner Falkenstein/Nuremberg) + Neon EU
//     PITR + R2 EU+US geo-replicated + token-bucket rate-limit
//     (per-account + per-IP) + edge DDoS absorption.
//   • Browser sandbox: action-based no-script-eval + one-WebKit-per-
//     session + cross-session-state-never-bleeds + profile is the
//     only persistence mechanism + 429 concurrency-limit RFC 7807.
//   • Sub-processor list rendered from SUB_PROCESSORS in
//     marketing-site/src/data/sub-processors.ts (2026-09-16),
//     replacing the hand-written 5-name shortlist (Stripe +
//     NowPayments + Cloudflare + Postmark + Sentry) that omitted
//     Neon, Hetzner, MacStadium and LiveKit — all four named
//     elsewhere on this same page. Entry-level coverage — including
//     what firstSentence() actually returns for each entry — lives in
//     marketing-site/tests/unit/docs-security-overview-sub-processor-register-binding.test.ts.
//     The retired shortlist's wording is pinned negative against the
//     sub-processor SECTION only; page-wide it would ban true
//     statements the page makes in prose.
//   • Network egress bullet names ONE list: /trust/sub-processors as
//     the register, /legal/sub-processors as the same list under the
//     DPA. It used to make a second completeness claim of its own.
//   • 30-day notice before adding/rotating sub-processor + announcements@
//     enterprise-only.
//   • Audit + observability 3-stream: audit log + session logs + cost ledger.
//   • Incident response 72h disclosure + 1-business-day vulnerability
//     reporting SLA + safe-harbour /legal/vulnerability-disclosure.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/security-overview.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SECTION_HEADING = '<h2>Sub-processors</h2>';

/**
 * The page's sub-processor section: its own `<h2>` up to the next one.
 *
 * The retired shortlist's wording is pinned negative against THIS
 * slice, not against the whole page. Page-wide, those negatives would
 * ban true statements — "no payment data touches our infra" and
 * "PII-scrubbed" were commitments this page made, and the page is
 * entitled to make them again outside the generated list.
 */
function subProcessorSection(page: string): string {
  const start = page.indexOf(SECTION_HEADING);
  expect(start, 'the page still has a <h2>Sub-processors</h2> section').toBeGreaterThan(-1);
  const rest = page.slice(start + SECTION_HEADING.length);
  const end = rest.indexOf('<h2>');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('W521.C apps/marketing-site/src/pages/docs/security-overview.astro content parity', () => {
  const body = read(LIB);
  const subProcessors = subProcessorSection(body);

  it('V-713 framing pinned. Re-enabled by slice 269 after verifying the V-713 anchor + 3-companion-doc framing still exists verbatim at security-overview.astro:4-8', () => {
    expect(body).toMatch(
      /\/\/ V-713 — public security overview\. Pitched at customer security\s*\/\/ review \+ procurement teams\. Companion to https:\/\/docs\.driftstack\.io\/reference\/data-residency\/,\s*\/\/ \/docs\/audit-log, \/docs\/incident-policy\./,
    );
  });

  it("At-rest 4-control framing pinned: 'All customer data in Postgres is on encrypted volumes (managed by Neon).' + 'API key plaintext is never stored — keys are hashed with scrypt (logN=15) at mint time.' + 'OAuth client secrets are similarly hashed before storage.' + 'MFA seeds are AES-256 encrypted with a key from the MFA_ENCRYPTION_KEY env, never written in plaintext.' — pinned so the 4-at-rest control (encrypted-volumes + scrypt-logN=15 + OAuth-hashed + MFA-AES-256 with MFA_ENCRYPTION_KEY) commitment survives (drift to a different hash function would create marketing↔crypto-engineering divergence)", () => {
    expect(body).toMatch(
      /<strong>At rest:<\/strong> All customer data in Postgres is on\s*encrypted volumes \(managed by Neon\)\. API key plaintext is\s*<strong>never<\/strong> stored — keys are hashed with\s*<code>scrypt<\/code> \(logN=15\) at mint time\. OAuth client\s*secrets are similarly hashed before storage\. MFA seeds are\s*AES-256 encrypted at rest, never written in plaintext\./,
    );
  });

  it("In-transit + HSTS framing pinned: 'TLS 1.2+ enforced on every public endpoint. HSTS is set with max-age=63072000; includeSubDomains; preload' + /docs/api-security-headers cross-ref — pinned so the TLS-1.2+ + HSTS-max-age=63072000 + includeSubDomains + preload commitment survives", () => {
    expect(body).toMatch(
      /<strong>In transit:<\/strong> TLS 1\.2\+ enforced on every\s*public endpoint\. HSTS is set with\s*<code>max-age=63072000; includeSubDomains; preload<\/code>/,
    );
    expect(body).toMatch(/<a href="\/docs\/api-security-headers\/">API security headers<\/a>/);
  });

  it('Object storage + profile state framing pinned. Object-storage (S3-SSE + never-publicly-listable + desktop-local recorder/no-upload boundary) + Profile-state (encrypted-files on the driver host = the MacStadium fleet, US + Postgres-EU-metadata-only) framings exist verbatim at docs/security-overview.astro:44-56', () => {
    expect(body).toMatch(
      /<strong>Object storage:<\/strong> Customer-generated artefacts\s*that land in Cloudflare R2 use server-side encryption \(S3-SSE\);\s*underlying objects are never publicly listable\. The desktop app's\s*recorder saves streamed session frames locally on the operator's\s*machine; those recordings are not uploaded by the recording workflow\.\s*See <a href="\/docs\/recordings\/">\/docs\/recordings<\/a> for the boundary\./,
    );
    expect(body).toMatch(
      /<strong>Profile state:<\/strong> Per-profile browser state\s*\(cookies, localStorage, IndexedDB\) is stored as per-profile\s*encrypted files on the browser hosts \(MacStadium, US\)\. The\s*database record \(EU\) holds metadata only — name, device\s*profile, description\./,
    );
  });

  it("Payment-details + error-report framing pinned: 'Card numbers never reach Driftstack systems. Stripe collects and tokenises them under its own PCI-DSS scope; we keep the token and the billing details that appear on your invoice.' + 'Server errors go to Sentry, our error-tracking service (EU region), with personal data scrubbed out first. Request logs record technical detail only — never the body of your request or of our response.' — these are the two commitments the retired 5-name shortlist carried in its Stripe and Sentry lines ('card billing only — no payment data touches our infra', 'PII-scrubbed at SDK level'). The generated list quotes the register, which does not make them, so they are pinned here in the data-handling section instead of leaving a procurement-facing page (drift to dropping either would silently retire a commitment while every other arm stayed green)", () => {
    expect(body).toMatch(
      /<strong>Payment details:<\/strong> Card numbers never reach\s*Driftstack systems\. Stripe collects and tokenises them under\s*its own PCI-DSS scope; we keep the token and the billing\s*details that appear on your invoice\./,
    );
    expect(body).toMatch(
      /<strong>Error reports:<\/strong> Server errors go to Sentry,\s*our error-tracking service \(EU region\), with personal data\s*scrubbed out first\. Request logs record technical detail only\s*— never the body of your request or of our response\./,
    );
  });

  it('Auth + authz 4-bullet framing pins audit-log behavior without internal labels', () => {
    expect(body).toMatch(
      /Customer keys are scoped: <code>read<\/code> \/\s*<code>write<\/code> \/ <code>account_owner<\/code>\. We default to\s*least-privilege; the dashboard's "create key" flow defaults to\s*<code>read<\/code> with an explicit checkbox to widen\./,
    );
    expect(body).toMatch(
      /MFA \(TOTP\) is available for every account and required for\s*any operation we classify as "sensitive" — see the dashboard\s*for the per-account toggle\. We re-prompt for MFA after 15\s*minutes of step-up inactivity\./,
    );
    expect(body).toMatch(
      /Admin actions are gated behind a separate\s*<code>driftstack_internal_admin<\/code> scope that no customer\s*key can hold\./,
    );
    expect(body).toMatch(
      /Every login event \+ every key mint\/revoke is captured in the\s*account audit log; customers can self-serve a full\s*log export\./,
    );
  });

  it("Network + infrastructure 4-bullet framing pinned: 'Driftstack runs primarily in the EU (Hetzner Falkenstein / Nuremberg). Customer-facing API endpoints are served from the EU region today; multi-region routing is on the roadmap.' + 'Postgres is managed by Neon (EU) with point-in-time recovery. Object storage (R2) is geo-replicated across Cloudflare's EU + US regions; presigned access is location-agnostic.' + 'Customer data egress to non-EU regions is restricted to the companies listed below. That one list is published in full at /trust/sub-processors, and it is the same list the Data Processing Addendum refers to at /legal/sub-processors.' (re-pinned 2026-09-16 — the bullet used to say 'the subprocessors enumerated below and on the sub-processor list' and link only /legal, which made a second completeness claim competing with the generated section's) + 'Rate-limiting is enforced application-side via token buckets (per-account + per-IP); DDoS absorption is handled at the CDN edge.' — pinned so the EU-primary Hetzner + Neon-PITR + R2-EU+US-geo-replicated + one-list-two-URLs + per-account+per-IP-token-buckets + edge-DDoS-absorption commitment survives", () => {
    expect(body).toMatch(
      /Driftstack runs <strong>primarily in the EU<\/strong> \(Hetzner,\s*Falkenstein, Germany\)\./,
    );
    expect(body).toMatch(
      /Postgres is managed by Neon \(EU\) with point-in-time recovery\.\s*Object storage \(R2\) is geo-replicated across Cloudflare's\s*EU \+ US regions; presigned access is location-agnostic\./,
    );
    // Re-pinned 2026-09-16: the bullet used to make its own
    // completeness claim ("the subprocessors enumerated below and on
    // the sub-processor list", linking /legal) while the section four
    // paragraphs down made a different one, naming /trust as the
    // register. One list, named once, with both URLs identified.
    expect(body).toMatch(
      /Customer data egress to non-EU regions is restricted to the\s*companies listed below\. That one list is published in full at\s*<a href="\/trust\/sub-processors\/">\/trust\/sub-processors<\/a>, and\s*it is the same list the Data Processing Addendum refers to at\s*<a href="\/legal\/sub-processors\/">\/legal\/sub-processors<\/a>\./,
    );
    expect(body).toMatch(
      /Rate-limiting is enforced application-side via token buckets\s*\(per-account \+ per-IP\); see\s*<a href="\/docs\/rate-limits\/">\/docs\/rate-limits<\/a> for the\s*bucket model\. DDoS absorption is handled at the CDN edge\./,
    );
  });

  it("Browser-sandbox 3-bullet framing pinned: 'Driftstack does not execute customer-supplied script bodies server-side — the API surface is action-based (navigate / interact / wait / capture). Arbitrary script eval is intentionally not exposed.' + 'Each session is one isolated WebKit instance backed by an ephemeral context; cross-session state never bleeds. Persistence between sessions only happens via the customer-managed profile mechanism (encrypted browser state on the driver host — the MacStadium fleet, US).' + 'Per-tier caps on how many sessions run at once are the primary cost-control and abuse-mitigation mechanism; exceeding the cap returns 429 with the concurrency-limit RFC 7807 type.' — pinned so the no-server-side-script-eval + one-WebKit-per-session + profile-as-only-persistence + concurrency-cap-as-cost-control + 429 concurrency-limit RFC 7807 commitment survives", () => {
    expect(body).toMatch(
      /Driftstack does not execute customer-supplied script bodies\s*server-side — the API surface is action-based\s*\(<code>navigate<\/code> \/ <code>interact<\/code> \/\s*<code>wait<\/code> \/ <code>capture<\/code>\)\. Arbitrary script\s*eval is intentionally not exposed\./,
    );
    expect(body).toMatch(
      /Each session runs in its own isolated browser that starts\s*fresh; state never leaks between sessions\.\s*Persistence between sessions only happens via the\s*customer-managed <strong>profile<\/strong> mechanism\s*\(encrypted browser state on the browser hosts — MacStadium,\s*US\)\./,
    );
    expect(body).toMatch(
      /Per-tier caps on how many sessions run at once are the primary\s*cost-control and abuse-mitigation mechanism; exceeding the cap\s*returns <code>429<\/code> with the\s*<code>concurrency-limit<\/code> RFC 7807 type\./,
    );
  });

  it("Sub-processor section + 30-day-notice framing pinned: the list is rendered from the SUB_PROCESSORS register (import + <li> template + /trust/sub-processors as the full record + 'This is the complete list') and 'We publish 30-day notice before adding or rotating a sub-processor. Enterprise contracts can opt into the announcement mailing list at announcements@.' — re-pinned 2026-09-16, replacing the 5-name transcribed shortlist (Stripe / NowPayments / Cloudflare / Postmark / Sentry) that omitted Neon, Hetzner, MacStadium and LiveKit. The negatives keep a hand-maintained list from returning; the 30-day-notice + enterprise-announcements@ commitment is unchanged.", () => {
    expect(body).toMatch(
      /import\s*\{[\s\S]*?\bSUB_PROCESSORS\b[\s\S]*?\}\s+from\s+['"][^'"]*data\/sub-processors/,
    );
    expect(body).toMatch(
      /\{\s*SUB_PROCESSORS\.map\(\(sp\) => \(\s*<li>\s*<strong>\{sp\.name\}<\/strong> — \{firstSentence\(sp\.purpose\)\}\s*<\/li>\s*\)\)\s*\}/,
    );
    expect(body).toMatch(
      /This is the complete list, taken from the register published at\s*<a href="\/trust\/sub-processors\/">\/trust\/sub-processors<\/a>/,
    );
    // The transcribed shortlist's own wording must not come back INTO
    // THE SECTION. Scoped there, not page-wide: these are stale list
    // entries, not forbidden facts.
    expect(subProcessors).not.toMatch(/card billing only/);
    expect(subProcessors).not.toMatch(/crypto checkout/);
    expect(subProcessors).not.toMatch(/CDN, WAF, R2 object storage/);
    expect(subProcessors).not.toMatch(/PII-scrubbed at SDK level/);
    expect(subProcessors).not.toMatch(/shortlist as of/);
    expect(body).toMatch(
      /We publish 30-day notice before adding or rotating a sub-\s*processor\. Enterprise contracts can opt into the announcement\s*mailing list at <code>announcements@<\/code>\./,
    );
  });

  it('Audit + observability 3-stream framing pinned: Account audit log (every mutation on your account) + Session logs (per-session navigation + console output retained per tier) + Cost ledger (every billable event, queryable via the API) — pinned so the 3-customer-readable log streams commitment survives', () => {
    expect(body).toMatch(
      /<a href="\/docs\/audit-log\/">Account audit log<\/a> — every\s*mutation on your account \(key mints, profile changes, billing\s*events\)\./,
    );
    expect(body).toMatch(
      /Session activity — the pages visited in your agent sessions, per\s*profile, via the <a href="\/api-reference\/">API<\/a>\s*\(<code>GET \/v1\/profiles\/:id\/activity<\/code>\)\./,
    );
    expect(body).toMatch(
      /<a href="\/docs\/cost-monitoring\/">Operational cost estimate<\/a> — a\s*per-month estimate of what it costs to serve your account\. It is not\s*an invoice\./,
    );
    // Neither console-output retention nor a per-event billable ledger exists.
    expect(body).not.toMatch(/console output|Cost ledger|every billable event/);
  });

  it("Incident response + vulnerability reporting framing pinned: 'See /docs/incident-policy for the disclosure timeline + the status page cadence. Security-relevant incidents are disclosed within 72h of confirmation; we do not bury exposure events.' + 'Email security@driftstack.dev with the details. We respond within 1 business day. Our vulnerability disclosure policy covers safe-harbour for good-faith research; please review it before testing.' — pinned so the 72h-disclosure + don't-bury-exposure + 1-business-day-SLA + /legal/vulnerability-disclosure safe-harbour commitment survives (drift to softening 72h or 1-business-day would weaken procurement-trust)", () => {
    expect(body).toMatch(
      /Security-relevant incidents are disclosed within 72h\s*of confirmation; we do not bury exposure events\./,
    );
    expect(body).toMatch(
      /<a href="mailto:security@driftstack\.dev">security@driftstack\.dev<\/a>\s*with the details\. We respond within 1 business day\./,
    );
    expect(body).toMatch(
      /<a href="\/legal\/vulnerability-disclosure\/">vulnerability\s*disclosure policy<\/a> covers safe-harbour for good-faith\s*research; please review it before testing\./,
    );
  });

  it('5-related-doc cluster: /docs/data-residency + /docs/admin-api + /docs/incident-policy + /docs/audit-log + /legal/sub-processors — pinned so the 5-related-doc navigation surface stays complete', () => {
    // S47 2026-07-07 (founder-approved: mirror deprecation): the data-residency mirror is deleted; href re-pinned to the docs successor.
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.io\/reference\/data-residency\/">Data residency<\/a>/,
    );
    expect(body).toMatch(/<a href="\/docs\/admin-api\/">Admin API \+ scope<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/incident-policy\/">Incident policy<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/audit-log\/">Audit log<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/sub-processors\/">Sub-processors<\/a>/);

    const slashlessOwnedHref =
      /href="\/(?:docs\/(?:api-security-headers|recordings|rate-limits|audit-log|admin-api|incident-policy)|legal\/(?:sub-processors|vulnerability-disclosure))"/;
    expect(body).not.toMatch(slashlessOwnedHref);
    expect(body.replace('href="/docs/admin-api/"', 'href="/docs/admin-api"')).toMatch(
      slashlessOwnedHref,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
