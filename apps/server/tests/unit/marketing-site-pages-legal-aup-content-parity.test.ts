// W505.C — drift guard for apps/marketing-site/src/pages/legal/aup.md.
// Acceptable Use Policy v1.0 — categorical prohibitions + customer-
// responsibility framing + graduated enforcement. Drift here either
// weakens a prohibited-target / prohibited-technique categorical rule
// (would expose Driftstack to liability for misuse) or breaks the
// 'Customer is the lawful-basis decision-maker' GDPR Article 28 split.
//
//   • Version 1.0 + effective 2026-05-07 + Terms incorporation.
//   • Section 1 prohibited targets 5-list: CSAM + terrorism + sanctioned
//     entities + critical infrastructure + malware distribution.
//   • Section 2 prohibited techniques 7-list: credential stuffing +
//     mass account creation + DDoS + unauth vulnerability exploit +
//     defeat-commercial-limits + GDPR-scraping-without-lawful-basis +
//     CAPTCHA bypass against other-user rights.
//   • Section 3 customer-responsibility 5-state framing including
//     'Customer is the Controller / Driftstack is the Processor'
//     GDPR Article 28(3)(a) anchor.
//   • Section 4 abuse-reporting 3-source: targets + data subjects +
//     law enforcement.
//   • Section 5 graduated 3-stage enforcement: Warning → Suspension →
//     Termination + 4-condition discretion to skip.
//   • Section 7 own-AUP-compliance: MacStadium + Stripe.
//   • Driftstack B.V. Amsterdam Dutch BV jurisdiction.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/aup.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W505.C apps/marketing-site/src/pages/legal/aup.md content parity', () => {
  const body = read(LIB);

  it('Version 1.0 effective 2026-05-07 + Terms incorporation — pinned so the version-tracked AUP + the Terms-of-Service incorporation survive (drift to dropping the Terms-incorporation would orphan the AUP from contractual force; drift to changing the version without updating downstream Terms would create cross-doc divergence)', () => {
    expect(body).toMatch(/\*\*Version:\*\* 1\.0 · \*\*Effective:\*\* 2026-05-07/);
    expect(body).toMatch(
      /The AUP is incorporated into the \[Terms of Service\]\(\/legal\/terms\/\) by reference/,
    );
    expect(body.match(/\[Terms of Service\]\(\/legal\/terms\/\)/g)).toHaveLength(4);
    expect(body).not.toMatch(/\[Terms of Service\]\(terms\.md\)/);
  });

  it("General-purpose-infrastructure framing pinned: 'The AUP exists because the Service is general-purpose infrastructure that can be misused. Customer is the party closest to the lawfulness of any given Session: Customer chooses the target site, supplies the authentication credentials' + 'Driftstack is the infrastructure provider; Driftstack does not pre-screen target sites and does not assess the legality of Customer's specific use under Customer's own law.' — pinned so the infrastructure-not-arbiter posture survives (drift to claiming pre-screening would mislead customers into thinking Driftstack vets targets; drift to dropping the 'Customer closest to lawfulness' framing would weaken the lawful-basis-is-Customer's-call commitment)", () => {
    expect(body).toMatch(
      /The AUP exists because the Service is general-purpose infrastructure\s*\n?\s*that can be misused\. Customer is the party closest to the lawfulness\s*\n?\s*of any given Session/,
    );
    expect(body).toMatch(
      /Driftstack is the infrastructure\s*\n?\s*provider; Driftstack does not pre-screen target sites and does not\s*\n?\s*assess the legality of Customer's specific use under Customer's own\s*\n?\s*law\./,
    );
  });

  it('Section 1 prohibited targets 5-list: CSAM + Terrorism + Sanctioned entities + Critical infrastructure + Malware/ransomware distribution — pinned so the 5-categorical-prohibition list stays complete (drift to dropping CSAM would create complicity-by-omission risk; drift to dropping Critical infrastructure would let public-utility probing slip into authorised)', () => {
    expect(body).toMatch(/\*\*Child sexual abuse material \(CSAM\)\.\*\*/);
    expect(body).toMatch(/\*\*Terrorism or material support for terrorism\.\*\*/);
    expect(body).toMatch(/\*\*Sanctioned entities\.\*\*/);
    expect(body).toMatch(/\*\*Critical infrastructure attack\.\*\*/);
    expect(body).toMatch(/\*\*Distribution of malware, ransomware, or destructive payloads\.\*\*/);
  });

  it("CSAM absolute-prohibition framing pinned: 'This prohibition is absolute and overrides any claim of investigative or research purpose; investigators with a legitimate basis under their own law route requests through the appropriate authorities, not commercial automation infrastructure.' — pinned so the absolute-no-investigative-carve-out commitment survives (drift to creating a research carve-out would invite abuse-via-research-claim; drift to dropping 'commercial automation infrastructure' framing would weaken the 'wrong tool for that job' positioning)", () => {
    expect(body).toMatch(
      /This\s*\n?\s*prohibition is absolute and overrides any claim of investigative or\s*\n?\s*research purpose; investigators with a legitimate basis under their\s*\n?\s*own law route requests through the appropriate authorities, not\s*\n?\s*commercial automation infrastructure\./,
    );
  });

  it('Sanctions 3-regime anchor pinned: EU sanctions (Council Regulation) + UK Office of Financial Sanctions Implementation + US OFAC SDN list — pinned so the 3-jurisdiction sanctions anchor survives (drift to dropping UK OFSI would create gaps for UK-jurisdiction customers; drift to dropping OFAC SDN would create gaps for US-jurisdiction customers)', () => {
    expect(body).toMatch(
      /Any entity, person, or service designated\s*\n?\s*under EU sanctions \(Council Regulation\), the UK sanctions list \(UK\s*\n?\s*Office of Financial Sanctions Implementation\), the US OFAC SDN\s*\n?\s*list/,
    );
  });

  it("Section 2 prohibited techniques 7-list: Credential stuffing + Mass account creation + DDoS + Unauth vuln exploit + Defeat commercial limits + GDPR-scraping-without-lawful-basis + CAPTCHA bypass against other-users — pinned so the 7-technique-prohibition stays complete (drift to dropping 'Credential stuffing' would leave the breach-corpus-replay attack surface unconstrained; drift to dropping 'CAPTCHA bypass' would let bypass against other-user-protections slip)", () => {
    expect(body).toMatch(/\*\*Credential stuffing\.\*\*/);
    expect(body).toMatch(/\*\*Mass account creation in violation of target Terms of Service\.\*\*/);
    expect(body).toMatch(/\*\*Distributed denial-of-service \(DDoS\) or volumetric attack\.\*\*/);
    expect(body).toMatch(/\*\*Vulnerability exploitation without authorisation\.\*\*/);
    expect(body).toMatch(
      /\*\*Bypassing technical protection measures with intent to defeat\s*\n?\s*commercial limits\.\*\*/,
    );
    expect(body).toMatch(/\*\*Personal data scraping outside Customer's lawful basis\.\*\*/);
    expect(body).toMatch(
      /\*\*Circumventing CAPTCHA or anti-automation in a manner that\s*\n?\s*targets the rights of the target's other users\.\*\*/,
    );
  });

  it("EU Digital Markets Act + InfoSoc Directive carve-out pinned: 'pricing tiers, rate limits, or geographic licensing restrictions that the target lawfully enforces under applicable law (including the EU Digital Markets Act exceptions and the InfoSoc Directive 2001/29/EC's permitted exceptions). This clause does not prohibit interoperability or research use that is itself lawful in Customer's jurisdiction.' — pinned so the EU-DMA + InfoSoc-Directive interoperability/research carve-out survives (drift to dropping would let interoperability/research be inadvertently swept into the technical-protection-bypass prohibition)", () => {
    expect(body).toMatch(
      /pricing tiers, rate limits, or geographic licensing\s*\n?\s*restrictions that the target lawfully enforces under applicable\s*\n?\s*law \(including the EU Digital Markets Act exceptions and the\s*\n?\s*InfoSoc Directive 2001\/29\/EC's permitted exceptions\)\./,
    );
    expect(body).toMatch(
      /This clause\s*\n?\s*does not prohibit interoperability or research use that is itself\s*\n?\s*lawful in Customer's jurisdiction\./,
    );
  });

  it("Section 3 Controller/Processor GDPR Article 28(3)(a) split pinned: 'Customer is the lawful-basis decision-maker. When Customer processes Personal Data through the Service, Customer is the Controller (in GDPR terms) and Driftstack is the Processor.' + Article 28(3)(a) anchor on instructions framing — pinned so the GDPR-controller-vs-processor split + the Article-28(3)(a) instructions anchor survive (drift to claiming Driftstack as Controller would shift compliance responsibility incorrectly; drift to dropping the Article 28(3)(a) anchor would weaken the legal-basis-of-instructions framing)", () => {
    expect(body).toMatch(/\*\*Customer is the lawful-basis decision-maker\.\*\*/);
    expect(body).toMatch(
      /Customer is the\s*\n?\s*Controller \(in GDPR terms\) and Driftstack is the Processor\./,
    );
    expect(body).toMatch(
      /Driftstack acts on\s*\n?\s*that request as Customer's documented instruction \(within the\s*\n?\s*meaning of Article 28\(3\)\(a\) GDPR\)/,
    );
  });

  it("Customer-Connected Services 4-list framing pinned: 'the proxy provider Customer uses, the captcha-solving service Customer uses, the email-verification service Customer uses, and the SMS-verification service Customer uses are Customer's contractual counterparties, not Driftstack's.' — pinned so the 4-customer-connected-services delineation survives (drift to dropping any would let customers conflate those services with Driftstack sub-processors; drift to dropping 'not Driftstack's' would create ambiguity about which contractual chain applies)", () => {
    expect(body).toMatch(
      /the proxy provider Customer uses, the\s*\n?\s*captcha-solving service Customer uses, the email-verification\s*\n?\s*service Customer uses, and the SMS-verification service Customer\s*\n?\s*uses are Customer's contractual counterparties, not Driftstack's\./,
    );
  });

  it('Section 4 abuse-reporting 3-source pinned: Target operators + Data subjects + Law enforcement (Dutch BV legal process) + abuse@driftstack.dev + 5-business-day triage — pinned so the 3-reporter-source surface + the 5-business-day triage SLA + the Dutch-BV-jurisdiction anchor survive (drift to dropping the Dutch BV jurisdiction would orphan the law-enforcement framing from the legal-entity reality; drift to dropping the data-subject reporting path would close off the GDPR-Article-15 customer-side channel)', () => {
    expect(body).toMatch(
      /Driftstack maintains an abuse-reporting channel at `abuse@driftstack\.dev`\./,
    );
    expect(body).toMatch(/Reports are triaged within five \(5\) business days\./);
    expect(body).toMatch(/\*\*Target operators\*\*/);
    expect(body).toMatch(/\*\*Data subjects\*\*/);
    expect(body).toMatch(
      /\*\*Law enforcement\*\* acting under a valid legal process applicable\s*\n?\s*to Driftstack as a Dutch BV\./,
    );
  });

  it("Section 5 graduated 3-stage enforcement: Warning (7-day remediation) → Suspension (30-day, 403 + problem+json + Customer-Provided Secrets not deleted + billing pauses) → Termination (Section 16 ToS) — pinned so the 3-stage progression + the suspension-mechanics specificity (403 / errors.driftstack.dev/forbidden / billing-pauses / secrets-preserved) survive (drift to dropping 'secrets NOT deleted' on suspension would force customers to recreate state on remediation; drift to dropping the 7-day-remediation-window would let warnings escalate without time-to-fix)", () => {
    expect(body).toMatch(/\*\*5\.1 Warning\.\*\*/);
    expect(body).toMatch(/a remediation\s*\n?\s*window \(typically 7 days\)/);
    expect(body).toMatch(/\*\*5\.2 Suspension\.\*\*/);
    expect(body).toMatch(
      /the API rejects authenticated requests\s*\n?\s*with HTTP 403 carrying a problem type\s*\n?\s*`https:\/\/errors\.driftstack\.dev\/forbidden`/,
    );
    expect(body).toMatch(/Customer-Provided Secrets are NOT\s*\n?\s*deleted/);
    expect(body).toMatch(/Suspension typically lasts up\s*\n?\s*to 30 days/);
    // V-758 — the "billing pauses" promise is now TRUE (suspend() sets pause_collection
    // via BillingCollectionPauser) and the copy states the mechanism, so the pin requires
    // the specificity rather than the bare phrase. `void` not `keep_as_draft` is the
    // load-bearing part: deferral would bill a suspended customer retroactically, which is
    // the opposite of what this clause tells them.
    expect(body).toMatch(/Driftstack sets `pause_collection` on the/);
    expect(body).toMatch(/voided rather than deferred/);
    expect(body).toMatch(/not\s*\n?\s*billed retroactively on reinstatement/);
    expect(body).toMatch(/\*\*5\.3 Termination\.\*\*/);
    // V-1170 — §5.4 grants discretion to skip steps in "Section 5.1–5.3", which did not
    // exist as identifiers until the ladder carried them.
    expect(body, 'the ladder lost its clause identifiers again').not.toMatch(
      /^2\. \*\*Suspension\.\*\*/m,
    );
    expect(body).toMatch(/Driftstack terminates the Subscription per Section 16 of the ToS\./);
  });

  it("Section 5.4 discretion-to-skip 4-condition pinned: Section 1 violations + legal process + imminent third-party threat + admitted-or-incontrovertible violation — pinned so the 4 skip-the-progression conditions stay explicit (drift to dropping 'admitted by Customer' would force Driftstack through the warning step even after Customer self-confession; drift to dropping 'imminent threat' would block fast-suspension for ongoing third-party harm)", () => {
    expect(body).toMatch(/The violation is described in Section 1 of this AUP/);
    expect(body).toMatch(
      /A valid legal process — court order, supervisory authority order,\s*\n?\s*or law-enforcement demand — requires it\./,
    );
    expect(body).toMatch(
      /Continued operation poses a credible imminent threat to a third\s*\n?\s*party that immediate suspension can mitigate\./,
    );
    expect(body).toMatch(
      /The violation is admitted by Customer or is supported by\s*\n?\s*incontrovertible evidence/,
    );
  });

  it("Section 7 own-AUP-compliance 2-vendor: MacStadium (mac mini fleet) + Stripe Restricted Businesses + Stripe-restricted-customer-may-cause-Driftstack-termination + future-payment-processor sub-processor-amendment notice — pinned so the 2-vendor upstream-AUP constraint + the customer-may-be-Stripe-blocked-while-AUP-clean framing + the future-payment-processor notification commitment all survive (drift to dropping MacStadium would orphan the hosting-layer constraint; drift to dropping the 'render Customer's account un-billable' framing would mislead customers about how Stripe's restrictions can hit them)", () => {
    expect(body).toMatch(/\*\*MacStadium's AUP\*\* for the mac mini fleet hosting layer\./);
    expect(body).toMatch(/\*\*Stripe's AUP \/ Restricted Businesses list\*\*/);
    expect(body).toMatch(
      /a Customer whose use of the Service falls into a\s*\n?\s*Stripe-restricted category may render the Customer's account\s*\n?\s*un-billable through Stripe even if the use otherwise satisfies\s*\n?\s*Section 1 and Section 2 of this AUP\./,
    );
  });

  it('Section 9 Dutch BV Amsterdam jurisdiction + 3-contact-channel pinned: abuse@ + support@ + Driftstack B.V., Amsterdam, the Netherlands — pinned so the Dutch-legal-entity jurisdiction + 3-contact-surface stays consistent (drift to dropping the Dutch BV jurisdiction would orphan the legal-entity reality from the contact framing; drift to dropping the abuse@ channel would close off the AUP-violation-reporting path)', () => {
    expect(body).toMatch(/- Abuse reports: `abuse@driftstack\.dev`/);
    expect(body).toMatch(/- General AUP questions: `support@driftstack\.dev`/);
    expect(body).toMatch(
      /- Postal correspondence: addressed to Driftstack B\.V\., Amsterdam, the Netherlands\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
