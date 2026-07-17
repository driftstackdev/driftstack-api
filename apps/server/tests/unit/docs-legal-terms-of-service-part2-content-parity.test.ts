// W576.B — drift guard for /docs/legal/terms-of-service.md (Part 2 of 3).
// Driftstack ToS Version 1.0 (2026-05-07). Drift here either unsets the
// 5-method payment matrix (card / SEPA / iDEAL / Bancontact / crypto),
// drops the NowPayments OÜ crypto sub-processor, weakens the Reverse-
// Charge VAT framing, breaks the 12-months Fees liability cap, or
// removes the gross-negligence / confidentiality / payment carve-outs.
//
//   • Section 8: 5-payment-method matrix + NowPayments OÜ + crypto rules.
//   • Section 8.4: NL BTW + EU Reverse-Charge + outside-EU framing.
//   • Section 9: no SLA at lower tiers; API Scale/Enterprise SLA truth.
//   • Section 13: liability cap = 12 months Fees; gross-negligence carve.
//   • Part 2: sections 8-13 (Fees through Liability cap).

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

describe('W576.B /docs/legal/terms-of-service.md (part 2) content parity', () => {
  const body = read(LIB);

  it('Section 8 (Fees) + 5-payment-method matrix + NowPayments crypto framing pinned', () => {
    expect(body).toMatch(/## 8\. Fees \+ payment/);
    expect(body).toMatch(/8\.1 \*\*Fees\.\*\*/);
    expect(body).toMatch(/Customer pays the Fees for the Subscription tier/);
    expect(body).toMatch(/Driftstack offers a perpetual Free tier, a/);
    expect(body).toMatch(/Manual ladder \(Personal, Team, Agency\), and an API ladder \(API/);
    expect(body).toMatch(/Starter, API Builder, API Scale\), with a custom-priced Enterprise/);
    expect(body).toMatch(/<https:\/\/driftstack\.dev\/pricing\/>/);
    expect(body).toMatch(/8\.2 \*\*Billing cycles\.\*\*/);
    expect(body).toMatch(/Enterprise tier bills annually in advance by default\./);
    expect(body).toMatch(/8\.3 \*\*Payment methods\.\*\*/);
    expect(body).toMatch(
      /1\. \*\*Card payments\*\* \(Visa, Mastercard, American Express, regional/,
    );
    expect(body).toMatch(/cards where available\) via Stripe\./);
    expect(body).toMatch(/2\. \*\*SEPA Direct Debit\*\* for Customers with a EUR bank account in/);
    expect(body).toMatch(/the SEPA zone, via Stripe\./);
    expect(body).toMatch(/3\. \*\*iDEAL\*\* for Customers with a Dutch bank account, via Stripe\./);
    expect(body).toMatch(/4\. \*\*Bancontact\*\* for Customers with a Belgian bank account, via/);
    expect(body).toMatch(/Stripe\./);
    expect(body).toMatch(/5\. \*\*Cryptocurrency\*\* in the assets and networks displayed at/);
    expect(body).toMatch(/checkout, via NowPayments OÜ \(Estonia\)\./);
    expect(body).toMatch(/converted into a time-limited crypto quote/);
    expect(body).toMatch(/exact quoted asset and network/);
    expect(body).toMatch(/Entitlement starts only after NowPayments reports the order paid/);
    expect(body).toMatch(/does not custody crypto or initiate crypto refunds/);
  });

  it('Section 8.4 (VAT/BTW) + 8.5 (late) + 8.6 (disputes) + 8.7 (refunds) + 8.8 (tier) framing pinned', () => {
    expect(body).toMatch(/8\.4 \*\*VAT \/ BTW\.\*\*/);
    expect(body).toMatch(/1\. Customers established in the Netherlands are charged Dutch BTW at/);
    expect(body).toMatch(/the prevailing rate \(currently 21%\)\./);
    expect(body).toMatch(/2\. Customers established in another EU Member State and providing a/);
    expect(body).toMatch(/valid VAT identification number are subject to \*\*Reverse-Charge/);
    expect(body).toMatch(/VAT\*\*/);
    expect(body).toMatch(/3\. Customers established outside the EU are invoiced without BTW and/);
    expect(body).toMatch(/4\. Where the EU "place of supply" rules under Council Directive/);
    expect(body).toMatch(/2006\/112\/EC, as amended/);
    expect(body).toMatch(/8\.5 \*\*Late payment\.\*\*/);
    expect(body).toMatch(/Past-due/);
    expect(body).toMatch(/amounts accrue interest at the statutory commercial rate under/);
    expect(body).toMatch(/Article 6:119a of the Dutch Civil Code \(`wettelijke handelsrente`\)\./);
    expect(body).toMatch(/seven \(7\) days' written notice/);
    expect(body).toMatch(/8\.6 \*\*Disputes\.\*\*/);
    expect(body).toMatch(/8\.7 \*\*Refunds\.\*\*/);
    expect(body).toMatch(/8\.7\.1 \*\*Crypto payments are non-refundable\.\*\*/);
    expect(body).toMatch(/8\.8 \*\*Tier changes\.\*\*/);
  });

  it('Section 9 (Service levels) + Section 10 (Data + privacy) framing pinned', () => {
    expect(body).toMatch(/## 9\. Service levels/);
    expect(body).toMatch(/9\.1 \*\*No guaranteed SLA at lower tiers\.\*\*/);
    expect(body).toMatch(/The Free, Manual-ladder/);
    expect(body).toMatch(/\(Personal, Team, Agency\), API Starter, and API Builder tiers are/);
    expect(body).toMatch(/level\s+agreement\./);
    expect(body).toMatch(/9\.2 \*\*Commercial SLA at higher tiers\.\*\*/);
    expect(body).toMatch(/The API Scale and Enterprise/);
    expect(body).toMatch(/currently:\s+99\.9%\s+monthly availability/);
    expect(body).toMatch(/four \(4\) hours on API Scale and one \(1\) hour on Enterprise/);
    expect(body).toMatch(/9\.3 \*\*Maintenance\.\*\*/);
    expect(body).toMatch(/status page at <https:\/\/status\.driftstack\.dev>/);
    expect(body).toMatch(/9\.4 \*\*Force majeure events\*\* \(Section 19\)/);
    expect(body).toMatch(/## 10\. Data \+ privacy/);
    expect(body).toMatch(/10\.1 \*\*Privacy Policy\.\*\*/);
    expect(body).toMatch(/10\.2 \*\*DPA\.\*\*/);
    expect(body).toMatch(/10\.3 \*\*Customer-Provided Secrets\.\*\*/);
  });

  it('Section 11 (Warranties) + Section 12 (Indemnification) + Section 13 (Liability cap) framing pinned', () => {
    expect(body).toMatch(/## 11\. Warranties \+ disclaimer/);
    expect(body).toMatch(/11\.1 \*\*Driftstack warranties\.\*\*/);
    expect(body).toMatch(/1\. It will provide the Service in a workmanlike manner consistent/);
    expect(body).toMatch(/with industry practice for similar services\./);
    expect(body).toMatch(/11\.2 \*\*Disclaimer\.\*\*/);
    expect(body).toMatch(/Service is provided \*\*"as is"\*\* and \*\*"as available"\*\*/);
    expect(body).toMatch(/11\.3 \*\*Customer assumes risk on target compatibility\.\*\*/);
    expect(body).toMatch(/notification\s+mechanism in Section 3\.4 of the DPA/);
    expect(body).not.toMatch(/notification\s+mechanism in Section 5 of the DPA/);
    expect(body).toMatch(/## 12\. Indemnification/);
    expect(body).toMatch(/12\.1 \*\*Driftstack indemnifies Customer\*\*/);
    expect(body).toMatch(/12\.2 \*\*Carve-outs from Driftstack's indemnification\.\*\*/);
    expect(body).toMatch(/12\.3 \*\*Customer indemnifies Driftstack\*\*/);
    expect(body).toMatch(/12\.4 \*\*Indemnification procedure\.\*\*/);
    expect(body).toMatch(/## 13\. Limitation of liability/);
    expect(body).toMatch(/13\.1 \*\*Liability cap\.\*\*/);
    expect(body).toMatch(/\*\*TO THE MAXIMUM EXTENT PERMITTED BY/);
    expect(body).toMatch(/APPLICABLE LAW\*\*/);
    expect(body).toMatch(/\*\*limited to the total Fees paid/);
    expect(body).toMatch(/or payable by Customer to Driftstack under this agreement during the/);
    expect(body).toMatch(/twelve \(12\) months immediately preceding the event giving rise to/);
    expect(body).toMatch(/the claim\*\*/);
    expect(body).toMatch(/13\.2 \*\*Excluded damages\.\*\*/);
    expect(body).toMatch(/13\.3 \*\*Carve-outs from the cap and excluded damages\.\*\*/);
    expect(body).toMatch(/1\. Gross negligence or willful misconduct \(_opzet of bewuste/);
    expect(body).toMatch(/roekeloosheid_\)/);
    expect(body).toMatch(/3\. Breach of Section 7 \(Confidentiality\)\./);
    expect(body).toMatch(/4\. Customer's payment obligations under Section 8\./);
    expect(body).toMatch(/13\.4 \*\*Allocation rationale\.\*\*/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
