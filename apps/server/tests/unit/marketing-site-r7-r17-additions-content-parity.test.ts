// W627 — drift guard for the R7-R17 customer-facing additions to the
// marketing-site homepage + footer + brand asset. The R-series visual
// redesign added several load-bearing sections that were not pinned
// by the original W500.C / W371.A homepage parity guards:
//
//   • R7 — "Pre-launch trust signals" 4-up strip (EU-resident /
//     Stripe-billed / GDPR DPA / Source escrow) just below the hero.
//   • R7 — Footer compliance strip (Stripe-billed · SCA/3DS +
//     GDPR-aware + EU-resident + Article 28(2) sub-processor
//     change-log) sitting above the copyright line.
//   • R7 → R9 — "Built by engineers, not a growth team." design-
//     partner band with 3-card posture grid (Direct engineer access
//     / Honest pricing / Sovereignty). R9 swapped the prior
//     "operators / 20-person growth team" framing for the
//     capability-led copy that survives today.
//   • R8 — "Works with your stack" integrations strip with 3 SDK
//     cards (TypeScript / Python / Go) + 3 "via API" cards
//     (Playwright / n8n+Make / curl+cron).
//   • R8 — "What detection systems see" fingerprint check matrix
//     (6-signal table: User-agent / Canvas hash / WebGL renderer /
//     AudioContext / Core Text metrics / JS engine timing) — the
//     visual product-vs-competitor differentiator.
//   • R15 + R17 — Brand SVG asset (driftstack-mark.svg) shipped under
//     apps/marketing-site/public/. R17 added the oxblood→glow-red
//     vertical gradient + red drop-shadow halo and the ?v=2 cache-
//     bust to break the 24h Cloudflare edge cache.
//
// Drift on any of these would silently regress the customer-facing
// conversion surface — a future copy refactor that drops the trust
// strip would lose the at-a-glance EU/Stripe/GDPR signals that
// serious buyers anchor on; a regression in the fingerprint matrix
// would lose the visual product differentiator.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const INDEX = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/index.astro');
const FOOTER = resolve(REPO_ROOT, 'apps/marketing-site/src/components/Footer.astro');
const MARK_SVG = resolve(REPO_ROOT, 'apps/marketing-site/public/driftstack-mark.svg');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W627 R7-R17 marketing additions content parity', () => {
  describe('R7 Pre-launch trust signals 4-up strip (homepage)', () => {
    const body = read(INDEX);

    it('"Pre-launch trust signals" eyebrow + 4 trust-card labels pinned (EU-resident / Stripe-billed / GDPR DPA / Source escrow)', () => {
      expect(body).toMatch(/Pre-launch trust signals/);
      expect(body).toMatch(
        /<span class="text-base font-semibold text-ink-primary">EU-resident<\/span>/,
      );
      expect(body).toMatch(
        /<span class="text-base font-semibold text-ink-primary">Stripe-billed<\/span>/,
      );
      expect(body).toMatch(
        /<span class="text-base font-semibold text-ink-primary">GDPR DPA<\/span>/,
      );
      expect(body).toMatch(
        /<span class="text-base font-semibold text-ink-primary">Source escrow<\/span>/,
      );
    });

    it('Each trust-card sub-claim pinned (Hetzner FSN · Neon EU · R2 EU + SCA/3DS · 14-day window + Article 28(2) change-log + Enterprise + Self-hosted)', () => {
      expect(body).toMatch(/Hetzner FSN · Neon EU · R2 EU/);
      expect(body).toMatch(/SCA \/ 3DS · 14-day window/);
      expect(body).toMatch(/Article 28\(2\) change-log/);
      expect(body).toMatch(/Enterprise \+ Self-hosted/);
    });
  });

  describe('R7 → R9 "Built by engineers" design-partner band (homepage)', () => {
    const body = read(INDEX);

    it('R9 capability-led headline pinned ("Built by engineers, not a growth team." replaces the prior "operators / 20-person growth team" framing) + "people who write the WebKit patches" body copy', () => {
      expect(body).toMatch(/Built by engineers, not a growth team\./);
      expect(body).toMatch(
        /Driftstack is built by the people who write the WebKit\s*\n?\s*patches/,
      );
      expect(body).toMatch(/no SDR machine, no upsell ladder, no roadmap chosen/);
    });

    it('3-card posture grid pinned (Design partner direct-engineer-access + Honest pricing one-concurrent-metric + Sovereignty your-data-stays-in-EU) — each card has its eyebrow label + headline + sub-processors cross-link in the Sovereignty card', () => {
      expect(body).toMatch(/Design partner/);
      expect(body).toMatch(/Direct engineer access/);
      expect(body).toMatch(/Honest pricing/);
      expect(body).toMatch(/One concurrent metric/);
      expect(body).toMatch(/Sovereignty/);
      expect(body).toMatch(/Your data stays in the EU/);
      expect(body).toMatch(/href="\/trust\/sub-processors"/);
    });
  });

  describe('R8 "Works with your stack" integrations strip (homepage)', () => {
    const body = read(INDEX);

    it('Section eyebrow + headline pinned ("Three SDKs. One HTTPS API. Slots into anything.") + curl/cron example in the body', () => {
      expect(body).toMatch(/Works with your stack/);
      expect(body).toMatch(/Three SDKs\. One HTTPS API\. Slots into anything\./);
      expect(body).toMatch(
        /Playwright tests, n8n\s*\n?\s*workflows, Make\.com scenarios, Zapier triggers/,
      );
    });

    it('3 first-party SDK cards pinned (TypeScript @driftstack/sdk + Python driftstack-sdk + Go driftstack-go)', () => {
      expect(body).toMatch(
        /<p class="mt-2 text-sm font-semibold text-ink-primary">TypeScript<\/p>/,
      );
      expect(body).toMatch(/@driftstack\/sdk/);
      expect(body).toMatch(/<p class="mt-2 text-sm font-semibold text-ink-primary">Python<\/p>/);
      expect(body).toMatch(/driftstack-sdk/);
      expect(body).toMatch(/<p class="mt-2 text-sm font-semibold text-ink-primary">Go<\/p>/);
      expect(body).toMatch(/driftstack-go/);
    });

    it('3 "via API" orchestration cards pinned (Playwright + n8n · Make + curl · cron)', () => {
      expect(body).toMatch(
        /<p class="mt-2 text-sm font-semibold text-ink-primary">Playwright<\/p>/,
      );
      expect(body).toMatch(/drives sessions/);
      expect(body).toMatch(
        /<p class="mt-2 text-sm font-semibold text-ink-primary">n8n · Make<\/p>/,
      );
      expect(body).toMatch(/workflow nodes/);
      expect(body).toMatch(
        /<p class="mt-2 text-sm font-semibold text-ink-primary">curl · cron<\/p>/,
      );
      expect(body).toMatch(/plain HTTPS/);
    });
  });

  describe('R8 "What detection systems see" fingerprint check matrix (homepage)', () => {
    const body = read(INDEX);

    it('Section eyebrow + headline pinned ("Same signals as a physical iPhone. Not \\"close enough\\".") + /trust/security-overview cross-link for the live posture', () => {
      expect(body).toMatch(/What detection systems see/);
      expect(body).toMatch(/Same signals as a physical iPhone\. Not "close enough"\./);
      expect(body).toMatch(/href="\/trust\/security-overview"/);
    });

    it('6-signal table rows pinned (User-agent / Canvas hash / WebGL renderer / AudioContext / Core Text metrics / JS engine timing) + 6 Driftstack-column values', () => {
      // Left-column signal names.
      expect(body).toMatch(/<span class="text-ink-primary">User-agent<\/span>/);
      expect(body).toMatch(/<span class="text-ink-primary">Canvas hash<\/span>/);
      expect(body).toMatch(/<span class="text-ink-primary">WebGL renderer<\/span>/);
      expect(body).toMatch(/<span class="text-ink-primary">AudioContext<\/span>/);
      expect(body).toMatch(/<span class="text-ink-primary">Core Text metrics<\/span>/);
      expect(body).toMatch(/<span class="text-ink-primary">JS engine timing<\/span>/);
      // Right-column Driftstack values — concrete brand/engine references.
      expect(body).toMatch(/Apple GPU/);
      expect(body).toMatch(/JSCore/);
    });

    it('Stealth-Chromium comparison column pinned (spoofed user-agent / 3x leaks Chromium / leaks system / V8 fingerprint) — the contrast that makes the matrix visually load-bearing', () => {
      expect(body).toMatch(/Stealth Chromium/);
      expect(body).toMatch(/leaks Chromium/);
      expect(body).toMatch(/V8 fingerprint/);
    });
  });

  describe('R7 Footer trust strip (compliance signals above the copyright)', () => {
    const body = read(FOOTER);

    it('All 4 footer trust signals pinned (Stripe-billed · SCA/3DS + GDPR-aware · DPA on request + EU-resident infrastructure + Article 28(2) sub-processor change-log)', () => {
      expect(body).toMatch(/Stripe-billed · SCA \/ 3DS/);
      expect(body).toMatch(/GDPR-aware · DPA on request/);
      expect(body).toMatch(/EU-resident infrastructure/);
      expect(body).toMatch(/Article 28\(2\) sub-processor change-log/);
    });

    it('R7 trust-strip doc-comment pinned (placement rationale: "just above the copyright so prospects who scroll the full footer see the trust band before they leave")', () => {
      expect(body).toMatch(/R7 — Trust strip\. Outseta-style row of compliance\/payment/);
      expect(body).toMatch(
        /so prospects who scroll the full footer see the trust band\s*\n?\s*before they leave/,
      );
    });
  });

  describe('R15 + R17 brand SVG asset (driftstack-mark.svg)', () => {
    const svg = read(MARK_SVG);

    it('SVG file exists at canonical path apps/marketing-site/public/ + 256×256 viewBox', () => {
      expect(existsSync(MARK_SVG)).toBe(true);
      expect(svg).toMatch(/<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 256 256"/);
      expect(svg).toMatch(/aria-label="Driftstack logo"/);
    });

    it('R17 vertical gradient stops pinned (oxblood-600 #8d2c3e top → oxblood-500 #a83b4d mid → glow-red #e23847 bottom) — replaces the R15 flat-oxblood fill="#722F37"', () => {
      expect(svg).toMatch(/<linearGradient id="d-grad"/);
      expect(svg).toMatch(/<stop offset="0%" stop-color="#8d2c3e"\/>/);
      expect(svg).toMatch(/<stop offset="55%" stop-color="#a83b4d"\/>/);
      expect(svg).toMatch(/<stop offset="100%" stop-color="#e23847"\/>/);
    });

    it('R17 red drop-shadow glow filter pinned (gaussian-blur stdDeviation=3 + dy=2 + flood-color glow-red 0.45 alpha) — the halo that gives the mark visual punch against the dark surface', () => {
      expect(svg).toMatch(/<filter id="d-glow"/);
      expect(svg).toMatch(/<feGaussianBlur in="SourceAlpha" stdDeviation="3"\/>/);
      expect(svg).toMatch(/<feOffset dx="0" dy="2"/);
      expect(svg).toMatch(/<feFlood flood-color="#e23847" flood-opacity="0\.45"\/>/);
    });

    it('Path uses even-odd fill rule + url(#d-grad) gradient fill + url(#d-glow) filter — so the inner iPhone shape punches transparent and any surface shows through', () => {
      expect(svg).toMatch(/fill="url\(#d-grad\)"/);
      expect(svg).toMatch(/fill-rule="evenodd"/);
      expect(svg).toMatch(/filter="url\(#d-glow\)"/);
    });

    it('iPhone-shaped inner counter path commands pinned (notch-detail control points at y=52/56/60 that define the speaker-and-camera cutout at the top of the inner silhouette)', () => {
      // The 4 control points at lines `L 130 52 / 132 60 / 152 60 / 158 52`
      // define the notch dip. Pinning these specific coordinates so a
      // future SVG edit that drops the notch breaks the test.
      expect(svg).toMatch(/L 130 52/);
      expect(svg).toMatch(/132 60/);
      expect(svg).toMatch(/152 60/);
      expect(svg).toMatch(/158 52/);
    });

    it("Brand SVG mirrored byte-identical across all 5 apps (marketing-site + customer-dashboard + docs + status-site + admin-panel) — so a brand-asset update can't silently diverge between sites", () => {
      const apps = ['marketing-site', 'customer-dashboard', 'docs', 'status-site', 'admin-panel'];
      const hashes = new Set<string>();
      for (const app of apps) {
        const p = resolve(REPO_ROOT, `apps/${app}/public/driftstack-mark.svg`);
        expect(existsSync(p), `missing driftstack-mark.svg in apps/${app}/public/`).toBe(true);
        hashes.add(read(p));
      }
      expect(
        hashes.size,
        'driftstack-mark.svg content must be byte-identical across all 5 apps',
      ).toBe(1);
    });
  });
});
