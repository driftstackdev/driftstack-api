// W575.C — drift guard for /docs/legal/dpa.md (Part 3 of 3).
// Driftstack DPA Annexes 1-5 + Contact. Drift here either drops a
// sub-processor from the Annex-3 table, weakens an Annex-2 TOM
// category (A-G), or unsets the UK IDTA + Swiss FDPIC addenda.
//
//   • Annex 1: data subjects + categories + special-category posture.
//   • Annex 2: 7 TOM categories (A-G) per Article 32.
//   • Annex 3: 13-row sub-processor table.
//   • Annex 4: 2021 SCCs Module 1/2/3 selections.
//   • Annex 5: UK IDTA + Swiss FDPIC addenda.
//   • Contact: privacy@ + legal@.

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

describe('W575.C /docs/legal/dpa.md (part 3) content parity', () => {
  const body = read(LIB);

  it('Annex 1 (Data Subjects + Personal Data + special-category) + Annex 2 TOM categories A-D framing pinned', () => {
    expect(body).toMatch(/## Annex 1 — Description of Processing/);
    expect(body).toMatch(/### Categories of Data Subjects/);
    expect(body).toMatch(/1\. Customer's Authorized Users \(employees, contractors, agents\)/);
    expect(body).toMatch(/whose Personal Data is contained in Account Data\./);
    expect(body).toMatch(/2\. Natural persons whose Personal Data Customer's automated/);
    expect(body).toMatch(/browsing encounters at Customer-selected target sites\./);
    expect(body).toMatch(/### Categories of Personal Data/);
    expect(body).toMatch(/1\. \*\*Account-related\*\* \(Authorized Users\): name, email address,/);
    expect(body).toMatch(/role, time zone, billing contact information\./);
    expect(body).toMatch(/2\. \*\*Session-related\*\* \(Data Subjects encountered through/);
    expect(body).toMatch(/automation\):/);
    expect(body).toMatch(/- Identifiers visible to the automated browsing \(account names,/);
    expect(body).toMatch(/screen names, profile photos, public posts, public profile/);
    expect(body).toMatch(/URLs\)\./);
    expect(body).toMatch(/3\. \*\*Customer-Provided Secrets\*\*: credentials Customer supplies/);
    expect(body).toMatch(/\(proxy auth, captcha API keys, email credentials, SMS API keys\)\./);
    expect(body).toMatch(/### Special categories/);
    expect(body).toMatch(/Driftstack does \*\*not\*\* intentionally Process Special Category Data/);
    expect(body).toMatch(/under Article 9 GDPR\./);
    expect(body).toMatch(/Where Customer's automated browsing causes/);
    expect(body).toMatch(/such data to enter a Recording, Customer is responsible for the/);
    expect(body).toMatch(/underlying Article 9 lawful basis\./);
    expect(body).toMatch(/### Processing operations/);
    expect(body).toMatch(/Storage, retrieval, transmission, transformation, deletion,/);
    expect(body).toMatch(/forwarding to Customer-Connected Services on Customer's/);
    expect(body).toMatch(/instruction/);
    expect(body).toMatch(/## Annex 2 — Technical and Organisational Measures \(TOMs\)/);
    expect(body).toMatch(/These measures meet the requirement of Article 32 GDPR/);
    expect(body).toMatch(/### A\. Confidentiality \(Article 32\(1\)\(b\)\)/);
    expect(body).toMatch(
      /1\. \*\*Access control to systems\.\*\* Production systems are accessible/,
    );
    expect(body).toMatch(/only to authenticated personnel through identity-provider-/);
    expect(body).toMatch(/integrated SSO with hardware-key-gated access where available\./);
    expect(body).toMatch(
      /2\. \*\*Access control to data\.\*\* Application-level authentication via/,
    );
    expect(body).toMatch(/API Keys; per-Customer scoping/);
    expect(body).toMatch(/3\. \*\*API key handling\.\*\* API Keys are stored as scrypt hashes/);
    expect(body).toMatch(
      /4\. \*\*Customer-Provided Secret handling\.\*\* Stored encrypted at rest/,
    );
    expect(body).toMatch(/5\. \*\*Personnel\.\*\* Driftstack personnel with production access are/);
    expect(body).toMatch(/bound by written confidentiality obligations\./);
    expect(body).toMatch(/### B\. Integrity \(Article 32\(1\)\(b\)\)/);
    expect(body).toMatch(
      /1\. \*\*Encryption in transit\.\*\* TLS 1\.2 minimum \(TLS 1\.3 preferred\)/,
    );
    expect(body).toMatch(/for all API and Service traffic\. HSTS configured\./);
    expect(body).toMatch(/2\. \*\*Encryption at rest\.\*\* Postgres disk-level encryption at the/);
    expect(body).toMatch(/storage layer; application-level encryption for sensitive/);
    expect(body).toMatch(/fields \(API key hashes, Customer-Provided Secrets\)\./);
    expect(body).toMatch(
      /3\. \*\*Input validation\.\*\* Every API endpoint validates input through/,
    );
    expect(body).toMatch(/Zod schemas;/);
    expect(body).toMatch(/4\. \*\*Code-level protections\.\*\* TypeScript strict mode across the/);
    expect(body).toMatch(/codebase/);
    expect(body).toMatch(/### C\. Availability \+ resilience \(Article 32\(1\)\(b\)\)/);
    expect(body).toMatch(/1\. \*\*Backup\.\*\* Postgres point-in-time recovery configured;/);
    expect(body).toMatch(/default 30-day retention\./);
    expect(body).toMatch(/2\. \*\*Redundancy\.\*\* Mac mini fleet capacity is provisioned with/);
    expect(body).toMatch(/N\+1 redundancy at launch tiers/);
    expect(body).toMatch(/3\. \*\*Health monitoring\.\*\* Structured Pino logs/);
    expect(body).toMatch(/4\. \*\*Incident response\.\*\* Documented runbook;/);
    expect(body).toMatch(/### D\. Restoration \(Article 32\(1\)\(c\)\)/);
    expect(body).toMatch(/Backups are tested for restore at least quarterly\./);
  });

  it('Annex 2 TOMs E-G + Annex 3 sub-processor table (13 rows) framing pinned', () => {
    expect(body).toMatch(
      /### E\. Process for testing, assessing, evaluating effectiveness \(Article 32\(1\)\(d\)\)/,
    );
    expect(body).toMatch(/1\. Periodic security reviews of changes affecting/);
    expect(body).toMatch(/authentication, authorisation, or data handling\./);
    expect(body).toMatch(/2\. Dependency vulnerability scanning on every CI run\./);
    expect(body).toMatch(
      /3\. Coordinated vulnerability disclosure: a published mechanism for security researchers to report issues at `security@driftstack\.dev`\./,
    );
    expect(body).toMatch(/4\. Review of TOMs at each annual revision of this DPA\./);
    expect(body).toMatch(/### F\. Pseudonymisation \(Article 32\(1\)\(a\)\)/);
    expect(body).toMatch(/Where pseudonymisation can be applied without defeating the/);
    expect(body).toMatch(/purpose of Processing, it is\./);
    expect(body).toMatch(/aggregated capacity/);
    expect(body).toMatch(/metrics use hashed customer identifiers; per-Customer telemetry is/);
    expect(body).toMatch(/not aggregated across Customers without anonymisation\./);
    expect(body).toMatch(/### G\. Logical separation/);
    expect(body).toMatch(/Customer data is logically separated by tenant identifier/);
    expect(body).toMatch(/\(account_id\) at the database layer\./);
    expect(body).toMatch(/## Annex 3 — Sub-processors/);
    expect(body).toMatch(
      /\| MacStadium, Inc\.\s+\| Mac mini fleet hosting\s+\| US, California\s+\| 2021 SCCs Module 2 \+ EU-US DPF \(verify\) \|/,
    );
    expect(body).toMatch(
      /\| Stripe Payments Europe Ltd\s+\| Payment processing \(EEA\/UK\/CH Customers\)\s+\| Ireland\s+\| EEA-internal\s+\|/,
    );
    expect(body).toMatch(
      /\| Stripe, Inc\.\s+\| Payment processing \(non-EEA Customers\)\s+\| US, Delaware\s+\| 2021 SCCs Module 2 \+ EU-US DPF \(verify\) \|/,
    );
    expect(body).toMatch(
      /\| Anthropic, PBC \(conditional, opt-in only\) \| Bundled-LLM AI agent\s+\| US, Delaware\s+\| 2021 SCCs Module 3 \+ EU-US DPF \(verify\) \|/,
    );
    expect(body).toMatch(
      /\| Moneybird B\.V\.\s+\| Accounting \+ invoicing\s+\| Netherlands\s+\| EEA-internal\s+\|/,
    );
    expect(body).toMatch(
      /\| Hetzner Online GmbH\s+\| Control-plane hosting \(VM\)\s+\| Germany\s+\| EEA-internal\s+\|/,
    );
    expect(body).toMatch(
      /\| Neon, Inc\.\s+\| Managed Postgres\s+\| US \(corp\); EU Frankfurt \(data\)\s+\| 2021 SCCs Module 2 \+ EU-US DPF \(verify\) \|/,
    );
    expect(body).toMatch(
      /\| Upstash, Inc\.\s+\| Managed Redis\s+\| US \(corp\); EU Frankfurt \(data\)\s+\| 2021 SCCs Module 2 \+ EU-US DPF \(verify\) \|/,
    );
    // S43 2026-07-07 (founder-approved) — Cloudflare location cell
    // corrected: R2 uses the default jurisdiction (data replicated
    // EU + US), not "EU jurisdiction". The SCCs+DPF transfer-mechanism
    // cell was already correct and now actually applies.
    expect(body).toMatch(
      /\| Cloudflare, Inc\.\s+\| DNS \/ CDN \/ edge \/ R2 \/ Pages\s+\| US \(corp\); R2 default jurisdiction \(data replicated EU \+ US\) \| 2021 SCCs Module 2 \+ EU-US DPF \(verify\) \|/,
    );
    expect(body).not.toMatch(/\| US \(corp\); EU jurisdiction \(data\)/);
    expect(body).toMatch(
      /\| Postmark \(ActiveCampaign LLC\)\s+\| Transactional email\s+\| US\s+\| 2021 SCCs Module 2 \+ EU-US DPF \(verify\) \|/,
    );
    expect(body).toMatch(
      /\| Sentry \(Functional Software, Inc\.\)\s+\| Error tracking\s+\| US \(corp\); EU region \(data\)\s+\| 2021 SCCs Module 2 \+ EU-US DPF \(verify\) \|/,
    );
    expect(body).toMatch(
      /\| NowPayments OU \(conditional, opt-in only\) \| Crypto payment processing\s+\| Estonia\s+\| EEA-internal\s+\|/,
    );
    expect(body).toMatch(
      /\| LiveKit, Inc\. \(conditional, opt-in only\)\s+\| WebRTC live-session signaling \+ media SFU \| US, Delaware\s+\| 2021 SCCs Module 2 \+ EU-US DPF \(verify\) \|/,
    );
    expect(body).toMatch(/The list as published in the Privacy Policy is the authoritative/);
    expect(body).toMatch(/list for the avoidance of doubt; this Annex is a convenience copy\./);
  });

  it('Annex 4 (2021 SCCs Module 1/2/3) + Annex 5 (UK IDTA + Swiss FDPIC) + Contact + End-of-DPA framing pinned', () => {
    expect(body).toMatch(/## Annex 4 — Standard Contractual Clauses/);
    expect(body).toMatch(/Where international transfer to a non-Adequate Country requires/);
    expect(body).toMatch(/the SCCs, the \*\*Commission Implementing Decision \(EU\) 2021\/914\*\*/);
    expect(body).toMatch(/Standard Contractual Clauses are incorporated into this DPA by/);
    expect(body).toMatch(/reference, with the following Module selections:/);
    expect(body).toMatch(
      /1\. \*\*Customer \(EU Controller\) → Driftstack \(Dutch Processor\)\.\*\* No/,
    );
    expect(body).toMatch(/SCC needed for Driftstack itself \(EEA-internal\)\./);
    expect(body).toMatch(/2\. \*\*Driftstack \(Dutch Processor\) → Sub-processor in non-Adequate/);
    expect(body).toMatch(/Country\.\*\* Module 3 \(processor-to-\(sub\)processor\)\./);
    expect(body).toMatch(/3\. \*\*Driftstack \(Dutch Processor\) → Sub-processor that itself acts/);
    expect(body).toMatch(/as a Controller \(e\.g\. payment processors in their independent/);
    expect(body).toMatch(/Controller capacity\)\.\*\* Module 1 \(controller-to-controller\) for/);
    expect(body).toMatch(/the data flowing in that capacity, and Module 3 for the/);
    expect(body).toMatch(/Processor-side flow\./);
    expect(body).toMatch(/The selections are made per Sub-processor in the agreement/);
    expect(body).toMatch(/between Driftstack and that Sub-processor;/);
    expect(body).toMatch(/The SCCs are amended by Annex I \(information about transfer\),/);
    expect(body).toMatch(/Annex II \(technical and organisational measures — refers to Annex/);
    expect(body).toMatch(/2 above\), Annex III \(sub-processors — refers to Annex 3 above\) of/);
    expect(body).toMatch(/the SCCs, populated per the Sub-processor relationship\./);
    expect(body).toMatch(/## Annex 5 — UK \/ Swiss addenda/);
    expect(body).toMatch(/For UK Personal Data, the \*\*UK International Data Transfer/);
    expect(body).toMatch(/Addendum\*\* \(issued under Section 119A Data Protection Act 2018,/);
    expect(body).toMatch(/mandatory from 21 March 2024 for new transfers\)/);
    expect(body).toMatch(/For Swiss Personal Data, the SCCs are amended per the Swiss FDPIC/);
    expect(body).toMatch(/guidance on EU SCCs as adopted in Switzerland: references to/);
    expect(body).toMatch(/"Member State" extend to Switzerland; the FADP Article 6 obligation/);
    expect(body).toMatch(/on cross-border transfers is satisfied; the FDPIC is the relevant/);
    expect(body).toMatch(/supervisory authority\./);
    expect(body).toMatch(/These addenda are included by reference;/);
    expect(body).toMatch(/## Contact/);
    expect(body).toMatch(/For all matters relating to this Data Processing Agreement:/);
    expect(body).toMatch(/- Privacy: `privacy@driftstack\.dev`/);
    expect(body).toMatch(/- Legal: `legal@driftstack\.dev`/);
    expect(body).toMatch(
      /- Postal correspondence: addressed to Driftstack B\.V\., Amsterdam, the Netherlands\./,
    );
    expect(body).toMatch(/_End of DPA\._/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
