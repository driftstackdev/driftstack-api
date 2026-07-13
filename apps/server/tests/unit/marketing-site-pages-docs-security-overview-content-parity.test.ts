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
//   • Object storage: S3-SSE on R2 + never-publicly-listable; managed
//     recordings roadmap vs desktop-local recording distinction.
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
//   • Sub-processors shortlist 5: Stripe + NowPayments + Cloudflare +
//     Postmark + Sentry (PII-scrubbed at SDK level).
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

describe('W521.C apps/marketing-site/src/pages/docs/security-overview.astro content parity', () => {
  const body = read(LIB);

  it('V-713 framing pinned. Re-enabled by slice 269 after verifying the V-713 anchor + 3-companion-doc framing still exists verbatim at security-overview.astro:4-8', () => {
    expect(body).toMatch(
      /\/\/ V-713 — public security overview\. Pitched at customer security\s*\n?\s*\/\/ review \+ procurement teams\. Companion to https:\/\/docs\.driftstack\.dev\/reference\/data-residency\/,\s*\n?\s*\/\/ \/docs\/audit-log, \/docs\/incident-policy\./,
    );
  });

  it("At-rest 4-control framing pinned: 'All customer data in Postgres is on encrypted volumes (managed by Neon).' + 'API key plaintext is never stored — keys are hashed with scrypt (logN=15) at mint time.' + 'OAuth client secrets are similarly hashed before storage.' + 'MFA seeds are AES-256 encrypted with a key from the MFA_ENCRYPTION_KEY env, never written in plaintext.' — pinned so the 4-at-rest control (encrypted-volumes + scrypt-logN=15 + OAuth-hashed + MFA-AES-256 with MFA_ENCRYPTION_KEY) commitment survives (drift to a different hash function would create marketing↔crypto-engineering divergence)", () => {
    expect(body).toMatch(
      /<strong>At rest:<\/strong> All customer data in Postgres is on\s*\n?\s*encrypted volumes \(managed by Neon\)\. API key plaintext is\s*\n?\s*<strong>never<\/strong> stored — keys are hashed with\s*\n?\s*<code>scrypt<\/code> \(logN=15\) at mint time\. OAuth client\s*\n?\s*secrets are similarly hashed before storage\. MFA seeds are\s*\n?\s*AES-256 encrypted with a key from the\s*\n?\s*<code>MFA_ENCRYPTION_KEY<\/code> env, never written in\s*\n?\s*plaintext\./,
    );
  });

  it("In-transit + HSTS framing pinned: 'TLS 1.2+ enforced on every public endpoint. HSTS is set with max-age=63072000; includeSubDomains; preload' + /docs/api-security-headers cross-ref — pinned so the TLS-1.2+ + HSTS-max-age=63072000 + includeSubDomains + preload commitment survives", () => {
    expect(body).toMatch(
      /<strong>In transit:<\/strong> TLS 1\.2\+ enforced on every\s*\n?\s*public endpoint\. HSTS is set with\s*\n?\s*<code>max-age=63072000; includeSubDomains; preload<\/code>/,
    );
    expect(body).toMatch(/<a href="\/docs\/api-security-headers">API security headers<\/a>/);
  });

  it('Object storage + profile state framing pinned. Object-storage (S3-SSE + never-publicly-listable + managed-recordings-roadmap vs desktop-local recorder) + Profile-state (encrypted-files on the driver host = the MacStadium fleet, US + Postgres-EU-metadata-only) framings exist verbatim at docs/security-overview.astro:44-56', () => {
    expect(body).toMatch(
      /<strong>Object storage:<\/strong> Customer-generated artefacts\s*\n?\s*that land in Cloudflare R2 use server-side encryption \(S3-SSE\);\s*\n?\s*underlying objects are never publicly listable\. Managed API session\s*\n?\s*recordings in R2 are a roadmap item; the desktop app's current manual\s*\n?\s*recorder saves streamed frames locally on the operator's machine\. See\s*\n?\s*<a href="\/docs\/recordings">\/docs\/recordings<\/a> for the distinction\./,
    );
    expect(body).toMatch(
      /<strong>Profile state:<\/strong> Per-profile browser state\s*\n?\s*\(cookies, localStorage, IndexedDB\) lives in the WebKit driver\s*\n?\s*layer as per-profile encrypted files on disk on the driver\s*\n?\s*host \(the MacStadium fleet, US\)\. The Postgres profile row\s*\n?\s*\(EU\) holds metadata only — name, archetype, description\./,
    );
  });

  it('Auth + authz 4-bullet framing pinned. Re-enabled by slice 278 after restoring the V-074 anchor on the account-audit-log bullet at docs/security-overview.astro:81 (the other 3 bullets — scope-ladder + MFA + driftstack_internal_admin — were intact)', () => {
    expect(body).toMatch(
      /Customer keys are scoped: <code>read<\/code> \/\s*\n?\s*<code>write<\/code> \/ <code>account_owner<\/code>\. We default to\s*\n?\s*least-privilege; the dashboard's "create key" flow defaults to\s*\n?\s*<code>read<\/code> with an explicit checkbox to widen\./,
    );
    expect(body).toMatch(
      /MFA \(TOTP\) is available for every account and required for\s*\n?\s*any operation we classify as "sensitive" — see the dashboard\s*\n?\s*for the per-account toggle\. We re-prompt for MFA after 15\s*\n?\s*minutes of step-up inactivity\./,
    );
    expect(body).toMatch(
      /Admin actions are gated behind a separate\s*\n?\s*<code>driftstack_internal_admin<\/code> scope that no customer\s*\n?\s*key can hold\./,
    );
    expect(body).toMatch(
      /Every login event \+ every key mint\/revoke is captured in the\s*\n?\s*account audit log \(V-074\); customers can self-serve a full\s*\n?\s*log export\./,
    );
  });

  it("Network + infrastructure 4-bullet framing pinned: 'Driftstack runs primarily in the EU (Hetzner Falkenstein / Nuremberg). Customer-facing API endpoints are served from the EU region today; multi-region routing is on the roadmap.' + 'Postgres is managed by Neon (EU) with point-in-time recovery. Object storage (R2) is geo-replicated across Cloudflare's EU + US regions; presigned access is location-agnostic.' + 'Customer data egress to non-EU regions is restricted to the subprocessors enumerated below and on the sub-processor list.' + 'Rate-limiting is enforced application-side via token buckets (per-account + per-IP); DDoS absorption is handled at the CDN edge.' — pinned so the EU-primary Hetzner + Neon-PITR + R2-EU+US-geo-replicated + per-account+per-IP-token-buckets + edge-DDoS-absorption commitment survives", () => {
    expect(body).toMatch(
      /Driftstack runs <strong>primarily in the EU<\/strong> \(Hetzner\s*\n?\s*Falkenstein \/ Nuremberg\)\./,
    );
    expect(body).toMatch(
      /Postgres is managed by Neon \(EU\) with point-in-time recovery\.\s*\n?\s*Object storage \(R2\) is geo-replicated across Cloudflare's\s*\n?\s*EU \+ US regions; presigned access is location-agnostic\./,
    );
    expect(body).toMatch(
      /Customer data egress to non-EU regions is restricted to the\s*\n?\s*subprocessors enumerated below and on the\s*\n?\s*<a href="\/legal\/sub-processors">sub-processor list<\/a>\./,
    );
    expect(body).toMatch(
      /Rate-limiting is enforced application-side via token buckets\s*\n?\s*\(per-account \+ per-IP\); see\s*\n?\s*<a href="\/docs\/rate-limits">\/docs\/rate-limits<\/a> for the\s*\n?\s*bucket model\. DDoS absorption is handled at the CDN edge\./,
    );
  });

  it("Browser-sandbox 3-bullet framing pinned: 'Driftstack does not execute customer-supplied script bodies server-side — the API surface is action-based (navigate / interact / wait / capture). Arbitrary script eval is intentionally not exposed.' + 'Each session is one isolated WebKit instance backed by an ephemeral context; cross-session state never bleeds. Persistence between sessions only happens via the customer-managed profile mechanism (encrypted browser state on the driver host — the MacStadium fleet, US).' + 'Concurrent-session caps per tier act as the primary cost-control + abuse-mitigation primitive; exceeding the cap returns 429 with the concurrency-limit RFC 7807 type.' — pinned so the no-server-side-script-eval + one-WebKit-per-session + profile-as-only-persistence + concurrency-cap-as-cost-control + 429 concurrency-limit RFC 7807 commitment survives", () => {
    expect(body).toMatch(
      /Driftstack does not execute customer-supplied script bodies\s*\n?\s*server-side — the API surface is action-based\s*\n?\s*\(<code>navigate<\/code> \/ <code>interact<\/code> \/\s*\n?\s*<code>wait<\/code> \/ <code>capture<\/code>\)\. Arbitrary script\s*\n?\s*eval is intentionally not exposed\./,
    );
    expect(body).toMatch(
      /Each session is one isolated WebKit instance backed by an\s*\n?\s*ephemeral context; cross-session state never bleeds\.\s*\n?\s*Persistence between sessions only happens via the\s*\n?\s*customer-managed <strong>profile<\/strong> mechanism\s*\n?\s*\(encrypted browser state on the driver host — the MacStadium\s*\n?\s*fleet, US\)\./,
    );
    expect(body).toMatch(
      /Concurrent-session caps per tier act as the primary\s*\n?\s*cost-control \+ abuse-mitigation primitive; exceeding the cap\s*\n?\s*returns <code>429<\/code> with the\s*\n?\s*<code>concurrency-limit<\/code> RFC 7807 type\./,
    );
  });

  it("Sub-processors 5-shortlist + 30-day-notice framing pinned: Stripe (card billing only — no payment data touches our infra) + NowPayments (crypto checkout) + Cloudflare (CDN, WAF, R2 object storage) + Postmark (transactional email) + Sentry (engineering error monitoring; PII-scrubbed at SDK level) + 'We publish 30-day notice before adding or rotating a sub-processor. Enterprise contracts can opt into the announcement mailing list at announcements@.' — pinned so the 5-shortlist + Stripe-no-payment-data-on-our-infra + Sentry-PII-scrubbed-at-SDK-level + 30-day-notice + enterprise-announcements@ commitment survives", () => {
    expect(body).toMatch(
      /<li>Stripe \(card billing only — no payment data touches our infra\)<\/li>/,
    );
    expect(body).toMatch(/<li>NowPayments \(crypto checkout\)<\/li>/);
    expect(body).toMatch(/<li>Cloudflare \(CDN, WAF, R2 object storage\)<\/li>/);
    expect(body).toMatch(/<li>Postmark \(transactional email\)<\/li>/);
    expect(body).toMatch(
      /<li>Sentry \(engineering error monitoring; PII-scrubbed at SDK level\)<\/li>/,
    );
    expect(body).toMatch(
      /We publish 30-day notice before adding or rotating a sub-\s*\n?\s*processor\. Enterprise contracts can opt into the announcement\s*\n?\s*mailing list at <code>announcements@<\/code>\./,
    );
  });

  it('Audit + observability 3-stream framing pinned: Account audit log (every mutation on your account) + Session logs (per-session navigation + console output retained per tier) + Cost ledger (every billable event, queryable via the API) — pinned so the 3-customer-readable log streams commitment survives', () => {
    expect(body).toMatch(
      /<a href="\/docs\/audit-log">Account audit log<\/a> — every\s*\n?\s*mutation on your account \(key mints, profile changes, billing\s*\n?\s*events\)\./,
    );
    expect(body).toMatch(
      /Session logs — per-session navigation \+ console output\s*\n?\s*retained per tier\./,
    );
    expect(body).toMatch(/Cost ledger — every billable event, queryable via the API\./);
  });

  it("Incident response + vulnerability reporting framing pinned: 'See /docs/incident-policy for the disclosure timeline + the status page cadence. Security-relevant incidents are disclosed within 72h of confirmation; we do not bury exposure events.' + 'Email security@driftstack.dev with the details. We respond within 1 business day. Our vulnerability disclosure policy covers safe-harbour for good-faith research; please review it before testing.' — pinned so the 72h-disclosure + don't-bury-exposure + 1-business-day-SLA + /legal/vulnerability-disclosure safe-harbour commitment survives (drift to softening 72h or 1-business-day would weaken procurement-trust)", () => {
    expect(body).toMatch(
      /Security-relevant incidents are disclosed within 72h\s*\n?\s*of confirmation; we do not bury exposure events\./,
    );
    expect(body).toMatch(
      /<a href="mailto:security@driftstack\.dev">security@driftstack\.dev<\/a>\s*\n?\s*with the details\. We respond within 1 business day\./,
    );
    expect(body).toMatch(
      /<a href="\/legal\/vulnerability-disclosure">vulnerability\s*\n?\s*disclosure policy<\/a> covers safe-harbour for good-faith\s*\n?\s*research; please review it before testing\./,
    );
  });

  it('5-related-doc cluster: /docs/data-residency + /docs/admin-api + /docs/incident-policy + /docs/audit-log + /legal/sub-processors — pinned so the 5-related-doc navigation surface stays complete', () => {
    // S47 2026-07-07 (founder-approved: mirror deprecation): the data-residency mirror is deleted; href re-pinned to the docs successor.
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/reference\/data-residency\/">Data residency<\/a>/,
    );
    expect(body).toMatch(/<a href="\/docs\/admin-api">Admin API \+ scope<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/incident-policy">Incident policy<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/audit-log">Audit log<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/sub-processors">Sub-processors<\/a>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
