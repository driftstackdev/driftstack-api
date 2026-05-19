// W505.A — drift guard for apps/marketing-site/src/pages/legal/sub-processors.md.
// Sub-processor List v1.0 — referenced from DPA section 4 ('Sub-processors')
// and the authoritative list at the effective date. Drift here either
// drops a sub-processor (would create marketing↔contract divergence under
// Article 28(2)) or changes the 30-day-notice-and-objection mechanics
// (would breach the DPA commitment customers signed on).
//
//   • Version 1.0 + effective 2026-05-11 + DPA section 4 anchor.
//   • 9-vendor sub-processor table: AWS / Cloudflare / Stripe / NowPayments
//     / Postmark (Wildbit) / Sentry (Functional Software) / Hetzner /
//     LiveKit / GitHub.
//   • Scope exclusions: own-business-data vendors + customer-integrated
//     vendors + self-hosted OSS.
//   • Changelog summary: NowPayments added + LiveKit added (V-531) +
//     Hetzner narrowed.
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

  it('Version 1.0 + effective 2026-05-11 + DPA section 4 anchor — pinned so the version-tracked register + the DPA-section-4 cross-reference both survive (drift to dropping section 4 anchor would orphan the customer contractual register from the marketing version; drift to a different DPA section would create cross-doc divergence)', () => {
    expect(body).toMatch(/\*\*Version:\*\* 1\.0 · \*\*Effective:\*\* 2026-05-11/);
    expect(body).toMatch(
      /referenced from the\s*\n?\s*\[Data Processing Addendum\]\(dpa\.md\) \(section 4 — "Sub-processors"\)/,
    );
  });

  it("Intentionally-short vendor surface framing pinned: 'The list below is intentionally short. Driftstack is a small, infrastructure-focused company and we keep the vendor surface tight on purpose — every additional sub-processor is one more place a breach can originate and one more party we owe a contract to.' — pinned so the 'tight vendor surface by design' commitment + the per-vendor-is-a-breach-surface rationale survive (drift to dropping would let the list grow without the intentional-restraint signal customers buy on)", () => {
    expect(body).toMatch(
      /The list below is intentionally short\. Driftstack is a small,\s*\n?\s*infrastructure-focused company and we keep the vendor surface tight on\s*\n?\s*purpose — every additional sub-processor is one more place a breach\s*\n?\s*can originate and one more party we owe a contract to\./,
    );
  });

  it("3-scope-exclusion framing: own-business-data vendors + customer-integrated vendors + self-hosted OSS — pinned so the 3 exclusions stay explicit (drift to dropping 'open-source software we self-host' would leave Postgres/Redis ambiguity; drift to dropping 'customer-integrated' would create scope creep for customer-owned Slack/webhook destinations)", () => {
    expect(body).toMatch(
      /Vendors that only receive Driftstack's own business data \(e\.g\. our\s*\n?\s*accounting platform, our HR provider\)/,
    );
    expect(body).toMatch(
      /Vendors a customer chooses to integrate with directly \(e\.g\. their\s*\n?\s*own Slack workspace receiving Driftstack webhooks\)/,
    );
    expect(body).toMatch(
      /Open-source software we self-host \(Postgres, Redis, etc\.\)\. Self-\s*\n?\s*hosted infrastructure runs inside our managed cloud accounts and is\s*\n?\s*not a separate processor\./,
    );
  });

  it("9-vendor sub-processor table: AWS + Cloudflare + Stripe + NowPayments (OÜ Estonia) + Postmark/ActiveCampaign (Wildbit) + Sentry (Functional Software) + Hetzner + LiveKit + GitHub (Microsoft) — pinned so the 9-vendor scope stays consistent with the DPA Annex 3 contractual register (drift to dropping any vendor would create marketing↔DPA divergence; drift to dropping the legal-entity names — 'OÜ' / 'Wildbit, LLC' / 'Functional Software, Inc.' — would weaken the contractual specificity)", () => {
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

  it('EU SCC (Regulation 2021/914) transfer mechanism stays consistent on US-hosted vendors — pinned so the GDPR-compliant transfer basis stays anchored to the current EU Standard Contractual Clauses regulation (drift to a different version would create GDPR-compliance divergence; drift to dropping the regulation citation would weaken the legal-anchoring)', () => {
    expect(body).toMatch(/EU SCCs \(2021\/914\) for transfers outside the EEA\./);
    expect(body).toMatch(/EU SCCs \(2021\/914\)/);
    expect(body).toMatch(/Intra-EEA transfer; no extra-EEA SCCs required\./);
  });

  it("Changelog summary pinned: 'NowPayments added' for crypto-tier + 'LiveKit added' for Browser Theatre + 'Hetzner narrowed' to dev/staging — pinned so the 3-substantive-change record + Hetzner-narrowed-from-production audit-trail all survive (drift to dropping 'Hetzner narrowed' would let customers think Hetzner still processes production data). Re-enabled by slice 303 after the R4 V-NNN session-log scrub (b46b8d4124b) intentionally removed the (V-531) anchor from customer-facing copy — the test regex had been pinning the pre-scrub form", () => {
    expect(body).toMatch(
      /\*\*NowPayments added\*\* for crypto-tier processing\. Previously\s*\n?\s*crypto-payment customers used a manual invoice flow/,
    );
    expect(body).toMatch(
      /\*\*LiveKit added\*\* for the Browser Theatre live-session feature\s*\n?\s*\. Live sessions are off by default/,
    );
    expect(body).toMatch(
      /\*\*Hetzner narrowed\*\* to dev\/staging only\. Previously listed as a\s*\n?\s*production secondary; production has been consolidated onto AWS\./,
    );
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

  it('Related-docs cross-link 4-set: dpa.md + privacy.md + /docs/security-overview + /docs/data-residency — pinned so the 4-doc reference cluster (binding contract + privacy policy + security architecture + region-pinning) stays complete (drift to dropping /docs/data-residency would orphan the no-cross-region-copy commitment from the register)', () => {
    expect(body).toMatch(/\[Data Processing Addendum\]\(dpa\.md\)/);
    expect(body).toMatch(/\[Privacy Policy\]\(privacy\.md\)/);
    expect(body).toMatch(/\[\/docs\/security-overview\]\(\/docs\/security-overview\)/);
    expect(body).toMatch(
      /\[\/docs\/data-residency\]\(\/docs\/data-residency\) — region-pinning \+ the\s*\n?\s*no-cross-region-copy guarantee\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
