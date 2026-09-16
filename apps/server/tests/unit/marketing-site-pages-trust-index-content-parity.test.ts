// W503.B — drift guard for apps/marketing-site/src/pages/trust/index.astro.
// V-477 trust center landing — the bookmarkable URL for buyer
// evaluations and ongoing GDPR/DPA reviews. Drift here either drops
// one of the 7 trust-surface cards (would orphan that surface from
// the trust-center hub) or breaks the 'one bookmark for everything
// compliance-relevant' framing.
//
//   • V-477 doc-comment framing.
//   • StatusBadge import + render in hero.
//   • 7-card grid: Security + Sub-processors + Incident history + Legal
//     (DPA·Privacy·Terms·AUP) + Compliance + Security overview + cumulative rig.
//   • Quick-reference 6-question buyer FAQ.
//   • CTA: 'Bring the questionnaire. We'll fill it.'

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W503.B apps/marketing-site/src/pages/trust/index.astro content parity', () => {
  const body = read(LIB);

  it("V-477 framing pinned: 'trust center landing. Aggregates the customer-trust surfaces (security, sub-processors, legal documents, incident history) on a single page so customers evaluating the platform have one URL to bookmark.' — pinned so the V-477 doc-comment + the 'one URL to bookmark' commitment survive (drift to dropping V-477 would orphan the engineering reason; drift to dropping 'one URL' would weaken the hub-page-vs-scattered-pages positioning)", () => {
    expect(body).toMatch(
      /\/\/ V-477 — trust center landing\. Aggregates the customer-trust\s*\/\/ surfaces \(security, sub-processors, legal documents, incident\s*\/\/ history\) on a single page so customers evaluating the platform\s*\/\/ have one URL to bookmark\./,
    );
  });

  it("StatusBadge import + render: 'import StatusBadge from \"../../components/StatusBadge.astro\";' + '<StatusBadge />' — pinned so the live-status visual signal stays in the hero (drift to dropping the badge would lose the at-a-glance 'is the platform up right now' signal customers scan for first)", () => {
    expect(body).toMatch(/import StatusBadge from '\.\.\/\.\.\/components\/StatusBadge\.astro';/);
    expect(body).toMatch(/<StatusBadge \/>/);
  });

  it('7-card trust surface grid uses canonical routes, including the signal-by-signal cumulative rig.', () => {
    for (const href of [
      '/security/',
      '/trust/sub-processors/',
      '/trust/incidents/',
      '/legal/dpa/',
      '/trust/compliance/',
      '/trust/security-overview/',
      '/trust/cumulative-rig/',
    ]) {
      expect(body, `trust card ${href}`).toContain(`<a href="${href}"`);
    }
    for (const href of [
      '/trust/sub-processors/',
      '/legal/dpa/',
      '/trust/incidents/',
      '/docs/sla-policy/',
    ]) {
      expect(body, `quick-reference link ${href}`).toContain(`href="${href}"`);
    }
    expect(body).not.toMatch(
      /href="\/(?:security|legal\/dpa|trust\/(?:sub-processors|incidents|compliance|security-overview|cumulative-rig)|docs\/sla-policy)"/,
    );
  });

  // S26 2026-07-06 (#132) — re-pinned: the card said "Five pillars"
  // while /security (the page this card links to) renders SIX
  // (01 Transport / 02 Egress / 03 API keys / 04 Webhooks /
  // 05 Team roles / 06 Live-media handling). The enumeration now
  // matches the real six; the EU-hosting sentence (not one of the
  // /security pillars) rides as its own sentence — softened to "EU
  // servers" by S30 2026-07-07 (founder decision: soften).
  it("Security card pinned: 'Architecture + posture →' + 6-pillar shipped commitment matching /security's rendered pillars (01–06). History: 2026-05-22 egress flipped roadmap→shipped (4→5); S26 2026-07-06 count corrected 5→6 to match /security.", () => {
    expect(body).toMatch(/Architecture \+ posture →/);
    // 2026-09-15 plain-language pass: "pillars" → "promises" (matches
    // /security's "Six promises" headline); every claim survives in
    // customer words; "control plane" is banned on customer surfaces.
    expect(body).toMatch(/Six promises in place today/);
    expect(body).not.toMatch(/Five pillars shipped today|Six pillars shipped today/);
    expect(body).toMatch(/everything between you and us\s+is encrypted \(TLS\)/);
    // 2026-09-15 truth pass: the VPN schemes are named (they ship as
    // customer-attached egress — see W332.B); the desktop app never launches a
    // profile without an attached proxy (apps/gui-client/src/views/
    // ProfilesView.tsx).
    // 2026-09-15 refuter: the "managed exit" fallback was an INVENTED feature —
    // no Driftstack-run exit is configured for production (infra/env-templates/
    // production.env.template leaves DEFAULT_EGRESS_HOST/PORT empty on purpose:
    // "UNSET IS VALID AND DELIBERATE"; production.env carries no DEFAULT_EGRESS_*
    // line; apps/server/src/routes/agent-sessions.ts dispatches NO proxy when
    // proxy_id is omitted and a REQUIRE_PROXY=1 node refuses by name). The page
    // now says an API session names a saved proxy and that no shared Driftstack
    // exit exists; the old clause is negatively pinned so it cannot return.
    // VPN exits are tier-gated (TIER_FEATURES.free.vpnEgress = false) — stated.
    expect(body).toMatch(
      /each profile can use a SOCKS5 proxy or, on\s+paid plans, a VPN \(OpenVPN or WireGuard\) you choose — the\s+desktop app launches only through one you attach, an API\s+session names one of your saved proxies, and we do not route\s+your traffic through a shared exit of our own/,
    );
    expect(body).not.toMatch(/managed exit/);
    expect(body).not.toMatch(/OpenVPN \/ WireGuard VPN/);
    expect(body).toMatch(
      /API keys\s+are stored only as one-way hashes that nobody — including us —\s+can read back/,
    );
    expect(body).toMatch(/every webhook is signed so you can confirm it\s+came from us/);
    expect(body).toMatch(/your whole team can view but only admins can\s+change/);
    // 2026-09-15: "no built-in way" — the same honest scope /security uses
    // (W333.B negatively pins the blanket "no way to join" there).
    expect(body).toMatch(
      /the live view of a session is encrypted in\s+transit, not kept by default, and gives Driftstack staff no\s+built-in way to join it/,
    );
    expect(body).not.toMatch(/gives Driftstack staff no\s+way to join it/);
    // Shipped account-security controls the hub used to leave unmentioned;
    // none is tier-gated (TIER_FEATURES carries no MFA / web-session / audit flag).
    expect(body).toMatch(
      /Two-factor sign-in, an active\s+sign-ins list you can revoke from, and a CSV export of your\s+audit log come with every plan\./,
    );
    expect(body).not.toMatch(/keeps our staff from\s+ever seeing your session content/);
    expect(body).toMatch(/Our API and main database run in the EU/);
    // Rendered copy only — the S30 source comment above the card may still say it.
    expect(body).not.toMatch(/API control\s+plane/);
    expect(body).toMatch(
      /the\s+live view is routed through a region chosen per session, EU\s+preferred/,
    );
    expect(body).not.toMatch(/All of it runs on EU\s+servers\./);
    expect(body).not.toMatch(/All of it runs on EU-resident\s+infrastructure\./);
  });

  it("Sub-processors card pinned: 'Live list + regions →' + 'Source of truth for Article 28(2) amendment notices; mirrored in DPA Annex 3.' — pinned so the Article 28(2) + DPA-Annex-3 cross-reference survives in the hub-card too (consistent with the canonical /trust/sub-processors framing)", () => {
    expect(body).toMatch(/Live list \+ regions →/);
    // S20c 2026-07-06 plain-language pass: same source-of-truth +
    // Annex-3 mirror facts, plain words lead.
    expect(body).toMatch(
      /This list is the official source for\s+the 30-day change notices GDPR Article 28\(2\) requires, and\s+it appears verbatim as Annex 3 of our data-processing\s+agreement \(DPA\)\./,
    );
  });

  it("Incident history card pinned: 'Past events + post-mortems →' + 'with timestamps, customer impact, root cause, and the remediation we applied.' — pinned so the 4-attribute incident-disclosure commitment (timestamp/impact/root-cause/remediation) survives (drift to dropping 'root cause' would weaken the post-mortem-grade commitment; drift to dropping 'remediation' would leave incidents without a fix-applied signal)", () => {
    expect(body).toMatch(/Past events \+ post-mortems →/);
    expect(body).toMatch(
      /with\s*timestamps, customer impact, root cause, and the remediation\s*we applied\./,
    );
  });

  it("Legal card pinned: 'DPA · Privacy · Terms · AUP →' + 'Data Processing Agreement (Article 28 + SCCs), Privacy Policy (Article 13–15 disclosures), Terms of Service, Acceptable Use Policy.' — pinned so the 4-legal-document scope + the GDPR-Article-anchoring (Article 28 / Article 13–15) survives (drift to dropping AUP would orphan acceptable-use rules; drift to dropping Article anchors would weaken the GDPR-grounding)", () => {
    expect(body).toMatch(/DPA · Privacy · Terms · AUP →/);
    // S20c 2026-07-06 plain-language pass: same 4 documents + GDPR
    // Article anchors, with SCCs + Article 13–15 glossed inline.
    expect(body).toMatch(
      /Data\s+Processing Agreement \(GDPR Article 28, including the EU's\s+Standard Contractual Clauses — SCCs — for data sent\s+abroad\), Privacy Policy \(the GDPR Article 13–15\s+disclosures: what we collect and your rights over it\),\s+Terms of Service, Acceptable Use\s+Policy\./,
    );
  });

  it('Compliance card pins only current attestations, private disclosure, safe harbour, change notice, and retention.', () => {
    expect(body).toMatch(/Compliance \+ disclosure →/);
    expect(body).toMatch(
      /The attestations available today, how to report a security\s+issue privately, our safe-harbour commitment for good-faith\s+research, sub-processor change notice, and current log-retention\s+periods\./,
    );
    expect(body).not.toMatch(/certifications are in progress|penetration-test reports/);
  });

  it("Quick-reference 7-question buyer FAQ: 'Where is data hosted?' + 'Do you see our destination URLs?' + 'Are API keys recoverable by staff?' + 'How do we get a DPA on file?' + 'What's the incident-response SLA?' + 'Can we use two-factor sign-in and see who is signed in?' (added 2026-09-15) + 'How do we get a security questionnaire answered?' — pinned so the buyer-evaluation FAQ stays complete (drift to dropping 'API keys recoverable' would obscure the scrypt-hashing posture; drift to dropping 'see destination URLs' would obscure the egress-via-customer-proxy posture)", () => {
    expect(body).toMatch(/Where is data hosted\?/);
    expect(body).toMatch(/Do you see our destination URLs\?/);
    expect(body).toMatch(/Are API keys recoverable by staff\?/);
    expect(body).toMatch(/How do we get a DPA on file\?/);
    expect(body).toMatch(/What's the incident-response SLA\?/);
    expect(body).toMatch(/Can we use two-factor sign-in and see who is signed in\?/);
    expect(body).toMatch(/How do we get a security questionnaire answered\?/);
  });

  it("Data-hosted answer pinned: 'EU by default. Servers in Falkenstein, Germany (Hetzner); database in Frankfurt (Neon); file storage on Cloudflare R2, which keeps copies in both the EU and the US.' — S30 2026-07-07 (founder decision: soften) supersedes the prior 'EU only ... R2 EU jurisdiction' pin: R2 uses the DEFAULT jurisdiction (verified on the prod box, task #24), so the absolutist 'EU only' + false 'EU jurisdiction' had to go; the 3-sub-processor location specificity survives. 2026-09-15: 'Nuremberg' corrected to Falkenstein per the sub-processor register", () => {
    expect(body).toMatch(
      /EU by default\. Servers in Falkenstein, Germany \(Hetzner\); database\s+in Frankfurt \(Neon\); file storage on Cloudflare R2, which keeps\s+copies in both the EU and the US\./,
    );
    expect(body).not.toMatch(/Nuremberg/);
    // S30 negative pins — the absolutist claims must not silently return.
    expect(body).not.toMatch(/EU only\./);
    expect(body).not.toMatch(/Cloudflare R2 EU jurisdiction/);
  });

  it('Destination-URL answer distinguishes control-plane URL processing/event recording from browser egress', () => {
    // 2026-09-15 truth pass: VPN named alongside SOCKS5 (desktop app always
    // attaches one). 2026-09-15 refuter: the "managed exit" fallback for API
    // sessions does not exist in the shipped config (see the security-card
    // pin above) — the answer now says a saved proxy is named and no shared
    // Driftstack exit is used.
    expect(body).toMatch(
      /Yes\. When you or your agent open a URL, Driftstack processes\s+that URL and keeps a record of the visit for your account\. The\s+page traffic itself goes out through your own SOCKS5 proxy or\s+VPN — the desktop app always launches through one, and an API\s+session names one of your saved proxies\. Driftstack does not\s+route it through a shared exit of its own\./,
    );
    expect(body).not.toMatch(/OpenVPN \/ WireGuard VPN/);
    expect(body).not.toMatch(/the\s+addresses you visit don't pass through us/);
  });

  it("API-keys-recoverable answer pinned: 'No. Keys are scrypt-hashed at rest. A database breach surfaces hashes, not keys. If a key leaks, rotate via the dashboard's 24-hour grace flow.' — pinned so the scrypt-hashing + breach-doesn't-leak-keys + 24-hour-rotation-grace commitments survive (drift to dropping 'scrypt-hashed' would lose the specific-algorithm signal; drift to dropping '24-hour grace' would obscure the rotation-policy)", () => {
    // S20c 2026-07-06 plain-language pass: hard 'No.' + scrypt +
    // 24-hour grace facts survive, plain words lead.
    expect(body).toMatch(
      /No\. Keys are stored only as one-way hashes \(scrypt\) — staff,\s+and even a database thief, see scrambled values, not keys\.\s+If a key leaks, rotate it in the dashboard; the old key\s+keeps working for 24 hours \(the grace window\) so nothing\s+breaks mid-switch\./,
    );
  });

  it('CTA truthfully accepts CAIQ, VSAQ and custom questionnaires without an unimplemented response-time SLA', () => {
    expect(body).toMatch(/title="Bring the questionnaire\. We'll fill it\."/);
    // S20c 2026-07-06 plain-language pass: CAIQ/VSAQ named as
    // standard security-questionnaire formats.
    expect(body).toMatch(
      /Standard security-questionnaire formats \(CAIQ, VSAQ\) and custom enterprise vendor questionnaires — all welcome\./,
    );
    expect(body).toMatch(/primaryHref="mailto:support@driftstack\.dev"\s*primaryLabel="Email us"/);
    expect(body).toMatch(/we answer the remaining items in writing/);
    expect(body).not.toMatch(/within a working day/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
