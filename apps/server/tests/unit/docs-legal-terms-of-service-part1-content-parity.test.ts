// W576.A — drift guard for /docs/legal/terms-of-service.md (Part 1 of 3).
// Driftstack ToS Version 1.1 (2026-07-17). Drift here either weakens
// the B2B-only carve-out (Article 7:5 BW + Directive 2011/83/EU non-
// consumer scope), drops the Customer-Connected-Services-are-Customer's-
// relationship invariant, or unsets the live-session opt-in framing.
//
//   • ToS Version 1.1. Effective 2026-07-17.
//   • B2B-only — Article 7:5 BW + Directive 2011/83/EU exclusion.
//   • Live-session via LiveKit, opt-in, encrypted in transit; LiveKit
//     processes/forwards it; no application-level E2EE claim.
//   • Customer-Connected Services: Customer's relationship, not Driftstack's.
//   • Part 1: header + sections 1-7 (Acceptance through Confidentiality).

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

describe('W576.A /docs/legal/terms-of-service.md (part 1) content parity', () => {
  const body = read(LIB);

  it('Header + Version-1.1 + 2026-07-17 + B2B-only + Article-7:5-BW + Directive-2011/83/EU framing pinned', () => {
    expect(body).toMatch(/^# Driftstack — Terms of Service$/m);
    expect(body).toMatch(/\*\*Version:\*\* 1\.1 · \*\*Effective:\*\* 2026-07-17/);
    expect(body).toMatch(
      /These Terms of Service \("\*\*ToS\*\*"\) govern Customer's access to and/,
    );
    expect(body).toMatch(/use of the Service offered by Driftstack\./);
    expect(body).toMatch(/Capitalised terms are/);
    expect(body).toMatch(/defined in \[`definitions\.md`\]\(definitions\.md\)\./);
    expect(body).toMatch(/\[Privacy Policy\]\(privacy-policy\.md\),/);
    expect(body).toMatch(/\[Data Processing Agreement\]\(dpa\.md\),/);
    expect(body).toMatch(/\[Acceptable Use Policy\]\(acceptable-use-policy\.md\)/);
    expect(body).toMatch(/incorporated/);
    expect(body).toMatch(/by reference and form part of the agreement between the Parties\./);
    expect(body).toMatch(/The Service is provided to \*\*business customers\*\* only\./);
    expect(body).toMatch(/is not intended for, and is not offered to, consumers within the/);
    expect(body).toMatch(/meaning of Article 7:5 of the Dutch Civil Code \(_Burgerlijk Wetboek_\)/);
    expect(body).toMatch(/or Article 2\(1\) of Directive 2011\/83\/EU\./);
    expect(body).toMatch(/Customer represents that/);
    expect(body).toMatch(/its acceptance is on behalf of a legal entity acting in the course of/);
    expect(body).toMatch(/its trade, business, craft, or profession\./);
  });

  it('Section 1 (Acceptance) + Section 2 (Defined terms) + Section 3 (Service) framing pinned', () => {
    expect(body).toMatch(/## 1\. Acceptance \+ parties/);
    expect(body).toMatch(/By creating an Account, by recording an Acceptance through the API,/);
    expect(body).toMatch(/or by accessing the Service through an API Key issued to Customer,/);
    expect(body).toMatch(/Customer agrees to these ToS\./);
    expect(body).toMatch(/The individual recording the/);
    expect(body).toMatch(/Acceptance represents that they are authorised to bind Customer\./);
    expect(body).toMatch(/## 2\. Defined terms/);
    expect(body).toMatch(/Capitalised terms in this ToS have the meanings set out in/);
    expect(body).toMatch(/\[`definitions\.md`\]\(definitions\.md\)\./);
    expect(body).toMatch(/## 3\. The Service/);
    expect(body).toMatch(/Driftstack provides an iPhone-archetype Safari automation platform\./);
    expect(body).toMatch(
      /1\. An \*\*API\*\* \(the `\/v1\/` endpoints\) accepting Customer instructions/,
    );
    expect(body).toMatch(/2\. \*\*SDKs\*\* \(TypeScript, Python, Go\) that wrap the API\./);
    expect(body).toMatch(
      /3\. A \*\*self-hosted GUI Client\*\* for operating Sessions interactively\./,
    );
    expect(body).toMatch(/4\. \*\*Mac mini fleet infrastructure\*\* that hosts the WebKit driver/);
    expect(body).toMatch(/processes underlying each Session\./);
    expect(body).toMatch(/The Service is \*\*intent-based\*\*\./);
    expect(body).toMatch(/returning Session and Capture artifacts\./);
    expect(body).not.toMatch(/Session, Capture, and Recording artifacts/);
    expect(body).toMatch(/\*\*Live-session viewing and desktop-local recording \(optional,/);
    expect(body).toMatch(/in-progress browser may be viewed in/);
    expect(body).toMatch(/real time through LiveKit, Inc\. \(Sub-processor — see Privacy Policy/);
    expect(body).toMatch(/DPA Annex 3\)\./);
    expect(body).toMatch(/Live-session media is ephemeral: Driftstack does/);
    expect(body).toMatch(/not store it, and frames are dropped on session end\./);
    expect(body).toMatch(/local NDJSON recording/);
    expect(body).toMatch(/workflow does not upload those files or frames to Driftstack's API,/);
    expect(body).toMatch(/control plane, or Cloudflare R2\./);
    expect(body).toMatch(/provides no API recording endpoint or cloud recording-/);
    expect(body).toMatch(/screenshot, DOM snapshot, or PDF bytes inline/);
    expect(body).toMatch(/does not retain the/);
    expect(body).toMatch(/artifact\./);
    expect(body).not.toMatch(/Recording feature[\s\S]{0,80}Cloudflare R2/);
    expect(body).toMatch(/Live-session media is encrypted in transit on/);
    expect(body).toMatch(/each WebRTC connection using DTLS-SRTP\./);
    expect(body).toMatch(/LiveKit receives, processes,/);
    expect(body).toMatch(/and forwards the media as a Sub-processor/);
    expect(body).toMatch(/does not/);
    expect(body).toMatch(/currently provide application-level end-to-end encryption through/);
    expect(body).not.toMatch(/E2EE (?:on|is enabled by) default/i);
    expect(body).not.toMatch(/end-to-end encryption is enabled by default/i);
    expect(body).not.toMatch(/cannot decrypt/i);
  });

  it('Section 4 (Account) + Section 5 (Customer responsibilities) + Section 5.5 warranties framing pinned', () => {
    expect(body).toMatch(/## 4\. Account \+ authorised users/);
    expect(body).toMatch(/4\.1 \*\*Account\.\*\*/);
    expect(body).toMatch(/4\.2 \*\*Authorized Users\.\*\*/);
    expect(body).toMatch(/4\.3 \*\*API Keys\.\*\*/);
    expect(body).toMatch(/4\.4 \*\*No multi-customer use\.\*\*/);
    expect(body).toMatch(/## 5\. Customer responsibilities/);
    expect(body).toMatch(/5\.1 \*\*Lawful use\.\*\*/);
    expect(body).toMatch(/5\.2 \*\*AUP compliance\.\*\*/);
    expect(body).toMatch(/5\.3 \*\*Customer-Connected Services\.\*\*/);
    expect(body).toMatch(/HTTP \//);
    expect(body).toMatch(/SOCKS5 proxies, captcha-solving services, email-verification services,/);
    expect(body).toMatch(/and SMS-verification services\./);
    expect(body).toMatch(/Customer is responsible for procuring,/);
    expect(body).toMatch(/authenticating, and paying for these services\./);
    expect(body).toMatch(/Customer holds the/);
    expect(body).toMatch(/relationship with the third-party provider/);
    expect(body).toMatch(/5\.4 \*\*Customer Workflows \+ Customer Data\.\*\*/);
    expect(body).toMatch(/5\.5 \*\*Customer warranties\.\*\*/);
    expect(body).toMatch(/3\. It has a lawful basis under Article 6 GDPR \(or applicable/);
    expect(body).toMatch(/4\. It complies with applicable export control law \(including EU Dual/);
    expect(body).toMatch(/Use Regulation \(EU\) 2021\/821 and equivalent regimes\)/);
    expect(body).toMatch(/5\.6 \*\*Cooperation\.\*\*/);
  });

  it('Section 6 (IP) + Section 7 (Confidentiality) framing pinned', () => {
    expect(body).toMatch(/## 6\. Intellectual property/);
    expect(body).toMatch(/6\.1 \*\*Driftstack IP\.\*\*/);
    expect(body).toMatch(/6\.2 \*\*Customer IP\.\*\*/);
    expect(body).toMatch(/6\.3 \*\*Customer feedback\.\*\*/);
    expect(body).toMatch(/6\.4 \*\*No reverse engineering\.\*\*/);
    expect(body).toMatch(/except to the extent permitted by mandatory/);
    expect(body).toMatch(/applicable law \(including Article 6 of Directive 2009\/24\/EC on the/);
    expect(body).toMatch(/legal protection of computer programs/);
    expect(body).toMatch(/6\.5 \*\*Open-source components\.\*\*/);
    expect(body).toMatch(/## 7\. Confidentiality/);
    expect(body).toMatch(/7\.1 \*\*Confidential Information\.\*\*/);
    expect(body).toMatch(/7\.2 \*\*Obligations\.\*\*/);
    expect(body).toMatch(/7\.3 \*\*Exceptions\.\*\*/);
    expect(body).toMatch(/7\.4 \*\*Survival\.\*\*/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
