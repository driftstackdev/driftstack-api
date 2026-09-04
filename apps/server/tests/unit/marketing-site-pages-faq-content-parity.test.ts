// W500.A — drift guard for the marketing-site /faq surface.
// Public FAQ page. Drift here either drops a V-500 group (would lose
// the architecture / migration / AUP questions that pad support
// inboxes pre-launch) or breaks the canonical pricing/SLA numbers
// (which customers reading the FAQ compare against the actual
// product config).
//
// 2026-07-03 Fleet v2 — the Q&A array moved verbatim from faq.astro
// to apps/marketing-site/src/data/faq.ts (single source of truth):
// the page markup AND the FAQPage JSON-LD both derive from
// FAQ_GROUPS. Content pins below read the data file; the JSON-LD
// single-source pin reads the page.
//
//   • 10-group taxonomy (Pricing model + Free tier + Tiers + upgrades
//     + Billing + payments + Bundled LLM + BYOK + EU stack + compliance
//     + V-500 Architecture + sessions + V-500 Migrating + V-500
//     Acceptable use + Support + reliability).
//   • Concurrent caps: Solo/Team/Agency 1/3/8 + API
//     Starter/Builder/Scale 2/8/24.
//   • Free-tier mechanic: $0 forever + one profile + one concurrent +
//     manual-only (GUI-only, no API/SDK) + perpetual + no metering.
//     Every PAID tier includes programmatic API/SDK access (S43
//     2026-07-07 claims fix); the API ladder is the code-first path.
//   • Enterprise from $4,000/mo.
//   • Stripe payment processor + EU VAT/BTW reverse-charge.
//   • Support: single 48h business-time target across all tiers
//     (non-contractual) + ToS §9.2 Severity-1 first-response SLA on
//     API Scale / Enterprise (S43 2026-07-07).
//   • Uptime: §9.1 tiers best-effort; API Scale + Enterprise carry
//     the contractual 99.9% SLA per ToS §9.2 (S43 2026-07-07).
//   • 20% annual discount + 30-day cancellation notice.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/data/faq.ts');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/faq.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W500.A apps/marketing-site /faq (src/data/faq.ts + faq.astro) content parity', () => {
  const body = read(LIB);
  const page = read(PAGE);

  it('10-group taxonomy pinned: Pricing model + Free tier + Tiers + upgrades + Billing + payments + Bundled LLM + BYOK + EU stack + compliance + V-500 Architecture + sessions + V-500 Migrating from another vendor + V-500 Acceptable use + Support + reliability — pinned so the 10-bucket structure stays consistent (drift to dropping V-500 groups would re-orphan customers from architecture / migration / AUP self-service answers)', () => {
    expect(body).toMatch(/title: 'Pricing model',/);
    expect(body).toMatch(/title: 'Free tier',/);
    expect(body).toMatch(/title: 'Tiers \+ upgrades',/);
    expect(body).toMatch(/title: 'Billing \+ payments',/);
    expect(body).toMatch(/title: 'Bundled LLM \+ BYOK',/);
    expect(body).toMatch(/title: 'EU stack \+ compliance',/);
    expect(body).toMatch(/title: 'Architecture \+ sessions',/);
    expect(body).toMatch(/title: 'Migrating from another vendor',/);
    expect(body).toMatch(/title: 'Acceptable use',/);
    expect(body).toMatch(/title: 'Support \+ reliability',/);
  });

  it("V-500 'Architecture + sessions' group doc-comment framing pinned: 'V-500 — architecture + sessions group. Three buyer-recurring questions buried in support threads pre-launch; pulling them up so prospects answer themselves.' — pinned so the why-we-added-V-500-groups rationale survives (drift to dropping would let a future maintainer remove these groups thinking they're noise)", () => {
    expect(body).toMatch(
      /\/\/ V-500 — architecture \+ sessions group\. Three buyer-recurring\s*\/\/ questions buried in support threads pre-launch; pulling them\s*\/\/ up so prospects answer themselves\./,
    );
  });

  it("Concurrent metering 7-tier framing pinned: 'Personal = 1 concurrent / Team = 3 / Agency = 8 / API Starter = 2 / API Builder = 8 / API Scale = 24 / Enterprise = custom' — pinned so the per-tier concurrent caps stay consistent with the customer-dashboard select-tier page (drift would create cross-page price-to-cap divergence)", () => {
    expect(body).toMatch(
      /Personal = 1 concurrent \/ Team = 3 \/ Agency = 8 \/ API Starter = 2 \/ API Builder = 8 \/ API Scale = 24 \/ Enterprise = custom/,
    );
  });

  it("Free-tier mechanic pinned: 'One persistent profile, one concurrent session, and sessions up to 20 minutes each, driven from our desktop app — $0 forever, no card required. The free tier is manual-only (no API/SDK access from code)' + perpetual (no expiry) + manual-only + no metering — pinned so the founder-locked free-tier shape survives. (S43 2026-07-07 claims fix: EVERY PAID tier includes programmatic API/SDK access with live keys — TIER_FEATURES apiAccess: true across the paid ladder — so the old 'starts on the API ladder' sentence is retired; the API ladder is the path built/sized for code-first workloads. The free tier stays manual-only — common.ts 'free $0 — manual-only (no API)'.)", () => {
    expect(body).toMatch(
      /One persistent profile, one concurrent session, and sessions up to 20 minutes each, driven from our desktop app — \$0 forever, no card required\./,
    );
    expect(body).toMatch(/The free tier is manual-only \(no API\/SDK access from code\)/);
    expect(body).toMatch(/The free tier is perpetual/);
    expect(body).toMatch(
      /Every paid tier, including the Manual tiers, includes programmatic API\/SDK access with live keys/,
    );
    expect(body).toMatch(
      /The API ladder \(API Starter from \$149\/mo\) is the path built and sized for code-first workloads/,
    );
    expect(body).not.toMatch(/starts on the API ladder/);
    expect(body).not.toMatch(/within the free limits/);
    expect(body).not.toMatch(/driven from the API or the desktop GUI client/);
    expect(body).toMatch(/No per-hour metering, no credit decrement, no overage/);
  });

  it("Enterprise pricing framing: 'from $4,000/mo on annual contracts only' — pinned so the Enterprise baseline-price + annual-only restriction stay consistent across marketing pages (drift to dropping the 'annual contracts only' would let prospects expect monthly Enterprise contracts that don't exist)", () => {
    expect(body).toMatch(/Enterprise is custom — from \$4,000\/mo on annual contracts only\./);
  });

  it('Support response framing pinned: single 48h business-time target across all tiers, explicitly non-contractual, Slack Connect on request post-subscription + the ToS §9.2 Severity-1 first-response grant on API Scale/Enterprise (S43 2026-07-07, aligned to the binding ToS §9 — supersedes the 2026-05-19 flat-ladder framing where it contradicted §9.2)', () => {
    expect(body).toMatch(/Reply target is 48h business-time across every tier/);
    expect(body).toMatch(/an operational target we hold ourselves to, not a contractual SLA/);
    expect(body).toMatch(
      /Slack Connect is available on request once a paid subscription is active/,
    );
    expect(body).toMatch(
      /contractual first-response SLA on Severity-1 incidents \(4 hours and 1 hour respectively\)/,
    );
  });

  it('Uptime framing pinned to ToS §9 (S43 2026-07-07, founder-approved): §9.1 tiers best-effort (no contractual commitment; ~99.5% operational aim), §9.2 tiers (API Scale + Enterprise) carry the contractual 99.9% SLA with credits published at /docs/sla-policy — the old "There is no formal SLA with credits" blanket was FALSE against §9.2 and must not reappear', () => {
    expect(body).toMatch(/there is no contractually-binding SLA/);
    expect(body).toMatch(/operationally we aim for 99\.5%\+/);
    expect(body).toMatch(
      /API Scale and Enterprise carry a contractual SLA: 99\.9% monthly availability with service credits/,
    );
    expect(body).not.toMatch(/There is no formal SLA with credits/);
    expect(body).not.toMatch(/Best-effort 99\.5% across all tiers/);
    expect(body).toMatch(/status\.driftstack\.io/);
  });

  it("Annual contract framing: 'billed up front for 12 months at 20% off the monthly equivalent' + 'Annual contracts auto-renew unless cancelled at least 30 days before renewal' — pinned so the 20% discount + 30-day-notice cancellation policy stay consistent with the Stripe customer portal behavior (drift to a different notice period would create a Stripe↔marketing-page mismatch)", () => {
    expect(body).toMatch(
      /Annual contracts are billed up front for 12 months at 20% off the monthly equivalent\./,
    );
    expect(body).toMatch(
      /Annual contracts auto-renew unless cancelled at least 30 days before renewal\./,
    );
  });

  it('Stripe payment framing pinned: \'Stripe is our payment processor. Card statements show "STRIPE *DRIFTSTACK". Receipts come from Stripe. Subscription management goes through the Stripe Customer Portal. Stripe handles PCI compliance, fraud protection, dispute mechanisms, and EU VAT/BTW reverse-charge — all of which we inherit rather than reimplement.\' — pinned so the Stripe-handled scope (PCI + fraud + dispute + EU VAT/BTW reverse-charge) stays explicit (drift to dropping would let customers wonder which compliance pieces Driftstack does vs. Stripe)', () => {
    expect(body).toMatch(
      /Stripe handles PCI compliance \(the card-security rules\), fraud protection, payment disputes, and EU VAT\/BTW reverse-charge \(the EU tax rules for business buyers\) — we rely on Stripe for all of that rather than rebuilding it ourselves\./,
    );
  });

  it("Crypto-via-NowPayments framing: 'Yes — via NowPayments on tiers where crypto checkout is enabled.' + 'Crypto payments are non-refundable' — pinned so the NowPayments crypto rail + non-refundability stay explicit (drift to claiming refundable crypto would let customers expect impossible chargebacks; drift to dropping NowPayments would orphan customers from the canonical processor)", () => {
    expect(body).toMatch(/Yes — via NowPayments on tiers where crypto checkout is enabled\./);
    expect(body).toMatch(/<strong>Crypto payments are non-refundable<\/strong>/);
  });

  it("BYOK security framing: 'Your Anthropic API key is encrypted at rest with envelope encryption, decrypted in-memory only at session execution time, and never logged. The DPA covers the handling shape. Self-hosted customers can use their own KMS for the envelope key.' — pinned so the envelope-encryption + in-memory-only + never-logged + DPA-coverage + KMS-bring-your-own posture survive (drift to dropping any would weaken the BYOK security narrative for compliance buyers)", () => {
    expect(body).toMatch(
      /Your Anthropic API key is encrypted at rest with envelope encryption, decrypted in-memory only at session execution time, and never logged\./,
    );
    // S20b 2026-07-06: the security terms stay, each now carries a plain
    // gloss (envelope encryption / DPA / KMS spelled out). The data-file
    // literal escapes the apostrophe (`it\'s`) — accept both forms.
    expect(body).toMatch(
      /Our data-processing agreement \(DPA\) covers exactly how it\\?'s handled\./,
    );
    expect(body).toMatch(
      /Self-hosted customers can hold the outer \(envelope\) key in their own key-management system \(KMS\)\./,
    );
  });

  it('operational cost copy keeps payment truth, compute-only estimate and thresholds separate', () => {
    expect(body).toContain(`q: "Where can I see what I've actually been billed?"`);
    expect(body).toMatch(/Stripe-issued invoices are payment truth for card subscriptions/);
    expect(body).toMatch(/crypto customers use their NowPayments order receipt/);
    expect(body).toMatch(/operational cost-to-serve estimate for a UTC month, not your invoice/);
    expect(body).toMatch(/only its compute estimate is populated/);
    expect(body).toMatch(/storage, egress, email, and LLM are reserved zero fields/);
    expect(body).toMatch(/operator unit-economics signal, not a customer spending cap/);
    expect(body).toMatch(/does not send a customer billing email, add an invoice item, rate-limit/);
    expect(body).toMatch(/recomputed on each request from lifecycle-derived session minutes/);
  });

  it('AI billing states the shipped included-service budget and self-serve consent paths without launch promises', () => {
    expect(body).toContain("q: 'How is AI usage billed?'");
    expect(body).toContain("q: 'What is the bundled LLM?'");
    expect(body).toMatch(/BYOK has no Driftstack markup/);
    expect(body).toMatch(/\$0\.10 included-service accounting value against the monthly budget/);
    expect(body).toMatch(/budget is enforced but not separately itemized by Stripe today/);
    expect(body).toMatch(/Enterprise can use a contracted custom budget/);
    expect(body).toMatch(/Settings → AI &amp; billing/);
    expect(body).toMatch(/PATCH \/v1\/account\/me\/bundled-llm-settings/);
    expect(body).not.toMatch(
      /announced at launch|arrives at v1\.1|until then|at a markup over|metered in "tokens"|billed on one invoice|contracted custom rate/i,
    );
  });

  it("Cap-reached HTTP 429 + RFC 9457 framing: 'Session-creation requests fail with HTTP 429 + a structured RFC 9457 problem-detail pointing at the cap-reached state and (where applicable) the next-tier upgrade path. Existing in-flight sessions are not interrupted.' — pinned so the 429 status + RFC 9457 + non-interruption contract stay explicit (drift to dropping non-interruption would let customers think hitting cap mid-fleet would kill in-flight sessions)", () => {
    // S20b 2026-07-06: the answer now leads plain ("starting one session
    // too many simply fails with a clear error") and keeps the developer
    // contract in a parenthetical — 429 + RFC 9457 + non-interruption all
    // still pinned.
    expect(body).toMatch(/the request fails with HTTP 429 \+ a structured RFC 9457 problem-detail/);
    expect(body).toMatch(/Existing in-flight sessions are not interrupted\./);
  });

  it("Source-escrow framing: 'Data portability: profiles + audit logs + session metadata can be exported as CSV/JSON from the dashboard or via the API at any time' + 'Self-hosted SKU: Enterprise + Self-hosted licensees receive source escrow — if the cloud service is sunsetted, the source escrow agreement releases the WebKit fork + control-plane code so customers can continue running the stack on their own hardware indefinitely.' — pinned so the 2-protection 'what if Driftstack goes away?' framing survives (drift to dropping would lose the dealbreaker answer for compliance-conscious enterprise buyers)", () => {
    expect(body).toMatch(/<strong>Data portability:<\/strong>/);
    expect(body).toMatch(/<strong>Self-hosted option:<\/strong>/);
    expect(body).toMatch(/Enterprise \+ Self-hosted licensees receive source escrow/);
  });

  it('FAQPage JSON-LD single-source pinned: the page derives Question/acceptedAnswer pairs from the same FAQ_GROUPS array it renders (W507 discipline — schema can never diverge from the visible Q&A; no fabricated ratings/reviews)', () => {
    expect(page).toMatch(
      /import \{ FAQ_GROUPS, faqGroupSlug, faqPlainText \} from '\.\.\/data\/faq';/,
    );
    expect(page.match(/'@type': 'FAQPage'/g)).toHaveLength(1);
    expect(page).toMatch(/mainEntity: FAQ_GROUPS\.flatMap\(\(group\) => group\.entries\)/);
    expect(page).toMatch(/text: faqPlainText\(entry\.a\)/);
    expect(page).not.toMatch(/aggregateRating|reviewCount|ratingValue/i);
  });

  it('files exist at canonical paths', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(existsSync(PAGE)).toBe(true);
  });
});
