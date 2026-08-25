// W377.C — drift guard for marketing-site /legal/aup.md content.
// Existing legal-doc-cross-link-integrity covers shape. This guard
// pins the load-bearing abuse-counsel claims (target operator /
// data subject / law-enforcement reviewer anchor):
//
//   • Version 1.0 + Effective 2026-05-07 (pin via doc-header drift).
//   • §1 5 prohibited targets: CSAM / terrorism / sanctioned /
//     critical-infra / malware. Each row is load-bearing and
//     cross-checked against sanction-regime references.
//   • §2 7 prohibited techniques (credential stuffing / mass
//     account creation / DDoS / vuln-exploit / commercial-limit
//     bypass / personal-data scraping / CAPTCHA-circumvention-
//     harming-target-users).
//   • §3 5 customer-responsibility framings (constitutive, not
//     advisory).
//   • §4 5-business-day abuse-report triage + abuse@driftstack.dev.
//   • §5 3-step graduated progression: Warning → Suspension →
//     Termination. §5.2 suspension: HTTP 403 +
//     errors.driftstack.dev/forbidden problem type.
//   • §5.4 4 skip-step conditions (§1 violation / valid legal
//     process / imminent threat / admitted violation).
//   • §7 MacStadium + Stripe Sub-processor AUP-binding framing.
//   • Cross-links: terms.md exists.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/aup.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W377.C marketing-site /legal/aup.md content parity', () => {
  const body = read(PAGE);

  it('version 1.0 + effective 2026-05-07 doc header pinned', () => {
    expect(body).toMatch(/\*\*Version:\*\* 1\.0 · \*\*Effective:\*\* 2026-05-07/);
  });

  it('preamble: infrastructure-not-pre-screen + customer-closest-to-lawfulness framing', () => {
    expect(body).toMatch(/the Service is general-purpose infrastructure\s+that can be misused/);
    expect(body).toMatch(/Customer is the party closest to the lawfulness/);
    expect(body).toMatch(/Driftstack does not pre-screen target sites/);
  });

  it('§1 5 prohibited-target rows pinned (CSAM / terrorism / sanctioned / critical-infra / malware)', () => {
    expect(body).toMatch(/\*\*Child sexual abuse material \(CSAM\)\.\*\*/);
    expect(body).toMatch(/\*\*Terrorism or material support for terrorism\.\*\*/);
    expect(body).toMatch(/\*\*Sanctioned entities\.\*\*/);
    expect(body).toMatch(/\*\*Critical infrastructure attack\.\*\*/);
    expect(body).toMatch(/\*\*Distribution of malware, ransomware, or destructive payloads\.\*\*/);
  });

  it('§1.1 CSAM absolute prohibition pinned + "overrides any claim of investigative purpose"', () => {
    expect(body).toMatch(
      /This\s+prohibition is absolute and overrides any claim of investigative or\s+research purpose/,
    );
    expect(body).toMatch(/persons under 18/);
  });

  it('§1.2 terrorism: 3 sanction-list references (EU consolidated / UN consolidated / US OFAC SDN)', () => {
    expect(body).toMatch(/EU consolidated terrorist list/);
    expect(body).toMatch(/UN consolidated sanctions\s+list/);
    expect(body).toMatch(/US OFAC Specially Designated Nationals list/);
  });

  it('§1.4 critical-infrastructure: 5 impact categories + authorised-pentest carve-out', () => {
    expect(body).toMatch(
      /public safety, public health,\s+public utilities, defence, financial-system stability, or\s+electoral integrity/,
    );
    expect(body).toMatch(
      /Customer's authorised penetration\s+testing of Customer's own infrastructure is permitted only when\s+Customer holds written authorisation/,
    );
  });

  it('§2 7 prohibited-technique rows pinned', () => {
    expect(body).toMatch(/\*\*Credential stuffing\.\*\*/);
    expect(body).toMatch(/\*\*Mass account creation in violation of target Terms of Service\.\*\*/);
    expect(body).toMatch(/\*\*Distributed denial-of-service \(DDoS\) or volumetric attack\.\*\*/);
    expect(body).toMatch(/\*\*Vulnerability exploitation without authorisation\.\*\*/);
    expect(body).toMatch(
      /\*\*Bypassing technical protection measures with intent to defeat\s+commercial limits\.\*\*/,
    );
    expect(body).toMatch(/\*\*Personal data scraping outside Customer's lawful basis\.\*\*/);
    expect(body).toMatch(
      /\*\*Circumventing CAPTCHA or anti-automation in a manner that\s+targets the rights of the target's other users\.\*\*/,
    );
  });

  it('§2.3 DDoS: Driftstack reserves right to per-target rate-limit on its own initiative', () => {
    expect(body).toMatch(
      /Driftstack\s+reserves the right to apply per-target rate limiting on its own\s+initiative when usage patterns suggest DDoS-like behaviour/,
    );
  });

  it('§2.5 commercial-limit bypass: EU DMA + InfoSoc Directive 2001/29/EC carve-outs', () => {
    expect(body).toMatch(/EU Digital Markets Act exceptions/);
    expect(body).toMatch(/InfoSoc Directive 2001\/29\/EC/);
  });

  it('§3 5 customer-responsibility framings pinned (constitutive-not-advisory)', () => {
    expect(body).toMatch(/The following framing is constitutive, not advisory:/);
    expect(body).toMatch(/\*\*Customer holds the relationship with the target\.\*\*/);
    expect(body).toMatch(
      /\*\*Customer holds the relationships with Customer-Connected\s+Services\.\*\*/,
    );
    expect(body).toMatch(/\*\*Customer is the lawful-basis decision-maker\.\*\*/);
    expect(body).toMatch(/\*\*The Service provides infrastructure, not legality\.\*\*/);
    expect(body).toMatch(/\*\*Customer's sessions can constitute Customer's instructions\.\*\*/);
  });

  it('§3.5 Article 28(3)(a) GDPR documented-instruction framing', () => {
    expect(body).toMatch(
      /Driftstack acts on\s+that request as Customer's documented instruction \(within the\s+meaning of Article 28\(3\)\(a\) GDPR\)/,
    );
  });

  it('§4 abuse@driftstack.dev + 5-business-day triage', () => {
    expect(body).toMatch(/abuse-reporting channel at `abuse@driftstack\.dev`/);
    expect(body).toMatch(/triaged within five \(5\) business days/);
  });

  it('§4 3 accepted-report sources: target operators / data subjects / law enforcement', () => {
    expect(body).toMatch(/\*\*Target operators\*\* who believe Customer's use of the Service/);
    expect(body).toMatch(
      /\*\*Data subjects\*\* who believe a Customer is processing their\s+Personal Data/,
    );
    expect(body).toMatch(
      /\*\*Law enforcement\*\* acting under a valid legal process applicable\s+to Driftstack as a Dutch BV/,
    );
  });

  it('§5 3-step graduated progression: Warning → Suspension → Termination', () => {
    expect(body).toMatch(/\*\*5\.1 Warning\.\*\* First instance of a non-severe violation/);
    expect(body).toMatch(/\*\*5\.2 Suspension\.\*\* A continued or repeated violation/);
    expect(body).toMatch(/\*\*5\.3 Termination\.\*\* A severe violation under Section 1/);
    // V-1170 — the steps carried no clause identifiers while §5.4 cited "Section 5.1–5.3".
    expect(body, 'the ladder lost its clause identifiers again').not.toMatch(
      /^2\. \*\*Suspension\.\*\*/m,
    );
  });

  it('§5.1 warning: 7-day remediation window', () => {
    expect(body).toMatch(/remediation\s+window \(typically 7 days\)/);
  });

  it('§5.2 suspension: HTTP 403 + errors.driftstack.dev/forbidden problem type. V-754 REMOVED the `reason` extension promise — ForbiddenError takes only `detail` and passes no extensions, so all three suspension throw sites emit a bare problem body and no AUP clause identifier is stored anywhere to put in one.', () => {
    expect(body).toMatch(/the API rejects authenticated requests\s+with HTTP 403/);
    expect(body).toMatch(/problem type\s+`https:\/\/errors\.driftstack\.dev\/forbidden`/);
    // The false promise must not return, and the honest replacement must stay: the
    // machine-readable suspension signal is the webhook reason_code, not the 403 body.
    expect(body).not.toMatch(/forbidden` and a `reason` extension/);
    expect(body).not.toMatch(/`reason` extension\s+identifying the AUP clause/);
    expect(body).toMatch(/there is no `reason` extension naming an AUP/);
    expect(body).toMatch(/reason_code: "account_suspended"/);
    expect(body).toMatch(/typically lasts up\s*to 30 days/);
    // V-758 — the billing-pauses promise is implemented now (pause_collection with
    // Stripe's `void` behaviour, set on suspend and cleared on unsuspend), so the copy
    // names the mechanism and this pin requires it.
    expect(body).toMatch(/Driftstack sets `pause_collection` on the/);
    expect(body).toMatch(/voided rather than deferred/);
    expect(body).toMatch(/Customer-Provided Secrets are NOT\s+deleted/);
  });

  it('§5.4 4 skip-step conditions (§1 violation / valid legal process / imminent threat / admitted)', () => {
    expect(body).toMatch(
      /Driftstack reserves the right to skip directly to suspension or\s+termination/,
    );
    expect(body).toMatch(/The violation is described in Section 1 of this AUP/);
    expect(body).toMatch(
      /A valid legal process — court order, supervisory authority order,\s+or law-enforcement demand/,
    );
    expect(body).toMatch(/credible imminent threat to a third\s+party/);
    expect(body).toMatch(/The violation is admitted by Customer/);
  });

  it('§6 takedown response: EU DSA (Regulation (EU) 2022/2065) framing', () => {
    expect(body).toMatch(/EU Digital Services Act \(Regulation \(EU\)\s+2022\/2065\)/);
    expect(body).toMatch(
      /Driftstack will not voluntarily disclose Customer Data to third\s+parties \(including law enforcement\) absent a valid legal process/,
    );
  });

  it('§7 Driftstack-own-AUP-compliance: MacStadium + Stripe Restricted Businesses', () => {
    expect(body).toMatch(/\*\*MacStadium's AUP\*\* for the mac mini fleet hosting layer/);
    expect(body).toMatch(/\*\*Stripe's AUP \/ Restricted Businesses list\*\*/);
    expect(body).toMatch(
      /a Customer whose use of the Service falls into a\s+Stripe-restricted category may render the Customer's account\s+un-billable/,
    );
  });

  it('§9 contact addresses: abuse@ + support@', () => {
    expect(body).toMatch(/Abuse reports: `abuse@driftstack\.dev`/);
    expect(body).toMatch(/General AUP questions: `support@driftstack\.dev`/);
    expect(body).toMatch(/Driftstack B\.V\., Amsterdam, the Netherlands/);
  });

  it('cross-link: canonical Terms route', () => {
    expect(body).toMatch(/\[Terms of Service\]\(\/legal\/terms\/\)/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/terms.md'))).toBe(
      true,
    );
  });
});
