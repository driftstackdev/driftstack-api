// W506.C — drift guard for apps/marketing-site/src/pages/legal/terms.md.
// Terms of Service v1.0 — master commercial agreement Dutch BV.
// Drift here either weakens a liability cap (would expose Driftstack
// to uncapped damages) or shifts the B2B-only positioning (would
// inadvertently engage EU consumer-protection regime that the doc
// explicitly disclaims).
//
//   • Version 1.0 effective 2026-05-07 + B2B-only (Dutch BW 7:5 +
//     Directive 2011/83/EU) + incorporates Privacy + DPA + AUP.
//   • Section 8.1 fee tiers: perpetual Free + Manual ladder
//     (Personal/Team/Agency) + API ladder (API Starter/Builder/Scale)
//     + custom-priced Enterprise; current prices published at
//     driftstack.dev/pricing (NOT hardcoded in the contract).
//   • Section 8.4 VAT 4-rule: NL 21% BTW + EU reverse-charge + non-EU
//     no-BTW + place-of-supply 2006/112/EC.
//   • Section 8.5 late-payment AWB 6:119a wettelijke handelsrente.
//   • Section 8.7 refunds non-refundable-default + 8.7.1 crypto
//     non-refundable specifically.
//   • Section 9 SLA: no-contractual-SLA on Free/Personal/Team/Agency/
//     API-Starter/API-Builder + 99.9% monthly SLA on API-Scale/
//     Enterprise (Severity-1 first-response 4h API-Scale / 1h Enterprise).
//   • Section 11 'as is' + 'as available' disclaimer.
//   • Section 13.1 12-month-Fees liability cap.
//   • Section 13.3 carve-outs: gross-negligence (Dutch opzet of
//     bewuste roekeloosheid) + indemnification + confidentiality
//     + payment + death/personal-injury.
//   • Section 16 Dutch law (excl conflict-of-laws + CISG).
//   • Section 17.2 Amsterdam exclusive jurisdiction.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/terms.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W506.C apps/marketing-site/src/pages/legal/terms.md content parity', () => {
  const body = read(LIB);

  it('Version 1.0 effective 2026-05-07 + incorporates Privacy + DPA + AUP by reference pinned — pinned so the 3-doc incorporation stays consistent (drift to dropping any incorporation would orphan that downstream doc from the master agreement; drift to changing the version would silently desynchronise from the legal-acceptance machinery)', () => {
    expect(body).toMatch(/\*\*Version:\*\* 1\.0 · \*\*Effective:\*\* 2026-05-07/);
    expect(body).toMatch(
      /The\s*\n?\s*\[Privacy Policy\]\(\/legal\/privacy\/\), the\s*\n?\s*\[Data Processing Agreement\]\(\/legal\/dpa\/\), and the\s*\n?\s*\[Acceptable Use Policy\]\(\/legal\/aup\/\) are incorporated\s*\n?\s*by reference and form part of the agreement between the Parties\./,
    );
    expect(body).not.toMatch(/\]\((?:privacy|dpa|aup)\.md\)/);
  });

  it("B2B-only-not-consumer framing pinned: 'The Service is provided to **business customers** only. The Service is not intended for, and is not offered to, consumers within the meaning of Article 7:5 of the Dutch Civil Code (_Burgerlijk Wetboek_) or Article 2(1) of Directive 2011/83/EU.' — pinned so the Dutch BW 7:5 + EU Directive 2011/83/EU anti-consumer-regime anchors survive (drift to dropping the BW 7:5 anchor would lose the Dutch-statute citation; drift to dropping Directive 2011/83/EU would let the EU consumer-rights regime accidentally apply)", () => {
    expect(body).toMatch(
      /The Service is provided to \*\*business customers\*\* only\. The Service\s*\n?\s*is not intended for, and is not offered to, consumers within the\s*\n?\s*meaning of Article 7:5 of the Dutch Civil Code \(_Burgerlijk Wetboek_\)\s*\n?\s*or Article 2\(1\) of Directive 2011\/83\/EU\./,
    );
  });

  it("Section 8.1 fee-tier ladder: perpetual Free tier + Manual ladder (Personal, Team, Agency) + API ladder (API Starter, API Builder, API Scale) + custom-priced Enterprise, with current prices published at driftstack.dev/pricing — pinned so the two-ladder ToS framing stays consistent (drift to dropping the published-at-pricing-page reference would re-introduce hardcoded marketing↔Stripe-invoice divergence at the contractual level; drift to dropping 'custom-priced Enterprise' would lose the Enterprise commitment)", () => {
    expect(body).toMatch(
      /Customer pays the Fees for the Subscription tier\s*\n?\s*selected at signup\. Driftstack offers a perpetual Free tier, a\s*\n?\s*Manual ladder \(Personal, Team, Agency\), and an API ladder \(API\s*\n?\s*Starter, API Builder, API Scale\), with a custom-priced Enterprise\s*\n?\s*tier\. The current tiers and prices are published at\s*\n?\s*<https:\/\/driftstack\.dev\/pricing\/>\./,
    );
    expect(body).not.toMatch(/<https:\/\/driftstack\.dev\/pricing>/);
    // The contract must NOT hardcode tier prices — those live on the
    // pricing page (single source of truth). Drift back to baked-in
    // dollar figures would desync from Stripe at the contractual level.
    expect(body).not.toMatch(/\$39\/mo, \$99\/mo, \$299\/mo, \$999\/mo/);
  });

  it('Section 8.3 payment methods 4-list: Stripe Card (Visa/MC/Amex) + SEPA Direct Debit + iDEAL + Bancontact — pinned so the 4-payment-method scope stays consistent (drift to dropping iDEAL would orphan Dutch customers from their preferred channel; drift to dropping SEPA would orphan EUR-bank customers)', () => {
    expect(body).toMatch(
      /\*\*Card payments\*\* \(Visa, Mastercard, American Express, regional\s*\n?\s*cards where available\) via Stripe\./,
    );
    expect(body).toMatch(
      /\*\*SEPA Direct Debit\*\* for Customers with a EUR bank account in\s*\n?\s*the SEPA zone, via Stripe\./,
    );
    expect(body).toMatch(/\*\*iDEAL\*\* for Customers with a Dutch bank account, via Stripe\./);
    expect(body).toMatch(
      /\*\*Bancontact\*\* for Customers with a Belgian bank account, via\s*\n?\s*Stripe\./,
    );
  });

  it('Section 8.4 VAT/BTW 4-rule: NL 21% BTW + EU reverse-charge + non-EU no-BTW + place-of-supply Directive 2006/112/EC — pinned so the 4-VAT-jurisdiction-rule + the Directive 2006/112/EC anchor on place-of-supply rules survive (drift to dropping the reverse-charge rule would expose EU-Customer accounting; drift to dropping Directive 2006/112/EC would weaken the place-of-supply legal anchor)', () => {
    expect(body).toMatch(
      /Customers established in the Netherlands are charged Dutch BTW at\s*\n?\s*the prevailing rate \(currently 21%\)\./,
    );
    expect(body).toMatch(/\*\*Reverse-Charge\s*\n?\s*VAT\*\*: Driftstack invoices without BTW/);
    expect(body).toMatch(/Customers established outside the EU are invoiced without BTW/);
    expect(body).toMatch(/Council Directive\s*\n?\s*2006\/112\/EC, as amended/);
  });

  it('Section 8.5 late-payment + Dutch wettelijke handelsrente (Article 6:119a BW) + 7-day cure pinned — pinned so the Dutch-civil-code 6:119a statutory-commercial-rate anchor + the 7-day cure window survive (drift to dropping 6:119a would orphan the rate from its statute; drift to softening the 7-day cure would shift the suspension trigger)', () => {
    expect(body).toMatch(
      /Past-due\s*\n?\s*amounts accrue interest at the statutory commercial rate under\s*\n?\s*Article 6:119a of the Dutch Civil Code \(`wettelijke handelsrente`\)\./,
    );
    expect(body).toMatch(/seven \(7\) days' written notice/);
  });

  it("Section 8.7.1 crypto-non-refundable specifically pinned: '**Crypto payments are non-refundable.** Subscriptions paid via crypto (NowPayments) are non-refundable in all cases, including but not limited to buyer's remorse, accidental over-payment, and price movement between order and any potential refund.' + 'Card refund mechanics (8.7, above) do not apply to crypto-paid Subscriptions.' — pinned so the crypto-non-refundable-3-case enumeration + the 'no card-refund-mechanic carryover' commitment survive (drift to creating any crypto-refund carve-out would invite chain-reversal disputes NowPayments can't honor)", () => {
    expect(body).toMatch(/8\.7\.1 \*\*Crypto payments are non-refundable\.\*\*/);
    expect(body).toMatch(
      /Subscriptions paid via\s*\n?\s*crypto \(NowPayments\) are non-refundable in all cases, including but\s*\n?\s*not limited to buyer's remorse, accidental over-payment, and price\s*\n?\s*movement between order and any potential refund\./,
    );
    expect(body).toMatch(
      /Card refund mechanics \(8\.7, above\) do not apply to crypto-paid\s*\n?\s*Subscriptions\./,
    );
  });

  it("Section 9 SLA-tier split pinned: 9.1 'No guaranteed SLA at lower tiers' (Free, Manual-ladder Personal/Team/Agency, API Starter, API Builder) + 9.2 Commercial SLA on API Scale + Enterprise (99.9% monthly; first-response Severity-1 of four (4) hours on API Scale + one (1) hour on Enterprise) — pinned so the per-tier SLA framing + the explicit 99.9%-availability + the API-Scale-4h / Enterprise-1h first-response Severity-1 commitments survive (drift to claiming SLA on lower tiers would over-promise; drift to dropping the 99.9% or the named per-tier first-response windows would weaken the contractual commitment to Scale/Enterprise customers)", () => {
    expect(body).toMatch(/9\.1 \*\*No guaranteed SLA at lower tiers\.\*\*/);
    expect(body).toMatch(
      /The Free, Manual-ladder\s*\n?\s*\(Personal, Team, Agency\), API Starter, and API Builder tiers are\s*\n?\s*provided \*\*without\*\* a contractually-binding service level\s*\n?\s*agreement\./,
    );
    expect(body).toMatch(/9\.2 \*\*Commercial SLA at higher tiers\.\*\*/);
    expect(body).toMatch(
      /The API Scale and Enterprise\s*\n?\s*tiers carry a contractual SLA published separately \(currently: 99\.9%\s*\n?\s*monthly availability; first-response SLA on Severity-1 incidents of\s*\n?\s*four \(4\) hours on API Scale and one \(1\) hour on Enterprise\)\./,
    );
  });

  it("Section 11.2 'as is' + 'as available' disclaimer pinned: 'Except as expressly stated in Section 11.1, the Service is provided **\"as is\"** and **\"as available\"**, and Driftstack disclaims all other warranties, express, implied, or statutory, including warranties of merchantability, fitness for a particular purpose, accuracy, completeness, and non-infringement' — pinned so the 5-warranty-disclaimer surface (merchantability + fitness-for-purpose + accuracy + completeness + non-infringement) survives (drift to dropping any specific warranty disclaimer would let it remain as implied protection; drift to softening 'as is' would weaken the boilerplate)", () => {
    expect(body).toMatch(
      /Except as expressly stated in Section 11\.1, the\s*\n?\s*Service is provided \*\*"as is"\*\* and \*\*"as available"\*\*/,
    );
    expect(body).toMatch(
      /Driftstack disclaims all other warranties, express, implied, or\s*\n?\s*statutory, including warranties of merchantability, fitness for a\s*\n?\s*particular purpose, accuracy, completeness, and non-infringement/,
    );
  });

  it("Section 13.1 liability cap pinned: 'aggregate liability under or in connection with this agreement is **limited to the total Fees paid or payable by Customer to Driftstack under this agreement during the twelve (12) months immediately preceding the event giving rise to the claim**.' — pinned so the 12-month-Fees liability cap survives (drift to a longer window would expose Driftstack to higher caps; drift to dropping the cap altogether would expose to uncapped damages)", () => {
    expect(body).toMatch(
      /aggregate liability under or in\s*\n?\s*connection with this agreement is \*\*limited to the total Fees paid\s*\n?\s*or payable by Customer to Driftstack under this agreement during the\s*\n?\s*twelve \(12\) months immediately preceding the event giving rise to\s*\n?\s*the claim\*\*\./,
    );
  });

  it("Section 13.2 excluded damages pinned: 'neither Party is liable for any indirect, incidental, special, consequential, or punitive damages, lost profits, lost revenues, lost data, or business interruption' — pinned so the 9-state excluded-damages enumeration (indirect + incidental + special + consequential + punitive + lost-profits + lost-revenues + lost-data + business-interruption) survives (drift to dropping any specific damage type would let it slip through the exclusion)", () => {
    expect(body).toMatch(
      /neither Party is liable for any indirect,\s*\n?\s*incidental, special, consequential, or punitive damages, lost\s*\n?\s*profits, lost revenues, lost data, or business interruption/,
    );
  });

  it("Section 13.3 carve-outs 6-list: gross-negligence (Dutch opzet of bewuste roekeloosheid) + indemnification + Confidentiality (Section 7) + Customer payment obligations + death/personal-injury + any-other-non-waivable — pinned so the 6-carve-out-from-cap-and-exclusion list stays complete (drift to dropping the Dutch 'opzet of bewuste roekeloosheid' civil-law anchor would weaken Dutch-jurisdiction enforceability; drift to dropping Section 7 Confidentiality carve-out would let confidentiality breaches hit the cap)", () => {
    expect(body).toMatch(
      /Gross negligence or willful misconduct \(_opzet of bewuste\s*\n?\s*roekeloosheid_\) by the liable Party or its officers or directors\./,
    );
    expect(body).toMatch(/Indemnification obligations under Section 12\.1/);
    expect(body).toMatch(/Breach of Section 7 \(Confidentiality\)\./);
    expect(body).toMatch(/Customer's payment obligations under Section 8\./);
    expect(body).toMatch(
      /Liability for death or personal injury caused by the liable\s*\n?\s*Party's negligence \(where applicable law mandates\)\./,
    );
  });

  it("Section 14.4 suspension 4-trigger: AUP violation + imminent threat + 30-day past-due undisputed Fees + law/legal-process — pinned so the 4-suspension-trigger surface survives (drift to dropping the 30-day-past-due trigger would block payment-failure suspension; drift to dropping 'law or valid legal process' would close off the legal-compliance trigger)", () => {
    expect(body).toMatch(
      /Customer's use violates the AUP per Section 5 of the AUP, \(b\)\s*\n?\s*Customer's use poses an imminent threat to the Service's integrity\s*\n?\s*or to other customers, \(c\) Customer is more than thirty \(30\) days\s*\n?\s*past due on undisputed Fees, or \(d\) Driftstack is required by law\s*\n?\s*or valid legal process to suspend\./,
    );
  });

  it("Section 16 governing law pinned: '**laws of the Netherlands**, excluding its conflict-of-law provisions and excluding the United Nations Convention on Contracts for the International Sale of Goods.' — pinned so the Dutch-law + CISG-exclusion + conflict-of-laws-exclusion 3-state choice-of-law commitment survives (drift to dropping the CISG exclusion would let UN sale-of-goods rules apply to a software contract; drift to dropping 'excluding conflict-of-law' would let renvoi route to non-Dutch law)", () => {
    expect(body).toMatch(
      /This agreement is governed by the \*\*laws of the Netherlands\*\*,\s*\n?\s*excluding its conflict-of-law provisions and excluding the United\s*\n?\s*Nations Convention on Contracts for the International Sale of Goods\./,
    );
  });

  it("Section 17.2 exclusive jurisdiction pinned: '**exclusive jurisdiction** of the courts of **Amsterdam, the Netherlands**, except that either Party may seek interim or injunctive relief in any court of competent jurisdiction to protect its intellectual property or Confidential Information.' — pinned so the Amsterdam-courts-exclusive + injunctive-relief-anywhere carve-out survive (drift to dropping 'Amsterdam' would orphan the Dutch-jurisdiction anchor; drift to dropping the injunctive-relief carve-out would force IP/confidentiality emergencies to wait for Amsterdam venue)", () => {
    expect(body).toMatch(
      /\*\*exclusive jurisdiction\*\* of the courts of\s*\n?\s*\*\*Amsterdam, the Netherlands\*\*, except that either Party may seek\s*\n?\s*interim or injunctive relief in any court of competent jurisdiction\s*\n?\s*to protect its intellectual property or Confidential Information\./,
    );
  });

  it('Section 18 export controls 3-regime: EU Regulation 2021/821 dual-use + US EAR (15 CFR §§ 730–774) + US OFAC — pinned so the 3-jurisdiction export-control anchor survives (drift to dropping the EAR §§ 730–774 citation would weaken US-export-law specificity; drift to dropping EU 2021/821 would orphan EU dual-use compliance)', () => {
    expect(body).toMatch(
      /Regulation \(EU\) 2021\/821 on dual-use items, US Export\s*\n?\s*Administration Regulations \(15 CFR §§ 730–774\) where applicable, and\s*\n?\s*US OFAC sanctions where applicable\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
