// W500.B — drift guard for apps/marketing-site/src/pages/self-hosted.astro.
// /self-hosted SKU + onboarding page. Drift here either drops the
// HARDWARE_BY_SKU 3-tier map (would render a SKU card with no
// hardware spec) or breaks the architecture-diagram framing
// ('session content stays inside your network') which is the core
// privacy promise self-hosted customers buy on.
//
//   • Sourced SELF_HOSTED_SKUS + SELF_HOSTED_SOFTWARE_UPDATES +
//     SELF_HOSTED_ARCHETYPE_UPDATES + SELF_HOSTED_SOURCE_ACCESS
//     from pricing.ts.
//   • HARDWARE_BY_SKU 3-tier map: self_hosted_solo → Mac Mini M4 16GB
//     / self_hosted_pro → Mac Studio M4 Max / self_hosted_enterprise →
//     Mac Studio Ultra / Mac Pro / multi-node.
//   • Support tier 3-state formatter: email_48h / email_slack_12h /
//     dedicated_csm_1h.
//   • Custom-archetype-dev 3-state: none / limited (1/yr) / unlimited.
//   • Architecture: 'Two boxes. One secure channel.' + session
//     content stays inside customer network framing.
//   • 3-card When self-hosted makes sense: Privacy / Volume /
//     Sovereignty.
//   • 4-step process: Contact sales → Procure hardware → Onboard →
//     Run.
//   • 'Available Contact Sales from day 0. Self-hosted GA follows
//     the API public launch.' (S43 2026-07-07 softening — was 'within 6
//     months of API public launch.'
//   • 'Concurrent capacity is bounded by your hardware, not by
//     license.'

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/self-hosted.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W500.B apps/marketing-site/src/pages/self-hosted.astro content parity', () => {
  const body = read(LIB);

  it('4-import set from pricing.ts: SELF_HOSTED_ARCHETYPE_UPDATES + SELF_HOSTED_SKUS + SELF_HOSTED_SOFTWARE_UPDATES + SELF_HOSTED_SOURCE_ACCESS — pinned so the SKU descriptor data stays sourced from the canonical pricing.ts (drift to hardcoding here would diverge from the marketing-site pricing page when the SKU table changes)', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*SELF_HOSTED_ARCHETYPE_UPDATES,\s*\n?\s*SELF_HOSTED_SKUS,\s*\n?\s*SELF_HOSTED_SOFTWARE_UPDATES,\s*\n?\s*SELF_HOSTED_SOURCE_ACCESS,\s*\n?\s*\} from '\.\.\/data\/pricing\.ts';/,
    );
  });

  it('HARDWARE_BY_SKU 3-tier map: each SKU recommends an Apple-Silicon class (Mac Mini M4 / Mac Studio M4 Max / Mac Studio Ultra | Mac Pro multi-node). Reframed 2026-05-XX to "Any Apple Silicon Mac (... recommended)" so customers know the sized-for guidance is a recommendation, not a hard requirement.', () => {
    expect(body).toMatch(
      /const HARDWARE_BY_SKU: Record<string, string> = \{\s*\n?\s*self_hosted_solo: 'Any Apple Silicon Mac \(Mac Mini M4 16 GB recommended\)',\s*\n?\s*self_hosted_pro: 'Apple Silicon Mac sized for sustained concurrency \(Mac Studio M4 Max recommended\)',\s*\n?\s*self_hosted_enterprise: 'Multi-node Apple Silicon fleet \(Mac Studio Ultra \/ Mac Pro recommended\)',\s*\n?\s*\};/,
    );
  });

  it("fmtSupportTier 3-state map: 2026-05-19 founder verdict dropped tiered SLA ladder (theatre for a small operation). All three states route to a single 48h best-effort target; email_slack_12h + dedicated_csm_1h surfaces add 'Email + Slack Connect' framing.", () => {
    expect(body).toMatch(/case 'email_48h':\s*\n?\s*return 'Email · 48h target';/);
    expect(body).toMatch(
      /case 'email_slack_12h':\s*\n?\s*return 'Email \+ Slack Connect · 48h target';/,
    );
    expect(body).toMatch(
      /case 'dedicated_csm_1h':\s*\n?\s*return 'Email \+ Slack Connect · 48h target';/,
    );
  });

  it("fmtCustomArchetypeDev 3-state: none → '—' / limited → 'Limited (1/yr)' / unlimited → 'Unlimited' — pinned so the custom-archetype-dev offering stays consistent across SKUs (drift to dropping 'Limited (1/yr)' would change the Pro-tier promise; drift to changing the count would create marketing↔contract divergence)", () => {
    expect(body).toMatch(/case 'none':\s*\n?\s*return '—';/);
    expect(body).toMatch(/case 'limited':\s*\n?\s*return 'Limited \(1\/yr\)';/);
    expect(body).toMatch(/case 'unlimited':\s*\n?\s*return 'Unlimited';/);
  });

  it('GA framing pinned (S43 2026-07-07, founder-approved softening): \'Available "Contact Sales" from day 0. Self-hosted GA follows the API public launch.\' — intent-without-deadline replaces the dated "within 6 months" commitment; the contact-sales-day-0 promise stays explicit and the dated form must not reappear', () => {
    expect(body).toMatch(
      /Available "Contact Sales" from day 0\. Self-hosted GA follows the\s*\n?\s*API public launch\./,
    );
    expect(body).not.toMatch(/GA within 6 months/);
    expect(body).not.toMatch(/ships within 6 months/);
  });

  it("Architecture framing pinned: 'Two boxes. One secure channel. Your hardware, our orchestration.' + 'Self-hosted is one piece of Driftstack software running on Mac hardware you own. The control plane orchestrates sessions, exposes the SDK + GUI, and never holds your session content.' — pinned so the two-box architecture metaphor + the 'we orchestrate, you hold session content' division of responsibility survive (drift to dropping 'never holds your session content' would weaken the privacy promise)", () => {
    expect(body).toMatch(/Two boxes\. One secure channel\. Your hardware, our orchestration\./);
    // S20c 2026-07-06 plain-language pass: control plane glossed as
    // "Driftstack's coordination service"; the never-holds-content
    // promise survives verbatim-in-intent.
    expect(body).toMatch(
      /Driftstack's coordination service \(the\s+"control plane"\) starts and manages sessions and gives you the\s+developer kit \(SDK\) and the desktop app \(GUI\) — and it never\s+holds what happens inside your sessions\./,
    );
  });

  it("Session-content-stays-inside-perimeter framing pinned: 'Session content (URLs, form data, captures, recordings) stays inside your network. Driftstack's control plane sees license + session metadata, never the session itself.' — pinned so the explicit 4-state scope (URLs / form data / captures / recordings) + the control-plane-sees-only-metadata commitment survive (drift to dropping the explicit scope would let customers question what 'session content' means)", () => {
    // S20c 2026-07-06 plain-language pass: metadata said plainly,
    // term kept in parens; 4-state scope + never-the-session survive.
    expect(body).toMatch(
      /Session content \(URLs, form data, captures, recordings\) stays inside\s+your network\. Driftstack's control plane sees your license and\s+basic session details — when a session started, which profile\s+ran \(session metadata\) — never the session itself\./,
    );
  });

  it("3-card 'When self-hosted makes sense': Privacy (sessions never leave perimeter) + Volume (sustained 10+ concurrent break-even) + Sovereignty (own R2-compatible storage, no DPA addendum) — pinned so the 3 motivators stay explicit (drift to dropping any would orphan customers needing that specific self-host driver: privacy-conscious / volume-driven / sovereignty-required)", () => {
    expect(body).toMatch(/Sessions never leave your perimeter/);
    expect(body).toMatch(/Sustained high-concurrency operations/);
    expect(body).toMatch(/Full control over recordings \+ state/);
    expect(body).toMatch(/sustained 10\+ concurrent across the month/);
  });

  it("4-step process: Contact sales (01) → Procure hardware (02) → Onboard (03) → Run (04) — pinned so the customer-facing onboarding sequence stays consistent (drift to dropping 'Procure hardware' would hide the customer-purchased model; drift to dropping 'Onboard joint smoke test' would lose the hands-on commitment that justifies the higher SKU price)", () => {
    expect(body).toMatch(
      /Contact sales<\/h3>\s*\n?\s*<p class="mt-2 text-sm text-tk-ink-2">\s*\n?\s*Email <a href="mailto:sales@driftstack\.dev"/,
    );
    expect(body).toMatch(/Procure hardware<\/h3>/);
    expect(body).toMatch(/Onboard<\/h3>/);
    // S20c 2026-07-06 plain-language pass: config field glossed as a
    // settings value; same one-change migration promise.
    expect(body).toMatch(
      /Same SDK as cloud Driftstack — change one settings value \(a\s+config field\) and your\s+existing code talks to your own installation instead of our\s+cloud\./,
    );
  });

  it("'Concurrent capacity is bounded by your hardware, not by license.' — pinned so the no-license-cap-on-self-hosted commitment survives (drift to dropping would let customers think self-hosted has the same concurrent caps as cloud SKUs; this is THE core unit-economics flip for high-volume customers)", () => {
    expect(body).toMatch(/Concurrent capacity is bounded by your hardware, not by license\./);
  });

  it("Architecture ASCII diagram framing pinned: 'YOUR INFRA' + 'DRIFTSTACK ORCHESTRATION' columns + 'WebKit sessions exit via your network' + 'Your network egress' (DC / VPN / BYO SOCKS5 + OpenVPN + WG). 2026-05-22 — diagram flipped 'roadmap: BYO' → shipped BYO per planning 133 Phase 1.", () => {
    expect(body).toMatch(/YOUR INFRA\s+DRIFTSTACK ORCHESTRATION/);
    expect(body).toMatch(/WebKit sessions exit via your network/);
    expect(body).toMatch(/BYO SOCKS5 \+/);
    expect(body).toMatch(/OpenVPN \+ WG/);
  });

  it("CTA pair pinned: 'Contact sales' → mailto:sales@driftstack.dev?subject=Self-Hosted%20inquiry (primary) + 'See pricing' → /pricing#self-hosted (secondary) — pinned so the conversion path stays consistent (drift to dropping the URL-encoded subject would lose the routing tag self-hosted-tagged inquiries get)", () => {
    expect(body).toMatch(/mailto:sales@driftstack\.dev\?subject=Self-Hosted%20inquiry/);
    expect(body).toMatch(/<a href="\/pricing#self-hosted" class="btn-secondary">See pricing<\/a>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
