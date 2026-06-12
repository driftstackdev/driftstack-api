// W504.A — drift guard for apps/marketing-site/src/pages/trust/compliance.astro.
// V-661 (V-550.C) compliance + pen-test + vulnerability-disclosure page.
// Drift here either claims a certification we don't have (would invite
// buyer pushback and legal risk) or breaks the safe-harbour /
// vulnerability-disclosure commitments (would discourage good-faith
// security researchers from reporting findings).
//
//   • V-661 (V-550.C) doc-comment framing + positive-list-only posture.
//   • 4-cert table: GDPR Article 28 (In place) / SOC 2 Type I (In
//     progress Q3 2026) / SOC 2 Type II (Planned Q1 2027) /
//     Independent pen-test (Scheduled Q3 2026).
//   • Pen-test access: public summary + NDA-gated full report + 1
//     business day + 7-day signed download URL.
//   • Vulnerability disclosure 5-state commitment: 2-day ack / 5-day
//     triage / 14-day updates / 90-day coordinated disclosure / public
//     credit.
//   • Safe-harbour 3-state scope: no other customer data + no
//     availability degradation + private before public.
//   • Sub-processor SLA: 30 calendar days + Article 28(2) + DPA
//     Annex 3 cross-reference.
//   • Audit-log 3-tier retention: customer-facing / admin (365d) /
//     access logs (90d hot + 1y cold).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/compliance.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W504.A apps/marketing-site/src/pages/trust/compliance.astro content parity', () => {
  const body = read(LIB);

  it('V-661 (V-550.C) framing pinned. Re-enabled by slice 202 after verifying the V-661 comment exists at compliance.astro:4-8 with the matching shape', () => {
    expect(body).toMatch(
      /\/\/ V-661 \(V-550\.C\) — compliance \+ pen-test \+ vulnerability-disclosure\s*\n?\s*\/\/ page\. Honest current-state surface: no claims for certifications we\s*\n?\s*\/\/ don't have\. Where work is in progress, we name the certification\s*\n?\s*\/\/ and the expected timeline\. Where we have no plans, the page is\s*\n?\s*\/\/ silent \(positive-list-only — silence is not a no\)\./,
    );
  });

  it('Positive-list-only commitment pinned: \'We list certifications that are either in place or actively in progress. We don\'t list certifications we have no plans to pursue — silence on a certification means "not on the current roadmap", not "not applicable".\' — pinned so the silence-means-not-applicable disclaimer survives (drift to dropping would let buyers read absence as either silence-is-no or silence-is-yes, creating ambiguity that the explicit disclaimer resolves)', () => {
    expect(body).toMatch(
      /We list certifications that are either in place or actively in\s*\n?\s*progress\. We don't list certifications we have no plans to\s*\n?\s*pursue — silence on a certification means "not on the current\s*\n?\s*roadmap", not "not applicable"\./,
    );
  });

  it('4-cert table: GDPR Article 28 (In place today → /legal/dpa) + SOC 2 Type I (In progress Q3 2026) + SOC 2 Type II (Planned Q1 2027) + Independent pen-test (Scheduled first engagement Q3 2026) — pinned so the 4-certification roadmap stays consistent (drift to a different timeline would create marketing↔audit-engagement divergence; drift to dropping any would orphan the buyer expectation for that cert)', () => {
    expect(body).toMatch(/GDPR Article 28<\/span>/);
    expect(body).toMatch(/DPA with SCCs ready to sign/);
    expect(body).toMatch(/SOC 2 Type I<\/span>/);
    expect(body).toMatch(/Q3 2026 \(audit window\)/);
    expect(body).toMatch(/SOC 2 Type II<\/span>/);
    expect(body).toMatch(/Q1 2027/);
    expect(body).toMatch(/Independent pen-test<\/span>/);
    expect(body).toMatch(/First engagement Q3 2026/);
  });

  it("Pen-test 2-tier access: 'Executive summary (PDF)' public-summary + 'Request under NDA' full-report + 'one business day' NDA response + '7-day signed download URL' — pinned so the public-summary / NDA-gated-full split + the 1-business-day SLA + the 7-day-signed-URL mechanics all survive (drift to dropping the 1-business-day SLA would let security-review timelines slip; drift to dropping '7-day signed URL' would obscure the download-link mechanics)", () => {
    expect(body).toMatch(/Executive summary \(PDF\)/);
    expect(body).toMatch(/Request under NDA/);
    expect(body).toMatch(
      /<a href="mailto:security@driftstack\.dev" class="text-tk-accent underline"\s*\n?\s*>security@driftstack\.dev<\/a\s*\n?\s*> with your company name and use case\. We respond within\s*\n?\s*one business day with the NDA\. Approved requests receive a\s*\n?\s*7-day signed download URL\./,
    );
  });

  it("Vulnerability disclosure 5-state commitment: 'Acknowledge receipt within 2 business days.' + 'Triage + initial severity within 5 business days.' + 'Status updates at least every 14 days until resolution.' + 'Coordinated disclosure window: 90 days from report, extendable on mutual agreement.' + 'Public credit on this page (with reporter consent) once the finding is remediated.' — pinned so the 5-state response-SLA commitment survives (drift to weakening any of the 2-day / 5-day / 14-day / 90-day windows would erode the researcher-confidence the safe-harbour rests on)", () => {
    expect(body).toMatch(/<li>Acknowledge receipt within 2 business days\.<\/li>/);
    expect(body).toMatch(/<li>Triage \+ initial severity within 5 business days\.<\/li>/);
    expect(body).toMatch(
      /<li>\s*\n?\s*Status updates at least every 14 days until resolution\.\s*\n?\s*<\/li>/,
    );
    expect(body).toMatch(
      /<li>\s*\n?\s*Coordinated disclosure window: 90 days from report,\s*\n?\s*extendable on mutual agreement\.\s*\n?\s*<\/li>/,
    );
    expect(body).toMatch(
      /<li>\s*\n?\s*Public credit on this page \(with reporter consent\) once\s*\n?\s*the finding is remediated\.\s*\n?\s*<\/li>/,
    );
  });

  it("Safe-harbour 3-state scope pinned: 'We won't pursue legal action against good-faith security research on the platform's public surface (api.driftstack.dev, driftstack.dev, app.driftstack.dev)' + 3 conditions (no other-customer-data + no availability-degradation + private-before-public) — pinned so the 3-host scope + 3-condition safe-harbour survives (drift to dropping a hostname would shrink protected surface; drift to dropping a condition would weaken the boundary on what counts as good-faith research)", () => {
    expect(body).toMatch(
      /We won't pursue legal action against good-faith security\s*\n?\s*research on the platform's public surface \(api\.driftstack\.dev,\s*\n?\s*driftstack\.dev, app\.driftstack\.dev\)/,
    );
    expect(body).toMatch(/<li>Don't access, modify, or exfiltrate other customers' data\.<\/li>/);
    expect(body).toMatch(
      /<li>Don't degrade service availability \(no load tests against prod\)\.<\/li>/,
    );
    expect(body).toMatch(/<li>Report findings privately before public disclosure\.<\/li>/);
  });

  it('Sub-processor SLA pinned. Re-enabled by slice 266 after restoring the V-550.A anchor on the RSS-feed-roadmap sentence at trust/compliance.astro:241 (anchor stripped to bare space before "lands")', () => {
    expect(body).toMatch(
      /Per GDPR Article 28\(2\) and DPA Annex 3, we provide 30 calendar\s*\n?\s*days' notice for any material change to the sub-processor list\s*\n?\s*\(additions or replacements\)\./,
    );
    expect(body).toMatch(
      /material changes are emitted as an RSS feed \(subscribe\s*\n?\s*from the same page when V-550\.A lands\)\./,
    );
  });

  it("Audit-log 3-tier retention pinned: 'Customer-facing audit log' (per-tier + dashboard + GET /v1/account/audit-log) + 'Admin audit log' (internal 365 days, customer access only via legal-process or consent) + 'Access logs' (90 days hot, 1 year cold, on-call + compliance lead only) — pinned so the 3-tier retention scope + the access controls (on-call + compliance-lead, legal-process for admin log) survive (drift to dropping the legal-process gate on admin log would weaken the access-control commitment; drift to changing the 90d/1y window would create marketing↔retention-policy divergence)", () => {
    expect(body).toMatch(/Per ADR-006:/);
    expect(body).toMatch(/Customer-facing audit log<\/span>/);
    expect(body).toMatch(/Admin audit log<\/span>/);
    expect(body).toMatch(
      /internal-only retention of 365 days for every privileged\s*\n?\s*admin action\. Customer access requires legal process or\s*\n?\s*explicit customer consent\./,
    );
    expect(body).toMatch(/Access logs<\/span>/);
    expect(body).toMatch(
      /90 days hot, 1 year cold for forensic timeline reconstruction\.\s*\n?\s*Read-restricted to the on-call engineer \+ compliance lead\./,
    );
  });

  it("Vulnerability disclosure where-to-report pinned: 'security@driftstack.dev. Use PGP if your finding involves customer data exposure (key fingerprint published on this page once available).' — pinned so the security@ routing + PGP-for-customer-data commitment + 'key fingerprint forthcoming' honest framing all survive (drift to dropping PGP-for-customer-data would force researchers to send sensitive findings unencrypted; drift to claiming a PGP key now would mislead)", () => {
    expect(body).toMatch(
      /security@driftstack\.dev<\/a\s*\n?\s*>\. Use PGP if your finding involves customer data exposure\s*\n?\s*\(key fingerprint published on this page once available\)\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
