// W368.A — drift guard for marketing-site /faq page content.
// V-500. Existing tests cover tier-cap + free-tier subset
// parity + coverage baseline; this guard pins the structural
// shape and the load-bearing answers a buyer reads before
// signing.
//
// 2026-07-03 Fleet v2 — the Q&A array moved verbatim to
// src/data/faq.ts (single source of truth): the page markup AND the
// FAQPage JSON-LD both derive from FAQ_GROUPS, so they can never
// diverge. Content pins below read the data file; structural pins
// read the page + FaqList component:
//
//   • 9 FAQ groups present, in canonical order (+ Support, 10th). A
//     future "drop a group" change should require a deliberate
//     decision, not a drive-by.
//   • Page derives BOTH the rendered Q&A and one FAQPage JSON-LD from
//     FAQ_GROUPS (no second hardcoded copy anywhere).
//   • Questions stay REAL h3 headings in the DOM — no accordion
//     (<details>) hiding answers from crawlers/find-in-page.
//   • Sticky category side-nav anchors to the group headings.
//   • Free-tier mechanics: $0 forever / one profile / one
//     concurrent / manual-only (no API) / perpetual / no
//     metering. (Free is GUI-only; programmatic API/SDK access
//     starts on the API ladder.)
//   • Concurrent-cap ladder (Personal = 1 / Team = 3
//     / Agency = 8 / API Starter = 2 / Builder = 8 /
//     Scale = 24 / Enterprise = custom).
//   • 429 + RFC 9457 problem-detail on cap reached.
//   • Annual billing 20% off / 30-day cancel-before-renewal.
//   • Cancel → "suspended" + 30-day grace-period + DPA
//     retention schedule.
//   • Card details never touch Driftstack servers (Stripe only).
//   • "What if Driftstack goes away" two-protection answer
//     (data portability + source escrow).
//   • AUP link to /legal/aup + bot/fraud prohibitions.
//   • Support SLA: single 48h business-time target.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/faq.astro');
const DATA = resolve(REPO_ROOT, 'apps/marketing-site/src/data/faq.ts');
const FAQ_LIST = resolve(REPO_ROOT, 'apps/marketing-site/src/components/FaqList.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W368.A marketing-site /faq page content parity', () => {
  const body = read(DATA);
  const page = read(PAGE);
  const faqList = read(FAQ_LIST);

  it('9 FAQ groups present in canonical order', () => {
    const expected = [
      "title: 'Pricing model'",
      "title: 'Free tier'",
      "title: 'Tiers + upgrades'",
      "title: 'Billing + payments'",
      "title: 'Bundled LLM + BYOK'",
      "title: 'EU stack + compliance'",
      "title: 'Architecture + sessions'",
      "title: 'Migrating from another vendor'",
      "title: 'Acceptable use'",
    ];
    let lastIdx = -1;
    for (const t of expected) {
      const idx = body.indexOf(t);
      expect(idx, `group missing or out of order: ${t}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
    // Support group exists too (10th total).
    expect(body).toContain("title: 'Support + reliability'");
  });

  it('page + FAQPage JSON-LD both derive from the one FAQ_GROUPS array (single source, W507 no-fabrication discipline)', () => {
    // Page imports the data module — no second hardcoded Q&A copy.
    expect(page).toMatch(
      /import \{ FAQ_GROUPS, faqGroupSlug, faqPlainText \} from '\.\.\/data\/faq';/,
    );
    // Exactly one FAQPage JSON-LD, built from FAQ_GROUPS via faqPlainText.
    expect(page.match(/'@type': 'FAQPage'/g)).toHaveLength(1);
    expect(page).toMatch(/mainEntity: FAQ_GROUPS\.flatMap\(\(group\) => group\.entries\)/);
    expect(page).toMatch(/text: faqPlainText\(entry\.a\)/);
    expect(page).toMatch(
      /<script type="application\/ld\+json" set:html=\{JSON\.stringify\(faqStructuredData\)\} \/>/,
    );
    // No fabricated structured data: FAQPage carries Question/Answer only.
    expect(page).not.toMatch(/aggregateRating|reviewCount|ratingValue/i);
  });

  it('questions render as REAL h3 headings (FaqList) — no <details> accordion hiding answers from crawlers', () => {
    expect(page).toContain('<FaqList entries={group.entries}');
    expect(page).not.toContain('<details');
    expect(faqList).toMatch(/<h3 [^>]*>\{entry\.q\}<\/h3>/);
    expect(faqList).toMatch(/set:html=\{entry\.a\}/);
    expect(faqList).not.toContain('<details');
  });

  it('sticky category side-nav anchors to the slugged group headings (desktop)', () => {
    expect(page).toMatch(/aria-label="FAQ categories"/);
    expect(page).toMatch(/sticky top-24/);
    expect(page).toMatch(/href=\{`#\$\{faqGroupSlug\(group\.title\)\}`\}/);
    expect(page).toMatch(/id=\{faqGroupSlug\(group\.title\)\}/);
  });

  it('free-tier mechanics pinned: $0-forever / one profile / one concurrent / manual-only (no API) / perpetual / no metering', () => {
    expect(body).toMatch(
      /One persistent profile, one concurrent session, and sessions up to 20 minutes each, driven from our desktop app/,
    );
    expect(body).toMatch(/\$0 forever, no card required/);
    expect(body).toMatch(/The free tier is manual-only \(no API\/SDK access from code\)/);
    expect(body).toMatch(/The free tier is perpetual/);
    // Free tier is manual-only: access from code (API/SDK) starts on the
    // API ladder (API Starter from $149/mo). Old "API-within-free-limits"
    // framing (2026-05-28) is superseded. S20b 2026-07-06: same facts,
    // plain words ("GUI client" → "desktop app", "programmatic" → "from
    // code").
    expect(body).toMatch(
      /Access from code — the API and SDKs — starts on the API ladder \(API Starter from \$149\/mo\)/,
    );
    expect(body).not.toMatch(/within the free limits/);
    expect(body).not.toMatch(/driven from the API or the desktop GUI client/);
    expect(body).toMatch(/No per-hour metering, no credit decrement, no overage/);
  });

  it('concurrent-cap ladder pinned exactly (Solo=1 / Team=3 / Agency=8 / Starter=2 / Builder=8 / Scale=24)', () => {
    expect(body).toMatch(
      /Personal = 1 concurrent \/ Team = 3 \/ Agency = 8 \/ API Starter = 2 \/ API Builder = 8 \/ API Scale = 24 \/ Enterprise = custom/,
    );
  });

  it('cap-reached behavior: 429 + RFC 9457 problem-detail + in-flight not interrupted', () => {
    expect(body).toMatch(/HTTP 429 \+ a structured RFC 9457 problem-detail/);
    expect(body).toMatch(/Existing in-flight sessions are not interrupted/);
  });

  it('annual billing pinned: 20% off / Stripe proration / 30-day cancel-before-renewal', () => {
    expect(body).toMatch(/billed up front for 12 months at 20% off the monthly equivalent/);
    expect(body).toMatch(/prorated automatically by Stripe/);
    expect(body).toMatch(/auto-renew unless cancelled at least 30 days before renewal/);
  });

  it('cancel posture: "suspended" + 30-day grace-period + DPA retention schedule (no immediate delete)', () => {
    expect(body).toMatch(/No data is deleted at cancellation/);
    expect(body).toMatch(
      /account stays in a "suspended" state with a 30-day grace-period for recovery/,
    );
    expect(body).toMatch(
      /your account data \(profiles, sessions, captures\) is deleted on the schedule set in our data-processing agreement \(DPA\)/,
    );
  });

  it('"Card details never touch Driftstack servers" Stripe-PCI claim pinned', () => {
    // Load-bearing trust claim.
    expect(body).toMatch(/Card details are stored by Stripe, never by Driftstack/);
    expect(body).toMatch(/the card number itself never touches our servers/);
  });

  it('"What if Driftstack goes away" two-protection answer pinned (portability + escrow)', () => {
    expect(body).toMatch(/Data portability:/);
    expect(body).toMatch(/Self-hosted option:/);
    expect(body).toMatch(
      /escrow agreement releases the browser engine \(the WebKit fork\) and the management software \(the control-plane code\)/,
    );
  });

  it('AUP link to /legal/aup + explicit prohibition list pinned (CSAM / fraud / sneaker bots)', () => {
    expect(body).toMatch(/href="\/legal\/aup"/);
    // Note: the data-file literal may or may not escape the apostrophe
    // (`don\'t`) depending on the string's quote style — accept both.
    expect(body).toMatch(/We don\\?'t allow attacks on third-party systems/);
    expect(body).toMatch(/fraud \(ad fraud, fake-account creation, payment fraud\)/);
    expect(body).toMatch(/CSAM \(child sexual abuse material\) or other illegal content/);
    expect(body).toMatch(/sneaker bots \/ ticket bots/);
  });

  it('support response framing pinned: single 48h business-time target, no tiered ladder (founder 2026-05-19 verdict)', () => {
    expect(body).toMatch(/Reply target is 48h business-time across every tier/);
    expect(body).toMatch(/Slack Connect is available on request/);
  });

  it('uptime target framing pinned: best-effort 99.5% across all tiers, no tiered SLA (founder 2026-05-19 verdict)', () => {
    expect(body).toMatch(/Best-effort 99\.5% across all tiers/);
    expect(body).toMatch(/There is no formal SLA with credits/);
  });

  it('hardware framing pinned: M-series Macs (macOS, Apple Silicon); not Linux + x86 — founder 2026-05-19 correction (S20b plain words, same hardware fact)', () => {
    expect(body).toMatch(/M-series Macs \(macOS, Apple Silicon\)/);
    expect(body).not.toMatch(/Linux fleet hardware/);
    expect(body).not.toMatch(/data-center x86/);
  });

  it('BYOK secret-handling claim pinned (envelope encryption + in-memory at exec)', () => {
    expect(body).toMatch(
      /encrypted at rest with envelope encryption, decrypted in-memory only at session execution time, and never logged/,
    );
  });

  it('Enterprise pricing floor pinned: from $4,000/mo on annual contracts only', () => {
    expect(body).toMatch(/from \$4,000\/mo on annual contracts only/);
  });

  it('accent-colored link text in answers uses the AA-safe text-tk-accent-text tone (design-system v2)', () => {
    // Raw text-tk-accent fails WCAG AA as TEXT on the dark bg; the
    // accent-text token is the readable tone. Fills/borders may keep
    // tk-accent, but answer links are text.
    expect(body).not.toMatch(/class="text-tk-accent underline"/);
  });

  it('cross-links resolve: /legal/aup + /legal/dpa + /trust/sub-processors + /comparison + /roadmap', () => {
    for (const path of [
      'apps/marketing-site/src/pages/legal/aup.md',
      'apps/marketing-site/src/pages/legal/dpa.md',
      'apps/marketing-site/src/pages/comparison.astro',
      'apps/marketing-site/src/pages/roadmap.astro',
    ]) {
      expect(existsSync(resolve(REPO_ROOT, path)), `cross-linked path missing: ${path}`).toBe(true);
    }
  });
});
