// W505.A — drift guard for apps/marketing-site/src/pages/legal/sub-processors.md.
// Sub-processor List v1.0 — referenced from DPA section 4 ('Sub-processors')
// and the authoritative list at the effective date. Drift here either
// drops a sub-processor (would create marketing↔contract divergence under
// Article 28(2)) or changes the 30-day-notice-and-objection mechanics
// (would breach the DPA commitment customers signed on).
//
//   • Version 1.1 + effective 2026-07-07 (S43 R2 correction) + DPA
//     section 4 anchor.
//   • 12-vendor sub-processor table matching the live register: Hetzner /
//     Neon / Upstash / Cloudflare R2 / Postmark / Sentry / Stripe /
//     Anthropic / Moneybird / MacStadium / NowPayments / LiveKit —
//     NO AWS, NO GitHub.
//   • Scope exclusions: own-business-data vendors + customer-integrated
//     vendors (2 exclusions; the self-hosted-OSS exclusion was dropped
//     because Neon/Upstash are managed sub-processors, not self-hosted).
//   • Changelog summary: NowPayments added + LiveKit added.
//   • 30-day notice + objection process + pro-rated refund termination.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/sub-processors.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W505.A apps/marketing-site/src/pages/legal/sub-processors.md content parity', () => {
  const body = read(LIB);

  it("Version 1.1 + effective 2026-07-07 + DPA section 4 anchor — pinned so the version-tracked register + the DPA-section-4 cross-reference both survive (S43 2026-07-07: v1.0 → v1.1 for the Cloudflare R2 correction, per the page's own bump-the-effective-date convention)", () => {
    expect(body).toMatch(/\*\*Version:\*\* 1\.1 · \*\*Effective:\*\* 2026-07-07/);
    expect(body).toMatch(
      /referenced from the\s*\n?\s*\[Data Processing Addendum\]\(dpa\.md\) \(section 4 — "Sub-processors"\)/,
    );
  });

  it("Intentionally-short vendor surface framing pinned: 'The list below is intentionally short. Driftstack is a small, infrastructure-focused company and we keep the vendor surface tight on purpose — every additional sub-processor is one more place a breach can originate and one more party we owe a contract to.' — pinned so the 'tight vendor surface by design' commitment + the per-vendor-is-a-breach-surface rationale survive (drift to dropping would let the list grow without the intentional-restraint signal customers buy on)", () => {
    expect(body).toMatch(
      /The list below is intentionally short\. Driftstack is a small,\s*\n?\s*infrastructure-focused company and we keep the vendor surface tight on\s*\n?\s*purpose — every additional sub-processor is one more place a breach\s*\n?\s*can originate and one more party we owe a contract to\./,
    );
  });

  it("2-scope-exclusion framing: own-business-data vendors + customer-integrated vendors — pinned so the 2 exclusions stay explicit (drift to dropping 'customer-integrated' would create scope creep for customer-owned Slack/webhook destinations). The old self-hosted-OSS exclusion was dropped: Neon/Upstash are managed sub-processors, not self-hosted, so that exclusion must not reappear", () => {
    expect(body).toMatch(
      /Vendors that only receive Driftstack's own business data with no\s*\n?\s*customer workload exposure \(e\.g\. our HR provider\)/,
    );
    expect(body).toMatch(
      /Vendors a customer chooses to integrate with directly \(e\.g\. their\s*\n?\s*own Slack workspace receiving Driftstack webhooks\)/,
    );
    expect(body).not.toMatch(/self-host \(Postgres, Redis/);
  });

  it('12-vendor sub-processor table matching the live register: Hetzner + Neon + Upstash + Cloudflare R2 + Postmark + Sentry + Stripe + Anthropic + Moneybird + MacStadium + NowPayments (OÜ) + LiveKit — pinned so the vendor scope stays consistent with the DPA Annex contractual register (drift to dropping any vendor would create marketing↔DPA divergence). AWS and GitHub are NOT Driftstack sub-processors and must not appear', () => {
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
    expect(body).not.toMatch(/Amazon Web Services|\bAWS\b/);
    expect(body).not.toMatch(/GitHub/);
  });

  it('SCC + EU-US DPF transfer mechanism stays consistent on US-hosted vendors — pinned so the GDPR-compliant transfer basis stays anchored (drift to dropping the SCC/DPF citation would weaken the legal-anchoring)', () => {
    expect(body).toMatch(/2021 Standard Contractual Clauses \+ EU-US Data Privacy Framework\./);
    expect(body).toMatch(/EEA-internal — no transfer mechanism required\./);
  });

  it("Changelog summary pinned: 'NowPayments added' for crypto-tier + 'LiveKit added' for the live-session feature — pinned so the 2-substantive-change record survives. The old 'Hetzner narrowed / consolidated onto AWS' claim is removed: production runs on Hetzner", () => {
    expect(body).toMatch(
      /\*\*NowPayments added\*\* for crypto-tier processing\. Previously\s*\n?\s*crypto-payment customers used a manual invoice flow/,
    );
    expect(body).toMatch(/\*\*LiveKit added\*\* for the optional live-session feature/);
    expect(body).not.toMatch(/Hetzner narrowed/);
    expect(body).not.toMatch(/consolidated onto AWS/);
  });

  it('30-day notice delivery 3-channel pinned: page-update + announcements@driftstack.dev email + in-dashboard changelog — pinned so the 3-channel notice mechanism survives (drift to dropping the email channel would leave customers reliant on polling the page; drift to dropping the in-dashboard changelog would orphan the customer-facing surface from the notice)', () => {
    expect(body).toMatch(
      /Driftstack publishes 30 days' notice before adding, removing, or\s*\n?\s*materially changing the role of any sub-processor\./,
    );
    expect(body).toMatch(/An update to this page \(the \*\*Effective\*\* date at the top bumps/);
    expect(body).toMatch(
      /An email to the address registered on\s*\n?\s*`announcements@driftstack\.dev`/,
    );
    expect(body).toMatch(/A note in the in-dashboard changelog feed\./);
  });

  it("Objection-and-terminate framing pinned: 'Customers under a signed DPA may object to a new sub-processor in writing within the 30-day window. If we cannot make reasonable accommodation (e.g. by isolating the customer's workload from the new sub-processor) the customer may terminate the affected Services for convenience with a pro-rated refund.' — pinned so the objection-right + isolate-fallback + terminate-with-pro-rated-refund 3-state customer protection survives (drift to dropping the pro-rated refund would weaken the termination remedy; drift to dropping the 'reasonable accommodation' attempt would skip the isolation fallback that lets customers stay)", () => {
    expect(body).toMatch(
      /Customers under a signed DPA may object to a new sub-processor in\s*\n?\s*writing within the 30-day window\./,
    );
    expect(body).toMatch(
      /If we cannot make reasonable\s*\n?\s*accommodation \(e\.g\. by isolating the customer's workload from the new\s*\n?\s*sub-processor\) the customer may terminate the affected Services for\s*\n?\s*convenience with a pro-rated refund\./,
    );
  });

  it('Subscription opt-in via security@driftstack.dev + one-business-day reply commitment — pinned so the announcement-mailing-list opt-in + the 1-business-day-reply SLA survive (drift to dropping security@ would orphan the channel; drift to a longer SLA would let customer questions slip)', () => {
    expect(body).toMatch(
      /\[security@driftstack\.dev\]\(mailto:security@driftstack\.dev\) with your\s*\n?\s*account ID \+ the email you want subscribed\./,
    );
    expect(body).toMatch(/We reply\s*\n?\s*within one business day\./);
  });

  it('Related-docs cross-link 4-set: dpa.md + privacy.md + /docs/security-overview + the docs data-residency page (S49: redirected successor) — pinned so the 4-doc reference cluster (binding contract + privacy policy + security architecture + region-pinning) stays complete (drift to dropping /docs/data-residency would orphan the no-cross-region-copy commitment from the register)', () => {
    expect(body).toMatch(/\[Data Processing Addendum\]\(dpa\.md\)/);
    expect(body).toMatch(/\[Privacy Policy\]\(privacy\.md\)/);
    expect(body).toMatch(/\[\/docs\/security-overview\]\(\/docs\/security-overview\)/);
    expect(body).toMatch(
      /\[docs\.driftstack\.dev\/reference\/data-residency\]\(https:\/\/docs\.driftstack\.dev\/reference\/data-residency\/\) — region-pinning \+ the\s*\n?\s*no-cross-region-copy guarantee\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
