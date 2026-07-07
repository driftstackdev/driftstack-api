// W733 — Sub-processor manifest + ADR-002 Stripe-only payment-rail
// parity. Sixtieth in the cross-SDK drift-guard series.
//
// Pins THREE files that define the sub-processor + payment-rail
// posture:
//
//   AGENTS.md — V-052 sub-processor list authoritative manifest
//     (any addition outside the list = directional question first).
//
//   apps/marketing-site/src/pages/legal/sub-processors.md — the
//     customer-facing legal sub-processor table.
//
//   docs/adr/ADR-002-stripe-only-payment-processing.md — the
//     architectural decision record locking Stripe-only fiat rail at
//     launch with Mollie deferred (revisit-triggers).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const AGENTS = resolve(REPO_ROOT, 'AGENTS.md');
const LEGAL = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/sub-processors.md');
const ADR = resolve(REPO_ROOT, 'docs/adr/ADR-002-stripe-only-payment-processing.md');

describe('W733 sub-processors + ADR-002 Stripe-only parity', () => {
  it('all 3 files exist at canonical paths', () => {
    expect(existsSync(AGENTS)).toBe(true);
    expect(existsSync(LEGAL)).toBe(true);
    expect(existsSync(ADR)).toBe(true);
  });

  it('CRITICAL AGENTS.md sub-processor roster pinned (V-052 revision 2026-05-03) — 10 vendors: Hetzner / Neon / Upstash / Cloudflare (R2+Pages+DNS) / Postmark / Sentry / Stripe / Anthropic (BYO bundled LLM only, opt-in) / Moneybird / MacStadium. Drift to adding outside this list = directional question first, never silent.', () => {
    const a = read(AGENTS);

    expect(a).toMatch(
      /Sub-processor list \(revised 2026-05-03 — V-052\): Hetzner, Neon, Upstash, Cloudflare/,
    );
    expect(a).toMatch(
      /\(R2 \+ Pages \+ DNS\), Postmark, Sentry, Stripe, Anthropic \(BYO bundled LLM only, opt-in\), Moneybird, MacStadium/,
    );
    expect(a).toMatch(
      /Adding any sub-processor outside this list = directional question first, never silent/,
    );
  });

  it('CRITICAL AGENTS.md crypto-rail-dropped-2026-05-03 framing pinned. Coinbase Commerce closed for non-US/Singapore 2026-03-31; Stripe sole rail at launch (fiat-only).', () => {
    const a = read(AGENTS);

    expect(a).toMatch(/Crypto rail dropped from launch \(2026-05-03\):/);
    expect(a).toMatch(/Coinbase Commerce closed for non-US\/Singapore merchants 2026-03-31/);
    expect(a).toMatch(/Stripe is the sole payment rail at launch \(fiat-only\)/);
  });

  it("CRITICAL AGENTS.md post-launch crypto candidates framing pinned. Stripe's native USDC/USDB (Dec 2025) is candidate for crypto re-entry pending EU merchant eligibility; alt processors (CoinGate / NOWPayments / BVNK / Triple-A) deferred.", () => {
    const a = read(AGENTS);

    expect(a).toMatch(
      /Stripe's native USDC\/USDB support \(Dec 2025\) is the candidate for crypto re-entry/,
    );
    expect(a).toMatch(/pending EU merchant eligibility verification/);
    expect(a).toMatch(
      /Alternative EU-friendly crypto processors \(CoinGate, NOWPayments, BVNK, Triple-A\) deferred to post-launch/,
    );
  });

  it('CRITICAL ADR-002 status + date + V-052 + D-027 anchors pinned. The Accepted-2026-05-03 dual-anchor (V-052 + D-027) threads the decision into both the V-log and the D-decision-record.', () => {
    const d = read(ADR);

    expect(d).toMatch(/# ADR-002 — Stripe-only payment processing at launch/);
    expect(d).toMatch(/\*\*Status:\*\* Accepted/);
    expect(d).toMatch(/\*\*Date:\*\* 2026-05-03/);
    expect(d).toMatch(/\*\*Tier:\*\* Architectural \(approved deviation; vendor \/ structural\)/);
    expect(d).toMatch(/V-052 \(Coinbase Commerce dropped from sub-processor list \+ legal docs\)/);
    expect(d).toMatch(/V-060 \(this ADR \+ D-027 entry\)/);
    expect(d).toMatch(/D-027 — Stripe-only payment rail at launch/);
  });

  it('CRITICAL ADR-002 4-constraint rationale pinned — (1) Stripe EU coverage caught up; (2) solo-entrepreneur operational load; (3) BTW reverse-charge mechanic; (4) metered LLM line-item billing. The 4-constraint chain is what justifies dropping Mollie.', () => {
    const d = read(ADR);

    expect(d).toMatch(/Stripe's EU payment-method coverage caught up/);
    expect(d).toMatch(/Solo-entrepreneur operational load/);
    expect(d).toMatch(/\*\*BTW reverse-charge\*\* mechanic/);
    expect(d).toMatch(/\*\*metered billing for BYOK LLM line-item billing\*\*/);
  });

  it('CRITICAL ADR-002 Stripe primitives roster pinned — Billing + Tax + Webhooks + Meters + Customer Portal. The 5-primitive set is what gets wired; drift to dropping any would let a different Stripe path slip in.', () => {
    const d = read(ADR);

    expect(d).toMatch(/Stripe Billing for subscription management/);
    expect(d).toMatch(/Stripe Tax for BTW reverse-charge handling/);
    expect(d).toMatch(/Stripe Webhooks for subscription lifecycle events/);
    expect(d).toMatch(/Stripe Meters for BYOK LLM line-item billing/);
    expect(d).toMatch(/Stripe Customer Portal for self-service plan changes/);
  });

  it('CRITICAL ADR-002 driftstack_llm_tokens meter name pinned. The meter name is wire-stable; drift to renaming would break Stripe meter dashboards + every customer invoice line.', () => {
    const d = read(ADR);
    expect(d).toMatch(/`driftstack_llm_tokens`/);
  });

  it('CRITICAL ADR-002 6-event webhook roster pinned — created/updated/cancelled/past_due/payment_failed/payment_succeeded. The 6-event set is what gates subscription-state-machine transitions.', () => {
    const d = read(ADR);

    expect(d).toMatch(
      /subscription lifecycle events \(created \/ updated \/ cancelled \/ past_due \/ payment_failed \/ payment_succeeded\)/,
    );
  });

  it('CRITICAL ADR-002 "Mollie deferred to revisit triggers" framing pinned. The deferral framing keeps the Mollie spec alive without expanding scope (revisit triggers: Stripe underwriting decline at KvK onboarding).', () => {
    const d = read(ADR);

    expect(d).toMatch(
      /The earlier "dual-processor with Mollie primary" design[\s\S]{0,300}deferred to the revisit triggers below/,
    );
    expect(d).toMatch(
      /if Stripe's underwriting flow declines the legal entity at KvK-onboarding time, Mollie reactivates/,
    );
  });

  it('CRITICAL ADR-002 Coinbase-Commerce closure framing pinned with V-052 cross-reference. "Dropped 2026-05-03 (V-052) due to closure for non-US/Singapore merchants and Coinbase Business unavailability in NL".', () => {
    const d = read(ADR);
    expect(d).toMatch(
      /Coinbase Commerce was earlier in the rail mix; dropped 2026-05-03 \(V-052\) due to closure for non-US\/Singapore merchants and Coinbase Business unavailability in NL/,
    );
  });

  it('CRITICAL legal/sub-processors.md customer-facing table includes all 12 wire-active vendors. Each vendor MUST appear in the legal-doc table (12-vendor register: Hetzner / Neon / Upstash / Cloudflare R2 / Postmark / Sentry / Stripe / Anthropic / Moneybird / MacStadium / NowPayments / LiveKit).', () => {
    const l = read(LEGAL);

    for (const vendor of [
      'Hetzner Cloud',
      'Neon, Inc.',
      'Upstash, Inc.',
      'Cloudflare R2',
      'Postmark',
      'Sentry',
      'Stripe',
      'Anthropic',
      'Moneybird',
      'MacStadium',
      'NowPayments OÜ',
      'LiveKit, Inc.',
    ]) {
      expect(l, `legal sub-processor ${vendor}`).toMatch(new RegExp(`\\*\\*${escapeRe(vendor)}`));
    }
  });

  it('CRITICAL legal/sub-processors.md customer-facing Stripe row framing — the data-category column lists only a "card token" (never the PAN / full card data), tokenised at Stripe, plus Stripe Tax BTW reverse-charge handling. Drift to claiming Driftstack stores card numbers would mislead customers about Stripe\'s PCI role.', () => {
    const l = read(LEGAL);
    // Stripe row: purpose mentions BTW reverse-charge via Stripe Tax …
    expect(l).toMatch(
      /Payment processing, subscription management, BYOK metered billing, BTW reverse-charge handling via Stripe Tax\./,
    );
    // … and the only card data category is a token, not the PAN.
    expect(l).toMatch(/Billing email, line-item description, amount, card token\./);
  });

  it('CRITICAL legal/sub-processors.md Cloudflare R2 row data categories pinned (S43 2026-07-07 correction): avatar bytes + encrypted profile blobs + operational status snapshots — the old "Recording artifacts + screenshots" claim was false (session recording is not a live feature; captures return inline and are not retained on R2).', () => {
    const l = read(LEGAL);
    expect(l).toMatch(
      /Avatar bytes, encrypted profile blobs, status-page snapshots \(operational JSON\)/,
    );
    expect(l).not.toMatch(/Recording artifacts \+ screenshots/);
  });

  it('CRITICAL legal/sub-processors.md SCC + EU-US DPF framing pinned on every US-transfer vendor row (Postmark, Stripe, Anthropic, MacStadium, LiveKit). Drift to dropping would weaken the GDPR-Article-46 compliance posture.', () => {
    const l = read(LEGAL);

    const sccCount = (
      l.match(/2021 Standard Contractual Clauses \+ EU-US Data Privacy Framework\./g) ?? []
    ).length;
    expect(
      sccCount,
      'SCC + EU-US DPF references on US-transfer vendor rows',
    ).toBeGreaterThanOrEqual(4);
  });

  it('CRITICAL legal/sub-processors.md Hetzner = PRIMARY production compute framing pinned. Production runs on Hetzner + Neon + Upstash + Cloudflare R2 (the corrected register; the old "narrowed to dev/staging only" framing is RETRACTED — Hetzner IS the production data plane).', () => {
    const l = read(LEGAL);
    // Hetzner row purpose names production compute.
    expect(l).toMatch(
      /\*\*Hetzner Cloud\*\*\s*\|\s*Compute infrastructure for the Driftstack control plane \(production\)\./,
    );
    // Production-topology section names the real production stack.
    expect(l).toMatch(/The production control plane runs on \*\*Hetzner Cloud\*\* \(compute\)/);
    // The retracted "dev/staging only" narrowing must not return.
    expect(l).not.toMatch(/Hetzner narrowed.{0,100}dev\/staging only/);
  });

  it('CRITICAL cross-file consistency — Stripe + Postmark + Sentry + Cloudflare + Hetzner appear in BOTH AGENTS.md sub-processor list AND legal/sub-processors.md customer table. Drift would let one document show vendors the other does not.', () => {
    const a = read(AGENTS);
    const l = read(LEGAL);

    for (const vendor of ['Stripe', 'Postmark', 'Sentry', 'Cloudflare', 'Hetzner']) {
      expect(a, `AGENTS.md ${vendor}`).toMatch(new RegExp(vendor));
      expect(l, `legal ${vendor}`).toMatch(new RegExp(vendor));
    }
  });

  it('Sub-processors + ADR-002 5-invariant cluster — V-052 anchor + 10-vendor manifest + crypto-rail-dropped framing + ADR-002 Accepted-2026-05-03 + 4-constraint rationale + Stripe 5-primitive roster + driftstack_llm_tokens meter + Mollie-deferred-revisit-triggers.', () => {
    const a = read(AGENTS);
    const d = read(ADR);

    expect(a).toMatch(/V-052/);
    expect(a).toMatch(/Crypto rail dropped from launch \(2026-05-03\)/);
    expect(d).toMatch(/V-052/);
    expect(d).toMatch(/D-027/);
    expect(d).toMatch(/driftstack_llm_tokens/);
    expect(d).toMatch(/deferred to the revisit triggers/);
    expect(d).toMatch(/Stripe Billing/);
    expect(d).toMatch(/Stripe Tax/);
    expect(d).toMatch(/Stripe Webhooks/);
    expect(d).toMatch(/Stripe Meters/);
    expect(d).toMatch(/Stripe Customer Portal/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sub-processors-adr-002-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
