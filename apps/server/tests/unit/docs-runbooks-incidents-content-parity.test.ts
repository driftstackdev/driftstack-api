// W556.A — drift guard for /docs/runbooks/incidents.md.
// V-499 standing incident playbook. Drift here either weakens
// the 4-tier severity ladder (P-0/P-1/P-2/P-3 = the spine of
// response posture), drops the GDPR Art-33-34 72h notification
// clock, drops the sub-processor incident-propagation forwarding-
// without-filtering rule, or weakens the blameless-PIR template.
//
//   • V-499. Last full review 2026-05-10.
//   • Sev set at first report, not at root cause.
//   • Pre-launch: founder is entire on-call rotation.
//   • Severity at first contact + downgrade requires explicit ack.
//   • Security incident: contain BEFORE investigate.
//   • GDPR 72h DPA clock, customer notify "without undue delay".
//   • Dutch DPA = Autoriteit Persoonsgegevens.
//   • Sub-processor incident = our incident from customer POV.
//   • PIR template: no "person responsible" — blameless invariant.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/runbooks/incidents.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W556.A /docs/runbooks/incidents.md content parity', () => {
  const body = read(LIB);

  it("Header + V-499 + scope-of-this-doc + pre-launch posture framing pinned: '# Incident Runbooks (V-499)' + 'This document is the operating manual for everything that goes wrong in production after launch.' + 'the **classification ladder** (P-0 / P-1 / P-2 / P-3) and the response posture for each' + 'the **customer-reported bug triage** flow' + 'the **security incident response** flow (including breach notification timelines under GDPR Art. 33–34)' + 'the **sub-processor incident propagation** flow (forwarding upstream incidents to customers per Art. 28)' + 'the **CSE (Customer-Side Engineering) escalation tree**' + 'the **post-incident review template**' + 'Pre-launch posture: the founder is the entire on-call rotation.' — pinned so the V-499-operating-manual + 6-bullet-scope (classification + bug-triage + security + sub-processor + CSE + PIR) + founder-entire-on-call-pre-launch commitment survives", () => {
    expect(body).toMatch(/^# Incident Runbooks \(V-499\)$/m);
    expect(body).toMatch(/This document is the operating manual for everything that goes wrong/);
    expect(body).toMatch(/in production after launch\./);
    expect(body).toMatch(
      /- the \*\*classification ladder\*\* \(P-0 \/ P-1 \/ P-2 \/ P-3\) and the/,
    );
    expect(body).toMatch(/response posture for each;/);
    expect(body).toMatch(/- the \*\*customer-reported bug triage\*\* flow;/);
    expect(body).toMatch(/- the \*\*security incident response\*\* flow \(including breach/);
    expect(body).toMatch(/notification timelines under GDPR Art\. 33–34\);/);
    expect(body).toMatch(/- the \*\*sub-processor incident propagation\*\* flow \(forwarding/);
    expect(body).toMatch(/upstream incidents to customers per Art\. 28\);/);
    expect(body).toMatch(/- the \*\*CSE \(Customer-Side Engineering\) escalation tree\*\*/);
    expect(body).toMatch(/- the \*\*post-incident review template\*\*/);
    expect(body).toMatch(/Pre-launch posture: the founder is the entire on-call rotation\./);
  });

  it("Severity 4-tier table framing pinned: '## 1. Severity classification' + 'Severity is set at **first report**, not at root-cause discovery.' + '| P-0      | Service is down OR data is being corrupted / exfiltrated' + 'Immediate — drop everything' + '| P-1      | Major feature broken for all customers' + '<30 min' + '| P-2      | Major feature broken for a subset OR minor for all' + 'Same business day' + '| P-3      | Cosmetic / docs / single-customer minor' + 'Within 5 business days' + 'Severity downgrades require explicit acknowledgement in the incident timeline' — pinned so the 4-tier-severity + first-report-not-root-cause + 4 response-time bands + downgrade-explicit-ack commitment survives", () => {
    expect(body).toMatch(/## 1\. Severity classification/);
    expect(body).toMatch(/Severity is set at \*\*first report\*\*, not at root-cause discovery\./);
    expect(body).toMatch(
      /\|\s*P-0\s+\|\s+Service is down OR data is being corrupted \/ exfiltrated/,
    );
    expect(body).toMatch(/Immediate — drop everything/);
    expect(body).toMatch(/\|\s*P-1\s+\|\s+Major feature broken for all customers/);
    expect(body).toMatch(/<30 min/);
    expect(body).toMatch(/\|\s*P-2\s+\|\s+Major feature broken for a subset OR minor for all/);
    expect(body).toMatch(/Same business day/);
    expect(body).toMatch(/\|\s*P-3\s+\|\s+Cosmetic \/ docs \/ single-customer minor/);
    expect(body).toMatch(/Within 5 business days/);
    expect(body).toMatch(/Severity downgrades require explicit acknowledgement in the/);
    expect(body).toMatch(/incident timeline/);
  });

  it("§2 Customer-reported bug triage + §3 First 60 min framing pinned: '## 2. Customer-reported bug triage' + 'Customer reports arrive through three channels' + 'Acknowledge within 30 min during business hours' + 'Acknowledgement is a non-AI human reply per Rule J — do not auto-respond.' + 'Do **not** ask them to send API keys' + '### 3.2 First 60 minutes (P-0 security event)' + '**Contain** before investigating. The attacker keeps moving while you grep logs.' + '**Preserve evidence.** Snapshot Postgres point-in-time (Neon's PITR is on by default), capture Redis with `BGSAVE`' + 'docs/internal/incidents/YYYY-MM-DD-<slug>.md` — internal-only' + 'Establish timeline.' + 'The timeline IS the incident — without it the post-mortem is fiction.' — pinned so the 3-channel-customer-report + 30min-non-AI-human-Rule-J + no-API-keys-paste + Contain-before-investigate + Neon-PITR-Redis-BGSAVE + internal-incidents-doc + timeline-IS-the-incident commitment survives", () => {
    expect(body).toMatch(/## 2\. Customer-reported bug triage/);
    expect(body).toMatch(/Customer reports arrive through three channels:/);
    expect(body).toMatch(/1\. \*\*Acknowledge within 30 min during business hours, end of next/);
    expect(body).toMatch(/business day otherwise\.\*\* Acknowledgement is a non-AI human/);
    expect(body).toMatch(/reply per Rule J — do not auto-respond\./);
    expect(body).toMatch(/Do$/m);
    expect(body).toMatch(/\*\*not\*\* ask them to send API keys/);
    expect(body).toMatch(/### 3\.2 First 60 minutes \(P-0 security event\)/);
    expect(body).toMatch(/1\. \*\*Contain\*\* before investigating\. The attacker keeps moving/);
    expect(body).toMatch(/while you grep logs\./);
    expect(body).toMatch(/2\. \*\*Preserve evidence\.\*\* Snapshot Postgres point-in-time/);
    expect(body).toMatch(/\(Neon's PITR is on by default\), capture Redis with `BGSAVE`,/);
    expect(body).toMatch(/`docs\/internal\/incidents\/YYYY-MM-DD-<slug>\.md` — internal-only,/);
    expect(body).toMatch(/4\. \*\*Establish timeline\.\*\* UTC timestamps for every observation/);
    expect(body).toMatch(/The timeline IS the incident — without it the/);
    expect(body).toMatch(/post-mortem is fiction\./);
  });

  it("§3.3 GDPR 72h + Dutch DPA + customer notification framing pinned: '### 3.3 GDPR Art. 33–34 notification clock' + 'A \"personal data breach\" under GDPR is a security incident leading to \"accidental or unlawful destruction, loss, alteration, unauthorized disclosure of, or access to\" personal data.' + '**72-hour clock starts when the controller becomes aware**, not when the breach happened.' + '**Customers get notified \"without undue delay\"** if the breach is \"likely to result in a high risk to the rights and freedoms of natural persons\" (Art. 34).' + 'For Driftstack, the supervisory authority is the **Dutch DPA (Autoriteit Persoonsgegevens, AP)**.' + 'https://datalekken.autoriteitpersoonsgegevens.nl' + 'one-stop-shop applies — file with AP and they coordinate with other DPAs.' + 'Pre-launch state: zero paying customers means zero personal data on file beyond the founder's own.' — pinned so the 72h-controller-aware-not-breach-happened + customer-without-undue-delay-Art-34 + Dutch-DPA-Autoriteit-Persoonsgegevens + datalekken.autoriteitpersoonsgegevens.nl + one-stop-shop-AP + pre-launch-zero-PII-on-file commitment survives", () => {
    expect(body).toMatch(/### 3\.3 GDPR Art\. 33–34 notification clock/);
    expect(body).toMatch(/A "personal data breach" under GDPR is a security incident/);
    expect(body).toMatch(/leading to "accidental or unlawful destruction, loss, alteration,/);
    expect(body).toMatch(/unauthorized disclosure of, or access to" personal data\./);
    expect(body).toMatch(/- \*\*72-hour clock starts when the controller becomes aware\*\*, not/);
    expect(body).toMatch(/when the breach happened\./);
    expect(body).toMatch(/- \*\*Customers get notified "without undue delay"\*\* if the breach/);
    expect(body).toMatch(/is "likely to result in a high risk to the rights and freedoms/);
    expect(body).toMatch(/of natural persons" \(Art\. 34\)\./);
    expect(body).toMatch(/- For Driftstack, the supervisory authority is the \*\*Dutch DPA/);
    expect(body).toMatch(/\(Autoriteit Persoonsgegevens, AP\)\*\*\./);
    expect(body).toMatch(/https:\/\/datalekken\.autoriteitpersoonsgegevens\.nl/);
    expect(body).toMatch(/one-stop-shop applies — file with AP and they coordinate with/);
    expect(body).toMatch(/other DPAs\./);
    expect(body).toMatch(/> Pre-launch state: zero paying customers means zero personal data/);
    expect(body).toMatch(/> on file beyond the founder's own\./);
  });

  it("§4 Sub-processor propagation + §5 CSE escalation framing pinned: '## 4. Sub-processor incident propagation' + 'Hetzner (compute, EU)' + 'Neon (Postgres, EU)' + 'Upstash (Redis, EU)' + 'Cloudflare (CDN + DNS + Pages, global w/ EU pop preference)' + 'Postmark (transactional email)' + 'Stripe (payments, US — SCC + Stripe DPA)' + 'Sentry (error tracking, EU region)' + '**Forward without filtering**' + '**Translate impact.**' + '**If the upstream incident is a security incident**, treat it as a Driftstack security incident' + 'Sub-processor breach = our breach from the customer's perspective.' + '## 5. CSE escalation tree (pre-launch single-on-call)' + '### 5.2 P-0 channels' + 'A P-0 must reach the founder within 5 minutes regardless of hour.' + '### 5.3 Failover' + 'No second responder pre-launch — this is honestly disclosed at `/trust/incidents`' — pinned so the 7-sub-processor-chain + Forward-without-filtering + Translate-impact + upstream-security=our-security + 5-min-P-0-reach + honest-no-second-responder commitment survives", () => {
    expect(body).toMatch(/## 4\. Sub-processor incident propagation/);
    expect(body).toMatch(/- Hetzner \(compute, EU\)/);
    expect(body).toMatch(/- Neon \(Postgres, EU\)/);
    expect(body).toMatch(/- Upstash \(Redis, EU\)/);
    expect(body).toMatch(/- Cloudflare \(CDN \+ DNS \+ Pages, global w\/ EU pop preference\)/);
    expect(body).toMatch(/- Postmark \(transactional email\)/);
    expect(body).toMatch(/- Stripe \(payments, US — SCC \+ Stripe DPA\)/);
    expect(body).toMatch(/- Sentry \(error tracking, EU region\)/);
    expect(body).toMatch(/1\. \*\*Forward without filtering\*\*/);
    expect(body).toMatch(/2\. \*\*Translate impact\.\*\*/);
    expect(body).toMatch(/3\. \*\*If the upstream incident is a security incident\*\*, treat it/);
    expect(body).toMatch(/as a Driftstack security incident/);
    expect(body).toMatch(/Sub-processor breach = our breach\s*from the customer's perspective\./);
    expect(body).toMatch(/## 5\. CSE escalation tree \(pre-launch single-on-call\)/);
    expect(body).toMatch(/### 5\.2 P-0 channels/);
    expect(body).toMatch(/A P-0 must reach the founder within 5 minutes regardless of/);
    expect(body).toMatch(/hour\./);
    expect(body).toMatch(/### 5\.3 Failover/);
    expect(body).toMatch(/No\s*second responder pre-launch — this is honestly disclosed at/);
    expect(body).toMatch(/`\/trust\/incidents`/);
  });

  it("§6 PIR + 5-business-day + blameless-invariant framing pinned: '## 6. Post-incident review' + 'Every P-0 and P-1 produces a post-incident review (PIR) within 5 business days of resolution.' + 'P-2/P-3 produce a tech-debt entry only.' + '**Severity at peak:** P-0 / P-1' + '## Timeline' + '(Pasted directly from the internal incident doc — no edits.' + '## Root cause' + '## What went well' + '## What went poorly' + '## Action items' + 'Each action item that requires code becomes a V-NNN slice.' + 'Each that requires policy change becomes a `decisions.md` entry.' + '### 6.2 Blameless invariant' + 'The PIR template has no \"person responsible\" field by design.' + 'Root cause is always systemic' + '## 7. Runbook for this runbook' + 'Last full review: V-499 / 2026-05-10.' — pinned so the PIR-within-5-business-days + P-2/P-3=tech-debt-only + 5-section-template + V-NNN-or-decisions.md-action + no-person-responsible-blameless + V-499/2026-05-10 commitment survives", () => {
    expect(body).toMatch(/## 6\. Post-incident review/);
    expect(body).toMatch(/Every P-0 and P-1 produces a post-incident review \(PIR\) within/);
    expect(body).toMatch(/5 business days of resolution\./);
    expect(body).toMatch(/P-2\/P-3 produce a tech-debt entry/);
    expect(body).toMatch(/only\./);
    expect(body).toMatch(/\*\*Severity at peak:\*\* P-0 \/ P-1/);
    expect(body).toMatch(/## Timeline/);
    expect(body).toMatch(/\(Pasted directly from the internal incident doc — no edits\./);
    expect(body).toMatch(/## Root cause/);
    expect(body).toMatch(/## What went well/);
    expect(body).toMatch(/## What went poorly/);
    expect(body).toMatch(/## Action items/);
    expect(body).toMatch(/Each action item that requires code becomes a V-NNN slice\./);
    expect(body).toMatch(/Each that requires policy change becomes a `decisions\.md`/);
    expect(body).toMatch(/entry\./);
    expect(body).toMatch(/### 6\.2 Blameless invariant/);
    expect(body).toMatch(/The PIR template has no "person responsible" field by design\./);
    expect(body).toMatch(/Root cause is/);
    expect(body).toMatch(/always systemic/);
    expect(body).toMatch(/## 7\. Runbook for this runbook/);
    expect(body).toMatch(/Last full review: V-499 \/ 2026-05-10\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
