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
//     framing (2026-09-15: plain words, no 'control plane'; the same
//     day the deployment model was corrected — the customer runs the
//     Driftstack server on their own Macs, so no Driftstack-hosted
//     service and no license / session-detail reporting is described).
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
const PRICING_PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro');

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

  it("fmtSupportTier 3-state map: Solo and Pro state the support channel plus the operational 48h target (Terms §9.1 — no contractual SLA); Self-Hosted Enterprise (dedicated_csm_1h) states the grant pricing.ts gives the Enterprise tier — a dedicated account manager and the contractual 1h first-reply SLA on Severity-1 incidents (Terms §9.2). 2026-09-15: until then all three SKUs rendered the same '48h target' string, contradicting pricing.ts and the /pricing Enterprise row.", () => {
    expect(body).toMatch(/case 'email_48h':\s*return 'Email · 48h target';/);
    expect(body).toMatch(/case 'email_slack_12h':\s*return 'Email \+ Slack Connect · 48h target';/);
    expect(body).toMatch(
      /case 'dedicated_csm_1h':\s*return 'Dedicated account manager · 1h SLA for first reply on critical \(Severity-1\) incidents';/,
    );
    // The under-claim must not return: the SKU whose data says 1h Sev-1
    // rendered as a 48h target for two months.
    expect(body).not.toMatch(
      /case 'dedicated_csm_1h':\s*return 'Email \+ Slack Connect · 48h target';/,
    );
    // The page glosses "target" vs "SLA" the same way /pricing does.
    expect(body).toMatch(
      /"Target" is the reply time we aim for, not a contractual promise\s+\(Terms §9\.1\)\. "SLA" is a contractual promise: on Self-Hosted\s+Enterprise it covers our first reply to the most serious\s+\("Severity-1"\) incidents \(Terms §9\.2\)\./,
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
    // 2026-09-15 refuter: apps/docs license-activation.md, Terms §3 and the
    // self-hosted runbook all have the customer running the Driftstack
    // server; no code implements a Driftstack-hosted coordination service
    // for self-hosted deployments, so the paragraph now names what runs on
    // the customer's Macs and what Driftstack supplies.
    expect(body).toMatch(/Your hardware, our software, one secure connection\./);
    expect(body).toMatch(
      /Self-hosted is the whole of Driftstack running on Mac hardware\s+you own: the server that starts and manages sessions, the desktop\s+app pointed at it, and the sessions themselves\. We supply the\s+software, its updates and new device profiles, and the developer\s+kit \(SDK\) — and we never hold what happens inside your sessions\./,
    );
    expect(body).not.toMatch(
      /coordination service|Driftstack hosts the service|you supply the machines/,
    );
  });

  it("Session-content-stays-inside-perimeter framing pinned: 'Session content (URLs, form data, captures, recordings) stays inside your network. Driftstack's control plane sees license + session metadata, never the session itself.' — pinned so the explicit 4-state scope (URLs / form data / captures / recordings) + the control-plane-sees-only-metadata commitment survive (drift to dropping the explicit scope would let customers question what 'session content' means)", () => {
    // S20c 2026-07-06 plain-language pass: metadata said plainly,
    // term kept in parens; 4-state scope + never-the-session survive.
    // 2026-09-15: the session record (when one started, which profile ran)
    // is kept by the customer's own server, so Driftstack holds no copy of
    // content or record; the old "sees only your license and basic session
    // details" described reporting that does not exist in the code.
    expect(body).toMatch(
      /Session content \(URLs, form data, captures, recordings\) stays inside\s+your network, and so does the record of your sessions — when one\s+started, which profile ran — because the server that keeps it is\s+yours\. Driftstack holds no copy of either\./,
    );
    expect(body).toMatch(
      /Crash reporting in the\s+desktop app is off by default when the app points at a self-hosted\s+server\./,
    );
    expect(body).not.toMatch(/sees only your license|license, API keys|session details\)/);
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
    // 2026-09-15: the right-hand column is Driftstack the supplier
    // (software releases, device-profile updates), not a hosted service.
    expect(body).toMatch(/YOUR MACS {2,}DRIFTSTACK\n/);
    expect(body).toMatch(/│ {2}Driftstack {6}│\s+│ {2}server, desktop │\s+│ {2}app, sessions {3}│/);
    expect(body).not.toMatch(/DRIFTSTACK SERVICE|Driftstack service/);
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

  it('cross-page parity: pricing.astro renders the same fmtSupportTier strings as self-hosted.astro for all three self-hosted SKUs (refuter 2026-09-15: /pricing#self-hosted still said 48h target for dedicated_csm_1h)', () => {
    const cases = (src: string): Record<string, string> =>
      Object.fromEntries(
        Array.from(
          src.matchAll(/case '(email_48h|email_slack_12h|dedicated_csm_1h)':\s*return '([^']+)';/g),
        ).map((m) => [m[1] as string, m[2] as string]),
      );
    const here = cases(body);
    const there = cases(read(PRICING_PAGE));
    expect(Object.keys(here).sort()).toEqual(['dedicated_csm_1h', 'email_48h', 'email_slack_12h']);
    expect(there).toEqual(here);
    expect(there['dedicated_csm_1h']).not.toMatch(/48h target/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
