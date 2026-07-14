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
  describe('"What is Driftstack?" Band-B differentiator tiles (homepage)', () => {
    const body = read(INDEX);

    // v2 2026-07-03 ("Plain Words, Same Teeth"): the former "What sets us
    // apart" 4-up differentiator strip merged into the "What is Driftstack?"
    // band as <Stat> tiles — a big plain-language claim (plain) + the exact
    // technical descriptor demoted to a small mono line (technical). The
    // sub-claim TEXT survives verbatim in the technical props; the
    // "No runtime JS patching…" descriptor moved to the proof section's
    // Engine-deep card.
    it('4 Band-B Stat tiles under "What is Driftstack?" (plain claim + technical descriptor), operators-first plain labels', () => {
      expect(body).toMatch(/What is Driftstack\?/);
      expect(body).not.toMatch(/Pre-launch trust signals/);
      expect(body).not.toMatch(/What sets us apart/);
      expect(body).toMatch(/plain="A real iPhone, not a lookalike"/);
      expect(body).toMatch(/plain="Looks human to every website"/);
      expect(body).toMatch(/plain="Drive it three ways"/);
      expect(body).toMatch(/plain="Any country you need"/);
    });

    it("differentiator sub-claims preserved in the Stat technical props (S20b 2026-07-06 plain-language pass: same facts — canvas+WebGL population-matched hashes glossed as the hidden 'device photos' sites take, Apple WebKit source code glossed as the engine inside every iPhone's Safari, code-or-dashboard access paths); the injects-nothing descriptor lives in the proof section Engine-deep card", () => {
      expect(body).toMatch(
        /The hidden 'device photos' sites take to spot fakes \(canvas \+ WebGL hashes\) match millions of real iPhones — not a new unique value per session like every other API/,
      );
      expect(body).toMatch(/Driftstack injects nothing, so there's nothing to find\./);
      expect(body).toMatch(
        /Built from Apple's WebKit source code — the engine inside every iPhone's Safari, the same one your iOS users run/,
      );
      expect(body).toMatch(
        /From code — TypeScript, Python, or Go — or point-and-click from the dashboard\. Same engine either way/,
      );
    });

    it('Vendor names stay off the homepage splash (moved to /trust/sub-processors/)', () => {
      expect(body).not.toMatch(/Hetzner FSN · Neon EU · R2 EU/);
      expect(body).not.toMatch(/SCA \/ 3DS · 14-day window/);
      expect(body).not.toMatch(/Article 28\(2\) change-log/);
    });
  });

  describe('R7 → R9 "Built by engineers" design-partner band (homepage)', () => {
    const body = read(INDEX);

    it('R9 capability-led headline pinned ("Built by engineers, not a growth team.") + "people who write the WebKit patches" body copy', () => {
      expect(body).toMatch(/Built by engineers, not a growth team\./);
      expect(body).toMatch(
        /Driftstack is built by the people who write the WebKit\s*\n?\s*patches/,
      );
      expect(body).toMatch(
        /no\s*\n?\s*cold-outreach sales team \(SDRs\), no upsell ladder, no product direction\s*\n?\s*chosen by investors/,
      );
      expect(body).not.toMatch(/roadmap chosen/i);
    });

    it('3-card posture grid pinned (Design partner direct-engineer-access + Honest pricing one-concurrent-metric + Sovereignty your-account-data-stays-in-EU) — each card has its eyebrow label + headline + sub-processors cross-link in the Sovereignty card. S30 2026-07-07 (founder decision: soften): the Sovereignty card title scoped to "Your account data" and the body discloses that R2-held uploaded files can replicate outside the EU.', () => {
      expect(body).toMatch(/Design partner/);
      expect(body).toMatch(/Direct engineer access/);
      expect(body).toMatch(/Honest pricing/);
      expect(body).toMatch(/One concurrent metric/);
      expect(body).toMatch(/Sovereignty/);
      expect(body).toMatch(/Your account data stays in the EU/);
      expect(body).toMatch(
        /uploaded files use Cloudflare's storage network,\s*\n?\s*which can replicate outside the EU/,
      );
      expect(body).toMatch(/href="\/trust\/sub-processors\/"/);
      expect(body).not.toMatch(/href="\/trust\/sub-processors"/);
      // S30 negative pin — the blanket card title must not return.
      expect(body).not.toMatch(/Card title="Your data stays in the EU"/);
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
      expect(body).toMatch(/<p class="mt-2 text-sm font-semibold text-tk-ink">TypeScript<\/p>/);
      expect(body).toMatch(/@driftstack\/sdk/);
      expect(body).toMatch(/<p class="mt-2 text-sm font-semibold text-tk-ink">Python<\/p>/);
      expect(body).toMatch(/driftstack-sdk/);
      expect(body).toMatch(/<p class="mt-2 text-sm font-semibold text-tk-ink">Go<\/p>/);
      expect(body).toMatch(/driftstack-go/);
    });

    it('3 "via API" orchestration cards pinned (Playwright + n8n · Make + curl · cron)', () => {
      expect(body).toMatch(/<p class="mt-2 text-sm font-semibold text-tk-ink">Playwright<\/p>/);
      expect(body).toMatch(/drives sessions/);
      expect(body).toMatch(/<p class="mt-2 text-sm font-semibold text-tk-ink">n8n · Make<\/p>/);
      expect(body).toMatch(/workflow nodes/);
      expect(body).toMatch(/<p class="mt-2 text-sm font-semibold text-tk-ink">curl · cron<\/p>/);
      expect(body).toMatch(/plain HTTPS/);
    });
  });

  describe('R8 "What detection systems see" fingerprint check matrix (homepage)', () => {
    const body = read(INDEX);

    it('Section eyebrow + headline pinned ("Same signals as a physical iPhone. Not \\"close enough\\".") + canonical /trust/security-overview/ cross-link for the live posture', () => {
      expect(body).toMatch(/What detection systems see/);
      expect(body).toMatch(/Same signals as a physical iPhone\. Not "close enough"\./);
      expect(body).toMatch(/href="\/trust\/security-overview\/"/);
      expect(body).not.toMatch(/href="\/trust\/security-overview"/);
    });

    it('7-signal table rows pinned (User-agent / Canvas hash / WebGL renderer / Audio fingerprint (AudioContext) / Core Text metrics / JavaScript engine timing / Fingerprint across sessions — the 7th row added 2026-05-16 to make the population-stable claim concrete; S20b 2026-07-06 plain-language labels) + Driftstack-column values + population-stable footnote', () => {
      // Left-column signal names.
      expect(body).toMatch(/<span class="text-tk-ink">User-agent<\/span>/);
      expect(body).toMatch(/<span class="text-tk-ink">Canvas hash<\/span>/);
      expect(body).toMatch(/<span class="text-tk-ink">WebGL renderer<\/span>/);
      expect(body).toMatch(/<span class="text-tk-ink">Audio fingerprint \(AudioContext\)<\/span>/);
      expect(body).toMatch(/<span class="text-tk-ink">Core Text metrics<\/span>/);
      expect(body).toMatch(/<span class="text-tk-ink">JavaScript engine timing<\/span>/);
      expect(body).toMatch(/<span class="text-tk-ink">Fingerprint across sessions<\/span>/);
      // Right-column Driftstack values — concrete brand/engine references.
      expect(body).toMatch(/Apple GPU/);
      expect(body).toMatch(/JSCore/);
      expect(body).toMatch(/population-stable/);
      // S20b: the plain-language footnote decoding the load-bearing row.
      expect(body).toMatch(/population-stable = the same value millions of real iPhones/);
    });

    it("Stealth-Chromium comparison column pinned (spoofed user-agent / 3x leaks Chromium / leaks system / Chrome's V8 / 100% unique hashes per session — the explicit fingerprint-uniqueness contrast added 2026-05-16)", () => {
      expect(body).toMatch(/Stealth Chromium/);
      expect(body).toMatch(/leaks Chromium/);
      expect(body).toMatch(/Chrome's V8/);
      expect(body).toMatch(/100% unique/);
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
      expect(body).toMatch(/UDP \/ QUIC \/ WebRTC tunnelling/);
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

    it('Fleet L2 mark pinned (founder-picked 2026-06-12; rebranded to oxblood 2026-06-16): ink-outline back layer (stroke #474a55 @ .55, rotate -7) + oxblood #9b3b46 flat-filled front layer + white home-indicator dot — flat fills so the mark stays crisp at favicon sizes', () => {
      expect(svg).toMatch(/stroke="#474a55" stroke-width="14" opacity="0\.55"/);
      expect(svg).toMatch(/transform="rotate\(-7 105 127\)"/);
      expect(svg).toMatch(/<rect x="86" y="30" width="118" height="194" rx="34" fill="#9b3b46"\/>/);
      expect(svg).toMatch(/<circle cx="145" cy="192" r="12" fill="#ffffff"\/>/);
      // the old gradient/glow-filter internals must be GONE (flat-fill commitment)
      expect(svg).not.toMatch(/<linearGradient/);
      expect(svg).not.toMatch(/<filter/);
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
