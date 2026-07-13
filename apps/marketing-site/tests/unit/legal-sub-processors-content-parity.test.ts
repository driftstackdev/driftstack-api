// W379.A — drift guard for marketing-site /legal/sub-processors.md
// content. Existing sub-processors-dpa-parity + sub-processor-
// registry-last-updated-baseline + legal-sub-processor-internal-doc-
// links cover binding + cross-ref shape. This guard pins the
// standalone-doc load-bearing claims (separate from the DPA Annex 3
// summary which has different framing):
//
//   • Version 1.0 + Effective 2026-05-10 (matches the register's
//     SUB_PROCESSOR_REGISTER_LAST_UPDATED in src/data/sub-processors.ts).
//   • 12 Sub-processor rows pinned to the live register (Hetzner /
//     Neon / Upstash / Cloudflare R2 / Postmark / Sentry / Stripe /
//     Anthropic / Moneybird / MacStadium / NowPayments / LiveKit) —
//     NO AWS, NO GitHub (neither is a Driftstack sub-processor).
//   • Production topology: Hetzner + Neon (Postgres) + Upstash
//     (Redis) + Cloudflare R2 (storage) + MacStadium (fleet).
//   • Sub-processor definition + 2 exclusions pinned.
//   • 30-day notice + 3 delivery channels (page update / email /
//     in-dashboard changelog).
//   • Objection-process: pro-rated refund + terminate-affected-
//     portion.
//   • announcements@driftstack.dev mailing list opt-in via
//     security@.
//   • 2 substantive change-list entries (NowPayments added /
//     LiveKit added).
//   • Cross-links: dpa.md + privacy.md + /docs/security-overview
//     + the docs data-residency page (S49: redirected successor).
//   • security@driftstack.dev + 1-business-day reply.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/sub-processors.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W379.A marketing-site /legal/sub-processors.md content parity', () => {
  const body = read(PAGE);

  it('version 1.1 + effective 2026-07-07 doc header pinned (matches register; S43 R2 correction bump)', () => {
    // S43 2026-07-07 (founder-approved) — v1.0 → v1.1: Cloudflare R2
    // row corrected (default jurisdiction w/ EU+US replication under
    // SCCs+DPF; real object classes). Header bumps per this page's own
    // change-notice convention.
    expect(body).toMatch(/\*\*Version:\*\* 1\.1 · \*\*Effective:\*\* 2026-07-07/);
  });

  it('changelog carries the v1.1 R2-correction entry alongside the v1.0 baseline (S43 2026-07-07)', () => {
    expect(body).toMatch(/\*\*2026-07-07 — v1\.1\.\*\* Cloudflare R2 row corrected/);
    expect(body).toMatch(/\*\*2026-05-10 — v1\.0\.\*\* Initial standalone publication/);
  });

  it('intentionally-short vendor surface posture framing pinned (load-bearing trust signal)', () => {
    expect(body).toMatch(/The list below is intentionally short/);
    expect(body).toMatch(
      /every additional sub-processor is one more place a breach\s+can originate and one more party we owe a contract to/,
    );
  });

  it('sub-processor definition: 2 exclusions pinned (business-data / customer-direct)', () => {
    expect(body).toMatch(/Vendors that only receive Driftstack's own business data/);
    expect(body).toMatch(/Vendors a customer chooses to integrate with directly/);
    // The old "self-hosted Postgres/Redis" exclusion contradicted Neon/
    // Upstash being managed sub-processors — it must not reappear.
    expect(body).not.toMatch(/self-host \(Postgres, Redis/);
  });

  it('12 sub-processor rows pinned to the live register (Hetzner / Neon / Upstash / Cloudflare R2 / Postmark / Sentry / Stripe / Anthropic / Moneybird / MacStadium / NowPayments / LiveKit)', () => {
    expect(body).toMatch(/\*\*Hetzner Cloud\*\*/);
    expect(body).toMatch(/\*\*Neon, Inc\.\*\*/);
    expect(body).toMatch(/\*\*Upstash, Inc\.\*\*/);
    expect(body).toMatch(/\*\*Cloudflare R2\*\*/);
    expect(body).toMatch(/\*\*Postmark\*\*/);
    expect(body).toMatch(/\*\*Sentry\*\*/);
    expect(body).toMatch(/\*\*Stripe\*\*/);
    expect(body).toMatch(/\*\*Anthropic\*\*/);
    expect(body).toMatch(/\*\*Moneybird\*\*/);
    expect(body).toMatch(/\*\*MacStadium\*\*/);
    expect(body).toMatch(/\*\*NowPayments OÜ\*\*/);
    expect(body).toMatch(/\*\*LiveKit, Inc\.\*\*/);
    // AWS and GitHub are not Driftstack sub-processors — must not appear.
    expect(body).not.toMatch(/Amazon Web Services|\bAWS\b/);
    expect(body).not.toMatch(/GitHub/);
  });

  it('production topology pinned: Hetzner compute + Neon Postgres + Upstash Redis + Cloudflare R2 storage + MacStadium fleet', () => {
    expect(body).toMatch(
      /The production control plane runs on \*\*Hetzner Cloud\*\* \(compute\) with\s+\*\*Neon\*\* \(managed Postgres\)/,
    );
    expect(body).toMatch(/\*\*Upstash\*\* \(managed Redis\)/);
    // S43 2026-07-07 — R2 object classes corrected: avatars, encrypted
    // profile blobs, public status snapshots (recordings/screenshots
    // were never stored there; recording is not a live feature).
    expect(body).toMatch(
      /\*\*Cloudflare R2\*\* for object storage \(avatars, encrypted profile\s+blobs, public status snapshots\)/,
    );
    expect(body).not.toMatch(/object storage \(recordings, screenshots,\s+avatars\)/);
    expect(body).toMatch(/execution\s+fleet runs on\s+\*\*MacStadium\*\*/);
  });

  it('Hetzner is production compute, EU-resident (not narrowed to dev/staging)', () => {
    expect(body).toMatch(
      /Compute infrastructure for the Driftstack control plane \(production\)\./,
    );
    expect(body).toMatch(/Falkenstein, Germany \(EU\)\./);
    // The old "Hetzner dev/staging only, production on AWS" framing is wrong.
    expect(body).not.toMatch(/development \+ staging environments only/);
  });

  it('Stripe row pinned: EU (Ireland) entity + SCC/DPF transfer', () => {
    expect(body).toMatch(/Stripe Payments Europe Ltd \(Ireland\)\./);
  });

  it('NowPayments: crypto-only, engaged at checkout, intra-EEA', () => {
    expect(body).toMatch(
      /Engaged only when a customer opts to pay with cryptocurrency at checkout; bypassed for Stripe-paying customers/,
    );
    expect(body).toMatch(/EEA-internal — no transfer mechanism required/);
  });

  it('Anthropic: optional AI agent, US, SCC/DPF; session data only when a mode is engaged', () => {
    expect(body).toMatch(
      /Large language model for the optional AI agent feature, engaged in BYOK-proxy or opt-in bundled-LLM mode/,
    );
    expect(body).toMatch(/United States\./);
  });

  it('MacStadium: US Mac-fleet host for iPhone Safari session execution, SCC/DPF', () => {
    expect(body).toMatch(/Mac hardware hosting for the iPhone Safari session execution fleet\./);
    expect(body).toMatch(/Session execution state \(transient\)\./);
  });

  it('LiveKit: opt-in live-session feature, disabled by default', () => {
    expect(body).toMatch(
      /WebRTC live-session signaling \+ media SFU for the optional "live session" feature/,
    );
    expect(body).toMatch(/Disabled by default\./);
  });

  it('30-day notice + 3 delivery channels (page-update / announcements@ email / in-dashboard changelog)', () => {
    expect(body).toMatch(
      /Driftstack publishes 30 days' notice before adding, removing, or\s+materially changing the role of any sub-processor/,
    );
    expect(body).toMatch(/An update to this page \(the \*\*Effective\*\* date at the top bumps/);
    expect(body).toMatch(/An email to the address registered on\s+`announcements@driftstack\.dev`/);
    expect(body).toMatch(/A note in the in-dashboard changelog feed/);
  });

  it('objection-process: 30-day window + pro-rated refund + terminate-affected-portion', () => {
    expect(body).toMatch(
      /Customers under a signed DPA may object to a new sub-processor in\s+writing within the 30-day window/,
    );
    expect(body).toMatch(
      /the customer may terminate the affected Services for\s+convenience with a pro-rated refund/,
    );
  });

  it('mailing-list opt-in via security@driftstack.dev + 1-business-day reply', () => {
    expect(body).toMatch(/\[security@driftstack\.dev\]\(mailto:security@driftstack\.dev\)/);
    expect(body).toMatch(/We reply\s+within one business day/);
  });

  it('changelog 2026-05-10 v1.0 entry pinned (initial publication)', () => {
    expect(body).toMatch(
      /\*\*2026-05-10 — v1\.0\.\*\* Initial standalone publication\. Inherits the\s+vendor list from DPA v0\.9 \+ adds NowPayments, LiveKit/,
    );
  });

  it('2 substantive changes pinned (NowPayments added / LiveKit added); no Hetzner-narrowed-to-AWS claim', () => {
    expect(body).toMatch(
      /\*\*NowPayments added\*\* for crypto-tier processing\. Previously\s+crypto-payment customers used a manual invoice flow/,
    );
    expect(body).toMatch(/\*\*LiveKit added\*\* for the optional live-session feature/);
    // Production runs on Hetzner; the "narrowed to dev/staging, consolidated onto AWS" claim is wrong.
    expect(body).not.toMatch(/Hetzner narrowed/);
    expect(body).not.toMatch(/consolidated onto AWS/);
  });

  it('cross-links: canonical DPA + privacy routes + /docs/security-overview + the docs data-residency page (S49: redirected successor)', () => {
    expect(body).toMatch(/\[Data Processing Addendum\]\(\/legal\/dpa\/\)/);
    expect(body).toMatch(/\[Privacy Policy\]\(\/legal\/privacy\/\)/);
    expect(body).toMatch(/\[\/docs\/security-overview\]\(\/docs\/security-overview\/\)/);
    expect(body).toMatch(
      /\[docs\.driftstack\.dev\/reference\/data-residency\]\(https:\/\/docs\.driftstack\.dev\/reference\/data-residency\/\)/,
    );
    const dir = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal');
    expect(existsSync(resolve(dir, 'dpa.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'privacy.md'))).toBe(true);
  });

  it('DPA section 4 cross-reference + "authoritative list" framing pinned', () => {
    expect(body).toMatch(
      /referenced from the\s+\[Data Processing Addendum\]\(\/legal\/dpa\/\) \(section 4 — "Sub-processors"\)/,
    );
    expect(body).toMatch(/the authoritative list at the date marked above/);
  });

  it('"no-cross-region-copy guarantee" data-residency framing pinned in related-links blurb', () => {
    expect(body).toMatch(/region-pinning \+ the\s+no-cross-region-copy guarantee/);
  });
});
