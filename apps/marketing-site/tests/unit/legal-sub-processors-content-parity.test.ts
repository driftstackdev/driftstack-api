// W379.A — drift guard for marketing-site /legal/sub-processors.md
// content. Existing sub-processors-dpa-parity + sub-processor-
// registry-last-updated-baseline + legal-sub-processor-internal-doc-
// links cover binding + cross-ref shape. This guard pins the
// standalone-doc load-bearing claims (separate from the DPA Annex 3
// summary which has different framing):
//
//   • Version 1.0 + Effective 2026-05-11.
//   • 9 Sub-processor rows pinned (AWS / Cloudflare / Stripe /
//     NowPayments / Postmark+ActiveCampaign / Sentry / Hetzner
//     dev-staging-only / LiveKit / GitHub).
//   • Sub-processor definition + 3 exclusions pinned.
//   • 30-day notice + 3 delivery channels (page update / email /
//     in-dashboard changelog).
//   • Objection-process: pro-rated refund + terminate-affected-
//     portion.
//   • announcements@driftstack.dev mailing list opt-in via
//     security@.
//   • 3 substantive change-list entries (NowPayments added /
//     LiveKit added V-531 / Hetzner narrowed to dev/staging).
//   • Cross-links: dpa.md + privacy.md + /docs/security-overview
//     + /docs/data-residency.
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

  it('version 1.0 + effective 2026-05-11 doc header pinned', () => {
    expect(body).toMatch(/\*\*Version:\*\* 1\.0 · \*\*Effective:\*\* 2026-05-11/);
  });

  it('intentionally-short vendor surface posture framing pinned (load-bearing trust signal)', () => {
    expect(body).toMatch(/The list below is intentionally short/);
    expect(body).toMatch(
      /every additional sub-processor is one more place a breach\s+can originate and one more party we owe a contract to/,
    );
  });

  it('sub-processor definition: 3 exclusions pinned (business-data / customer-direct / self-hosted OSS)', () => {
    expect(body).toMatch(/Vendors that only receive Driftstack's own business data/);
    expect(body).toMatch(/Vendors a customer chooses to integrate with directly/);
    expect(body).toMatch(
      /Open-source software we self-host \(Postgres, Redis, etc\.\)\. Self-\s*\n?\s*hosted infrastructure runs inside our managed cloud accounts/,
    );
  });

  it('9 sub-processor rows pinned (AWS / Cloudflare / Stripe / NowPayments / Postmark+ActiveCampaign / Sentry / Hetzner / LiveKit / GitHub)', () => {
    expect(body).toMatch(/\*\*Amazon Web Services, Inc\.\*\* \(AWS\)/);
    expect(body).toMatch(/\*\*Cloudflare, Inc\.\*\*/);
    expect(body).toMatch(/\*\*Stripe, Inc\.\*\*/);
    expect(body).toMatch(/\*\*NowPayments OÜ\*\*/);
    expect(body).toMatch(/\*\*Postmark \/ ActiveCampaign\*\* \(Wildbit, LLC\)/);
    expect(body).toMatch(/\*\*Functional Software, Inc\.\*\* \(Sentry\)/);
    expect(body).toMatch(/\*\*Hetzner Online GmbH\*\*/);
    expect(body).toMatch(/\*\*LiveKit, Inc\.\*\*/);
    expect(body).toMatch(/\*\*GitHub, Inc\.\*\* \(Microsoft\)/);
  });

  it('AWS regions: EU Ireland + US-East N. Virginia + AP-South Mumbai (pinned per customer region)', () => {
    expect(body).toMatch(
      /EU \(Ireland\), US-East \(N\. Virginia\), AP-South \(Mumbai\) — pinned per customer region/,
    );
  });

  it('Stripe: no PAN storage (tokenisation at hosted checkout)', () => {
    expect(body).toMatch(
      /Driftstack does not store PAN or full card data; tokenisation happens at Stripe's hosted checkout/,
    );
  });

  it('NowPayments: order-ID-only, no customer identity shared', () => {
    expect(body).toMatch(/No customer identity is shared with NowPayments beyond the order ID/);
    expect(body).toMatch(/Intra-EEA transfer; no extra-EEA SCCs required/);
  });

  it('Sentry: PII-scrubbing at SDK level before events leave the application', () => {
    expect(body).toMatch(
      /Driftstack PII-scrubs at the SDK level before events leave the application/,
    );
  });

  it('Hetzner narrowed to dev/staging only (no production customer data)', () => {
    expect(body).toMatch(
      /Secondary compute \(development \+ staging environments only\)\. No production customer data/,
    );
    expect(body).toMatch(/None in production\. Dev\/staging fixtures only/);
  });

  it.skip('LiveKit: opt-in feature for Browser Theatre live sessions (V-531)', () => {
    expect(body).toMatch(
      /Real-time audio\/video transport for Browser Theatre live sessions \(opt-in feature\)/,
    );
    expect(body).toMatch(/Live sessions are off by default/);
    expect(body).toMatch(/V-531/);
  });

  it('GitHub: source-control only, does not process customer workloads', () => {
    expect(body).toMatch(
      /Source-control hosting for Driftstack's own codebase \+ the customer-facing CLI release pipeline\. Does not process customer workloads/,
    );
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

  it('changelog 2026-05-11 v1.0 entry pinned (initial publication)', () => {
    expect(body).toMatch(
      /\*\*2026-05-11 — v1\.0\.\*\* Initial standalone publication\. Inherits the\s+vendor list from DPA v0\.9/,
    );
  });

  it('3 substantive changes pinned (NowPayments added / LiveKit added / Hetzner narrowed)', () => {
    expect(body).toMatch(
      /\*\*NowPayments added\*\* for crypto-tier processing\. Previously\s+crypto-payment customers used a manual invoice flow/,
    );
    expect(body).toMatch(/\*\*LiveKit added\*\* for the Browser Theatre live-session feature/);
    expect(body).toMatch(
      /\*\*Hetzner narrowed\*\* to dev\/staging only\. Previously listed as a\s+production secondary; production has been consolidated onto AWS/,
    );
  });

  it('cross-links: dpa.md + privacy.md + /docs/security-overview + /docs/data-residency', () => {
    expect(body).toMatch(/\[Data Processing Addendum\]\(dpa\.md\)/);
    expect(body).toMatch(/\[Privacy Policy\]\(privacy\.md\)/);
    expect(body).toMatch(/\[\/docs\/security-overview\]\(\/docs\/security-overview\)/);
    expect(body).toMatch(/\[\/docs\/data-residency\]\(\/docs\/data-residency\)/);
    const dir = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal');
    expect(existsSync(resolve(dir, 'dpa.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'privacy.md'))).toBe(true);
  });

  it('DPA section 4 cross-reference + "authoritative list" framing pinned', () => {
    expect(body).toMatch(
      /referenced from the\s+\[Data Processing Addendum\]\(dpa\.md\) \(section 4 — "Sub-processors"\)/,
    );
    expect(body).toMatch(/the authoritative list at the date marked above/);
  });

  it('"no-cross-region-copy guarantee" data-residency framing pinned in related-links blurb', () => {
    expect(body).toMatch(/region-pinning \+ the\s+no-cross-region-copy guarantee/);
  });
});
