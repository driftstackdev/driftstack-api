// W506.B — drift guard for apps/marketing-site/src/pages/legal/dpa.md.
// Data Processing Agreement v1.1 — Article 28 GDPR Processor terms.
// Drift here either weakens an Article 28(3)(a)-(h) obligation (would
// breach contractual commitment to GDPR-compliant Customer base) or
// breaks the Customer-Connected-Services-are-NOT-Sub-processors
// delineation that the AUP and Privacy Policy both rest on.
//
//   • Version 1.1 + Article 28(3) satisfaction + UK GDPR / Swiss FADP
//     extension.
//   • Section 1 subject-matter-duration-nature-purpose 6-row table.
//   • Section 2 roles: Customer is Controller, Driftstack is Processor.
//   • Section 3.1–3.9 Driftstack obligations (Article 28(3)(a)-(h) +
//     audit cooperation).
//   • Section 3.5 Customer-Connected Services NOT Sub-processors.
//   • Section 4 international transfers: 2021 SCCs + EU-US DPF +
//     Schrems II supplementary measures.
//   • Section 5 Customer-Provided Secrets specific obligations.
//   • Section 6 breach notification: 48h-target + 4-content-field.
//   • Annex 1-5: data description / TOMs / sub-processors / SCCs /
//     UK + Swiss addenda.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/dpa.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W506.B apps/marketing-site/src/pages/legal/dpa.md content parity', () => {
  const body = read(LIB);

  it("Version 1.1 effective 2026-07-17 + Article 28(3) GDPR satisfaction structure pinned: 'This DPA is structured to satisfy Article 28(3) GDPR. To the extent applicable to a Customer's processing in another jurisdiction (UK GDPR, Swiss FADP), this DPA's provisions read with the corresponding provisions of those regimes.' — pinned so the Article-28(3) anchor + UK-GDPR + Swiss-FADP cross-regime extension survive (drift to dropping the multi-regime read-through would orphan UK/Swiss customers from contractual coverage)", () => {
    expect(body).toMatch(/\*\*Version:\*\* 1\.1 · \*\*Effective:\*\* 2026-07-17/);
    expect(body).toMatch(
      /This DPA is structured to satisfy Article 28\(3\) GDPR\. To the extent\s*\n?\s*applicable to a Customer's processing in another jurisdiction \(UK\s*\n?\s*GDPR, Swiss FADP\), this DPA's provisions read with the corresponding\s*\n?\s*provisions of those regimes\./,
    );
  });

  it("Section 2.1 Customer-is-Controller + 2.2 Driftstack-is-Processor + 2.3 Customer-customer-chain framing — pinned so the GDPR-role split + the B2B2B accountability-chain commitment survive (drift to dropping 2.3 would orphan customers who themselves run B2B SaaS atop Driftstack; drift to softening 'Customer is the Controller' would shift contractual responsibility incorrectly)", () => {
    expect(body).toMatch(
      /2\.1 \*\*Customer is the Controller\*\* of the Personal Data processed\s*\n?\s*under this DPA\./,
    );
    expect(body).toMatch(/2\.2 \*\*Driftstack is the Processor\.\*\*/);
    expect(body).toMatch(
      /2\.3 \*\*Where Customer's Customer is itself a Data Subject's\s*\n?\s*Controller\*\*/,
    );
  });

  it("Section 3.1 documented-instructions 6-list: Terms + DPA + AUP + API requests + GUI/API configuration + written-DPA-referencing-instruction — pinned so the 6-source documented-instructions definition + the Article 28(3)(a) anchor + the 'API request as instruction' commitment survive (drift to dropping the API-requests-as-instructions item would orphan the operational reality from the contractual definition)", () => {
    expect(body).toMatch(/### 3\.1 Process only on documented instructions/);
    expect(body).toMatch(/\(Article 28\(3\)\(a\) GDPR\)\./);
    expect(body).toMatch(/The Terms of Service\./);
    expect(body).toMatch(/This DPA\./);
    expect(body).toMatch(/The Acceptable Use Policy\./);
    expect(body).toMatch(/The Customer's API requests \(treated as instructions\)\./);
    expect(body).toMatch(
      /Configuration Customer sets in the GUI Client or via the API\s*\n?\s*\(Session, Capture, live-session, Sub-processor consent, etc\.\)\./,
    );
    expect(body).toMatch(
      /Any documented instruction Customer provides to Driftstack in\s*\n?\s*writing referencing this DPA\./,
    );
  });

  it('implemented local-recording, inline-Capture, and ephemeral-live-media boundary replaces fictional cloud recording', () => {
    expect(body).toMatch(/return inline Capture artifacts, transmit ephemeral live-session media/);
    expect(body).toMatch(
      /Desktop-local recording files remain under Customer's\s*\n?\s*control and outside Driftstack's cloud processing/,
    );
    expect(body).toMatch(
      /Desktop-local recordings: not uploaded to or retained by\s*\n?\s*Driftstack/,
    );
    expect(body).toMatch(
      /API Capture artifacts: returned inline; the Capture endpoint does\s*\n?\s*not retain/,
    );
    expect(body).toMatch(
      /Live-session media: not stored; streamed through LiveKit and\s*\n?\s*dropped/,
    );
    expect(body).not.toMatch(/optionally store Recordings/);
    expect(body).not.toMatch(/Recording retention windows/);
    expect(body).not.toMatch(/1–365 days/);
  });

  it("Section 3.4 Sub-processors 5-commitment pinned: general written authorisation (Annex 3) + 30-day notice + Customer objection right + downstream contractual obligations no-less-protective + fully-liable-for-Sub-processor (Article 28(4)) — pinned so the 5-state Sub-processor regime survives (drift to dropping 'fully liable' would close off the customer-recovery path for Sub-processor failures; drift to softening the 30-day window would breach Article 28(2))", () => {
    expect(body).toMatch(
      /Provides Customer with \*\*general written authorisation\*\* to\s*\n?\s*engage the Sub-processors listed in \*\*Annex 3\*\*/,
    );
    expect(body).toMatch(/\*\*thirty \(30\) days\*\* before that change\s*\n?\s*takes effect/);
    expect(body).toMatch(
      /Permits Customer to \*\*object\*\* to the addition or replacement on\s*\n?\s*reasonable grounds/,
    );
    expect(body).toMatch(
      /Imposes \*\*contractual obligations on each Sub-processor\*\* that\s*\n?\s*are no less protective than those in this DPA/,
    );
    expect(body).toMatch(
      /Remains \*\*fully liable to Customer\*\* for the performance of any\s*\n?\s*Sub-processor's obligations \(Article 28\(4\) GDPR\)\./,
    );
  });

  it("Section 3.5 Customer-Connected Services NOT Sub-processors pinned: 'Customer-Connected Services (HTTP/SOCKS5 proxies, captcha-solving services, email services accessed by Customer's credentials, SMS services accessed by Customer's credentials) operate under **Customer's** account, **Customer's** credentials, and **Customer's** contractual relationship... They are not Sub-processors of Driftstack within the meaning of Article 28(2) and (4) GDPR.' — pinned so the explicit NOT-Sub-processor delineation + the 4-Customer-Connected-Service list + the Article-28(2)/(4) statute anchor all survive (drift to merging would create marketing↔DPA-Annex-3 + AUP §3.2 divergence)", () => {
    expect(body).toMatch(/### 3\.5 Customer-Connected Services are NOT Sub-processors/);
    expect(body).toMatch(
      /Customer-Connected Services \(HTTP\/SOCKS5 proxies, captcha-solving\s*\n?\s*services, email services accessed by Customer's credentials, SMS\s*\n?\s*services accessed by Customer's credentials\) operate under\s*\n?\s*\*\*Customer's\*\* account, \*\*Customer's\*\* credentials, and\s*\n?\s*\*\*Customer's\*\* contractual relationship/,
    );
    expect(body).toMatch(
      /They are not Sub-processors of Driftstack within the\s*\n?\s*meaning of Article 28\(2\) and \(4\) GDPR\./,
    );
  });

  it("Section 3.8 deletion-or-return at end of Processing: 'Deletes or returns (at Customer's choice, exercised within 30 days of termination) all Personal Data Driftstack Processes on Customer's behalf, except where Union or Member State law requires retention (Article 28(3)(g) GDPR).' + Dutch tax law 7-year carve-out — pinned so the customer-choice + 30-day-exercise-window + Article 28(3)(g) anchor + Dutch-tax-law-7-year carve-out all survive (drift to dropping the customer-choice would force one path; drift to dropping the 30d-exercise would let the choice slip silently to deletion)", () => {
    expect(body).toMatch(
      /Deletes or returns \(at Customer's choice, exercised within 30\s*\n?\s*days of termination\) all Personal Data Driftstack Processes on\s*\n?\s*Customer's behalf, except where Union or Member State law\s*\n?\s*requires retention \(Article 28\(3\)\(g\) GDPR\)\./,
    );
    expect(body).toMatch(/Dutch tax\s*\n?\s*law's 7-year retention for billing records/);
  });

  it("Section 3.9 audit cooperation 6-condition: 12-month frequency + 30-day notice + non-competitor-auditor + scope-limited + Customer-cost-default-except-material-breach + SOC-2-Type-II-substitution — pinned so the 6-audit-condition envelope survives (drift to dropping the 'except where supervisory authority' carve-out would block regulator-led audits; drift to dropping SOC-2-Type-II-substitution would force every audit through Customer-conducted inspection)", () => {
    expect(body).toMatch(
      /\*\*Frequency\.\*\* Once per twelve \(12\) months, except where \(a\)\s*\n?\s*required by a supervisory authority, or \(b\) following a\s*\n?\s*substantiated Personal Data breach affecting Customer\./,
    );
    expect(body).toMatch(/\*\*Notice\.\*\* At least thirty \(30\) days' written notice/);
    expect(body).toMatch(
      /\*\*Auditor\.\*\* Customer's own personnel or an independent\s*\n?\s*third-party auditor that is not a competitor of Driftstack/,
    );
    expect(body).toMatch(
      /\*\*Cost\.\*\* Borne by Customer except where the audit reveals a\s*\n?\s*material breach by Driftstack of this DPA/,
    );
    expect(body).toMatch(
      /\*\*Standardised reports\.\*\* Driftstack may, in lieu of a\s*\n?\s*Customer-conducted audit, satisfy this obligation by providing a\s*\n?\s*current SOC 2 Type II report or equivalent third-party audit report/,
    );
    expect(body).toMatch(/does not currently hold such a\s*\n?\s*report/);
    expect(body).toMatch(/does not limit Customer's audit rights above/);
  });

  it("Section 4 international transfers 3-mechanism + Schrems II supplementary measures pinned: '**The 2021 Standard Contractual Clauses** (Commission Implementing Decision (EU) 2021/914)' + '**The EU-US Data Privacy Framework**' + '**Supplementary measures** where required following the CJEU's _Schrems II_ judgment' — pinned so the 3-transfer-mechanism + Schrems-II-supplementary-measures + 'SCCs prevail in case of conflict' commitment all survive (drift to dropping Schrems II would weaken the post-2020 transfer-compliance posture; drift to dropping 'SCCs prevail in case of conflict' would create ambiguity on which doc wins)", () => {
    expect(body).toMatch(
      /\*\*The 2021 Standard Contractual Clauses\*\* \(Commission\s*\n?\s*Implementing Decision \(EU\) 2021\/914\)/,
    );
    expect(body).toMatch(/\*\*The EU-US Data Privacy Framework\*\*/);
    expect(body).toMatch(
      /\*\*Supplementary measures\*\* where required following the CJEU's\s*\n?\s*_Schrems II_ judgment/,
    );
    expect(body).toMatch(
      /where Driftstack and Customer act under\s*\n?\s*the SCCs, the SCCs prevail in case of conflict with this DPA on\s*\n?\s*matters of international transfer mechanism\./,
    );
  });

  it("Section 5 Customer-Provided Secrets 5-obligation: Storage (app-level encryption + key rotation) + Use (Customer instruction only) + Logging (opaque-identifier-only) + Deletion (30d-post-termination) + Compromise (24h-target notice) — pinned so the 5-state Customer-Provided-Secrets specific-obligation stack survives (drift to dropping the 24h-compromise-notice would weaken the breach-detection commitment; drift to dropping 'opaque identifier' would let plaintext secrets slip into audit logs)", () => {
    expect(body).toMatch(
      /\*\*Storage\.\*\* Customer-Provided Secrets are stored encrypted at\s*\n?\s*rest/,
    );
    expect(body).toMatch(
      /\*\*Use\.\*\* Customer-Provided Secrets are used solely to execute\s*\n?\s*Customer's Session instructions/,
    );
    expect(body).toMatch(
      /\*\*Logging\.\*\* Driftstack does not log Customer-Provided Secrets\s*\n?\s*in plaintext\. Audit logs reference secrets by an opaque\s*\n?\s*identifier \(e\.g\. `proxy_<uuid>`\) only\./,
    );
    expect(body).toMatch(
      /\*\*Deletion\.\*\* Customer-Provided Secrets are deleted within 30\s*\n?\s*days of Customer Account termination/,
    );
    expect(body).toMatch(
      /\*\*Compromise\.\*\*.+?notifies Customer without undue delay \(target: within 24\s*\n?\s*hours\)/s,
    );
  });

  it('Section 6.1 breach notification: 48h-target to Customer + Article 33(2) anchor + 4-field notification content (nature + likely consequences + measures + contact) — pinned so the 4-state breach notification + the Article 33(2) statutory anchor all survive (drift to weakening the 48h target would breach DPA commitment; drift to dropping the 4-content-fields would let notifications skip GDPR-mandated detail)', () => {
    expect(body).toMatch(
      /Driftstack notifies Customer of any Personal Data breach affecting\s*\n?\s*Customer's data \*\*without undue delay\*\* after becoming aware\s*\n?\s*\(target: within \*\*48 hours\*\*\)/,
    );
    expect(body).toMatch(/\(Article\s*\n?\s*33\(2\) GDPR\)/);
    expect(body).toMatch(
      /The nature of the breach, including the categories and\s*\n?\s*approximate number of Data Subjects and Personal Data records\s*\n?\s*affected\./,
    );
    expect(body).toMatch(/The likely consequences of the breach\./);
    expect(body).toMatch(/The measures taken or proposed to address the breach/);
    expect(body).toMatch(
      /The contact information of the Driftstack representative\s*\n?\s*coordinating the response\./,
    );
  });

  it("Annex 2 TOMs 7-section taxonomy: A Confidentiality + B Integrity + C Availability + D Restoration + E Process-for-testing + F Pseudonymisation + G Logical separation — pinned so the 7-TOM-section structure stays consistent with Article 32(1) (drift to dropping 'F Pseudonymisation' would orphan the Article 32(1)(a) commitment; drift to dropping 'G Logical separation' would weaken the per-tenant-isolation commitment)", () => {
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

  it('pins current region routing and existing Section 3.4 change rights without a rollout promise', () => {
    expect(body).toMatch(/\*\*Region preference vs\. region routing\.\*\*/);
    expect(body).toMatch(
      /Customer may state an\s*\n?\s*infrastructure region preference \(one of `us` \/ `eu` \/ `apac`\) via\s*\n?\s*the dashboard or API\. The preference does not change current data\s*\n?\s*residency: Customer Data held in Driftstack's databases \(account,\s*\n?\s*profile, session, and audit data\) resides on the EU-resident/,
    );
    expect(body).toMatch(/file objects held in Cloudflare R2/);
    expect(body).toMatch(
      /customer-uploaded avatars, encrypted profile blobs, public\s+status\s+snapshots/,
    );
    expect(body).toMatch(
      /use R2's default jurisdiction, which replicates storage\s+between the EU and the US under the transfer mechanism listed above/,
    );
    expect(body).not.toMatch(
      /all\s*\n?\s*Customer Data resides on the EU-jurisdiction infrastructure/,
    );
    expect(body).toMatch(
      /Any change to a Sub-processor or processing location remains subject\s+to Section 3\.4 notice and objection rights/,
    );
    expect(body).not.toMatch(/multi-region\s*\n?\s*rollout|informational for v1/i);
  });

  it('keeps redundancy operational, contractual commitments bounded, and the status page current', () => {
    expect(body).toMatch(/Fleet capacity and redundancy are managed\s*\n?\s*operationally/);
    expect(body).toMatch(
      /Any contractually binding availability or\s*\n?\s*redundancy commitment is stated in Customer's applicable Order\s*\n?\s*Form or published SLA/,
    );
    expect(body).toMatch(/public status page at `status\.driftstack\.dev`/);
    expect(body).not.toMatch(/status page planned|at launch/i);
  });

  it('Annex 4 SCC Module selections 3-module map: Module 1 controller-to-controller + Module 2 (no SCC for Customer→Driftstack EEA-internal) + Module 3 processor-to-(sub)processor — pinned so the SCC-Module selection survives (drift to a different module mapping would create SCC-compliance divergence)', () => {
    expect(body).toMatch(/Module 3 \(processor-to-\(sub\)processor\)\./);
    expect(body).toMatch(/Module 1 \(controller-to-controller\)/);
    expect(body).toMatch(/No\s*\n?\s*SCC needed for Driftstack itself \(EEA-internal\)\./);
  });

  it("Annex 5 UK Data Transfer Addendum + Swiss FDPIC FADP addenda pinned: 'For UK Personal Data, the **UK International Data Transfer Addendum** (issued under Section 119A Data Protection Act 2018, mandatory from 21 March 2024 for new transfers)' + Swiss FDPIC FADP Article 6 anchor — pinned so the UK + Swiss addenda anchors stay specific (drift to dropping the 21-March-2024 mandatory-date would orphan UK transfer compliance for new agreements; drift to dropping FDPIC reference would weaken the Swiss-supervisory-authority anchor)", () => {
    expect(body).toMatch(
      /\*\*UK International Data Transfer\s*\n?\s*Addendum\*\* \(issued under Section 119A Data Protection Act 2018,\s*\n?\s*mandatory from 21 March 2024 for new transfers\)/,
    );
    expect(body).toMatch(/Swiss FDPIC\s*\n?\s*guidance on EU SCCs as adopted in Switzerland/);
    expect(body).toMatch(
      /the FADP Article 6 obligation\s*\n?\s*on cross-border transfers is satisfied; the FDPIC is the relevant\s*\n?\s*supervisory authority\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
