// W574.C — drift guard for /docs/legal/acceptable-use-policy.md.
// Driftstack AUP Version 1.0 (2026-05-07). Drift here either weakens
// the 5 prohibited-target categories (CSAM + terrorism + sanctioned
// + critical-infra + malware), drops a prohibited-technique from the
// 7-clause list, or unsets the 3-step enforcement progression
// (warning → suspension → termination) + 4 skip-conditions.
//
//   • AUP Version 1.0. Effective 2026-05-07. Incorporated into ToS.
//   • 5 prohibited targets (Section 1).
//   • 7 prohibited techniques (Section 2).
//   • 5 Customer responsibility framing clauses (Section 3).
//   • 3-step enforcement progression + 4 skip-conditions.
//   • Driftstack itself bound by MacStadium AUP + Stripe AUP.
//   • abuse@driftstack.dev triage 5 business days.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/legal/acceptable-use-policy.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W574.C /docs/legal/acceptable-use-policy.md content parity', () => {
  const body = read(LIB);

  it('Header + Version-1.0 + 2026-05-07 + AUP-incorporated-into-ToS + 5-prohibited-targets framing pinned', () => {
    expect(body).toMatch(/^# Driftstack — Acceptable Use Policy$/m);
    expect(body).toMatch(/\*\*Version:\*\* 1\.0 · \*\*Effective:\*\* 2026-05-07/);
    expect(body).toMatch(
      /This Acceptable Use Policy \("\*\*AUP\*\*"\) governs Customer's use of the/,
    );
    expect(body).toMatch(
      /Service\. The AUP is incorporated into the \[Terms of Service\]\(terms-of-service\.md\) by reference\./,
    );
    expect(body).toMatch(/Capitalised terms are defined in/);
    expect(body).toMatch(/\[`definitions\.md`\]\(definitions\.md\)\./);
    expect(body).toMatch(/Customer is the party closest to the lawfulness/);
    expect(body).toMatch(/of any given Session/);
    expect(body).toMatch(/## 1\. Prohibited targets/);
    expect(body).toMatch(/1\. \*\*Child sexual abuse material \(CSAM\)\.\*\*/);
    expect(body).toMatch(/Including any site/);
    expect(body).toMatch(/distributing, advertising, or facilitating the production of/);
    expect(body).toMatch(/sexually exploitative imagery or content depicting persons under 18/);
    expect(body).toMatch(/2\. \*\*Terrorism or material support for terrorism\.\*\*/);
    expect(body).toMatch(/EU consolidated terrorist list, the UN consolidated sanctions/);
    expect(body).toMatch(/list, the US OFAC Specially Designated Nationals list/);
    expect(body).toMatch(/3\. \*\*Sanctioned entities\.\*\*/);
    expect(body).toMatch(/Any entity, person, or service designated/);
    expect(body).toMatch(/under EU sanctions \(Council Regulation\), the UK sanctions list \(UK/);
    expect(body).toMatch(/Office of Financial Sanctions Implementation\), the US OFAC SDN/);
    expect(body).toMatch(/list/);
    expect(body).toMatch(/4\. \*\*Critical infrastructure attack\.\*\*/);
    expect(body).toMatch(/Including any system whose/);
    expect(body).toMatch(/compromise would foreseeably impact public safety, public health,/);
    expect(body).toMatch(/public utilities, defence, financial-system stability, or/);
    expect(body).toMatch(/electoral integrity\./);
    expect(body).toMatch(
      /5\. \*\*Distribution of malware, ransomware, or destructive payloads\.\*\*/,
    );
    expect(body).toMatch(/The Service may not be used to deliver, host, or trigger software/);
    expect(body).toMatch(/designed to compromise, encrypt, or destroy third-party systems or/);
    expect(body).toMatch(/data\./);
  });

  it('7 prohibited techniques (credential stuffing + mass account creation + DDoS + vuln exploit + circumvention + PII scraping + CAPTCHA bypass) framing pinned', () => {
    expect(body).toMatch(/## 2\. Prohibited techniques/);
    expect(body).toMatch(/1\. \*\*Credential stuffing\.\*\*/);
    expect(body).toMatch(/Using the Service to test credential/);
    expect(body).toMatch(/pairs \(username\/password\) obtained from a breach corpus or other/);
    expect(body).toMatch(/third-party source against a target where Customer lacks the/);
    expect(body).toMatch(/account-holder's authorisation\./);
    expect(body).toMatch(
      /2\. \*\*Mass account creation in violation of target Terms of Service\.\*\*/,
    );
    expect(body).toMatch(/Where Customer lacks authorisation from the target operator and/);
    expect(body).toMatch(/the target operator's published terms prohibit programmatic/);
    expect(body).toMatch(/account creation/);
    expect(body).toMatch(/"At scale" means more than the rate a single/);
    expect(body).toMatch(/ordinary human user could plausibly create through the target's/);
    expect(body).toMatch(/intended interfaces\./);
    expect(body).toMatch(
      /3\. \*\*Distributed denial-of-service \(DDoS\) or volumetric attack\.\*\*/,
    );
    expect(body).toMatch(/Customer may not use the Service to generate request volumes/);
    expect(body).toMatch(/intended to degrade or deny availability of the target\./);
    expect(body).toMatch(/Driftstack/);
    expect(body).toMatch(/reserves the right to apply per-target rate limiting on its own/);
    expect(body).toMatch(/initiative when usage patterns suggest DDoS-like behaviour/);
    expect(body).toMatch(/4\. \*\*Vulnerability exploitation without authorisation\.\*\*/);
    expect(body).toMatch(/Customer may/);
    expect(body).toMatch(/not use the Service to exploit a known vulnerability against a/);
    expect(body).toMatch(/target that Customer is not authorised to test\./);
    expect(body).toMatch(/Customer's bug/);
    expect(body).toMatch(/bounty work falls within this carve-out only when the target/);
    expect(body).toMatch(/operator's published bug bounty programme covers the technique,/);
    expect(body).toMatch(/5\. \*\*Bypassing technical protection measures with intent to defeat/);
    expect(body).toMatch(/commercial limits\.\*\*/);
    expect(body).toMatch(/Customer may not use the Service to defeat/);
    expect(body).toMatch(/per-user pricing tiers, rate limits, or geographic licensing/);
    expect(body).toMatch(/restrictions that the target lawfully enforces under applicable/);
    expect(body).toMatch(/law \(including the EU Digital Markets Act exceptions and the/);
    expect(body).toMatch(/InfoSoc Directive 2001\/29\/EC's permitted exceptions\)\./);
    expect(body).toMatch(/6\. \*\*Personal data scraping outside Customer's lawful basis\.\*\*/);
    expect(body).toMatch(/Customer may not use the Service to harvest Personal Data \(as/);
    expect(body).toMatch(/defined by the GDPR or any equivalent regime applicable to the/);
    expect(body).toMatch(/data subject\) where Customer lacks a lawful basis under Article 6/);
    expect(body).toMatch(/GDPR or the equivalent local provision\./);
    expect(body).toMatch(/7\. \*\*Circumventing CAPTCHA or anti-automation in a manner that/);
    expect(body).toMatch(/targets the rights of the target's other users\.\*\*/);
    expect(body).toMatch(/Specifically:/);
    expect(body).toMatch(/when Customer's automation degrades the target's ability to/);
    expect(body).toMatch(/protect its other users \(e\.g\. by overwhelming a fraud-detection/);
    expect(body).toMatch(/pipeline or by impersonating non-Customer users\), Customer's use/);
    expect(body).toMatch(/crosses into prohibited territory regardless of Customer's/);
    expect(body).toMatch(/commercial purpose\./);
  });

  it('Customer-responsibility-framing + abuse-reporting + enforcement-progression + skip-conditions + Driftstack-AUP-compliance + Updates + Contact framing pinned', () => {
    expect(body).toMatch(/## 3\. Customer responsibility framing/);
    expect(body).toMatch(/The following framing is constitutive, not advisory:/);
    expect(body).toMatch(/1\. \*\*Customer holds the relationship with the target\.\*\*/);
    expect(body).toMatch(/2\. \*\*Customer holds the relationships with Customer-Connected/);
    expect(body).toMatch(/Services\.\*\*/);
    expect(body).toMatch(/3\. \*\*Customer is the lawful-basis decision-maker\.\*\*/);
    expect(body).toMatch(/When Customer/);
    expect(body).toMatch(/processes Personal Data through the Service, Customer is the/);
    expect(body).toMatch(/Controller \(in GDPR terms\) and Driftstack is the Processor\./);
    expect(body).toMatch(/4\. \*\*The Service provides infrastructure, not legality\.\*\*/);
    expect(body).toMatch(
      /5\. \*\*Customer's sessions can constitute Customer's instructions\.\*\*/,
    );
    expect(body).toMatch(/within the/);
    expect(body).toMatch(/meaning of Article 28\(3\)\(a\) GDPR/);
    expect(body).toMatch(/## 4\. Reporting \+ abuse mechanism/);
    expect(body).toMatch(
      /Driftstack maintains an abuse-reporting channel at `abuse@driftstack\.dev`\./,
    );
    expect(body).toMatch(/Reports are triaged within five \(5\) business days\./);
    expect(body).toMatch(/Driftstack accepts reports/);
    expect(body).toMatch(/from:/);
    expect(body).toMatch(/1\. \*\*Target operators\*\*/);
    expect(body).toMatch(/2\. \*\*Data subjects\*\*/);
    expect(body).toMatch(
      /3\. \*\*Law enforcement\*\* acting under a valid legal process applicable/,
    );
    expect(body).toMatch(/to Driftstack as a Dutch BV\./);
    expect(body).toMatch(/A report received in good faith will not result in immediate/);
    expect(body).toMatch(/suspension of Customer's account\./);
    expect(body).toMatch(/## 5\. Enforcement progression/);
    expect(body).toMatch(/Driftstack's enforcement of this AUP follows a graduated progression/);
    expect(body).toMatch(/1\. \*\*Warning\.\*\* First instance of a non-severe violation/);
    expect(body).toMatch(/2\. \*\*Suspension\.\*\* A continued or repeated violation following a/);
    expect(body).toMatch(/warning, OR a moderately severe first violation/);
    expect(body).toMatch(/the API rejects authenticated requests/);
    expect(body).toMatch(/with HTTP 403 carrying a problem type/);
    expect(body).toMatch(/`https:\/\/errors\.driftstack\.dev\/forbidden`/);
    expect(body).toMatch(/Suspension typically lasts up\s*\n?\s*to 30 days/);
    // V-758 — the billing-pauses clause now states its mechanism, because it is finally
    // implemented: suspend() sets pause_collection with Stripe's `void` behaviour and
    // unsuspend() clears it. `void` rather than deferral is the part that matters to a
    // customer — they are not billed retroactively for a window in which every request
    // 403'd.
    expect(body).toMatch(/Driftstack sets `pause_collection` on the/);
    expect(body).toMatch(/voided rather than deferred/);
    expect(body).toMatch(/3\. \*\*Termination\.\*\* A severe violation under Section 1/);
    expect(body).toMatch(/Driftstack terminates the Subscription per Section 16 of the ToS\./);
    expect(body).toMatch(/### 5\.4 Discretion to skip steps/);
    expect(body).toMatch(/Driftstack reserves the right to skip directly to suspension or/);
    expect(body).toMatch(/termination, without warning, where:/);
    expect(body).toMatch(/1\. The violation is described in Section 1 of this AUP/);
    expect(body).toMatch(/2\. A valid legal process — court order, supervisory authority order,/);
    expect(body).toMatch(/or law-enforcement demand — requires it\./);
    expect(body).toMatch(/3\. Continued operation poses a credible imminent threat to a third/);
    expect(body).toMatch(/party that immediate suspension can mitigate\./);
    expect(body).toMatch(/4\. The violation is admitted by Customer or is supported by/);
    expect(body).toMatch(/incontrovertible evidence/);
    expect(body).toMatch(/## 6\. Takedown response procedure/);
    expect(body).toMatch(/Driftstack responds to valid legal notices \(court orders,/);
    expect(body).toMatch(/supervisory-authority orders, mutual legal assistance treaty/);
    expect(body).toMatch(/requests, properly-served subpoenas applicable to Driftstack as a/);
    expect(body).toMatch(/Dutch BV\)/);
    expect(body).toMatch(/applicable regime is the EU Digital Services Act \(Regulation \(EU\)/);
    expect(body).toMatch(/2022\/2065\)/);
    expect(body).toMatch(/## 7\. Driftstack's own AUP compliance/);
    expect(body).toMatch(/1\. \*\*MacStadium's AUP\*\* for the mac mini fleet hosting layer\./);
    expect(body).toMatch(/2\. \*\*Stripe's AUP \/ Restricted Businesses list\*\* for the payment/);
    expect(body).toMatch(/processing layer\./);
    expect(body).toMatch(/## 8\. Updates/);
    expect(body).toMatch(
      /This AUP is a Document under the \[Terms of Service\]\(terms-of-service\.md\)\./,
    );
    expect(body).toMatch(/Material updates trigger the/);
    expect(body).toMatch(
      /re-acceptance flow described in \[`definitions\.md`\]\(definitions\.md\)/,
    );
    expect(body).toMatch(/under "Acceptance"\./);
    expect(body).toMatch(/Patch-level updates \(typo, formatting,/);
    expect(body).toMatch(/clarification of an existing prohibition\) do not\./);
    expect(body).toMatch(/## 9\. Contact/);
    expect(body).toMatch(/- Abuse reports: `abuse@driftstack\.dev`/);
    expect(body).toMatch(/- General AUP questions: `support@driftstack\.dev`/);
    expect(body).toMatch(
      /- Postal correspondence: addressed to Driftstack B\.V\., Amsterdam, the Netherlands\./,
    );
    expect(body).toMatch(/_End of AUP\._/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
