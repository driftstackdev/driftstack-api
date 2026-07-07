// W519.B — drift guard for apps/marketing-site/src/pages/docs/data-residency.astro.
// V-698 data-residency docs + V-298b region preference. Drift here either
// changes a sub-processor region (would create marketing↔/legal/sub-processors
// divergence) or breaks the EU-primary commitment (would mislead EU customers
// about default storage region).
//
//   • V-698 doc-comment framing + V-298b region-preference anchor.
//   • EU-primary: Hetzner Falkenstein/Nuremberg.
//   • region pref enum: us / eu / apac / null (unset).
//   • PATCH /v1/account/me + informational-today + roadmap 2026 PoPs.
//   • Data-categories table 12 rows: account / API keys / sessions /
//     profile metadata / profile state (encrypted file on disk, EU host) /
//     recordings (R2 EU+US replication, presigned 1h TTL) / audit log /
//     webhook deliveries (90-day hot window; S39) / Stripe (US, customer_id only) /
//     NowPayments (Estonia) / Redis Upstash EU + 5min TTL / Sentry EU /
//     Postmark EU.
//   • Never-leaves-EU 3-list: DB + cache + profile state AT REST (Neon EU,
//     Upstash EU, EU-region R2). Profile-state blobs load onto the
//     MacStadium (US) driver host + session-execution traffic flows
//     through the US fleet, so neither stays EU.
//   • Does-leave-EU 4-list: recordings R2 (single-region opt-in) +
//     Stripe (Stripe Payments Europe Ltd Ireland, SCCs + EU-US DPF) +
//     Anthropic (US, BYOK bypasses) + MacStadium (US, SCCs + EU-US DPF).
//   • 30-day grace + DSAR via privacy@.
//   • MFA secret AES-256 + MFA_ENCRYPTION_KEY.
//   • scrypt logN=15 API-key hashing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/data-residency.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W519.B apps/marketing-site/src/pages/docs/data-residency.astro content parity', () => {
  const body = read(LIB);

  it("V-698 + V-298b framing pinned: 'data-residency docs page. Covers where customer data physically lives, what counts as customer data, and the region-preference field on accounts (V-298b).' — pinned so the V-698 + V-298b anchors survive (drift to dropping V-298b would orphan the region-preference field from its engineering anchor). Note: the V-anchors live in the page-header doc-comment (internal-facing), not in customer-rendered copy, so they're allowed here.", () => {
    expect(body).toMatch(
      /\/\/ V-698 — data-residency docs page\. Covers where customer data\s*\n?\s*\/\/ physically lives, what counts as customer data, and the region-\s*\n?\s*\/\/ preference field on accounts \(V-298b\)\./,
    );
  });

  it('F-5 (Issue 5) short-answer bullet framing: EU-primary Hetzner Falkenstein/Nuremberg + customer-facing API endpoints served from EU (multi-region-on-roadmap framing dropped per Issue 5) + region preference (us/eu/apac) on PATCH /v1/account/me informational-only with explicit "every request served from EU regardless" honesty + Object storage R2 geo-replicated EU+US, presigned URL location-agnostic.', () => {
    expect(body).toMatch(
      /Driftstack runs <strong>primarily in the EU<\/strong>\s*\n?\s*\(Hetzner Falkenstein \/ Nuremberg\)\./,
    );
    expect(body).toMatch(
      /The <code>region<\/code> preference on\s*\n?\s*<code>PATCH \/v1\/account\/me<\/code>[\s\S]*?every request is served from EU regardless of the value\s*\n?\s*stored\./,
    );
    expect(body).toMatch(
      /Object storage \(R2\) is geo-replicated across Cloudflare's\s*\n?\s*EU \+ US regions; presigned URL access is location-agnostic\./,
    );
    // F-5 — multi-region-on-roadmap framing must not return.
    expect(body).not.toMatch(/multi-region routing is on the roadmap/);
    expect(body).not.toMatch(/non-EU PoPs/);
  });

  it('Data-categories table 13-row framing pinned: Account row (MFA secret AES-256 + MFA_ENCRYPTION_KEY) + API keys hashed scrypt logN=15 + Sessions metadata + Profile metadata + Profile state blob WebKit driver layer EU host (per-profile encrypted file on disk) + Uploaded files (avatars + encrypted profile blobs) R2 EU+US replication (S3-SSE + 1h presigned TTL) + Audit log entries (90-day hot window) + Webhook deliveries (90-day hot window) (S39: recordings/tier-retention/7-day fictions retired) + Stripe (US, customer_id linkage, never see card numbers) + NowPayments (EU Estonia, payment_id + status only) + Cache Redis Upstash EU (≤5 min TTL) + Sentry EU (ingest.de.sentry.io, PII filter strips emails) + Postmark (EU sending region) — pinned so the 13-category storage map + key-engineering-claims (MFA-AES-256 + scrypt logN=15 + 1h-presigned-TTL + 90-day webhook hot window + ≤5min cache TTL + PII-stripping-Sentry) all survive (drift on any row would create marketing↔sub-processor divergence)', () => {
    expect(body).toMatch(/MFA secret AES-256 encrypted with <code>MFA_ENCRYPTION_KEY<\/code>/);
    expect(body).toMatch(/scrypt logN=15; plaintext never stored/);
    expect(body).toMatch(/Per-profile encrypted file on disk/);
    // S39 2026-07-07 (fable-truth-audit follow-on) — three rows locked fictions: session
    // recordings never shipped (row now names the real R2 objects:
    // avatars + encrypted profile blobs), audit retention is a flat
    // 90-day hot window (never tier-dependent), and no 7-day
    // webhook-delivery prune exists (same 90-day window).
    expect(body).toMatch(/Uploaded files \(avatars, encrypted profile blobs\)/);
    expect(body).toMatch(/Object-level S3-SSE; presigned URLs 1h TTL/);
    expect(body).toMatch(/Append-only; 90-day hot window/);
    expect(body).toMatch(/Payload \+ response excerpt; 90-day hot window/);
    expect(body).not.toMatch(/tier-dependent retention/);
    expect(body).not.toMatch(/7-day retention/);
    expect(body).not.toMatch(/Session recordings \(WebM\)/);
    expect(body).toMatch(
      /<td>We never see card numbers\. Stripe customer_id is the linkage\.<\/td>/,
    );
    expect(body).toMatch(/NowPayments \(EU, Estonia\)/);
    expect(body).toMatch(
      /<td>We see payment_id \+ status only; on-chain data stays on-chain\.<\/td>/,
    );
    expect(body).toMatch(/<td>Upstash \(EU\)<\/td>/);
    expect(body).toMatch(
      /Auth cache, rate-limit counters, MFA-challenge tokens — all\s*\n?\s*short-lived \(≤5 min TTL\)\./,
    );
    expect(body).toMatch(/Sentry EU \(ingest\.de\.sentry\.io\)/);
    expect(body).toMatch(
      /Code-level errors with redacted body fields\. PII filter\s*\n?\s*strips emails before send\./,
    );
    expect(body).toMatch(/<td>Postmark \(EU sending region\)<\/td>/);
  });

  it('Never-leaves-EU 3-list pinned: Database content (Postgres Neon EU) + Cache content (Redis Upstash EU) + Profile state AT REST in DB + object storage (Neon EU, Upstash EU, EU-region R2) — pinned so the never-leaves-EU commitment survives. Per the EU control-plane / US driver-fleet split, profile-state BLOBS are loaded onto the MacStadium (US) driver host and session-execution traffic flows through the US fleet, so neither stays in the EU; only profile state AT REST is EU-resident.', () => {
    expect(body).toMatch(/<li>Database content \(Postgres, Neon EU\)\.<\/li>/);
    expect(body).toMatch(/<li>Cache content \(Redis, Upstash EU\)\.<\/li>/);
    expect(body).toMatch(
      /<li>Profile state at rest in the database \+ object storage\s*\n?\s*\(Neon EU, Upstash EU, EU-region R2 where configured\)\.<\/li>/,
    );
    // The corrected copy no longer claims the driver host or
    // session-execution traffic stays in the EU — both run on
    // MacStadium (US). Ban the old EU-resident driver-host claims.
    expect(body).not.toMatch(/Profile state blobs on the driver host \(EU\)/);
    expect(body).not.toMatch(
      /<li>Session-execution traffic between the API server, the\s*\n?\s*browser driver, and the customer's target URL\.<\/li>/,
    );
    // The split is stated explicitly: blobs load onto the driver
    // host and session-execution traffic flows through MacStadium US.
    expect(body).toMatch(
      /Profile state blobs are loaded onto the driver host and\s*\n?\s*session-execution traffic[\s\S]*?flows through the MacStadium fleet in the\s*\n?\s*US/,
    );
  });

  it('Does-leave-EU 4-list framing pinned: Recordings via R2 (Cloudflare replicates across regions to minimise playback latency; single-region opt-in via contact) + Stripe billing data (Stripe Payments Europe Ltd Ireland, customer_id linkage, SCCs + EU-US DPF) + Anthropic bundled-LLM only (opt-in; prompts + completions traverse Anthropic US under SCCs + EU-US DPF; BYOK accounts bypass entirely) + MacStadium (iPhone Safari driver fleet on MacStadium US, Driftstack-managed VPN tunnels, SCCs + EU-US DPF) — pinned so the 4-list does-leave-EU + 3-SCCs+EU-US-DPF-transfers + BYOK-bypasses-Anthropic + single-region-EU-recordings-via-contact commitment survives', () => {
    expect(body).toMatch(
      /<strong>Recordings via R2:<\/strong> Cloudflare replicates\s*\n?\s*across regions to minimise playback latency\./,
    );
    expect(body).toMatch(
      /If you require\s*\n?\s*strict EU-only storage for recordings, contact us — we can\s*\n?\s*configure your account with single-region \(EU-only\) R2\./,
    );
    expect(body).toMatch(
      /<strong>Stripe billing data:<\/strong> Stripe Payments\s*\n?\s*Europe Ltd \(Ireland\) is the contracted entity\./,
    );
    expect(body).toMatch(
      /Stripe may onward-transfer to\s*\n?\s*sub-processors under SCCs \+ EU-US DPF — see\s*\n?\s*<a href="\/trust\/sub-processors">\/trust\/sub-processors<\/a>\./,
    );
    expect(body).toMatch(
      /<strong>Anthropic \(bundled-LLM only\):<\/strong> the\s*\n?\s*bundled-LLM agent is opt-in\. When enabled, prompts \+\s*\n?\s*completions traverse Anthropic \(US\) under SCCs \+ EU-US DPF\.\s*\n?\s*BYOK accounts bypass this entirely\./,
    );
    expect(body).toMatch(
      /<strong>MacStadium \(session execution\):<\/strong> the\s*\n?\s*iPhone Safari driver fleet runs on MacStadium hardware\s*\n?\s*\(US\)\. Profile state is loaded onto the driver host for the\s*\n?\s*life of a session, and session-execution traffic between the\s*\n?\s*API server, the driver fleet, and the customer's target URL\s*\n?\s*traverses the US fleet via Driftstack-managed VPN tunnels;\s*\n?\s*contractual transfer is via SCCs \+ EU-US DPF\./,
    );
  });

  it("V-298b region account preference framing pinned: PATCH /v1/account/me with {region: 'eu'} + 'Accepted values: us, eu, apac, or null (unset).' + 'Today: the field is informational. We surface it on the account-me response and use it as a tag in our observability stack so we can prioritise where to add PoPs.' + 'Roadmap: once additional PoPs exist (planned for US + APAC in 2026), API routing will land sessions for region: us accounts on US infrastructure, and region: apac on APAC. The account row will still live in the EU primary; sessions + recordings will live in the preferred region.' — pinned so the V-298b 4-value-enum (us/eu/apac/null) + informational-today + observability-tag + 2026-PoP-roadmap + account-row-stays-EU-primary commitment survives. The previous skip pinned `<h2>...account preference (V-298b)</h2>` with the inline anchor that was removed from the customer-facing copy as a UX cleanup (internal V-anchors should not bleed into marketing-rendered headings); the framing itself survives without it.", () => {
    expect(body).toMatch(/<h2>The <code>region<\/code> account preference\s*<\/h2>/);
    expect(body).toMatch(/PATCH \/v1\/account\/me/);
    expect(body).toMatch(/\{ "region": "eu" \}/);
    expect(body).toMatch(
      /Accepted values: <code>us<\/code>, <code>eu<\/code>,\s*\n?\s*<code>apac<\/code>, or <code>null<\/code> \(unset\)\./,
    );
    expect(body).toMatch(
      /<strong>Today:<\/strong> the field is informational\. We surface\s*\n?\s*it on the account-me response and use it as a tag in our\s*\n?\s*observability stack so we can prioritise where to add PoPs\./,
    );
    expect(body).toMatch(
      /<strong>Roadmap:<\/strong> once additional PoPs exist \(planned\s*\n?\s*for US \+ APAC in 2026\), API routing will land sessions for\s*\n?\s*<code>region: us<\/code> accounts on US infrastructure, and\s*\n?\s*<code>region: apac<\/code> on APAC\. The account row will still\s*\n?\s*live in the EU primary; sessions \+ recordings will live in the\s*\n?\s*preferred region\./,
    );
    // Internal V-anchor must NOT bleed into customer-facing <h2> copy.
    expect(body).not.toMatch(/<h2>[^<]*\(V-298b\)[^<]*<\/h2>/);
  });

  it('GDPR / DSAR / right-to-erasure framing pinned: immediate deletion + privacy-policy purge schedule within 30 days + privacy@ DSAR channel (S39: undelete-grace + recordings fictions retired)', () => {
    // S39 2026-07-07 (fable-truth-audit follow-on) — the old pin locked an undelete grace window
    // (no restore flow exists; deletion is immediate) and listed
    // never-shipped recordings among purged resources.
    expect(body).toMatch(
      /Customer accounts can be deleted on request\. Deletion takes\s*\n?\s*effect immediately[\s\S]{0,220}purged on the schedule in the\s*\n?\s*privacy policy, within 30 days\./,
    );
    expect(body).not.toMatch(/grace period for accidental delete recovery/);
    expect(body).toMatch(/<a href="mailto:privacy@driftstack\.dev">privacy@driftstack\.dev<\/a>/);
  });

  it("/legal/sub-processors cross-ref + compliance@driftstack.dev framing pinned: 'Up-to-date subprocessor list with regions, purpose, and DPA links: /legal/sub-processors.' + 'Residency / compliance questions: compliance@driftstack.dev.' — pinned so the subprocessor-list cross-ref + compliance@ routing survives", () => {
    expect(body).toMatch(
      /Up-to-date subprocessor list with regions, purpose, and DPA\s*\n?\s*links: <a href="\/legal\/sub-processors">\/legal\/sub-processors<\/a>\./,
    );
    expect(body).toMatch(
      /Residency \/ compliance questions:\s*\n?\s*<a href="mailto:compliance@driftstack\.dev">compliance@driftstack\.dev<\/a>\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
