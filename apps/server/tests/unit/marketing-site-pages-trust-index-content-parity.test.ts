// W503.B — drift guard for apps/marketing-site/src/pages/trust/index.astro.
// V-477 trust center landing — the bookmarkable URL for buyer
// evaluations and ongoing GDPR/DPA reviews. Drift here either drops
// one of the 6 trust-surface cards (would orphan that surface from
// the trust-center hub) or breaks the 'one bookmark for everything
// compliance-relevant' framing.
//
//   • V-477 doc-comment framing.
//   • StatusBadge import + render in hero.
//   • 6-card grid: Security + Sub-processors + Incident history + Legal
//     (DPA·Privacy·Terms·AUP) + Compliance + Security overview.
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

  it('6-card trust surface grid: Security → /security + Sub-processors → /trust/sub-processors + Incident history → /trust/incidents + Legal → /legal/dpa + Compliance → /trust/compliance + Security overview → /trust/security-overview — pinned so the 6-card hub stays complete (drift to dropping any card would orphan that-surface from the trust-center navigation hub)', () => {
    expect(body).toMatch(/<a\s*\n?\s*href="\/security"/);
    expect(body).toMatch(/<a\s*\n?\s*href="\/trust\/sub-processors"/);
    expect(body).toMatch(/<a\s*\n?\s*href="\/trust\/incidents"/);
    expect(body).toMatch(/<a\s*\n?\s*href="\/legal\/dpa"/);
    expect(body).toMatch(/<a\s*\n?\s*href="\/trust\/compliance"/);
    expect(body).toMatch(/<a\s*\n?\s*href="\/trust\/security-overview"/);
  });

  it("Security card pinned: 'Architecture + posture →' + 'Four pillars shipped today: scrypt-hashed API keys at rest, HMAC-signed webhooks, no-customer-data-access enforcement, and EU-resident infrastructure.' — pinned so the 4-pillar shipped-today commitment survives (drift to dropping 'scrypt-hashed' or 'HMAC-signed' would weaken the specific-cryptography signal; drift to dropping 'EU-resident' would obscure data-residency posture)", () => {
    expect(body).toMatch(/Architecture \+ posture →/);
    expect(body).toMatch(
      /Four pillars shipped today: scrypt-hashed API keys at rest,\s*\n?\s*HMAC-signed webhooks, no-customer-data-access enforcement,\s*\n?\s*and EU-resident infrastructure\./,
    );
  });

  it("Sub-processors card pinned: 'Live list + regions →' + 'Source of truth for Article 28(2) amendment notices; mirrored in DPA Annex 3.' — pinned so the Article 28(2) + DPA-Annex-3 cross-reference survives in the hub-card too (consistent with the canonical /trust/sub-processors framing)", () => {
    expect(body).toMatch(/Live list \+ regions →/);
    expect(body).toMatch(
      /Source of\s*\n?\s*truth for Article 28\(2\) amendment notices; mirrored in DPA\s*\n?\s*Annex 3\./,
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
    expect(body).toMatch(
      /Data\s*\n?\s*Processing Agreement \(Article 28 \+ SCCs\), Privacy Policy\s*\n?\s*\(Article 13–15 disclosures\), Terms of Service, Acceptable Use\s*\n?\s*Policy\./,
    );
  });

  it("Compliance card pinned: 'Certifications + pen-test + disclosure →' + 'Honest current state: certifications in place + in progress, pen-test access workflow, vulnerability-disclosure policy + safe-harbour' — pinned so the 'honest current state' framing + 4-state compliance scope survives (drift to claiming certs that aren't in place would invite buyer-pushback; drift to dropping 'safe-harbour' would weaken the vulnerability-disclosure protection)", () => {
    expect(body).toMatch(/Certifications \+ pen-test \+ disclosure →/);
    expect(body).toMatch(
      /Honest current state: certifications in place \+ in progress,\s*\n?\s*pen-test access workflow, vulnerability-disclosure policy \+\s*\n?\s*safe-harbour, sub-processor change SLA, audit-log retention\./,
    );
  });

  it("Quick-reference 6-question buyer FAQ: 'Where is data hosted?' + 'Do you see our destination URLs?' + 'Are API keys recoverable by staff?' + 'How do we get a DPA on file?' + 'What's the incident-response SLA?' + 'How do we get a security questionnaire answered?' — pinned so the 6-question buyer-evaluation FAQ stays complete (drift to dropping 'API keys recoverable' would obscure the scrypt-hashing posture; drift to dropping 'see destination URLs' would obscure the egress-via-customer-proxy posture)", () => {
    expect(body).toMatch(/Where is data hosted\?/);
    expect(body).toMatch(/Do you see our destination URLs\?/);
    expect(body).toMatch(/Are API keys recoverable by staff\?/);
    expect(body).toMatch(/How do we get a DPA on file\?/);
    expect(body).toMatch(/What's the incident-response SLA\?/);
    expect(body).toMatch(/How do we get a security questionnaire answered\?/);
  });

  it("Data-hosted answer pinned: 'EU only. Compute (Hetzner Nuremberg), database (Neon Frankfurt), object storage (Cloudflare R2 EU jurisdiction).' — pinned so the EU-only + 3-sub-processor location specificity survives (drift to dropping the Hetzner Nuremberg / Neon Frankfurt / R2 EU specificity would lose the data-residency credibility signal; drift to dropping 'EU only' would soften the residency commitment)", () => {
    expect(body).toMatch(
      /EU only\. Compute \(Hetzner Nuremberg\), database \(Neon Frankfurt\),\s*\n?\s*object storage \(Cloudflare R2 EU jurisdiction\)\./,
    );
  });

  it("Destination-URL answer pinned: 'No. Session traffic exits through your egress (the SOCKS5 / OpenVPN / WireGuard proxies you configure). Driftstack orchestrates the session; the proxy carries the bytes.' — pinned so the no-we-don't-see-URLs + customer-egress posture survives (drift to softening 'No' would let buyers question what Driftstack actually sees; drift to dropping the SOCKS5/OpenVPN/WG list would lose the customer-controlled-egress specifics). Priority order SOCKS5 / OpenVPN / WireGuard per founder verdict 2026-05-16; matches the API server's user-facing 503 messages.", () => {
    expect(body).toMatch(
      /No\. Session traffic exits through your egress \(the SOCKS5 \/\s*\n?\s*OpenVPN \/ WireGuard proxies you configure\)\. Driftstack\s*\n?\s*orchestrates the session; the proxy carries the bytes\./,
    );
  });

  it("API-keys-recoverable answer pinned: 'No. Keys are scrypt-hashed at rest. A database breach surfaces hashes, not keys. If a key leaks, rotate via the dashboard's 24-hour grace flow.' — pinned so the scrypt-hashing + breach-doesn't-leak-keys + 24-hour-rotation-grace commitments survive (drift to dropping 'scrypt-hashed' would lose the specific-algorithm signal; drift to dropping '24-hour grace' would obscure the rotation-policy)", () => {
    expect(body).toMatch(
      /No\. Keys are scrypt-hashed at rest\. A database breach surfaces\s*\n?\s*hashes, not keys\. If a key leaks, rotate via the dashboard's\s*\n?\s*24-hour grace flow\./,
    );
  });

  it("CTA pinned: 'Bring the questionnaire. We'll fill it.' + 'CAIQ, VSAQ, custom enterprise vendor questionnaires — all welcome.' + mailto:support@driftstack.dev — pinned so the 'we fill questionnaires' commitment + the CAIQ/VSAQ scope + the support-team routing all survive (drift to dropping CAIQ/VSAQ specificity would let buyers question whether their format is supported; drift to dropping 'working day' implicit SLA would let response time slip)", () => {
    expect(body).toMatch(/Bring the questionnaire\. We'll fill it\./);
    expect(body).toMatch(
      /CAIQ, VSAQ, custom enterprise vendor questionnaires — all\s*\n?\s*welcome\./,
    );
    expect(body).toMatch(
      /<a href="mailto:support@driftstack\.dev" class="btn-primary">Email us<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
