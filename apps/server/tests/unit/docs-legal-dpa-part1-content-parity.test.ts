// W575.A — drift guard for /docs/legal/dpa.md (Part 1 of 3).
// Driftstack DPA Version 1.1 (2026-07-17). Drift here either weakens
// the Article 28(3) GDPR structural conformity, drops the Customer-
// Connected-Services-are-NOT-Sub-processors invariant, or unsets the
// 30-day Sub-processor notice + objection window.
//
//   • DPA Version 1.1. Effective 2026-07-17.
//   • Article 28(3) GDPR structured. UK GDPR + Swiss FADP applicable.
//   • Roles: Customer = Controller; Driftstack = Processor.
//   • Sub-processor: 30-day notice + objection + commercial-alt path.
//   • Customer-Connected Services NOT Sub-processors.
//   • Part 1: header + sections 1-2-3.1-3.5.

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

describe('W575.A /docs/legal/dpa.md (part 1) content parity', () => {
  const body = read(LIB);

  it('Header + Version-1.1 + 2026-07-17 + ToS-incorporation + Article-28(3)-GDPR + UK-GDPR + Swiss-FADP framing pinned', () => {
    expect(body).toMatch(/^# Driftstack — Data Processing Agreement$/m);
    expect(body).toMatch(/\*\*Version:\*\* 1\.1 · \*\*Effective:\*\* 2026-07-17/);
    expect(body).toMatch(/This Data Processing Agreement \("\*\*DPA\*\*"\) forms part of the/);
    expect(body).toMatch(
      /\[Terms of Service\]\(terms-of-service\.md\) between Driftstack B\.V\. \(the/,
    );
    expect(body).toMatch(
      /"\*\*Processor\*\*" or "\*\*Driftstack\*\*"\) and Customer \(the "\*\*Controller\*\*"/,
    );
    expect(body).toMatch(/or "\*\*Customer\*\*"\)\./);
    expect(body).toMatch(
      /Capitalised terms are defined in \[`definitions\.md`\]\(definitions\.md\)\./,
    );
    expect(body).toMatch(/This DPA is structured to satisfy Article 28\(3\) GDPR\./);
    expect(body).toMatch(/To the extent/);
    expect(body).toMatch(/applicable to a Customer's processing in another jurisdiction \(UK/);
    expect(body).toMatch(/GDPR, Swiss FADP\), this DPA's provisions read with the corresponding/);
    expect(body).toMatch(/provisions of those regimes\./);
  });

  it('Section 1 (Subject matter table) + Section 2 (Roles) framing pinned', () => {
    expect(body).toMatch(/## 1\. Subject matter, duration, nature, and purpose/);
    expect(body).toMatch(
      /\| \*\*Subject matter\*\*\s+\| Processing of Personal Data by Driftstack as Processor on Customer's behalf in the course of providing the Service\./,
    );
    expect(body).toMatch(
      /\| \*\*Duration\*\*\s+\| The duration of Customer's Subscription, plus the retention periods specified in Section 11 of this DPA and Section 9 of the Privacy Policy\./,
    );
    expect(body).toMatch(
      /\| \*\*Nature of Processing\*\*\s+\| Storage, transmission, transformation, retrieval, deletion, and execution of automated browsing instructions\./,
    );
    expect(body).toMatch(
      /\| \*\*Purpose of Processing\*\*\s+\| To provide the Service to Customer/,
    );
    expect(body).toMatch(/return inline Capture artifacts, transmit ephemeral live-session media/);
    expect(body).not.toMatch(/optionally store Recordings/);
    expect(body).toMatch(
      /\| \*\*Categories of Data Subjects\*\* \| Customer's Authorized Users \(where Customer's Account Data is processed\) and the natural persons whose Personal Data Customer's automated browsing encounters at the Customer-selected target sites\./,
    );
    expect(body).toMatch(/\| \*\*Categories of Personal Data\*\* \| Set out in Annex 1\./);
    expect(body).toMatch(/## 2\. Roles/);
    expect(body).toMatch(/2\.1 \*\*Customer is the Controller\*\* of the Personal Data processed/);
    expect(body).toMatch(/under this DPA\. Customer determines the purposes and means of/);
    expect(body).toMatch(/Processing, including the choice of target sites, the framing of/);
    expect(body).toMatch(/Customer Workflows, whether to request API Capture artifacts or view/);
    expect(body).toMatch(/ephemeral live-session media, and the supply of Customer-Provided/);
    expect(body).toMatch(/Desktop-local recording files remain under Customer's/);
    expect(body).toMatch(/control and outside Driftstack's cloud processing\./);
    expect(body).toMatch(
      /2\.2 \*\*Driftstack is the Processor\.\*\* Driftstack Processes Personal/,
    );
    expect(body).toMatch(/Data only on Customer's documented instructions, as set out in this/);
    expect(body).toMatch(/DPA, the Terms of Service, and through the Customer's API requests\./);
    expect(body).toMatch(/2\.3 \*\*Where Customer's Customer is itself a Data Subject's/);
    expect(body).toMatch(/Controller\*\* \(for example, where Customer is itself a B2B SaaS/);
    expect(body).toMatch(/serving its own customers\), Customer represents that it has the/);
    expect(body).toMatch(/right to engage Driftstack as a Processor for that processing\./);
    expect(body).toMatch(/The/);
    expect(body).toMatch(/chain of accountability beyond Customer is Customer's responsibility\./);
  });

  it('Section 3.1 documented-instructions + 3.2 confidentiality + 3.3 security + 3.4 sub-processors-30day + 3.5 CCS-NOT-Sub-processors framing pinned', () => {
    expect(body).toMatch(/## 3\. Driftstack's obligations as Processor/);
    expect(body).toMatch(/### 3\.1 Process only on documented instructions/);
    expect(body).toMatch(/Driftstack Processes Personal Data only on Customer's documented/);
    expect(body).toMatch(/instructions, including with regard to international transfers,/);
    expect(body).toMatch(/unless required to do otherwise by Union or Member State law to/);
    expect(body).toMatch(/which Driftstack is subject\./);
    expect(body).toMatch(/\(Article 28\(3\)\(a\) GDPR\)\./);
    expect(body).toMatch(/Customer's "documented instructions" comprise:/);
    expect(body).toMatch(/1\. The Terms of Service\./);
    expect(body).toMatch(/2\. This DPA\./);
    expect(body).toMatch(/3\. The Acceptable Use Policy\./);
    expect(body).toMatch(/4\. The Customer's API requests \(treated as instructions\)\./);
    expect(body).toMatch(/5\. Configuration Customer sets in the GUI Client or via the API/);
    expect(body).toMatch(/\(Session, Capture, live-session, Sub-processor consent, etc\.\)\./);
    expect(body).not.toMatch(/Recording retention windows/);
    expect(body).toMatch(/6\. Any documented instruction Customer provides to Driftstack in/);
    expect(body).toMatch(/writing referencing this DPA\./);
    expect(body).toMatch(/If Driftstack believes a Customer instruction infringes the GDPR,/);
    expect(body).toMatch(/the AVG, or other applicable data-protection law, Driftstack/);
    expect(body).toMatch(/informs Customer without delay \(Article 28\(3\) final paragraph/);
    expect(body).toMatch(/GDPR\)\./);
    expect(body).toMatch(/### 3\.2 Confidentiality/);
    expect(body).toMatch(/Driftstack ensures that personnel authorised to Process Personal/);
    expect(body).toMatch(/Data are bound by confidentiality obligations or are subject to a/);
    expect(body).toMatch(/statutory obligation of confidentiality \(Article 28\(3\)\(b\) GDPR\)\./);
    expect(body).toMatch(/### 3\.3 Security of Processing/);
    expect(body).toMatch(/Driftstack implements appropriate technical and organisational/);
    expect(body).toMatch(/measures to ensure a level of security appropriate to the risk/);
    expect(body).toMatch(/\(Article 32 GDPR\)\./);
    expect(body).toMatch(/The measures are set out in \*\*Annex 2\*\* of this/);
    expect(body).toMatch(/DPA\./);
    expect(body).toMatch(/### 3\.4 Sub-processors/);
    expect(body).toMatch(/1\. Provides Customer with \*\*general written authorisation\*\* to/);
    expect(body).toMatch(/engage the Sub-processors listed in \*\*Annex 3\*\* of this DPA\./);
    expect(body).toMatch(
      /2\. Notifies Customer of any \*\*intended addition or replacement\*\* of/,
    );
    expect(body).toMatch(/Sub-processors at least \*\*thirty \(30\) days\*\* before that change/);
    expect(body).toMatch(/takes effect, providing the new Sub-processor's identity, role,/);
    expect(body).toMatch(/data category, and applicable transfer mechanism\./);
    expect(body).toMatch(
      /3\. Permits Customer to \*\*object\*\* to the addition or replacement on/,
    );
    expect(body).toMatch(/reasonable grounds within the 30-day notice window\./);
    expect(body).toMatch(/4\. Imposes \*\*contractual obligations on each Sub-processor\*\* that/);
    expect(body).toMatch(/are no less protective than those in this DPA/);
    expect(body).toMatch(/\(Article 28\(4\) GDPR\)\./);
    expect(body).toMatch(/5\. Remains \*\*fully liable to Customer\*\* for the performance of any/);
    expect(body).toMatch(/Sub-processor's obligations \(Article 28\(4\) GDPR\)\./);
    expect(body).toMatch(/### 3\.5 Customer-Connected Services are NOT Sub-processors/);
    expect(body).toMatch(/Customer-Connected Services \(HTTP\/SOCKS5 proxies, captcha-solving/);
    expect(body).toMatch(/services, email services accessed by Customer's credentials, SMS/);
    expect(body).toMatch(/services accessed by Customer's credentials\) operate under/);
    expect(body).toMatch(/\*\*Customer's\*\* account, \*\*Customer's\*\* credentials, and/);
    expect(body).toMatch(/\*\*Customer's\*\* contractual relationship with the third-party/);
    expect(body).toMatch(/provider\. They are not Sub-processors of Driftstack within the/);
    expect(body).toMatch(/meaning of Article 28\(2\) and \(4\) GDPR\./);
    expect(body).toMatch(/When Customer instructs Driftstack to forward a Customer-Provided/);
    expect(body).toMatch(/Secret to a Customer-Connected Service in the course of Session/);
    expect(body).toMatch(/execution, Driftstack acts on that instruction without itself/);
    expect(body).toMatch(/becoming a Controller of the data flowing to the Customer-Connected/);
    expect(body).toMatch(/Service\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
