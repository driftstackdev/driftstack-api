// W370.C — drift guard for marketing-site /self-hosted page
// content. Existing self-hosted-sku-listing-baseline + self-
// hosted-sku-parity + self-hosted-skus-parity + self-hosted-
// narrative-baseline tests cover SKU shape parity to the
// pricing data source. This guard pins the load-bearing sales
// claims a procurement / security buyer reads:
//
//   • 3 SKUs come from SELF_HOSTED_SKUS data source (not hard-
//     coded on the page). A future inline-copy regression would
//     break the contract.
//   • Hardware-by-SKU mapping (Mac Mini M4 / Mac Studio M4 Max
//     / Mac Studio Ultra / Mac Pro / multi-node cluster).
//   • "Session content never leaves your perimeter" privacy
//     framing pinned — the load-bearing differentiator vs SaaS.
//   • Driftstack-side scope: "control plane sees license +
//     session metadata, never the session itself".
//   • 3 "when self-hosted is the right call" categories pinned
//     (Privacy / Volume / Sovereignty).
//   • 4-step process pinned (Contact sales / Procure hardware
//     / Onboard / Run) with sales@driftstack.dev contact.
//   • Softened GA framing pinned (S43 2026-07-07: "GA follows the
//     API public launch" — no dated commitment).
//   • Cross-link to /faq for procurement/compliance questions.
//   • ASCII architecture diagram present with secure-channel
//     callout.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/self-hosted.astro');
const PRICING_DATA = resolve(REPO_ROOT, 'apps/marketing-site/src/data/pricing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W370.C marketing-site /self-hosted page content parity', () => {
  const body = read(PAGE);

  it('SKUs come from SELF_HOSTED_SKUS data import (not inline-hardcoded)', () => {
    expect(body).toMatch(
      /import \{[\s\S]*?SELF_HOSTED_SKUS,[\s\S]*?\} from '\.\.\/data\/pricing\.ts';/,
    );
    expect(body).toMatch(/SELF_HOSTED_SKUS\.map\(\(sku\)/);
    expect(existsSync(PRICING_DATA)).toBe(true);
    expect(read(PRICING_DATA)).toContain('SELF_HOSTED_SKUS');
  });

  it('HARDWARE_BY_SKU map pinned: Solo / Pro / Enterprise recommend Apple Silicon (Mac Mini M4 / Mac Studio M4 Max / Mac Studio Ultra / Mac Pro multi-node). 2026-05-XX reframed to "Any Apple Silicon Mac (... recommended)" — the recommendation is guidance, not a hard requirement.', () => {
    expect(body).toMatch(
      /self_hosted_solo: 'Any Apple Silicon Mac \(Mac Mini M4 16 GB recommended\)'/,
    );
    expect(body).toMatch(
      /self_hosted_pro: 'Apple Silicon Mac sized for sustained concurrency \(Mac Studio M4 Max recommended\)'/,
    );
    expect(body).toMatch(
      /self_hosted_enterprise: 'Multi-node Apple Silicon fleet \(Mac Studio Ultra \/ Mac Pro recommended\)'/,
    );
  });

  it('"session content never leaves your perimeter" privacy framing pinned', () => {
    expect(body).toMatch(/Sessions never leave your perimeter/);
    // S20c 2026-07-06 plain-language pass: same 4-state scope + the
    // nothing-through-vendor-servers promise, plain words lead.
    expect(body).toMatch(
      /session content \(URLs, form data, captures,\s+recordings\) must never pass through anyone's servers but\s+your own/,
    );
  });

  it('control-plane scope claim pinned (sees license + metadata, never session itself)', () => {
    // S20c 2026-07-06 plain-language pass: metadata glossed inline.
    expect(body).toMatch(
      /Driftstack's control plane sees your license and\s+basic session details — when a session started, which profile\s+ran \(session metadata\) — never the session itself/,
    );
  });

  it('3 "when self-hosted is the right call" categories pinned (Privacy / Volume / Sovereignty). 2026-07-03 v2 re-skin — label tone moved to text-tk-accent-text (the AA-safe accent text token; raw --accent is a fill tone).', () => {
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-tk-accent-text">Privacy<\/p>/,
    );
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-tk-accent-text">Volume<\/p>/,
    );
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-tk-accent-text">Sovereignty<\/p>/,
    );
  });

  it('sustained-10+-concurrent break-even framing pinned (volume tier)', () => {
    expect(body).toMatch(/sustained 10\+ concurrent across the month/);
  });

  it('4-step process pinned (01 Contact sales / 02 Procure hardware / 03 Onboard / 04 Run)', () => {
    for (const step of [
      '<h3 class="mt-3 font-semibold text-tk-ink">Contact sales</h3>',
      '<h3 class="mt-3 font-semibold text-tk-ink">Procure hardware</h3>',
      '<h3 class="mt-3 font-semibold text-tk-ink">Onboard</h3>',
      '<h3 class="mt-3 font-semibold text-tk-ink">Run</h3>',
    ]) {
      expect(body, `step missing: ${step}`).toContain(step);
    }
  });

  it('sales@driftstack.dev contact + softened GA framing pinned (S43 2026-07-07: intent-without-deadline, no dated GA promise)', () => {
    expect(body).toMatch(/mailto:sales@driftstack\.dev\?subject=Self-Hosted%20inquiry/);
    // S43 2026-07-07 (founder-approved) — the dated "GA within 6
    // months of API public launch" commitment was softened to
    // intent-without-deadline; the dated form must not reappear.
    expect(body).toMatch(/Self-hosted GA follows the\s+API public launch/);
    expect(body).not.toMatch(/GA within 6 months/);
    expect(body).not.toMatch(/ships within 6 months/);
  });

  it('cross-link to /faq resolves (common-questions teaser section)', () => {
    expect(body).toMatch(/<a href="\/faq\/" class="btn-secondary">See FAQ<\/a>/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/faq.astro'))).toBe(true);
  });

  it('ASCII architecture diagram present with secure-channel callout', () => {
    expect(body).toMatch(/YOUR INFRA[\s\S]+?DRIFTSTACK ORCHESTRATION/);
    expect(body).toMatch(/Mac fleet/);
    expect(body).toMatch(/Control plane/);
    expect(body).toMatch(/secure ───/);
    expect(body).toMatch(/channel/);
    expect(body).toMatch(/\(HTTPS\)/);
  });

  it('egress posture pinned: WebKit sessions exit via your network (DC / VPN / BYO SOCKS5 + OpenVPN + WG). 2026-05-22 — "roadmap: BYO" flipped to shipped capability per planning 133 Phase 1.', () => {
    expect(body).toMatch(/WebKit sessions exit via your network/);
    expect(body).toMatch(/DC \/ VPN \//);
    expect(body).toMatch(/BYO SOCKS5 \+/);
    expect(body).toMatch(/OpenVPN \+ WG/);
  });

  it('"Concurrent capacity bounded by your hardware, not by license" pinned (cap framing)', () => {
    // Distinguishes self-hosted from SaaS — tier licensing
    // doesn't gate concurrent count on owned hardware.
    expect(body).toMatch(/Concurrent capacity is bounded by your hardware, not by license\./);
  });
});
