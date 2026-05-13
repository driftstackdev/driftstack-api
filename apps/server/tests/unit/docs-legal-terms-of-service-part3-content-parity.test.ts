// W576.C — drift guard for /docs/legal/terms-of-service.md (Part 3 of 3).
// Driftstack ToS Version 1.0 (2026-05-07). Drift here either weakens
// the 30-day Material-modification notice + Customer's terminate-with-
// pro-rated-refund option, drops the NL-governing-law / Amsterdam-
// exclusive-jurisdiction pin, breaks the class-action waiver, or
// loosens the export-control / force-majeure / notices machinery.
//
//   • Section 14: 30-day termination-for-convenience + suspension rules.
//   • Section 15: 30-day Material-modification notice + Customer's exit.
//   • Section 16: NL law, exclude CISG.
//   • Section 17: Amsterdam exclusive jurisdiction + class-action waiver.
//   • Section 18: EU 2021/821 + US EAR + OFAC export controls.
//   • Part 3: sections 14-22 (Termination through Contact).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/legal/terms-of-service.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W576.C /docs/legal/terms-of-service.md (part 3) content parity', () => {
  const body = read(LIB);

  it('Section 14 (Term + termination + suspension) + 30-day-termination framing pinned', () => {
    expect(body).toMatch(/## 14\. Term \+ termination \+ suspension/);
    expect(body).toMatch(/14\.1 \*\*Term\.\*\*/);
    expect(body).toMatch(/14\.2 \*\*Termination for convenience\.\*\*/);
    expect(body).toMatch(/Either Party may terminate the/);
    expect(body).toMatch(/agreement for convenience on thirty \(30\) days' written notice,/);
    expect(body).toMatch(/effective at the end of the then-current billing cycle\./);
    expect(body).toMatch(/14\.3 \*\*Termination for cause\.\*\*/);
    expect(body).toMatch(/materially breaches this agreement and fails to cure within thirty/);
    expect(body).toMatch(/\(30\) days of written notice of the breach/);
    expect(body).toMatch(/14\.4 \*\*Suspension by Driftstack\.\*\*/);
    expect(body).toMatch(/14\.5 \*\*Effect of termination or suspension\.\*\*/);
    expect(body).toMatch(/1\. Customer's API Keys are revoked\./);
    expect(body).toMatch(/2\. Active Sessions are destroyed\./);
    expect(body).toMatch(/3\. Customer's right to access the Service ceases\./);
    expect(body).toMatch(/4\. Driftstack retains Customer Data for the periods specified in the/);
    expect(body).toMatch(/Privacy Policy \(typically 30 days post-termination for content/);
    expect(body).toMatch(/data, longer for billing and tax records as required by Dutch/);
    expect(body).toMatch(/law\)/);
    expect(body).toMatch(/5\. Sections that by their nature survive/);
    expect(body).toMatch(/14\.6 \*\*Suspension's reversibility\.\*\*/);
  });

  it('Section 15 (Modifications) + 30-day-Material-mod-notice + Customer-exit framing pinned', () => {
    expect(body).toMatch(/## 15\. Modifications/);
    expect(body).toMatch(/15\.1 \*\*Modification procedure\.\*\*/);
    expect(body).toMatch(/15\.2 \*\*Material modifications\.\*\*/);
    expect(body).toMatch(/Material modifications \(those that/);
    expect(body).toMatch(/materially alter Customer's rights, obligations, or fees, or add or/);
    expect(body).toMatch(/remove a Sub-processor\) take effect no earlier than thirty \(30\) days/);
    expect(body).toMatch(/after notification to Customer\./);
    expect(body).toMatch(/15\.3 \*\*Customer's option on Material modification\.\*\*/);
    expect(body).toMatch(/Customer may/);
    expect(body).toMatch(/terminate the Subscription on written notice given before the new/);
    expect(body).toMatch(/version's effective date, without penalty and with pro-rated refund/);
    expect(body).toMatch(/15\.4 \*\*Non-material modifications\.\*\*/);
    expect(body).toMatch(/take effect immediately on publication and do/);
    expect(body).toMatch(/not require new Acceptance\./);
  });

  it('Section 16 (Governing law) + Section 17 (Dispute resolution) + Amsterdam-exclusive-jurisdiction + class-action-waiver framing pinned', () => {
    expect(body).toMatch(/## 16\. Governing law/);
    expect(body).toMatch(
      /16\.1 This agreement is governed by the \*\*laws of the Netherlands\*\*,/,
    );
    expect(body).toMatch(/excluding its conflict-of-law provisions and excluding the United/);
    expect(body).toMatch(/Nations Convention on Contracts for the International Sale of Goods\./);
    expect(body).toMatch(/16\.2 The mandatory provisions of any consumer-protection law of/);
    expect(body).toMatch(/## 17\. Dispute resolution/);
    expect(body).toMatch(/17\.1 \*\*Good-faith negotiation\.\*\*/);
    expect(body).toMatch(/17\.2 \*\*Jurisdiction\.\*\*/);
    expect(body).toMatch(/Disputes not resolved through Section 17\.1/);
    expect(body).toMatch(/are subject to the \*\*exclusive jurisdiction\*\* of the courts of/);
    expect(body).toMatch(/\*\*Amsterdam, the Netherlands\*\*/);
    expect(body).toMatch(/17\.3 \*\*Class action waiver\.\*\*/);
    expect(body).toMatch(/Each Party waives any right to/);
    expect(body).toMatch(/participate in a class action, collective action, or representative/);
    expect(body).toMatch(/proceeding against the other Party/);
  });

  it('Section 18 (Export controls) + Section 19 (Force majeure) + Section 20 (Notices) framing pinned', () => {
    expect(body).toMatch(/## 18\. Export controls/);
    expect(body).toMatch(/Customer represents and warrants that it complies with all/);
    expect(body).toMatch(/applicable export-control law, including \(without limitation\)/);
    expect(body).toMatch(/Regulation \(EU\) 2021\/821 on dual-use items, US Export/);
    expect(body).toMatch(/Administration Regulations \(15 CFR §§ 730–774\) where applicable, and/);
    expect(body).toMatch(/US OFAC sanctions where applicable\./);
    expect(body).toMatch(/## 19\. Force majeure/);
    expect(body).toMatch(/Neither Party is liable for failure or delay in performance \(other/);
    expect(body).toMatch(/than payment of Fees\) caused by events beyond the Party's reasonable/);
    expect(body).toMatch(/control/);
    expect(body).toMatch(/acts of war, terrorism,/);
    expect(body).toMatch(/civil disturbance, natural disaster, public-health emergency/);
    expect(body).toMatch(/declared by a competent authority, pandemic, internet or/);
    expect(body).toMatch(/telecommunications outage outside the Party's control/);
    expect(body).toMatch(/## 20\. Notices/);
    expect(body).toMatch(/20\.1 Notices to Driftstack are addressed to `legal@driftstack\.dev`/);
    expect(body).toMatch(/registered office of Driftstack B\.V\./);
    expect(body).toMatch(/20\.2 Notices to Customer are addressed to the billing email/);
    expect(body).toMatch(/provided by Customer in its Account/);
    expect(body).toMatch(/20\.3 Notices are effective on receipt for postal mail and on/);
    expect(body).toMatch(/transmission for electronic delivery/);
  });

  it('Section 21 (Severability + entire agreement + assignment) + Section 22 (Contact) framing pinned', () => {
    expect(body).toMatch(/## 21\. Severability \+ entire agreement \+ assignment/);
    expect(body).toMatch(/21\.1 \*\*Severability\.\*\*/);
    expect(body).toMatch(/21\.2 \*\*Entire agreement\.\*\*/);
    expect(body).toMatch(/This ToS, together with the Privacy/);
    expect(body).toMatch(/Policy, the DPA, the AUP, the Definitions, and any commercial order/);
    expect(body).toMatch(/form or schedule signed by both Parties, constitutes the entire/);
    expect(body).toMatch(/agreement/);
    expect(body).toMatch(/21\.3 \*\*Assignment\.\*\*/);
    expect(body).toMatch(/Customer may not assign this agreement without Driftstack's prior/);
    expect(body).toMatch(/written consent/);
    expect(body).toMatch(/21\.4 \*\*No third-party beneficiaries\.\*\*/);
    expect(body).toMatch(/21\.5 \*\*Independent contractors\.\*\*/);
    expect(body).toMatch(/21\.6 \*\*Headings\.\*\*/);
    expect(body).toMatch(/## 22\. Contact/);
    expect(body).toMatch(/- Legal: `legal@driftstack\.dev`/);
    expect(body).toMatch(/- Privacy: `privacy@driftstack\.dev`/);
    expect(body).toMatch(
      /- Postal correspondence: addressed to Driftstack B\.V\., Amsterdam, the Netherlands\./,
    );
    expect(body).toMatch(/_End of ToS\._/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
