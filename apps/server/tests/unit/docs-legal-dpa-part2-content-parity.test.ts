// W575.B — drift guard for /docs/legal/dpa.md (Part 2 of 3).
// Driftstack DPA Sections 3.6-11. Drift here either weakens the
// 48-hour breach notification target, drops the 24-hour Customer-
// Provided-Secret compromise notification target, or unsets the
// once-per-12-months audit cooperation cadence.
//
//   • 3.6 Data Subject request assistance (Articles 12-22 GDPR).
//   • 3.7 Compliance assistance (Articles 32-36 GDPR).
//   • 3.8 Deletion-or-return within 30 days of termination.
//   • 3.9 Audit cooperation: 12-month frequency + 30-day notice.
//   • Section 4 International transfers (2021 SCCs + EU-US DPF).
//   • Section 5 Customer-Provided Secrets: encrypted-at-rest, no
//     plaintext logging, 30-day deletion, 24h compromise notice.
//   • Section 6 Personal Data breaches: 48h notification target.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/legal/dpa.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W575.B /docs/legal/dpa.md (part 2) content parity', () => {
  const body = read(LIB);

  it('Section 3.6 (Data Subject requests) + 3.7 (Controller compliance) + 3.8 (deletion-or-return) + 3.9 (audit cooperation) framing pinned', () => {
    expect(body).toMatch(/### 3\.6 Assistance with Data Subject requests/);
    expect(body).toMatch(/Taking into account the nature of the Processing, Driftstack/);
    expect(body).toMatch(/assists Customer by appropriate technical and organisational/);
    expect(body).toMatch(/measures, insofar as possible, in fulfilling Customer's obligation/);
    expect(body).toMatch(/to respond to requests from Data Subjects exercising their rights/);
    expect(body).toMatch(/under Articles 12–22 GDPR \(Article 28\(3\)\(e\) GDPR\)\./);
    expect(body).toMatch(/1\. Forwards to Customer, without undue delay, any Data Subject/);
    expect(body).toMatch(/request received directly by Driftstack regarding data of which/);
    expect(body).toMatch(/Customer is the Controller\./);
    expect(body).toMatch(/2\. Provides Customer, on Customer's reasonable written request,/);
    expect(body).toMatch(/with the technical means to access, export, rectify, restrict,/);
    expect(body).toMatch(/or delete Personal Data Driftstack Processes on Customer's/);
    expect(body).toMatch(/behalf\./);
    expect(body).toMatch(/3\. Does not itself respond to a Data Subject's request regarding/);
    expect(body).toMatch(/Customer's data without Customer's instruction/);
    expect(body).toMatch(/### 3\.7 Assistance with Controller's compliance/);
    expect(body).toMatch(/compliance with Articles 32 to 36 GDPR \(Article 28\(3\)\(f\) GDPR\)/);
    expect(body).toMatch(/1\. Providing security documentation appropriate to Customer's risk/);
    expect(body).toMatch(/assessment under Article 32\./);
    expect(body).toMatch(/2\. Notifying Customer of Personal Data breaches per Section 7 of/);
    expect(body).toMatch(/this DPA \(Article 33\)\./);
    expect(body).toMatch(/3\. Cooperating with Customer's data protection impact assessments/);
    expect(body).toMatch(/\(DPIAs\) under Article 35/);
    expect(body).toMatch(/4\. Cooperating with Customer's prior consultation with the/);
    expect(body).toMatch(/supervisory authority under Article 36/);
    expect(body).toMatch(/### 3\.8 Deletion or return at end of Processing/);
    expect(body).toMatch(/Upon termination of Customer's Subscription, Driftstack:/);
    expect(body).toMatch(/1\. Deletes or returns \(at Customer's choice, exercised within 30/);
    expect(body).toMatch(/days of termination\) all Personal Data Driftstack Processes on/);
    expect(body).toMatch(/Customer's behalf, except where Union or Member State law/);
    expect(body).toMatch(/requires retention \(Article 28\(3\)\(g\) GDPR\)\./);
    expect(body).toMatch(/2\. Deletes existing copies after the return or deletion is/);
    expect(body).toMatch(/complete, except retained copies required by law \(e\.g\. Dutch tax/);
    expect(body).toMatch(/law's 7-year retention for billing records\)\./);
    expect(body).toMatch(/3\. Provides Customer with a confirmation of deletion or return on/);
    expect(body).toMatch(/Customer's written request\./);
    expect(body).toMatch(/### 3\.9 Audit cooperation/);
    expect(body).toMatch(/1\. \*\*Frequency\.\*\* Once per twelve \(12\) months/);
    expect(body).toMatch(/2\. \*\*Notice\.\*\* At least thirty \(30\) days' written notice/);
    expect(body).toMatch(/3\. \*\*Auditor\.\*\* Customer's own personnel or an independent/);
    expect(body).toMatch(/third-party auditor that is not a competitor of Driftstack/);
    expect(body).toMatch(/4\. \*\*Scope\.\*\* Limited to the systems, controls, and processes/);
    expect(body).toMatch(/relevant to the Processing of Customer's Personal Data\./);
    expect(body).toMatch(/5\. \*\*Cost\.\*\* Borne by Customer except where the audit reveals a/);
    expect(body).toMatch(/material breach by Driftstack of this DPA/);
    expect(body).toMatch(/6\. \*\*Standardised reports\.\*\* Driftstack may, in lieu of a/);
    expect(body).toMatch(/Customer-conducted audit, satisfy this obligation by providing a/);
    expect(body).toMatch(/current SOC 2 Type II report or equivalent third-party audit report/);
    expect(body).toMatch(/Driftstack does not currently hold such a/);
    expect(body).toMatch(/report; that fact does not limit Customer's audit rights above/);
  });

  it('Section 4 (international transfers + SCCs + DPF + Schrems II) + Section 5 (Customer-Provided Secrets) framing pinned', () => {
    expect(body).toMatch(/## 4\. International transfers/);
    expect(body).toMatch(/Where Driftstack transfers Personal Data outside the EEA to a/);
    expect(body).toMatch(/country without an adequacy decision under Article 45 GDPR,/);
    expect(body).toMatch(/Driftstack relies on:/);
    expect(body).toMatch(/1\. \*\*The 2021 Standard Contractual Clauses\*\* \(Commission/);
    expect(body).toMatch(/Implementing Decision \(EU\) 2021\/914\), the appropriate Module/);
    expect(body).toMatch(/per the data flow, which are incorporated by reference into/);
    expect(body).toMatch(/this DPA via \*\*Annex 4\*\*\./);
    expect(body).toMatch(/2\. \*\*The EU-US Data Privacy Framework\*\*, where the recipient is/);
    expect(body).toMatch(/self-certified at the time of transfer and the data category is/);
    expect(body).toMatch(/within the recipient's certification scope\./);
    expect(body).toMatch(/3\. \*\*Supplementary measures\*\* where required following the CJEU's/);
    expect(body).toMatch(/_Schrems II_ judgment, including the technical measures in/);
    expect(body).toMatch(/Annex 2 \(encryption in transit and at rest, key management/);
    expect(body).toMatch(/under Driftstack's control\)\./);
    expect(body).toMatch(/For the avoidance of doubt, where Driftstack and Customer act under/);
    expect(body).toMatch(/the SCCs, the SCCs prevail in case of conflict with this DPA on/);
    expect(body).toMatch(/matters of international transfer mechanism\./);
    expect(body).toMatch(/## 5\. Customer-Provided Secrets — specific obligations/);
    expect(body).toMatch(/1\. \*\*Storage\.\*\* Customer-Provided Secrets are stored encrypted at/);
    expect(body).toMatch(/rest using application-level encryption with keys managed by/);
    expect(body).toMatch(/Driftstack and rotated on a documented schedule\./);
    expect(body).toMatch(/2\. \*\*Use\.\*\* Customer-Provided Secrets are used solely to execute/);
    expect(body).toMatch(/Customer's Session instructions\./);
    expect(body).toMatch(/3\. \*\*Logging\.\*\* Driftstack does not log Customer-Provided Secrets/);
    expect(body).toMatch(/in plaintext\. Audit logs reference secrets by an opaque/);
    expect(body).toMatch(/identifier \(e\.g\. `proxy_<uuid>`\) only\./);
    expect(body).toMatch(/4\. \*\*Deletion\.\*\* Customer-Provided Secrets are deleted within 30/);
    expect(body).toMatch(/days of Customer Account termination or earlier on Customer's/);
    expect(body).toMatch(/documented request\./);
    expect(body).toMatch(/5\. \*\*Compromise\.\*\* If Driftstack determines a Customer-Provided/);
    expect(body).toMatch(/Secret has been compromised/);
    expect(body).toMatch(/notifies Customer without undue delay \(target: within 24/);
    expect(body).toMatch(/hours\)\./);
  });

  it('Section 6 (Personal Data breaches 48h) + 7 (Records) + 8 (Term) + 9 (Liability) + 10 (Conflict) + 11 (Retention) framing pinned', () => {
    expect(body).toMatch(/## 6\. Personal Data breaches/);
    expect(body).toMatch(/### 6\.1 Notification to Customer/);
    expect(body).toMatch(/Driftstack notifies Customer of any Personal Data breach affecting/);
    expect(body).toMatch(/Customer's data \*\*without undue delay\*\* after becoming aware/);
    expect(body).toMatch(/\(target: within \*\*48 hours\*\*\)/);
    expect(body).toMatch(/33\(2\) GDPR/);
    expect(body).toMatch(/1\. The nature of the breach, including the categories and/);
    expect(body).toMatch(/approximate number of Data Subjects and Personal Data records/);
    expect(body).toMatch(/affected\./);
    expect(body).toMatch(/2\. The likely consequences of the breach\./);
    expect(body).toMatch(/3\. The measures taken or proposed to address the breach and/);
    expect(body).toMatch(/mitigate its possible adverse effects\./);
    expect(body).toMatch(/4\. The contact information of the Driftstack representative/);
    expect(body).toMatch(/coordinating the response\./);
    expect(body).toMatch(/### 6\.2 Cooperation/);
    expect(body).toMatch(/Driftstack cooperates with Customer's response to the breach/);
    expect(body).toMatch(/### 6\.3 Documentation/);
    expect(body).toMatch(/Driftstack maintains records of all breaches affecting Customer/);
    expect(body).toMatch(/Article 33\(5\) GDPR/);
    expect(body).toMatch(/## 7\. Records of Processing/);
    expect(body).toMatch(/Driftstack maintains records of Processing activities under/);
    expect(body).toMatch(/Article 30\(2\) GDPR/);
    expect(body).toMatch(/## 8\. Term/);
    expect(body).toMatch(/This DPA takes effect on the Effective Date and continues for as/);
    expect(body).toMatch(/long as Driftstack Processes Personal Data on Customer's behalf,/);
    expect(body).toMatch(/plus any post-termination retention periods\./);
    expect(body).toMatch(/## 9\. Liability/);
    expect(body).toMatch(/Liability under this DPA is governed by the limitations and/);
    expect(body).toMatch(/carve-outs in Section 13 of the Terms of Service\./);
    expect(body).toMatch(/## 10\. Conflict/);
    expect(body).toMatch(/In case of conflict between this DPA and the Terms of Service or/);
    expect(body).toMatch(/any other Document on a matter of data protection, this DPA/);
    expect(body).toMatch(/prevails\./);
    expect(body).toMatch(/In case of conflict between this DPA and the SCCs \(where/);
    expect(body).toMatch(/incorporated under Annex 4\), the SCCs prevail on matters of/);
    expect(body).toMatch(/international transfer\./);
    expect(body).toMatch(/## 11\. Retention summary \(cross-reference\)/);
    expect(body).toMatch(/- Desktop-local recordings: not uploaded to or retained by/);
    expect(body).toMatch(/Customer controls retention and deletion on Customer's/);
    expect(body).toMatch(/- API Capture artifacts: returned inline; the Capture endpoint does/);
    expect(body).toMatch(/not retain the response bytes\./);
    expect(body).toMatch(/- Live-session media: not stored; streamed through LiveKit and/);
    expect(body).toMatch(/dropped on session end\./);
    expect(body).not.toMatch(/Session Recordings: Customer-controlled/);
    expect(body).not.toMatch(/1–365 days/);
    expect(body).toMatch(/- Customer-Provided Secrets: deleted within 30 days of Account/);
    expect(body).toMatch(/termination\./);
    expect(body).toMatch(/- Session metadata \(non-content\): 90 days operational; aggregated/);
    expect(body).toMatch(/counters retained indefinitely\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
