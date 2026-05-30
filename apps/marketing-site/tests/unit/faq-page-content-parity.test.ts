// W368.A — drift guard for marketing-site /faq page content.
// V-500. Existing tests cover tier-cap + free-tier subset
// parity + coverage baseline; this guard pins the structural
// shape and the load-bearing answers a buyer reads before
// signing:
//
//   • 9 FAQ groups present, in canonical order. A future "drop
//     a group" change should require a deliberate decision, not
//     a drive-by.
//   • Free-tier mechanics: $0 forever / one profile / one
//     concurrent / API-within-free-limits / perpetual / no
//     metering.
//   • Concurrent-cap ladder (Personal = 1 / Team = 3
//     / Agency = 8 / API Starter = 2 / Builder = 8 /
//     Scale = 24 / Enterprise = custom).
//   • 429 + RFC 7807 problem-detail on cap reached.
//   • Annual billing 20% off / 30-day cancel-before-renewal.
//   • Cancel → 90d "suspended" + DPA retention archive.
//   • Card details never touch Driftstack servers (Stripe only).
//   • "What if Driftstack goes away" two-protection answer
//     (data portability + source escrow).
//   • AUP link to /legal/aup + bot/fraud prohibitions.
//   • Support SLA ladder: 48h Starter → 1h Enterprise.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/faq.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W368.A marketing-site /faq page content parity', () => {
  const body = read(PAGE);

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

  it('free-tier mechanics pinned: $0-forever / one profile / one concurrent / API-within-free-limits / perpetual / no metering', () => {
    expect(body).toMatch(
      /One persistent profile, one concurrent session, and sessions up to 20 minutes each/,
    );
    expect(body).toMatch(/\$0 forever, no card required/);
    expect(body).toMatch(/The free tier is perpetual/);
    expect(body).toMatch(/within the free limits/);
    expect(body).toMatch(/No per-hour metering, no credit decrement, no overage/);
  });

  it('concurrent-cap ladder pinned exactly (Solo=1 / Team=3 / Agency=8 / Starter=2 / Builder=8 / Scale=24)', () => {
    expect(body).toMatch(
      /Personal = 1 concurrent \/ Team = 3 \/ Agency = 8 \/ API Starter = 2 \/ API Builder = 8 \/ API Scale = 24 \/ Enterprise = custom/,
    );
  });

  it('cap-reached behavior: 429 + RFC 7807 problem-detail + in-flight not interrupted', () => {
    expect(body).toMatch(/HTTP 429 \+ a structured RFC 7807 problem-detail/);
    expect(body).toMatch(/Existing in-flight sessions are not interrupted/);
  });

  it('annual billing pinned: 20% off / Stripe proration / 30-day cancel-before-renewal', () => {
    expect(body).toMatch(/billed up front for 12 months at 20% off the monthly equivalent/);
    expect(body).toMatch(/prorated automatically by Stripe/);
    expect(body).toMatch(/auto-renew unless cancelled at least 30 days before renewal/);
  });

  it('cancel posture: 90d "suspended" + DPA retention archive (no immediate delete)', () => {
    expect(body).toMatch(
      /account stays in a "suspended" state with recordings and audit logs intact for 90 days/,
    );
    expect(body).toMatch(/archived per the DPA retention schedule/);
  });

  it('"Card details never touch Driftstack servers" Stripe-PCI claim pinned', () => {
    // Load-bearing trust claim.
    expect(body).toMatch(/Card details are stored by Stripe, never by Driftstack/);
    expect(body).toMatch(/the card number itself never touches our servers/);
  });

  it('"What if Driftstack goes away" two-protection answer pinned (portability + escrow)', () => {
    expect(body).toMatch(/Data portability:/);
    expect(body).toMatch(/Self-hosted SKU:/);
    expect(body).toMatch(/source escrow agreement releases the WebKit fork \+ control-plane code/);
  });

  it('AUP link to /legal/aup + explicit prohibition list pinned (CSAM / fraud / sneaker bots)', () => {
    expect(body).toMatch(/href="\/legal\/aup"/);
    // Note: source-file literal escapes the apostrophe (`don\'t`)
    // because the FAQ entry strings are single-quoted JS literals.
    expect(body).toMatch(/We don\\?'t allow attacks on third-party systems/);
    expect(body).toMatch(/fraud \(ad fraud, fake-account creation, payment fraud\)/);
    expect(body).toMatch(/CSAM or other illegal content/);
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

  it('hardware framing pinned: macOS Apple Silicon (M-series Macs); not Linux + x86 — founder 2026-05-19 correction', () => {
    expect(body).toMatch(/macOS Apple Silicon fleet hardware \(M-series Macs\)/);
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
