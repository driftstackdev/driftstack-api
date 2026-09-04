// W577.A — drift guard for /docs/legal/privacy-policy.md (Part 1 of 3).
// Driftstack Privacy Policy Version 1.1 (2026-07-17). Drift here either
// weakens the Controller-vs-Processor split (where DPA governs Processor
// path), drops a §3.* data-category legal-basis pin (Article 6 GDPR), or
// breaks the §3.10 status-page double-opt-in / §3.11 live-session-not-
// stored / §3.6 NowPayments-opt-in posture invariants.
//
//   • Privacy Policy Version 1.1. Effective 2026-07-17.
//   • Driftstack B.V. (NL) is Controller; DPA governs Processor path.
//   • §3 collected: 11 categories — each with What/Why/Legal-basis/Source.
//   • §3.10 status-page email subs: double-opt-in (Art 6(1)(a) consent).
//   • §3.11 live-session media: NOT stored; encrypted in transit;
//     LiveKit processes/forwards it; no application-level E2EE claim.
//   • Part 1: header + sections 1-3 (Controller through 11 data categories).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/legal/privacy-policy.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W577.A /docs/legal/privacy-policy.md (part 1) content parity', () => {
  const body = read(LIB);

  it('Header + Version-1.1 + 2026-07-17 + Controller-vs-Processor split + DPA-incorporation framing pinned', () => {
    expect(body).toMatch(/^# Driftstack — Privacy Policy$/m);
    expect(body).toMatch(/\*\*Version:\*\* 1\.1 · \*\*Effective:\*\* 2026-07-17/);
    expect(body).toMatch(/This Privacy Policy describes how Driftstack Processes Personal Data/);
    expect(body).toMatch(/in connection with the Service\./);
    expect(body).toMatch(/Capitalised terms are defined in/);
    expect(body).toMatch(/\[`definitions\.md`\]\(definitions\.md\)\./);
    expect(body).toMatch(/This Privacy Policy describes Driftstack's processing as a/);
    expect(body).toMatch(
      /\*\*Controller\*\* \(account, billing, support correspondence, marketing/,
    );
    expect(body).toMatch(/site analytics where applicable\)\./);
    expect(body).toMatch(/Driftstack's processing as a/);
    expect(body).toMatch(
      /\*\*Processor\*\* on Customer's behalf \(Customer Data, Session content,/,
    );
    expect(body).toMatch(/Customer-Provided Secrets\) is governed by the/);
    expect(body).toMatch(/\[Data Processing Agreement \(DPA\)\]\(dpa\.md\)/);
  });

  it('Section 1 (Controller identity) + Section 2 (Scope) framing pinned', () => {
    expect(body).toMatch(/## 1\. Controller identity/);
    expect(body).toMatch(/The Controller of Personal Data described in this Privacy Policy is/);
    expect(body).toMatch(
      /\*\*Driftstack B\.V\.\*\*, a private limited company organised under the/,
    );
    expect(body).toMatch(/laws of the Netherlands, established in Amsterdam\./);
    expect(body).toMatch(/- Privacy: `privacy@driftstack\.dev`/);
    expect(body).toMatch(/- Legal: `legal@driftstack\.dev`/);
    expect(body).toMatch(/Driftstack does not currently have a Data Protection Officer subject/);
    expect(body).toMatch(/to mandatory appointment under Article 37\(1\)\(b\) GDPR/);
    expect(body).toMatch(/## 2\. Scope of this Privacy Policy/);
    expect(body).toMatch(/1\. Personal Data of Customer's Authorized Users that Driftstack/);
    expect(body).toMatch(/Processes to provision, bill for, and support the Service\./);
    expect(body).toMatch(/2\. Personal Data of individual contacts \(e\.g\. founders of B2B/);
    expect(body).toMatch(/prospects\) that Driftstack collects in pre-sales correspondence\./);
    expect(body).toMatch(/3\. Personal Data collected through any public-facing Driftstack/);
    expect(body).toMatch(/property/);
    expect(body).toMatch(/This Privacy Policy does \*\*not\*\* apply to:/);
    expect(body).toMatch(/1\. Personal Data Customer routes through the Service in the course/);
    expect(body).toMatch(/of its own automated browsing — that data is governed by the/);
    expect(body).toMatch(/\[DPA\]\(dpa\.md\), where Customer is the Controller and Driftstack is/);
    expect(body).toMatch(/the Processor\./);
  });

  it('Section 3.1 Account + 3.2 Auth + 3.3 Session-metadata + 3.4 local-recording/inline-Capture boundary pinned', () => {
    expect(body).toMatch(/## 3\. Data we collect \(and why\)/);
    expect(body).toMatch(/### 3\.1 Account data/);
    expect(body).toMatch(
      /\*\*What:\*\* legal entity name, billing address, VAT\/BTW identification/,
    );
    expect(body).toMatch(
      /\*\*Legal basis \(GDPR Art 6\):\*\* Article 6\(1\)\(b\) — performance of the/,
    );
    expect(body).toMatch(/contract with Customer/);
    expect(body).toMatch(/### 3\.2 Authentication data/);
    expect(body).toMatch(
      /\*\*What:\*\* API Keys \(stored as scrypt-hashed values; the plaintext key/,
    );
    expect(body).toMatch(/is shown to Customer once at issuance and is not recoverable/);
    expect(body).toMatch(
      /\*\*Legal basis:\*\* Article 6\(1\)\(b\) — performance of the contract\./,
    );
    expect(body).toMatch(/Article 6\(1\)\(c\) — compliance with legal obligation under Article 32/);
    expect(body).toMatch(/GDPR \(security of processing\)\./);
    expect(body).toMatch(/### 3\.3 Session metadata/);
    expect(body).toMatch(/### 3\.4 Desktop-local recordings and API Capture artifacts/);
    expect(body).toMatch(/completed recording as local NDJSON files in the app data directory/);
    expect(body).toMatch(
      /does \*\*not\*\* upload recording files or frames\s+to Driftstack's API, control plane, or Cloudflare R2/,
    );
    expect(body).toMatch(/Driftstack has\s+no API recording endpoint/);
    expect(body).toMatch(/`POST \/v1\/sessions\/:id\/capture`/);
    expect(body).toMatch(/returns the resulting\s+bytes inline in that response/);
    expect(body).toMatch(/Capture endpoint does not retain\s+the artifact/);
    expect(body).toMatch(/under the \[DPA\]\(dpa\.md\), not as Controller/);
    expect(body).not.toMatch(/Customer-controlled\. Default 30 days/);
    expect(body).not.toMatch(/1–365 days/);
  });

  it('Section 3.5 Customer-Provided Secrets + 3.6 Billing data + NowPayments crypto + renewal-reminder framing pinned', () => {
    expect(body).toMatch(/### 3\.5 Customer-Provided Secrets/);
    expect(body).toMatch(/\*\*Legal basis:\*\* Driftstack Processes Customer-Provided Secrets as/);
    expect(body).toMatch(
      /\*\*Processor on Customer's behalf\*\* under the DPA, not as Controller\./,
    );
    expect(body).toMatch(/\*\*Storage:\*\* encrypted at rest\./);
    expect(body).toMatch(/### 3\.6 Billing data/);
    expect(body).toMatch(/Driftstack does \*\*not\*\* retain primary account numbers/);
    expect(body).toMatch(/\(PANs\); these are tokenised by Stripe under PCI-DSS scope\./);
    expect(body).toMatch(/\*\*Cryptocurrency payments \(optional, opt-in only\)\.\*\*/);
    expect(body).toMatch(/chooses a crypto asset and network displayed at checkout/);
    expect(body).toMatch(/stores the internal order id, selected tier, fiat price, NowPayments/);
    expect(body).toMatch(/payment id, quoted crypto amount and currency, payment status/);
    expect(body).toMatch(/does not persist a Customer wallet address or blockchain/);
    expect(body).toMatch(/transaction hash in the crypto-order record/);
    expect(body).toMatch(/NowPayments returns payment id, quote, amount, currency, and/);
    expect(body).toMatch(/status data via signed webhook/);
    expect(body).toMatch(/Article 6\(1\)\(c\) — compliance with Dutch tax law \(Article 52 of the/);
    expect(body).toMatch(/Dutch _Algemene wet inzake rijksbelastingen_; 7-year retention\)\./);
    expect(body).toMatch(/\*\*Renewal-reminder emails\.\*\*/);
    expect(body).toMatch(/Stripe fires an/);
    expect(body).toMatch(/`invoice\.upcoming` webhook to Driftstack\./);
  });

  it('Section 3.7 Support + 3.8 Marketing-site + 3.9 Status-page + 3.10 Status-subs double-opt-in framing pinned', () => {
    expect(body).toMatch(/### 3\.7 Support correspondence/);
    expect(body).toMatch(/### 3\.8 Marketing-site data/);
    expect(body).toMatch(/Driftstack does \*\*not\*\* currently set first-party analytics cookies/);
    expect(body).toMatch(/Strictly-/);
    expect(body).toMatch(/necessary cookies do not require consent under Article 5\(3\) of/);
    expect(body).toMatch(/Directive 2002\/58\/EC \(the ePrivacy Directive\)\./);
    expect(body).toMatch(/### 3\.9 Status-page data/);
    expect(body).toMatch(/`status\.driftstack\.io`/);
    expect(body).toMatch(/\*\*Probe history:\*\*/);
    expect(body).toMatch(/is retained for 30 days for diagnostic purposes\./);
    expect(body).toMatch(/### 3\.10 Status-page email subscriptions/);
    expect(body).toMatch(
      /\*\*Legal basis \(GDPR Art 6\):\*\* Article 6\(1\)\(a\) — explicit, freely-given/,
    );
    expect(body).toMatch(/consent obtained via the double-opt-in flow/);
    expect(body).toMatch(/address itself is purged from this row 90 days after unsubscribe\./);
    expect(body).toMatch(/Notification emails are/);
    expect(body).toMatch(/dispatched via Postmark \(Sub-processor — see Annex 3 of the DPA\)\./);
  });

  it('Section 3.11 Live-session media + LiveKit-not-stored + encrypted-in-transit framing pinned without E2EE overclaim', () => {
    expect(body).toMatch(/### 3\.11 Live-session media \(optional, opt-in only\)/);
    expect(body).toMatch(
      /\*\*What:\*\* real-time WebRTC media streams \(rendered browser screen \+/,
    );
    expect(body).toMatch(/optional audio\) generated when Customer or Driftstack support/);
    expect(body).toMatch(/explicitly initiates a "live session"/);
    expect(body).toMatch(/\*\*Retention:\*\* live-session media is \*\*not stored\*\*\./);
    expect(body).toMatch(/Frames stream/);
    expect(body).toMatch(/through LiveKit's SFU \(selective forwarding unit\) in real time and/);
    expect(body).toMatch(/are dropped on session end\./);
    expect(body).toMatch(/No durable copy lands in Driftstack's/);
    expect(body).toMatch(/control plane\./);
    expect(body).toMatch(/Driftstack has no cloud recording endpoint or/);
    expect(body).toMatch(/Customer may create a desktop-local/);
    expect(body).toMatch(/artifact whose bytes are returned inline and not retained by the/);
    expect(body).not.toMatch(/Recording feature \(§3\.4\) is the durable path/);
    expect(body).toMatch(/\*\*Recipients:\*\* LiveKit, Inc\. \(Sub-processor — see Annex 3 of the/);
    expect(body).toMatch(/DPA\) for SFU\./);
    expect(body).toMatch(
      /\*\*Cryptography:\*\* live-session media is encrypted in transit on each/,
    );
    expect(body).toMatch(/WebRTC connection using DTLS-SRTP\./);
    expect(body).toMatch(/LiveKit receives, processes, and/);
    expect(body).toMatch(/forwards the media as a Sub-processor\./);
    expect(body).toMatch(/does not currently/);
    expect(body).toMatch(/provide application-level end-to-end encryption through the SFU\./);
    expect(body).not.toMatch(/E2EE (?:on|is enabled by) default/i);
    expect(body).not.toMatch(/end-to-end encryption is enabled by default/i);
    expect(body).not.toMatch(/cannot decrypt/i);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
