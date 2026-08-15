// W577.C — drift guard for /docs/legal/privacy-policy.md (Part 3 of 3).
// Driftstack Privacy Policy Version 1.1 (2026-07-17). Drift here either
// weakens the §8 Customer-Connected-Services-NOT-Sub-processors invariant,
// drops a §9 retention-schedule slot (Account 7yr / Auth 90d /
// Session-metadata 90d / local recordings / inline Captures / ephemeral
// live media / Secrets 30d-post-term / Billing 7yr / Support 3yr /
// Marketing-logs 30d), removes a §10 Art-15-22
// DSR right, breaks the §11 DPO-threshold policy, unsets the §13 72h
// breach-notification window, or loosens the §14 under-16 children posture.
//
//   • §8: CCS (proxies / captcha / email / SMS) NOT Sub-processors.
//   • §9: 8-row retention schedule.
//   • §10: Article 15-22 GDPR Data Subject Rights (incl. Art 20 audit-log
//     export at /v1/account/audit-log/export, 10,000-row ceiling).
//   • §11: DPO-threshold policy (1M sessions / 5,000 unique DS / AP guidance).
//   • §13: 72h supervisory authority + 48h Customer (Processor) windows.
//   • Part 3: sections 8-16 (CCS through Contact).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/legal/privacy-policy.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W577.C /docs/legal/privacy-policy.md (part 3) content parity', () => {
  const body = read(LIB);

  it('Section 8 (Customer-Connected Services NOT Sub-processors) 4-prong list framing pinned', () => {
    expect(body).toMatch(/## 8\. Customer-Connected Services \(NOT Sub-processors\)/);
    expect(body).toMatch(/The following third-party services are integrated with the Service/);
    expect(body).toMatch(/under \*\*Customer's\*\* account, \*\*Customer's\*\* credentials, and/);
    expect(body).toMatch(/\*\*Customer's\*\* contractual relationship\./);
    expect(body).toMatch(/They are \*\*not\*\*/);
    expect(body).toMatch(/Sub-processors of Driftstack:/);
    expect(body).toMatch(
      /1\. \*\*HTTP \/ SOCKS5 proxy providers\*\* \(e\.g\. Bright Data, Smartproxy,/,
    );
    expect(body).toMatch(/Customer's own infrastructure\)\./);
    expect(body).toMatch(/2\. \*\*Captcha-solving services\*\* \(e\.g\. 2Captcha, CapSolver,/);
    expect(body).toMatch(/AntiCaptcha\)\./);
    expect(body).toMatch(/3\. \*\*Email services\*\* Customer accesses by IMAP, Gmail OAuth, or/);
    expect(body).toMatch(/equivalent\./);
    expect(body).toMatch(/4\. \*\*SMS-verification services\*\* \(e\.g\. TextVerified, Twilio\)\./);
    expect(body).toMatch(/Driftstack does not contract with these providers/);
  });

  it('Section 9 retention schedule + local/inline/ephemeral artifact boundaries + AWR-Art-52 7yr framing pinned', () => {
    expect(body).toMatch(/## 9\. Retention/);
    expect(body).toMatch(
      /\| Account data\s+\| Duration of Subscription \+ 7 years post-termination/,
    );
    expect(body).toMatch(/Article 52 _Algemene wet inzake rijksbelastingen_ — 7-year retention/);
    expect(body).toMatch(
      /\| Authentication data \(hashed API keys, key metadata\) \| Until revocation/,
    );
    // This row promised DELETION until 2026-08-15, and nothing could honour it:
    // `api_keys` is RESTRICT-referenced by admin_audit_log, incidents,
    // incident_updates, rate_limit_overrides and sessions, so the row cannot be
    // deleted at all. The retention sweeper ANONYMISES in place. The pin froze
    // the promise rather than the behaviour — the negative below keeps the
    // unhonourable wording from coming back.
    expect(body).toMatch(
      /90 days after revocation the record is anonymised — the key hash and key name are destroyed\./,
    );
    expect(body).not.toMatch(/revoked records retained 90 days for audit then deleted/);
    expect(body).toMatch(/\| Session metadata\s+\| 90 days operational/);
    expect(body).toMatch(
      /\| Desktop-local recordings\s+\| Not uploaded to or retained by Driftstack/,
    );
    expect(body).toMatch(/\| API Capture artifacts\s+\| Returned inline to Customer/);
    expect(body).toMatch(/\| Live-session media\s+\| Not stored by Driftstack/);
    expect(body).not.toMatch(/\| Session Recordings\s+\|/);
    expect(body).not.toMatch(/1–365 days/);
    expect(body).toMatch(
      /\| Customer-Provided Secrets\s+\| Deleted within 30 days of Customer Account termination/,
    );
    expect(body).toMatch(
      /\| Billing data\s+\| 7 years post-transaction \(Dutch tax law, AWR Art 52\)\./,
    );
    expect(body).toMatch(/\| Support correspondence\s+\| 3 years post-resolution\./);
    expect(body).toMatch(/\| Marketing-site access logs\s+\| 30 days\./);
    expect(body).toMatch(/Anonymised aggregates may be/);
    expect(body).toMatch(/retained for capacity planning\./);
  });

  it('Section 10 (DSR Art 15-22 GDPR) + audit-log Art 20 + AP supervisory authority framing pinned', () => {
    expect(body).toMatch(/## 10\. Data subject rights/);
    expect(body).toMatch(/Where Driftstack acts as Controller for Personal Data of a Data/);
    expect(body).toMatch(/Subject, the Data Subject has the rights set out in Articles 15–22/);
    expect(body).toMatch(/GDPR:/);
    expect(body).toMatch(/- \*\*Right of access\*\* \(Article 15\)/);
    expect(body).toMatch(/- \*\*Right to rectification\*\* \(Article 16\)/);
    expect(body).toMatch(/- \*\*Right to erasure\*\* \("right to be forgotten" — Article 17\)/);
    expect(body).toMatch(/- \*\*Right to restriction of processing\*\* \(Article 18\)/);
    expect(body).toMatch(/- \*\*Right to data portability\*\* \(Article 20\)/);
    expect(body).toMatch(
      /audit-log export at `\/v1\/account\/audit-log\/export\?format=csv\|json`/,
    );
    expect(body).toMatch(/Maximum 10,000 rows per export/);
    expect(body).toMatch(/- \*\*Right to object\*\* \(Article 21\)/);
    expect(body).toMatch(/- \*\*Rights related to automated individual decision-making,/);
    expect(body).toMatch(/including profiling\*\* \(Article 22\)/);
    expect(body).toMatch(/Driftstack responds within one \(1\) month of receipt of the request/);
    expect(body).toMatch(/extendable by two \(2\) further months/);
    expect(body).toMatch(/\*\*Right to lodge a complaint with a supervisory authority\*\*/);
    expect(body).toMatch(/\*\*Autoriteit Persoonsgegevens\*\* \(Dutch DPA\), Postbus 93374, 2509/);
    expect(body).toMatch(/AJ Den Haag, the Netherlands/);
  });

  it('Section 11 (DPO/Privacy Contact) DPO-threshold policy framing pinned', () => {
    expect(body).toMatch(/## 11\. Data Protection Officer \/ Privacy Contact/);
    expect(body).toMatch(/Driftstack has assessed its DPO obligations under Article 37\(1\)\(b\)/);
    expect(body).toMatch(/GDPR and concluded that, at current scale, the threshold for/);
    expect(body).toMatch(/mandatory DPO appointment is not met\./);
    expect(body).toMatch(/1\. Total monthly active sessions across the Service exceed 1/);
    expect(body).toMatch(/million; \*\*or\*\*/);
    expect(body).toMatch(/2\. Any single Customer's monthly Sessions involve regular and/);
    expect(body).toMatch(/systematic monitoring of more than 5,000 unique Data Subjects;/);
    expect(body).toMatch(/\*\*or\*\*/);
    expect(body).toMatch(/3\. The Autoriteit Persoonsgegevens issues guidance applying the/);
    expect(body).toMatch(/Article 37\(1\)\(b\) threshold to similar services\./);
    expect(body).toMatch(/- Privacy Contact: `privacy@driftstack\.dev`/);
  });

  it('Section 12 (Security TOM) + Section 13 (Breach 72h+48h+34) framing pinned', () => {
    expect(body).toMatch(/## 12\. Security/);
    expect(body).toMatch(/Driftstack implements technical and organisational measures/);
    expect(body).toMatch(/appropriate to the risk under Article 32 GDPR\./);
    expect(body).toMatch(/1\. \*\*Encryption in transit:\*\* TLS 1\.2\+ for all API and Service/);
    expect(body).toMatch(/traffic\./);
    expect(body).toMatch(/2\. \*\*Encryption at rest:\*\* disk-level encryption on the Postgres/);
    expect(body).toMatch(/3\. \*\*Access control:\*\* role-based access to production systems/);
    expect(body).toMatch(/4\. \*\*API authentication:\*\* scrypt-hashed API Keys/);
    expect(body).toMatch(/5\. \*\*Audit logging:\*\*/);
    expect(body).toMatch(/6\. \*\*Backup:\*\* Postgres point-in-time recovery/);
    expect(body).toMatch(/7\. \*\*Vulnerability management:\*\*/);
    expect(body).toMatch(/8\. \*\*Incident response:\*\*/);
    expect(body).toMatch(/## 13\. Breach notification/);
    expect(body).toMatch(/Where Driftstack identifies a Personal Data breach within the/);
    expect(body).toMatch(/meaning of Article 4\(12\) GDPR:/);
    expect(body).toMatch(/1\. \*\*Notification to the supervisory authority\.\*\*/);
    expect(body).toMatch(/notifies the Autoriteit Persoonsgegevens \(or the lead/);
    expect(body).toMatch(/supervisory authority if different\) within 72 hours of becoming/);
    expect(body).toMatch(/aware of the breach/);
    expect(body).toMatch(
      /2\. \*\*Notification to Customer \(where Driftstack is Processor\)\.\*\*/,
    );
    expect(body).toMatch(/Driftstack notifies Customer without undue delay \(target: within/);
    expect(body).toMatch(/48 hours of becoming aware\)/);
    expect(body).toMatch(/3\. \*\*Notification to Data Subjects \(where Driftstack is Controller/);
    expect(body).toMatch(/and Article 34 applies\)\.\*\*/);
  });

  it('Section 14 (Children under 16) + Section 15 (Updates 30-day) + Section 16 (Contact) framing pinned', () => {
    expect(body).toMatch(/## 14\. Children/);
    expect(body).toMatch(/The Service is not directed to and is not intended for use by/);
    expect(body).toMatch(/children\./);
    expect(body).toMatch(/Driftstack does not knowingly collect Personal Data of/);
    expect(body).toMatch(/children under 16/);
    expect(body).toMatch(/## 15\. Updates to this Privacy Policy/);
    expect(body).toMatch(/Material updates take effect no earlier than 30 days after/);
    expect(body).toMatch(/notification \(in-product banner or email to Customer's billing/);
    expect(body).toMatch(/contact\)\./);
    expect(body).toMatch(/Non-material updates \(typo,/);
    expect(body).toMatch(/formatting, clarification\) take effect immediately on publication\./);
    expect(body).toMatch(/## 16\. Contact/);
    expect(body).toMatch(/- Privacy: `privacy@driftstack\.dev`/);
    expect(body).toMatch(/- Legal: `legal@driftstack\.dev`/);
    expect(body).toMatch(
      /- Postal correspondence: addressed to Driftstack B\.V\., Amsterdam, the Netherlands\./,
    );
    expect(body).toMatch(/_End of Privacy Policy\._/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
