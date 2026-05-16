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
  describe('F-2/F-5 "What sets us apart" product-differentiator 4-up strip (homepage)', () => {
    const body = read(INDEX);

    // 2026-05-16 F-2 (Issue 5) + F-5 (Issue 6) + F-7 (Issue 7): the
    // homepage strip was repurposed. Was: 4 compliance signals
    // (EU-resident / Stripe-billed / GDPR DPA / Source escrow) under
    // a "Pre-launch trust signals" eyebrow. Now: 4 product
    // differentiators (Bit-identical / Three proxies / Three access
    // paths / EU-hosted) under "What sets us apart". Vendor names
    // (Hetzner FSN / Neon EU / R2 EU) moved to /trust/sub-processors
    // per Issue 6. "Pre-launch" framing dropped per Issue 5.
    it('"What sets us apart" eyebrow + 4 fingerprint-leading differentiator labels pinned (Indistinguishable / Zero detection surface / Apple\'s WebKit not Chromium / API · SDK · GUI) — strip rewritten 2026-05-16 to lead with the canvas+WebGL-hash claim against competitors\' unique-per-session leakage', () => {
      expect(body).toMatch(/What sets us apart/);
      expect(body).not.toMatch(/Pre-launch trust signals/);
      expect(body).toMatch(
        /<span class="text-base font-semibold text-ink-primary">Indistinguishable<\/span>/,
      );
      expect(body).toMatch(
        /<span class="text-base font-semibold text-ink-primary">Zero detection surface<\/span>/,
      );
      expect(body).toMatch(
        /<span class="text-base font-semibold text-ink-primary">Apple's WebKit, not Chromium<\/span>/,
      );
      expect(body).toMatch(
        /<span class="text-base font-semibold text-ink-primary">API · SDK · GUI<\/span>/,
      );
    });

    it('Each differentiator-card sub-claim pinned (canvas+WebGL real-iPhone-population hash + no-runtime-JS-patching + Apple WebKit source + same engine 3 access paths)', () => {
      expect(body).toMatch(
        /Canvas \+ WebGL hashes match the real-iPhone population — not unique-per-session like every other API/,
      );
      expect(body).toMatch(/No runtime JS patching, no stealth bundle for fingerprinters to spot/);
      expect(body).toMatch(
        /Built from Apple's WebKit source — same engine your iOS users actually run/,
      );
      expect(body).toMatch(
        /TypeScript, Python, Go, or the dashboard — same engine, three access paths/,
      );
    });

    it('Vendor names removed from homepage splash strip per Issue 6 (moved to /trust/sub-processors)', () => {
      expect(body).not.toMatch(/Hetzner FSN · Neon EU · R2 EU/);
      expect(body).not.toMatch(/SCA \/ 3DS · 14-day window/);
      expect(body).not.toMatch(/Article 28\(2\) change-log/);
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

  describe('F-3 Footer signal strip — product-focused (replaced R7 compliance badges)', () => {
    const body = read(FOOTER);

    // 2026-05-16 F-3 (Issue 7): the original R7 compliance badge row
    // (Stripe-billed / GDPR-aware / EU-resident / Article 28(2)) was
    // replaced with product-focused differentiators on founder direction
    // — "footer splash position is for product signals, not paperwork."
    // Legal/compliance copy still lives at /trust + /legal pages and on
    // the consolidated meta-link row in the footer bottom.
    it('All 4 product-focused signals pinned (bit-identical iPhone Safari fingerprint + SOCKS5/WireGuard/OpenVPN proxies + API/SDK/GUI access + EU-hosted)', () => {
      expect(body).toMatch(/Bit-identical iPhone Safari fingerprint/);
      expect(body).toMatch(/SOCKS5 · WireGuard · OpenVPN proxies/);
      expect(body).toMatch(/API · SDK · GUI access/);
      expect(body).toMatch(/EU-hosted/);
    });

    it('R7 compliance badges no longer in footer splash position (moved to /trust + /legal)', () => {
      expect(body).not.toMatch(/Stripe-billed · SCA \/ 3DS/);
      expect(body).not.toMatch(/GDPR-aware · DPA on request/);
      expect(body).not.toMatch(/EU-resident infrastructure/);
      expect(body).not.toMatch(/Article 28\(2\) sub-processor change-log/);
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
