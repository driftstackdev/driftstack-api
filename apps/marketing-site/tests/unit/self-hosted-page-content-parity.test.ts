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
//   • Driftstack-side scope (2026-09-15): the customer runs the
//     Driftstack server on their own Macs, so the session record is
//     theirs too and Driftstack holds no copy of content or record.
//     The page must not describe a Driftstack-hosted service that
//     receives a license or session details — no such code exists;
//     apps/docs license-activation.md, Terms §3 and the self-hosted
//     runbook all have the customer running the server.
//   • 3 "when self-hosted is the right call" categories pinned
//     (Privacy / Volume / Sovereignty).
//   • 4-step process pinned (Contact sales / Procure hardware
//     / Onboard / Run) with sales@driftstack.dev contact.
//   • Current sales-led availability with no GA/early-access deferral.
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
const PRICING_PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro');

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
    // 2026-09-15 plain words: same recommended models, buyer-facing
    // reason (a larger Mac for many sessions at once / several Macs).
    expect(body).toMatch(
      /self_hosted_pro: 'A larger Apple Silicon Mac for running many sessions at once \(Mac Studio M4 Max recommended\)'/,
    );
    expect(body).toMatch(
      /self_hosted_enterprise: 'Several Apple Silicon Macs \(Mac Studio Ultra \/ Mac Pro recommended\)'/,
    );
  });

  it('"session content never leaves your perimeter" privacy framing pinned', () => {
    expect(body).toMatch(/Sessions never leave your network/); // 2026-09-15: "perimeter" → plain "network"
    // S20c 2026-07-06 plain-language pass: same 4-state scope + the
    // nothing-through-vendor-servers promise, plain words lead.
    expect(body).toMatch(
      /session content \(URLs, form data, captures,\s+recordings\) must never pass through anyone's servers but\s+your own/,
    );
  });

  it('Driftstack-side scope pinned (2026-09-15): the session record lives on the customer-run server too, Driftstack holds no copy of content or record, and desktop crash reporting is off by default on self-hosted', () => {
    // Until 2026-09-15 this block pinned "Driftstack sees only your
    // license and basic session details". No code sends either from a
    // self-hosted server (grep -i license apps/server/src: nothing), and
    // apps/docs/src/pages/license-activation.md ("Set up the Driftstack
    // server on your own hardware"), Terms §3 ("a self-hosted deployment
    // Customer runs") and docs/runbooks/self-hosted-mac-local.md all have
    // the customer running the server — so the record of a session is on
    // their server, not ours. The crash-reporting default is
    // apps/gui-client/src/lib/telemetry.ts (`telemetryEnabled`: with no
    // explicit opt-in it fires only for a cloud base URL).
    expect(body).toMatch(
      /Session content \(URLs, form data, captures, recordings\) stays inside\s+your network, and so does the record of your sessions — when one\s+started, which profile ran — because the server that keeps it is\s+yours\. Driftstack holds no copy of either\. Crash reporting in the\s+desktop app is off by default when the app points at a self-hosted\s+server\./,
    );
    expect(body).not.toMatch(
      /sees only your license|license, API keys|hosts the service that starts|coordination service|you supply the machines/,
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
    expect(body).toMatch(/10 or more,\s+sustained through a whole month/); // 2026-09-15 plain words
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

  it('sales@driftstack.dev contact + current guided sales-led availability', () => {
    expect(body).toMatch(/mailto:sales@driftstack\.dev\?subject=Self-Hosted%20inquiry/);
    expect(body).toMatch(/Self-hosted is set up together with our sales team, step by step\./);
    expect(body).toMatch(
      /check that the work is a good fit, plan the hardware and\s+network, install and set up your deployment, and run a first\s+live test/,
    );
    expect(body).toMatch(/Available now through Contact Sales · scoped and supported directly/);
    expect(body).not.toMatch(
      /\bGA\b|generally available|early access|follows the API public launch|ships within/i,
    );
  });

  it('cross-link to /faq resolves (common-questions teaser section)', () => {
    expect(body).toMatch(/<a href="\/faq\/" class="btn-secondary">See FAQ<\/a>/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/faq.astro'))).toBe(true);
  });

  it('ASCII architecture diagram present with secure-channel callout', () => {
    // 2026-09-15: banned words (fleet / control plane / orchestration)
    // left the diagram; the two sides and the HTTPS link survive.
    // 2026-09-15: the right-hand column is Driftstack the supplier
    // (software releases, device-profile updates), not a hosted service;
    // the left column shows the Driftstack server itself on the
    // customer's Macs.
    expect(body).toMatch(/YOUR MACS[\s\S]+?DRIFTSTACK\n/);
    expect(body).toMatch(/Your Macs/);
    expect(body).toMatch(/│  Driftstack {10}│/);
    expect(body).toMatch(/\(software releases,\s+│[\s\S]+?device-profile[\s\S]+?updates\)/);
    expect(body).toMatch(/│  Driftstack {6}│\s+│  server, desktop │\s+│  app, sessions {3}│/);
    expect(body).not.toMatch(
      /DRIFTSTACK SERVICE|Driftstack service|license, API keys|session details\)/,
    );
    expect(body).toMatch(/secure ───/);
    expect(body).toMatch(/connection/);
    expect(body).toMatch(/\(HTTPS\)/);
  });

  it('egress posture pinned: WebKit sessions exit via your network (DC / VPN / BYO SOCKS5 + OpenVPN + WG). 2026-05-22 — "roadmap: BYO" flipped to shipped capability per planning 133 Phase 1.', () => {
    expect(body).toMatch(/Sessions reach the web through your network/);
    expect(body).toMatch(/direct, VPN,/);
    expect(body).toMatch(/SOCKS5 \//);
    expect(body).toMatch(/OpenVPN \//);
    expect(body).toMatch(/WireGuard\)/);
  });

  it('"Concurrent capacity bounded by your hardware, not by license" pinned (cap framing)', () => {
    // Distinguishes self-hosted from SaaS — tier licensing
    // doesn't gate concurrent count on owned hardware.
    expect(body).toMatch(
      /How many sessions can run at once depends on your hardware, not your license\./,
    );
  });

  it('2026-09-15 what-ships pass: hero names the engine the house-style way, the privacy card scopes "never leaves" to session content, Onboard sets up team accounts and roles, and the Run step lists what the desktop app and account already include', () => {
    expect(body).toMatch(
      /Same SDK, same desktop app, and device profiles from the same\s+catalog — a build of Apple's own WebKit, the engine family behind\s+iPhone Safari, checked against real iPhones — just running on\s+hardware you own and inside a network you control\./,
    );
    expect(body).not.toMatch(/same iPhone Safari fidelity|the same browser Apple ships/i);
    expect(body).toMatch(/Mac mini or Mac Studio; session content\s+never leaves your network\./);
    expect(body).not.toMatch(/; nothing leaves\s+your network/);
    expect(body).toMatch(/set up\s+your team's accounts and roles/);
    expect(body).not.toMatch(/admin console/);
    // 2026-09-15 refuter: the desktop app has no audit-log export and no
    // two-factor step (grep audit-log/export|mfa|two-factor in
    // apps/gui-client/src: only an error string and redaction keys), so
    // those belong to the account, not the app.
    // Second pass 2026-09-15: the desktop app has no profile-snapshot
    // surface (apps/gui-client/src 'snapshot' hits are diagnostic dumps),
    // v1 snapshots capture device + name only (services/profile-
    // snapshots.ts), and GET /v1/profiles/:id/export is metadata-only, so
    // the app is credited with a recycle bin and settings export/import.
    expect(body).toMatch(
      /The desktop app is the same as well: profiles with a\s+recycle bin and export\/import of their settings as a file, and a\s+proxy or VPN attached per profile, with a Test readout before\s+you launch\. Your account keeps team roles, an audit log you\s+can export as CSV, and two-factor sign-in\./,
    );
    expect(body).not.toMatch(/The desktop app is the same as well:[^.]*snapshots/);
    expect(body).not.toMatch(
      /The desktop app is the same as well:[^.]*(?:audit log|two-factor|team roles)/,
    );
  });

  it("2026-09-15 deployment model: the Driftstack server runs on the customer's Macs (hero + architecture paragraph), and no Driftstack-hosted service is described", () => {
    // apps/docs/src/pages/license-activation.md ("Set up the Driftstack
    // server on your own hardware … paste the URL of your server"), Terms §3
    // ("a self-hosted deployment Customer runs against Customer's own …")
    // and docs/runbooks/self-hosted-mac-local.md agree; nothing in
    // apps/server/src reports a license or session details to a hosted
    // service.
    expect(body).toMatch(
      /The Driftstack server that starts and manages your sessions runs\s+on your Macs as well, with the desktop app pointed at it; we\s+install and set it up with you\./,
    );
    expect(body).toMatch(
      /Self-hosted is the whole of Driftstack running on Mac hardware\s+you own: the server that starts and manages sessions, the desktop\s+app pointed at it, and the sessions themselves\. We supply the\s+software, its updates and new device profiles, and the developer\s+kit \(SDK\) — and we never hold what happens inside your sessions\./,
    );
    expect(body).not.toMatch(
      /Driftstack hosts the service|coordination service|you supply the machines/,
    );
  });

  it('cross-page parity: /pricing#self-hosted renders the same support line for every self-hosted SKU as this page (one data file, one promise)', () => {
    // Refuter 2026-09-15: this page said "1h SLA" for Self-Hosted Enterprise
    // while pricing.astro's mirror of fmtSupportTier still said "48h target"
    // for the same `dedicated_csm_1h` SKU — and the two "See pricing"
    // buttons here link straight to that row. Both formatters must agree,
    // and the Enterprise string must be the Terms §9.2 grant.
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
    expect(here['dedicated_csm_1h']).toBe(
      'Dedicated account manager · 1h SLA for first reply on critical (Severity-1) incidents',
    );
  });
});
