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
      /\/\/ V-477 — trust center landing\. Aggregates the customer-trust\s*\n?\s*\/\/ surfaces \(security, sub-processors, legal documents, incident\s*\n?\s*\/\/ history\) on a single page so customers evaluating the platform\s*\n?\s*\/\/ have one URL to bookmark\./,
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
  // 05 Team roles / 06 No-customer-data-access). The enumeration now
  // matches the real six; the EU-hosting sentence (not one of the
  // /security pillars) rides as its own sentence — softened to "EU
  // servers" by S30 2026-07-07 (founder decision: soften).
  it("Security card pinned: 'Architecture + posture →' + 6-pillar shipped commitment matching /security's rendered pillars (01–06). History: 2026-05-22 egress flipped roadmap→shipped (4→5); S26 2026-07-06 count corrected 5→6 to match /security.", () => {
    expect(body).toMatch(/Architecture \+ posture →/);
    expect(body).toMatch(/Six pillars shipped today/);
    expect(body).not.toMatch(/Five pillars shipped today/);
    // All six pillars, plain words leading, precise terms in parens.
    expect(body).toMatch(/everything between you and us\s+travelling encrypted \(TLS\)/);
    expect(body).toMatch(
      /each profile bringing its own internet\s+exit — your SOCKS5 proxy \(including UDP\/QUIC\/WebRTC\s+traffic\) or your OpenVPN \/ WireGuard VPN/,
    );
    expect(body).toMatch(
      /API keys stored only as\s+one-way scrypt hashes \(unreadable even to us\)/,
    );
    expect(body).toMatch(
      /webhooks\s+cryptographically signed so you can prove each message\s+came from us \(HMAC\)/,
    );
    expect(body).toMatch(/team roles where your whole team can\s+look but only admins can change/);
    expect(body).toMatch(/a design that keeps our staff from\s+ever seeing your session content/);
    // EU hosting stays claimed (its own sentence, not a pillar).
    // S30 2026-07-07 (founder decision: soften): "EU servers" replaces
    // "EU-resident infrastructure" — the six pillars run on the EU
    // control plane (true), but the blanket infrastructure claim
    // over-reached since R2-held file objects replicate EU + US.
    expect(body).toMatch(/All of it runs on EU\s+servers\./);
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
      /with\s*\n?\s*timestamps, customer impact, root cause, and the remediation\s*\n?\s*we applied\./,
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

  it("Quick-reference 6-question buyer FAQ: 'Where is data hosted?' + 'Do you see our destination URLs?' + 'Are API keys recoverable by staff?' + 'How do we get a DPA on file?' + 'What's the incident-response SLA?' + 'How do we get a security questionnaire answered?' — pinned so the 6-question buyer-evaluation FAQ stays complete (drift to dropping 'API keys recoverable' would obscure the scrypt-hashing posture; drift to dropping 'see destination URLs' would obscure the egress-via-customer-proxy posture)", () => {
    expect(body).toMatch(/Where is data hosted\?/);
    expect(body).toMatch(/Do you see our destination URLs\?/);
    expect(body).toMatch(/Are API keys recoverable by staff\?/);
    expect(body).toMatch(/How do we get a DPA on file\?/);
    expect(body).toMatch(/What's the incident-response SLA\?/);
    expect(body).toMatch(/How do we get a security questionnaire answered\?/);
  });

  it("Data-hosted answer pinned: 'EU by default. Compute (Hetzner Nuremberg), database (Neon Frankfurt); object storage (Cloudflare R2, EU + US replication).' — S30 2026-07-07 (founder decision: soften) supersedes the prior 'EU only ... R2 EU jurisdiction' pin: R2 uses the DEFAULT jurisdiction (verified on the prod box, task #24), so the absolutist 'EU only' + false 'EU jurisdiction' had to go; the 3-sub-processor location specificity survives", () => {
    expect(body).toMatch(
      /EU by default\. Compute \(Hetzner Nuremberg\), database \(Neon Frankfurt\);\s*\n?\s*object storage \(Cloudflare R2, EU \+ US replication\)\./,
    );
    // S30 negative pins — the absolutist claims must not silently return.
    expect(body).not.toMatch(/EU only\./);
    expect(body).not.toMatch(/Cloudflare R2 EU jurisdiction/);
  });

  it("Destination-URL answer pinned: 'No. Session traffic exits through your egress (the SOCKS5 / OpenVPN / WireGuard proxies you configure). Driftstack orchestrates the session; the proxy carries the bytes.' — pinned so the no-we-don't-see-URLs + customer-egress posture survives (drift to softening 'No' would let buyers question what Driftstack actually sees; drift to dropping the SOCKS5/OpenVPN/WG list would lose the customer-controlled-egress specifics). Priority order SOCKS5 / OpenVPN / WireGuard per founder verdict 2026-05-16; matches the API server's user-facing 503 messages.", () => {
    // S20c 2026-07-06 plain-language pass: hard 'No.' + the
    // SOCKS5/OpenVPN/WireGuard priority order survive; plain words
    // explain what 'egress' and 'carries the bytes' meant.
    expect(body).toMatch(
      /No\. Session traffic leaves for the web through the exit you\s+configure \(your egress\) — your own SOCKS5 proxy or OpenVPN \/\s+WireGuard VPN\. Driftstack starts and manages the session;\s+your proxy carries the actual browsing traffic, so the\s+addresses you visit don't pass through us\./,
    );
  });

  it("API-keys-recoverable answer pinned: 'No. Keys are scrypt-hashed at rest. A database breach surfaces hashes, not keys. If a key leaks, rotate via the dashboard's 24-hour grace flow.' — pinned so the scrypt-hashing + breach-doesn't-leak-keys + 24-hour-rotation-grace commitments survive (drift to dropping 'scrypt-hashed' would lose the specific-algorithm signal; drift to dropping '24-hour grace' would obscure the rotation-policy)", () => {
    // S20c 2026-07-06 plain-language pass: hard 'No.' + scrypt +
    // 24-hour grace facts survive, plain words lead.
    expect(body).toMatch(
      /No\. Keys are stored only as one-way scrypt hashes — staff,\s+and even a database thief, see scrambled values, not keys\.\s+If a key leaks, rotate it in the dashboard; the old key\s+keeps working for 24 hours \(the grace window\) so nothing\s+breaks mid-switch\./,
    );
  });

  it("CTA pinned: 'Bring the questionnaire. We'll fill it.' + 'CAIQ, VSAQ, custom enterprise vendor questionnaires — all welcome.' + mailto:support@driftstack.dev — pinned so the 'we fill questionnaires' commitment + the CAIQ/VSAQ scope + the support-team routing all survive (drift to dropping CAIQ/VSAQ specificity would let buyers question whether their format is supported; drift to dropping 'working day' implicit SLA would let response time slip). Fleet v2 (S10): the hand-rolled CTA section became a <CtaBand> — the btn-primary anchor now renders from the primaryHref/primaryLabel props, so the pin matches the prop form", () => {
    expect(body).toMatch(/title="Bring the questionnaire\. We'll fill it\."/);
    // S20c 2026-07-06 plain-language pass: CAIQ/VSAQ named as
    // standard security-questionnaire formats.
    expect(body).toMatch(
      /Standard security-questionnaire formats \(CAIQ, VSAQ\) and custom enterprise vendor questionnaires — all welcome\./,
    );
    expect(body).toMatch(
      /primaryHref="mailto:support@driftstack\.dev"\s*\n?\s*primaryLabel="Email us"/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
