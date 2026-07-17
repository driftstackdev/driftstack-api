// W378.A — drift guard for marketing-site /legal/dpa.md content.
// Existing dpa-subprocessor-parity + sub-processors-dpa-parity cover
// sub-processor row derivation against the data source. This guard
// pins the load-bearing Article 28 GDPR processor obligations a
// procurement / DPO reviewer anchors on:
//
//   • Version 1.1 + Effective 2026-07-17.
//   • Desktop-local recordings stay outside Driftstack cloud
//     processing; Capture artifacts return inline; live media is ephemeral.
//   • §1 6-element subject-matter table (subject/duration/nature/
//     purpose/categories of data subjects/categories of personal
//     data) — Article 28(3) opening paragraph compliance.
//   • §2 roles: Customer=Controller, Driftstack=Processor.
//   • §3.1 process-only-on-documented-instructions (Art 28(3)(a))
//     + 6 categories of documented instructions.
//   • §3.4 Sub-processor obligations: general written authorisation
//     + 30-day notice + objection right + downstream contractual +
//     full Article 28(4) liability.
//   • §3.5 Customer-Connected Services NOT Sub-processors framing.
//   • §3.8 Deletion or return at end of Processing (Art 28(3)(g))
//     + 30-day choice window + confirmation-of-deletion.
//   • §3.9 audit: 12-month freq cap + 30-day notice + scope-limited
//     + cost-borne-by-Customer-unless-breach + SOC 2 Type II
//     substitution.
//   • §4 international transfers: 2021 SCCs (Decision 2021/914) +
//     EU-US DPF + Schrems II supplementary measures.
//   • §5 Customer-Provided Secrets: 5 specific obligations +
//     24-hour compromise-notification target.
//   • §6.1 48-hour processor-to-customer breach notification
//     (Art 33(2)) + 4 required-content elements.
//   • §7 records of processing (Article 30(2)).
//   • Annex 2 TOMs: 7 categories A–G.
//   • Annex 3: 13 Sub-processor rows + region-preference framing.
//   • Annex 4 SCCs: 3 module selections.
//   • Annex 5 UK/Swiss: DPA 2018 Section 119A + FADP Article 6.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/dpa.md');
const CANONICAL = resolve(REPO_ROOT, 'docs/legal/dpa.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W378.A marketing-site /legal/dpa.md content parity', () => {
  const body = read(PAGE);
  const canonical = read(CANONICAL);

  it('version 1.1 + effective 2026-07-17 is mirrored to the canonical DPA', () => {
    for (const doc of [body, canonical]) {
      expect(doc).toMatch(/\*\*Version:\*\* 1\.1 · \*\*Effective:\*\* 2026-07-17/);
    }
  });

  it('Article 28(3) GDPR structure declaration + UK GDPR / Swiss FADP applicability', () => {
    expect(body).toMatch(/structured to satisfy Article 28\(3\) GDPR/);
    expect(body).toMatch(/UK\s+GDPR, Swiss FADP/);
  });

  it('§1 subject-matter table: 6 row labels pinned', () => {
    for (const label of [
      'Subject matter',
      'Duration',
      'Nature of Processing',
      'Purpose of Processing',
      'Categories of Data Subjects',
      'Categories of Personal Data',
    ]) {
      expect(body, `subject-matter row missing: ${label}`).toMatch(
        new RegExp(`\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*`),
      );
    }
  });

  it('§2.1 Customer=Controller + §2.2 Driftstack=Processor (only-on-documented-instructions)', () => {
    expect(body).toMatch(/\*\*Customer is the Controller\*\*/);
    expect(body).toMatch(/\*\*Driftstack is the Processor\.\*\*/);
    expect(body).toMatch(/Processes Personal\s+Data only on Customer's documented instructions/);
  });

  it('§3.1 6 categories of documented instructions (ToS / DPA / AUP / API requests / config / written)', () => {
    expect(body).toMatch(/The Terms of Service/);
    expect(body).toMatch(/This DPA/);
    expect(body).toMatch(/The Acceptable Use Policy/);
    expect(body).toMatch(/The Customer's API requests \(treated as instructions\)/);
    expect(body).toMatch(/Configuration Customer sets in the GUI Client or via the API/);
    expect(body).toMatch(/Article 28\(3\)\(a\) GDPR/);
  });

  it('implemented recording/Capture/live-media processing boundary is mirrored without legacy cloud retention', () => {
    for (const doc of [body, canonical]) {
      expect(doc).toMatch(/return inline Capture artifacts, transmit ephemeral live-session media/);
      expect(doc).toMatch(
        /Desktop-local recording files remain under Customer's\s+control and outside Driftstack's cloud processing/,
      );
      expect(doc).toMatch(/\(Session, Capture, live-session, Sub-processor consent, etc\.\)/);
      expect(doc).toMatch(/Desktop-local recordings: not uploaded to or retained by\s+Driftstack/);
      expect(doc).toMatch(
        /API Capture artifacts: returned inline; the Capture endpoint does\s+not retain/,
      );
      expect(doc).toMatch(/Live-session media: not stored; streamed through LiveKit and\s+dropped/);
      expect(doc).not.toMatch(/optionally store Recordings/);
      expect(doc).not.toMatch(/Recording retention windows/);
      expect(doc).not.toMatch(/1–365 days/);
    }
  });

  it('§3.4 Sub-processor 30-day notice + objection right + Article 28(4) full liability', () => {
    expect(body).toMatch(
      /Notifies Customer of any \*\*intended addition or replacement\*\* of\s+Sub-processors at least \*\*thirty \(30\) days\*\* before that change\s+takes effect/,
    );
    expect(body).toMatch(/Permits Customer to \*\*object\*\* to the addition or replacement/);
    expect(body).toMatch(
      /Customer may terminate the\s+affected portion of the Subscription without penalty/,
    );
    expect(body).toMatch(
      /Remains \*\*fully liable to Customer\*\* for the performance of any\s+Sub-processor's obligations/,
    );
    expect(body).toMatch(/Article 28\(4\) GDPR/);
  });

  it('§3.5 Customer-Connected Services NOT Sub-processors framing (Art 28(2)/(4))', () => {
    expect(body).toMatch(/Customer-Connected Services \(HTTP\/SOCKS5 proxies, captcha-solving/);
    expect(body).toMatch(
      /They are not Sub-processors of Driftstack within the\s+meaning of Article 28\(2\) and \(4\) GDPR/,
    );
  });

  it('§3.6 Data-subject-request assistance (Articles 12–22 GDPR / Art 28(3)(e))', () => {
    expect(body).toMatch(/Articles 12–22 GDPR \(Article 28\(3\)\(e\) GDPR\)/);
    expect(body).toMatch(
      /Forwards to Customer, without undue delay, any Data Subject\s+request received directly by Driftstack/,
    );
  });

  it('§3.7 Controller-compliance assistance (Articles 32–36 / Art 28(3)(f))', () => {
    expect(body).toMatch(/Articles 32 to 36 GDPR \(Article 28\(3\)\(f\) GDPR\)/);
    expect(body).toMatch(/data protection impact assessments\s+\(DPIAs\) under Article 35/);
    expect(body).toMatch(/prior consultation with the\s+supervisory authority under Article 36/);
  });

  it('§3.8 deletion-or-return: 30-day Customer choice + Dutch tax 7-year carve-out (Art 28(3)(g))', () => {
    expect(body).toMatch(/Article 28\(3\)\(g\) GDPR/);
    expect(body).toMatch(/exercised within 30\s+days of termination/);
    expect(body).toMatch(/Dutch tax\s+law's 7-year retention/);
    expect(body).toMatch(/Provides Customer with a confirmation of deletion or return/);
  });

  it('§3.9 audit cooperation: 12-month frequency + notice + cost + truthful report substitution', () => {
    expect(body).toMatch(/Once per twelve \(12\) months/);
    expect(body).toMatch(/At least thirty \(30\) days' written notice/);
    expect(body).toMatch(/Driftstack reimburses reasonable audit costs/);
    expect(body).toMatch(/current SOC 2 Type II report or equivalent third-party audit report/);
    expect(body).toMatch(/does not currently hold such a\s+report/);
    expect(body).toMatch(/does not limit Customer's audit rights above/);
    expect(body).toMatch(/Article 28\(3\)\(h\) GDPR/);
  });

  it('§4 international transfers: 2021 SCCs (Decision 2021/914) + EU-US DPF + Schrems II', () => {
    expect(body).toMatch(
      /\*\*The 2021 Standard Contractual Clauses\*\* \(Commission\s+Implementing Decision \(EU\) 2021\/914\)/,
    );
    expect(body).toMatch(/\*\*The EU-US Data Privacy Framework\*\*/);
    expect(body).toMatch(
      /\*\*Supplementary measures\*\* where required following the CJEU's\s+_Schrems II_ judgment/,
    );
  });

  it('§5 Customer-Provided Secrets: 5 obligations pinned (storage / use / logging / deletion / compromise)', () => {
    expect(body).toMatch(
      /\*\*Storage\.\*\* Customer-Provided Secrets are stored encrypted at\s+rest/,
    );
    expect(body).toMatch(
      /\*\*Use\.\*\* Customer-Provided Secrets are used solely to execute\s+Customer's Session instructions/,
    );
    expect(body).toMatch(
      /\*\*Logging\.\*\* Driftstack does not log Customer-Provided Secrets\s+in plaintext/,
    );
    expect(body).toMatch(
      /\*\*Deletion\.\*\* Customer-Provided Secrets are deleted within 30\s+days of Customer Account termination/,
    );
    expect(body).toMatch(/\*\*Compromise\.\*\*.+target: within 24\s+hours/s);
  });

  it('§6.1 48-hour processor-to-customer breach notification target (Article 33(2))', () => {
    expect(body).toMatch(
      /\*\*without undue delay\*\* after becoming aware\s+\(target: within \*\*48 hours\*\*\)/,
    );
    expect(body).toMatch(/Article\s+33\(2\) GDPR/);
  });

  it('§6.1 4 notification-content elements pinned', () => {
    expect(body).toMatch(
      /categories and\s+approximate number of Data Subjects and Personal Data records\s+affected/,
    );
    expect(body).toMatch(/likely consequences of the breach/);
    expect(body).toMatch(/measures taken or proposed to address the breach/);
    expect(body).toMatch(
      /contact information of the Driftstack representative\s+coordinating the response/,
    );
  });

  it('§7 records of processing (Article 30(2))', () => {
    expect(body).toMatch(/Article 30\(2\) GDPR/);
  });

  it('§10 conflict: DPA prevails on data-protection matters + SCCs prevail on transfer', () => {
    expect(body).toMatch(/this DPA\s+prevails/);
    expect(body).toMatch(/the SCCs prevail on matters of\s+international transfer/);
  });

  it('Annex 2 TOMs: 7 categories A–G pinned (Confidentiality / Integrity / Availability / Restoration / Testing / Pseudonymisation / Logical separation)', () => {
    expect(body).toMatch(/### A\. Confidentiality \(Article 32\(1\)\(b\)\)/);
    expect(body).toMatch(/### B\. Integrity \(Article 32\(1\)\(b\)\)/);
    expect(body).toMatch(/### C\. Availability \+ resilience \(Article 32\(1\)\(b\)\)/);
    expect(body).toMatch(/### D\. Restoration \(Article 32\(1\)\(c\)\)/);
    expect(body).toMatch(
      /### E\. Process for testing, assessing, evaluating effectiveness \(Article 32\(1\)\(d\)\)/,
    );
    expect(body).toMatch(/### F\. Pseudonymisation \(Article 32\(1\)\(a\)\)/);
    expect(body).toMatch(/### G\. Logical separation/);
  });

  it('Annex 2.A.3 API key scrypt-hashed (matches Privacy Policy §3.2 + /trust/security-overview)', () => {
    expect(body).toMatch(/API Keys are stored as scrypt hashes/);
    expect(body).toMatch(/memory-hard parameter set documented in `apps\/server\/src\/lib`/);
  });

  it('Annex 3: 13 Sub-processor rows pinned in summary table', () => {
    for (const name of [
      'MacStadium, Inc.',
      'Stripe Payments Europe Ltd',
      'Stripe, Inc.',
      'Anthropic, PBC (conditional, opt-in only)',
      'Moneybird B.V.',
      'Hetzner Online GmbH',
      'Neon, Inc.',
      'Upstash, Inc.',
      'Cloudflare, Inc.',
      'Postmark (ActiveCampaign LLC)',
      'Sentry (Functional Software, Inc.)',
      'NowPayments OÜ (conditional, opt-in only)',
      'LiveKit (conditional, opt-in only)',
    ]) {
      expect(body, `annex-3 sub-processor missing: ${name}`).toContain(name);
    }
  });

  it('Annex 3 region-preference vs region-routing honesty framing + /trust/sub-processors cross-link', () => {
    expect(body).toMatch(/\*\*Region preference vs\. region routing\.\*\*/);
    // S43 2026-07-07 (founder-approved) — the old "all Customer Data
    // resides on the EU-jurisdiction infrastructure" blanket claim was
    // false for R2-held file objects (default jurisdiction, EU + US
    // replication). Now scoped: database data EU-resident; R2 file
    // objects replicate EU + US under the listed transfer mechanism.
    expect(body).toMatch(
      /Customer Data held in Driftstack's databases \(account,\s+profile, session, and audit data\) resides on the EU-resident\s+infrastructure/,
    );
    expect(body).toMatch(
      /use R2's default jurisdiction, which replicates\s+storage\s+between the EU and the US under the transfer mechanism listed above/,
    );
    expect(body).not.toMatch(/all\s+Customer Data resides on the EU-jurisdiction infrastructure/);
    expect(body).toMatch(
      /Any change to a Sub-processor or processing location remains subject\s+to Section 3\.4 notice and objection rights/,
    );
    expect(body).not.toMatch(/multi-region\s+rollout|informational for v1/i);
    expect(body).toMatch(/\[`\/trust\/sub-processors`\]\(\/trust\/sub-processors\/\)/);
  });

  it('Annex 2 availability promises stay operational and the public status page is current', () => {
    expect(body).toMatch(/Fleet capacity and redundancy are managed\s+operationally/);
    expect(body).toMatch(
      /Any contractually binding availability or\s+redundancy commitment is stated in Customer's applicable Order\s+Form or published SLA/,
    );
    expect(body).toMatch(/public status page at `status\.driftstack\.dev`/);
    expect(body).not.toMatch(/status page planned|at launch/i);
  });

  it('Annex 4 SCCs: 3 module selections (no-SCC-internal / Module 3 sub-processor / Module 1+3 controller-capacity)', () => {
    expect(body).toMatch(/No\s+SCC needed for Driftstack itself \(EEA-internal\)/);
    expect(body).toMatch(/Module 3 \(processor-to-\(sub\)processor\)/);
    expect(body).toMatch(
      /Module 1 \(controller-to-controller\) for\s+the data flowing in that capacity, and Module 3 for the\s+Processor-side flow/,
    );
  });

  it('Annex 5 UK + Swiss addenda: DPA 2018 Section 119A + FADP Article 6', () => {
    expect(body).toMatch(
      /\*\*UK International Data Transfer\s+Addendum\*\* \(issued under Section 119A Data Protection Act 2018/,
    );
    expect(body).toMatch(/mandatory from 21 March 2024/);
    expect(body).toMatch(/FADP Article 6 obligation\s+on cross-border transfers/);
    expect(body).toMatch(/FDPIC is the relevant\s+supervisory authority/);
  });

  it('cross-links: terms.md + privacy.md', () => {
    expect(body).toMatch(/\[Terms of Service\]\(\/legal\/terms\/\)/);
    expect(body).toMatch(/\[Privacy Policy\]\(\/legal\/privacy\/#9-retention\)/);
    const dir = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal');
    expect(existsSync(resolve(dir, 'terms.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'privacy.md'))).toBe(true);
  });

  it('Contact: privacy@ + legal@driftstack.dev + Driftstack B.V. Amsterdam', () => {
    expect(body).toMatch(/Privacy: `privacy@driftstack\.dev`/);
    expect(body).toMatch(/Legal: `legal@driftstack\.dev`/);
    expect(body).toMatch(/Driftstack B\.V\., Amsterdam, the Netherlands/);
  });
});
