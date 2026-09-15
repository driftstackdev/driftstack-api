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
//   • Architecture: 'Your hardware, our software, one secure
//     connection.' + session content stays inside customer network
//     framing (2026-09-15: plain words, no 'control plane').
//   • 3-card When self-hosted makes sense: Privacy / Volume /
//     Sovereignty.
//   • 4-step process: Contact sales → Procure hardware → Onboard →
//     Run.
//   • Available now through a guided setup with the sales team, with
//     no GA/early-access/future-launch deferral.
//   • 'How many sessions can run at once depends on your hardware,
//     not your license.'

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
      /import \{\s*SELF_HOSTED_ARCHETYPE_UPDATES,\s*SELF_HOSTED_SKUS,\s*SELF_HOSTED_SOFTWARE_UPDATES,\s*SELF_HOSTED_SOURCE_ACCESS,\s*\} from '\.\.\/data\/pricing\.ts';/,
    );
  });

  it('HARDWARE_BY_SKU 3-tier map: each SKU recommends an Apple-Silicon class (Mac Mini M4 / Mac Studio M4 Max / Mac Studio Ultra | Mac Pro multi-node). Reframed 2026-05-XX to "Any Apple Silicon Mac (... recommended)" so customers know the sized-for guidance is a recommendation, not a hard requirement.', () => {
    expect(body).toMatch(
      // 2026-09-15 plain words: "sized for sustained concurrency" /
      // "Multi-node ... fleet" → what the buyer needs (a larger Mac for
      // many sessions at once / several Macs); same recommended models.
      /const HARDWARE_BY_SKU: Record<string, string> = \{\s*self_hosted_solo: 'Any Apple Silicon Mac \(Mac Mini M4 16 GB recommended\)',\s*self_hosted_pro: 'A larger Apple Silicon Mac for running many sessions at once \(Mac Studio M4 Max recommended\)',\s*self_hosted_enterprise: 'Several Apple Silicon Macs \(Mac Studio Ultra \/ Mac Pro recommended\)',\s*\};/,
    );
  });

  it("fmtSupportTier 3-state map: 2026-05-19 founder verdict dropped tiered SLA ladder (theatre for a small operation). All three states route to a single 48h best-effort target; email_slack_12h + dedicated_csm_1h surfaces add 'Email + Slack Connect' framing.", () => {
    expect(body).toMatch(/case 'email_48h':\s*return 'Email · 48h target';/);
    expect(body).toMatch(/case 'email_slack_12h':\s*return 'Email \+ Slack Connect · 48h target';/);
    expect(body).toMatch(
      /case 'dedicated_csm_1h':\s*return 'Email \+ Slack Connect · 48h target';/,
    );
  });

  it("fmtCustomArchetypeDev 3-state: none → '—' / limited → 'Limited (1/yr)' / unlimited → 'Unlimited' — pinned so the custom-archetype-dev offering stays consistent across SKUs (drift to dropping 'Limited (1/yr)' would change the Pro-tier promise; drift to changing the count would create marketing↔contract divergence)", () => {
    expect(body).toMatch(/case 'none':\s*return '—';/);
    expect(body).toMatch(/case 'limited':\s*return 'Limited \(1\/yr\)';/);
    expect(body).toMatch(/case 'unlimited':\s*return 'Unlimited';/);
  });

  it('pins current guided sales-led availability and rejects deferred-launch copy', () => {
    // 2026-09-15 plain words: same guided, sales-team-led setup with the
    // same four steps (fit check / plan / install / first live test).
    expect(body).toMatch(
      /Self-hosted is set up together with our sales team, step by step\.\s*We check that the work is a good fit, plan the hardware and\s*network, install and set up your deployment, and run a first\s*live test with your team\./,
    );
    expect(body).toMatch(/Available now through Contact Sales · scoped and supported directly/);
    expect(body).not.toMatch(
      /\bGA\b|generally available|early access|follows the API public launch|ships within/i,
    );
  });

  it("Architecture framing pinned: 'Your hardware, our software, one secure connection.' + 'Self-hosted is one piece of Driftstack software running on Mac hardware you own. Driftstack's coordination service starts and manages sessions, gives you the SDK + desktop app, and never holds what happens inside your sessions.' — pinned so the two-sided architecture + the 'we coordinate, you hold session content' division of responsibility survive (drift to dropping 'never holds' would weaken the privacy promise)", () => {
    // 2026-09-15 owner directive: "control plane" / "orchestration" are
    // banned on customer surfaces; the two-sided architecture and the
    // never-holds-content promise survive in plain words.
    expect(body).toMatch(/Your hardware, our software, one secure connection\./);
    expect(body).toMatch(
      /Driftstack's coordination service starts and\s+manages sessions and gives you the developer kit \(SDK\) and the\s+desktop app — and it never holds what happens inside your\s+sessions\./,
    );
  });

  it("Session-content-stays-inside-perimeter framing pinned: 'Session content (URLs, form data, captures, recordings) stays inside your network. Driftstack's control plane sees license + session metadata, never the session itself.' — pinned so the explicit 4-state scope (URLs / form data / captures / recordings) + the control-plane-sees-only-metadata commitment survive (drift to dropping the explicit scope would let customers question what 'session content' means)", () => {
    // S20c 2026-07-06 plain-language pass: metadata said plainly,
    // term kept in parens; 4-state scope + never-the-session survive.
    expect(body).toMatch(
      /Session content \(URLs, form data, captures, recordings\) stays inside\s+your network\. Driftstack sees only your license and basic session\s+details — when a session started, which profile ran — never the\s+session itself\./,
    );
  });

  it("3-card 'When self-hosted makes sense': Privacy (sessions never leave your network) + Volume (10 or more sessions at once, sustained through a month, break-even) + Sovereignty (own S3-compatible storage, no extra DPA) — pinned so the 3 motivators stay explicit (drift to dropping any would orphan customers needing that specific self-host driver: privacy-conscious / volume-driven / sovereignty-required)", () => {
    expect(body).toMatch(/Sessions never leave your network/);
    expect(body).toMatch(/Running many sessions at once, consistently/);
    expect(body).toMatch(/Full control over recordings and saved files/);
    expect(body).toMatch(/10 or more,\s+sustained through a whole month/);
  });

  it("4-step process: Contact sales (01) → Procure hardware (02) → Onboard (03) → Run (04) — pinned so the customer-facing onboarding sequence stays consistent (drift to dropping 'Procure hardware' would hide the customer-purchased model; drift to dropping 'Onboard joint smoke test' would lose the hands-on commitment that justifies the higher SKU price)", () => {
    expect(body).toMatch(
      /Contact sales<\/h3>\s*<p class="mt-2 text-sm text-tk-ink-2">\s*Email <a href="mailto:sales@driftstack\.dev"/,
    );
    expect(body).toMatch(/Procure hardware<\/h3>/);
    expect(body).toMatch(/Onboard<\/h3>/);
    // S20c 2026-07-06 plain-language pass: config field glossed as a
    // settings value; same one-change migration promise.
    expect(body).toMatch(
      /Same SDK as cloud Driftstack — change one setting and your\s+existing code talks to your own installation instead of our\s+cloud\./,
    );
  });

  it("'How many sessions can run at once depends on your hardware, not your license.' — pinned so the no-license-cap-on-self-hosted commitment survives (drift to dropping would let customers think self-hosted has the same concurrent caps as cloud SKUs; this is THE core unit-economics flip for high-volume customers)", () => {
    expect(body).toMatch(
      /How many sessions can run at once depends on your hardware, not your license\./,
    );
  });

  it("Architecture ASCII diagram framing pinned: 'YOUR MACS' + 'DRIFTSTACK SERVICE' columns + 'Sessions reach the web through your network' + 'Your network exit' (direct / VPN / your own SOCKS5 / OpenVPN / WireGuard). 2026-05-22 — diagram flipped 'roadmap: BYO' → shipped BYO per planning 133 Phase 1; 2026-09-15 — banned words (fleet / control plane / multi-node / orchestration / egress) and the DC/BYO/WG abbreviations left the diagram.", () => {
    expect(body).toMatch(/YOUR MACS\s+DRIFTSTACK SERVICE/);
    expect(body).toMatch(/Sessions reach the web through your network/);
    expect(body).toMatch(/SOCKS5 \//);
    expect(body).toMatch(/OpenVPN \//);
    expect(body).toMatch(/WireGuard\)/);
    expect(body).not.toMatch(/Mac fleet|Control plane|multi-node|ORCHESTRATION/);
  });

  it('CTA pair pins the tagged sales mailto and canonical pricing anchor through CtaBand props', () => {
    expect(body).toMatch(
      /primaryHref="mailto:sales@driftstack\.dev\?subject=Self-Hosted%20inquiry"\s*primaryLabel="Contact sales"/,
    );
    expect(body).toMatch(/secondaryHref="\/pricing\/#self-hosted"\s*secondaryLabel="See pricing"/);
    expect(body).not.toContain('secondaryHref="/pricing#self-hosted"');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
