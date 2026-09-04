// W574.B — drift guard for /docs/legal/definitions.md.
// Driftstack legal-document shared-definitions source-of-truth.
// Drift here either weakens the Customer-Connected-Services-are-NOT-
// Sub-processors invariant, drops a GDPR/AVG/AP/SCCs/DPF Article-
// citation, or changes a sub-processor identity (Stripe + Moneybird +
// MacStadium + Hetzner + Neon + Upstash + Cloudflare + Postmark +
// Sentry + Anthropic).
//
//   • Version 1.1. Effective 2026-07-17.
//   • Driftstack B.V. (NL), Authorized Users bind Customer.
//   • Service = API + GUI Client + SDKs + mac mini fleet.
//   • Article 4(1)/4(2)/4(7)/4(8) GDPR + AVG + AP + 2021 SCCs +
//     2023 DPF + Adequate Country definitions.
//   • Customer-Connected Services are NOT Sub-processors.
//   • 10 sub-processors with entity + jurisdiction.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/legal/definitions.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W574.B /docs/legal/definitions.md content parity', () => {
  const body = read(LIB);

  it('Header + Version-1.1 + 2026-07-17 + 4-bound-docs + Parties + Authorized-User binds Customer framing pinned', () => {
    expect(body).toMatch(/^# Driftstack — defined terms \(shared\)$/m);
    expect(body).toMatch(/\*\*Version:\*\* 1\.1 · \*\*Effective:\*\* 2026-07-17/);
    expect(body).toMatch(/This file is the source of truth for terminology used across the/);
    expect(body).toMatch(
      /Driftstack legal document set: the \[Terms of Service\]\(terms-of-service\.md\),/,
    );
    expect(body).toMatch(
      /the \[Privacy Policy\]\(privacy-policy\.md\), the \[Data Processing Agreement\]\(dpa\.md\),/,
    );
    expect(body).toMatch(/and the \[Acceptable Use Policy\]\(acceptable-use-policy\.md\)\./);
    expect(body).toMatch(/When any of/);
    expect(body).toMatch(/those documents capitalises a term, this file controls\./);
    expect(body).toMatch(/If a term needs different meanings in different documents, it is/);
    expect(body).toMatch(/renamed in one of them\. We do not redefine\./);
    expect(body).toMatch(/## Parties \+ entities/);
    expect(body).toMatch(
      /\*\*"Driftstack"\*\*, \*\*"we"\*\*, \*\*"us"\*\*, or \*\*"our"\*\* means Driftstack B\.V\.,/,
    );
    expect(body).toMatch(
      /a private limited company \(_besloten vennootschap_\) organised under the laws of the Netherlands, established in Amsterdam\./,
    );
    expect(body).toMatch(
      /\*\*"Customer"\*\* or \*\*"you"\*\* means the legal entity that has accepted/,
    );
    expect(body).toMatch(/the Terms of Service and on whose behalf the Service is used, together/);
    expect(body).toMatch(/with that entity's Authorized Users\./);
    expect(body).toMatch(/\*\*"Authorized User"\*\* means an individual employee, contractor, or/);
    expect(body).toMatch(/agent of Customer that Customer has granted access to the Service\./);
    expect(body).toMatch(/An/);
    expect(body).toMatch(/Authorized User acts on Customer's behalf and binds Customer\./);
    expect(body).toMatch(
      /\*\*"Party"\*\* means Driftstack or Customer; \*\*"Parties"\*\* means both\./,
    );
  });

  it('Service-Platform + API + API-Key + GUI-Client + SDK + Session + Recording + Capture + Subscription tier-pricing framing pinned', () => {
    expect(body).toMatch(/## Service \+ product terms/);
    expect(body).toMatch(
      /\*\*"Service"\*\* or \*\*"Platform"\*\* means the Driftstack iPhone Safari/,
    );
    expect(body).toMatch(/automation platform, including the API, the self-hosted GUI Client,/);
    expect(body).toMatch(
      /the SDKs published on public package registries \(npm, PyPI, Go modules\),/,
    );
    expect(body).toMatch(/and the mac mini fleet that hosts the underlying WebKit driver/);
    expect(body).toMatch(/infrastructure\./);
    expect(body).toMatch(
      /\*\*"API"\*\* means the HTTP application programming interface published/,
    );
    expect(body).toMatch(/under the `\/v1\/` path at/);
    expect(body).toContain('[https://api.driftstack.dev](https://api.driftstack.dev)');
    expect(body).toContain('[https://docs.driftstack.io/api/](https://docs.driftstack.io/api/)');
    expect(body).not.toMatch(/placeholder|pending production deployment/i);
    expect(body).toMatch(
      /\*\*"API Key"\*\* means an authentication credential issued to Customer by/,
    );
    expect(body).toMatch(/Driftstack that authorises calls to the API on Customer's behalf\./);
    expect(body).toMatch(/API/);
    expect(body).toMatch(
      /API\s*Keys are revocable and limited by the scope taxonomy published in the/,
    );
    expect(body).toMatch(/current API reference\./);
    expect(body).toMatch(
      /\*\*"GUI Client"\*\* means the Tauri-based desktop application distributed/,
    );
    expect(body).toMatch(/connects to Driftstack Cloud or to a compatible/);
    expect(body).toMatch(/self-hosted Driftstack Node selected by Customer\./);
    expect(body).toMatch(
      /\*\*"SDK"\*\* or \*\*"SDKs"\*\* means the official client libraries published/,
    );
    expect(body).toMatch(/by Driftstack: `@driftstack\/sdk` \(TypeScript, npm\), `driftstack-sdk`/);
    expect(body).toMatch(/\(Python, PyPI\), and the Go SDK at/);
    expect(body).toMatch(/`github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go`\./);
    expect(body).toMatch(
      /\*\*"Session"\*\* means an instance of an iPhone-archetype Safari runtime/,
    );
    expect(body).toMatch(/provisioned on Driftstack's mac mini fleet under Customer's account,/);
    expect(body).toMatch(/identified by a `ses_<uuid>` identifier through the API\./);
    expect(body).toMatch(/\*\*"Recording"\*\* means a Customer-controlled desktop-local NDJSON/);
    expect(body).toMatch(/archive of streamed frames captured by the GUI Client during a/);
    expect(body).toMatch(/remain on Customer's device; the recording workflow/);
    expect(body).toMatch(/does not upload them to Driftstack\./);
    expect(body).toMatch(/\*\*"Capture"\*\* means a one-shot screenshot, DOM snapshot, or PDF/);
    expect(body).toMatch(/returned\s*inline to Customer and not retained by that endpoint\./);
    expect(body).toMatch(
      /\*\*"Customer Workflow"\*\* means the automation logic, recipes, scripts,/,
    );
    expect(body).toMatch(/or instructions Customer provides to the Service to drive Sessions\./);
    expect(body).toMatch(/\*\*"Subscription"\*\* means Customer's ongoing access to the Service/);
    expect(body).toMatch(/under a tier and price published on Driftstack's current pricing page/);
    expect(body).toMatch(/or agreed in an Order Form\./);
    expect(body).not.toMatch(/\$39\/mo|\$99\/mo|\$299\/mo|\$3,000\+\/mo/);
  });

  it('GDPR/AVG/AP/SCCs/DPF + Customer-Connected-NOT-Sub-processor + 10 sub-processor identities + Acceptance + Material-Change framing pinned', () => {
    expect(body).toMatch(/## Data terms \(GDPR-aligned\)/);
    expect(body).toMatch(/\*\*"Personal Data"\*\* has the meaning in Article 4\(1\) GDPR/);
    expect(body).toMatch(/\*\*"Special Category Data"\*\* has the meaning in Article 9 GDPR/);
    expect(body).toMatch(/\*\*"Data Subject"\*\* has the meaning in Article 4\(1\) GDPR/);
    expect(body).toMatch(/\*\*"Processing"\*\* has the meaning in Article 4\(2\) GDPR/);
    expect(body).toMatch(/\*\*"Controller"\*\* has the meaning in Article 4\(7\) GDPR/);
    expect(body).toMatch(/\*\*"Processor"\*\* has the meaning in Article 4\(8\) GDPR/);
    expect(body).toMatch(/\*\*"Sub-processor"\*\* means a third-party Processor engaged by/);
    expect(body).toMatch(/Driftstack to Process Personal Data on Customer's behalf in the/);
    expect(body).toMatch(/course of providing the Service\./);
    expect(body).toMatch(/\*\*"Customer-Connected Service"\*\* means a third-party service that/);
    expect(body).toMatch(/Customer integrates with the Service using Customer's own/);
    expect(body).toMatch(/credentials, Customer's own account, and Customer's own contractual/);
    expect(body).toMatch(/relationship with that third party\./);
    expect(body).toMatch(/Customer-Connected Services/);
    expect(body).toMatch(/include \(without limitation\) HTTP\/SOCKS5 proxies, captcha-solving/);
    expect(body).toMatch(/services \(e\.g\. 2Captcha, CapSolver\), email services accessed by/);
    expect(body).toMatch(/Customer's IMAP or OAuth credentials, and SMS verification services/);
    expect(body).toMatch(/\(e\.g\. TextVerified, Twilio\)\./);
    expect(body).toMatch(/> \*\*Customer-Connected Services are not Sub-processors\.\*\*/);
    expect(body).toMatch(/Driftstack/);
    expect(body).toMatch(/> does not contract with the third-party provider, does not receive/);
    expect(body).toMatch(/> service from them, and does not Process data on Driftstack's/);
    expect(body).toMatch(/> behalf through them\./);
    expect(body).toMatch(/The third-party Processes data on \*\*Customer's\*\*/);
    expect(body).toMatch(/> instruction via \*\*Customer's\*\* credentials\./);
    expect(body).toMatch(/\*\*"Customer-Provided Secrets"\*\* means the credentials Customer/);
    expect(body).toMatch(/supplies for use in Sessions, including \(without limitation\) proxy/);
    expect(body).toMatch(/authentication credentials, captcha-service API keys, email/);
    expect(body).toMatch(/credentials, and SMS-service API keys\./);
    expect(body).toMatch(/## Compliance \+ transfer terms/);
    expect(body).toMatch(/\*\*"GDPR"\*\* means Regulation \(EU\) 2016\/679/);
    expect(body).toMatch(/\*\*"AVG"\*\* means the _Algemene verordening gegevensbescherming_, the/);
    expect(body).toMatch(/Dutch implementing instrument of the GDPR\./);
    expect(body).toMatch(/\*\*"AP"\*\* means the Dutch Data Protection Authority \(_Autoriteit/);
    expect(body).toMatch(/Persoonsgegevens_\)/);
    expect(body).toMatch(/\*\*"SCCs"\*\* means the Standard Contractual Clauses adopted by/);
    expect(body).toMatch(/Commission Implementing Decision \(EU\) 2021\/914 of 4 June 2021/);
    expect(body).toMatch(/\*\*"DPF"\*\* means the EU-US Data Privacy Framework adopted by/);
    expect(body).toMatch(/Commission Implementing Decision \(EU\) 2023\/1795 of 10 July 2023/);
    expect(body).toMatch(/\*\*"Adequate Country"\*\* means a country, territory, sector, or/);
    expect(body).toMatch(/international organisation that the European Commission has/);
    expect(body).toMatch(/determined provides an adequate level of protection/);
    expect(body).toMatch(/\*\*"Stripe"\*\* means Stripe Payments Europe, Limited/);
    expect(body).toMatch(/\(Ireland-incorporated entity with company number 538590\)/);
    expect(body).toMatch(/Stripe, Inc\. \(Delaware, USA\) for Customers established outside the/);
    expect(body).toMatch(/EEA \/ UK \/ CH\./);
    expect(body).toMatch(/\*\*"Moneybird"\*\* means Moneybird B\.V\. \(Dutch entity, Utrecht\)/);
    expect(body).toMatch(/\*\*"MacStadium"\*\* means MacStadium, Inc\. \(Delaware, USA\)/);
    expect(body).toMatch(/\*\*"Hetzner"\*\* means Hetzner Online GmbH \(Gunzenhausen, Germany\)/);
    expect(body).toMatch(/\*\*"Neon"\*\* means Neon, Inc\. \(Delaware, USA\)/);
    expect(body).toMatch(/Data residency is/);
    expect(body).toMatch(/the EU Frankfurt region\./);
    expect(body).toMatch(/\*\*"Upstash"\*\* means Upstash, Inc\. \(Delaware, USA\)/);
    expect(body).toMatch(/\*\*"Cloudflare"\*\* means Cloudflare, Inc\. \(Delaware, USA\)/);
    expect(body).toMatch(/R2 object storage for customer-uploaded profile avatars,/);
    expect(body).toMatch(/encrypted profile blobs, and public status-page snapshots/);
    expect(body).toMatch(/default jurisdiction and may replicate data in the EU/);
    expect(body).not.toMatch(/Recordings durability|EU jurisdiction is selected/i);
    expect(body).toMatch(/\*\*"Postmark"\*\* means the transactional email service operated by/);
    expect(body).toMatch(/ActiveCampaign LLC \(Delaware, USA\)/);
    expect(body).toMatch(/\*\*"Sentry"\*\* means the error tracking and performance monitoring/);
    expect(body).toMatch(/service operated by Functional Software, Inc\. \(Delaware, USA\)/);
    expect(body).toMatch(/\*\*"Anthropic"\*\* means Anthropic, PBC \(Delaware, USA\)/);
    expect(body).toMatch(/when Customer consents to\s*Driftstack-provided model access/);
    expect(body).toMatch(/Customers who supply their own/);
    expect(body).toMatch(/Anthropic credentials \(BYOK\) do not establish an Anthropic/);
    expect(body).toMatch(/Sub-processor relationship through Driftstack\./);
    expect(body).toMatch(/Standard bundled-LLM turns currently post an/);
    expect(body).toMatch(/included-service accounting value/);
    expect(body).toMatch(/not a separately itemised Stripe charge/);
    expect(body).not.toMatch(/metered charges \(e\.g\. for bundled-LLM/);
    expect(body).toMatch(
      /\*\*"Acceptance"\*\* means a Customer-attributed event recorded by the API/,
    );
    expect(body).toMatch(
      /endpoint `POST \/v1\/legal\/accept` carrying `account_id`, `document_key`,/,
    );
    expect(body).toMatch(/`version`, `content_hash`, and `accepted_at`\./);
    expect(body).toMatch(/A Customer's continued/);
    expect(body).toMatch(/use of the Service after a Major version bump \(without recording a/);
    expect(body).toMatch(/new Acceptance\) constitutes objection to the new version and entitles/);
    expect(body).toMatch(/Customer to terminate the Subscription on notice without penalty\./);
    expect(body).toMatch(/\*\*"Material Change"\*\* means a change to a Document that materially/);
    expect(body).toMatch(/alters Customer's rights, obligations, or fees; adds or removes a/);
    expect(body).toMatch(/Sub-processor; or changes the Service's offered jurisdictions\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
