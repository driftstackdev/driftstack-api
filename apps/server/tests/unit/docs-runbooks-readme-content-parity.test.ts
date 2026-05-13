// W557.A — drift guard for /docs/runbooks/README.md.
// V-522 runbooks index. Drift here either weakens the index-as-
// navigation-surface posture (would orphan new runbooks added
// without updating the README), drops the 3-section split (pre-
// launch sequencing / day-to-day / workspace setup), or weakens
// the "where to file a new runbook" filing taxonomy.
//
//   • V-522. Operational reference, pick by what's happening.
//   • 3 navigation sections + 1 cross-cutting + 1 setup +
//     filing-taxonomy + cadence.
//   • Pre-launch sequencing (3 entries): pre-launch-checklist +
//     launch-day-runbook + first-customer-day.
//   • Day-to-day (9 entries): incidents + observability + dr +
//     runbook + stripe-webhook-testing + status-site + cost +
//     crypto + oauth.
//   • Cross-cutting: dr-rehearse.sh + load-test/run.mjs.
//   • Setup: self-hosted-mac-local.
//   • Re-review cadence: Tier-3 changes + customer-facing
//     incidents + quarterly post-launch.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/runbooks/README.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W557.A /docs/runbooks/README.md content parity', () => {
  const body = read(LIB);

  it("Header + V-522 + intro framing pinned: '# Runbooks index (V-522)' + 'Operational reference. Each runbook below is a standalone document for one specific operating concern — pick the right one by what's happening, not by chronology.' — pinned so the V-522-index + pick-by-what's-happening + standalone-per-concern commitment survives", () => {
    expect(body).toMatch(/^# Runbooks index \(V-522\)$/m);
    expect(body).toMatch(/Operational reference\. Each runbook below is a standalone/);
    expect(body).toMatch(/document for one specific operating concern — pick the right/);
    expect(body).toMatch(/one by what's happening, not by chronology\./);
  });

  it("Pre-launch + launch sequencing 3-entry framing pinned: '## Pre-launch + launch sequencing' + 'These read in sequence, in the days leading up to commercial activation' + '`docs/launch/pre-launch-checklist.md`' + 'The complete pre-launch audit + priority queue (V-279). Read this first; it's the gate.' + '`docs/operations/launch-day-runbook.md`' + 'The day you flip from staging-only to publicly accepting paying customers. T-24h checks + T-0 cutover (V-279 + V-516).' + '`first-customer-day.md`' + 'The 7 days AFTER the first paying customer signs up. Hour-0 watch / day-1 monitoring / week-1 feedback categorisation (V-519).' — pinned so the 3-entry-pre-launch-table (V-279-pre-launch-checklist + V-279/V-516-launch-day + V-519-first-customer-day) commitment survives", () => {
    expect(body).toMatch(/## Pre-launch \+ launch sequencing/);
    expect(body).toMatch(/These read in sequence, in the days leading up to commercial/);
    expect(body).toMatch(/activation:/);
    expect(body).toMatch(
      /\[`docs\/launch\/pre-launch-checklist\.md`\]\(\.\.\/launch\/pre-launch-checklist\.md\)/,
    );
    expect(body).toMatch(
      /The complete pre-launch audit \+ priority queue \(V-279\)\. Read this first; it's the gate\./,
    );
    expect(body).toMatch(
      /\[`docs\/operations\/launch-day-runbook\.md`\]\(\.\.\/operations\/launch-day-runbook\.md\)/,
    );
    expect(body).toMatch(
      /The day you flip from staging-only to publicly accepting paying customers\./,
    );
    expect(body).toMatch(/T-24h checks \+ T-0 cutover \(V-279 \+ V-516\)\./);
    expect(body).toMatch(/\[`first-customer-day\.md`\]\(first-customer-day\.md\)/);
    expect(body).toMatch(/The 7 days AFTER the first paying customer signs up\./);
    expect(body).toMatch(
      /Hour-0 watch \/ day-1 monitoring \/ week-1 feedback categorisation \(V-519\)\./,
    );
  });

  it("Day-to-day 9-entry framing pinned: '## Day-to-day operations' + 'incidents.md' + 'Severity ladder + GDPR Art. 33–34 timeline + CSE escalation tree (V-499).' + 'observability.md' + 'Sentry alerts, synthetic checks, load-test cadence, DLQ triage workflow (V-513).' + '../deployment/dr-runbook.md' + 'host loss, DB corruption, cert failure, sub-processor outage. 11 numbered scenarios with concrete commands.' + '../deployment/runbook.md' + '../deployment/stripe-webhook-testing.md' + 'v295c-status-site-cf-pages.md' + 'cost-monitoring.md' + 'V-673' + 'crypto-payments.md' + 'V-675' + 'oauth-ops.md' + 'V-682' — pinned so the 9-day-to-day entries with V-499 + V-513 + 11-DR-scenarios + V-673 + V-675 + V-682 V-anchors commitment survives", () => {
    expect(body).toMatch(/## Day-to-day operations/);
    expect(body).toMatch(/\[`incidents\.md`\]\(incidents\.md\)/);
    expect(body).toMatch(
      /Severity ladder \+ GDPR Art\. 33–34 timeline \+ CSE escalation tree \(V-499\)\./,
    );
    expect(body).toMatch(/\[`observability\.md`\]\(observability\.md\)/);
    expect(body).toMatch(
      /Sentry alerts, synthetic checks, load-test cadence, DLQ triage workflow \(V-513\)\./,
    );
    expect(body).toMatch(
      /\[`\.\.\/deployment\/dr-runbook\.md`\]\(\.\.\/deployment\/dr-runbook\.md\)/,
    );
    expect(body).toMatch(
      /host loss, DB corruption, cert failure, sub-processor outage\. 11 numbered scenarios with concrete commands\./,
    );
    expect(body).toMatch(/\[`\.\.\/deployment\/runbook\.md`\]\(\.\.\/deployment\/runbook\.md\)/);
    expect(body).toMatch(
      /\[`\.\.\/deployment\/stripe-webhook-testing\.md`\]\(\.\.\/deployment\/stripe-webhook-testing\.md\)/,
    );
    expect(body).toMatch(/\[`v295c-status-site-cf-pages\.md`\]\(v295c-status-site-cf-pages\.md\)/);
    expect(body).toMatch(/\[`cost-monitoring\.md`\]\(cost-monitoring\.md\)/);
    expect(body).toMatch(/V-673/);
    expect(body).toMatch(/\[`crypto-payments\.md`\]\(crypto-payments\.md\)/);
    expect(body).toMatch(/V-675/);
    expect(body).toMatch(/\[`oauth-ops\.md`\]\(oauth-ops\.md\)/);
    expect(body).toMatch(/V-682/);
  });

  it("Workspace setup + Cross-cutting framing pinned: '## Workspace setup' + '[`self-hosted-mac-local.md`](self-hosted-mac-local.md)' + 'Set up a complete local stack on macOS (every workspace, drivers, dev/E2E shortcuts). Engineering setup only.' + '## Cross-cutting' + '`../../scripts/dr-rehearse.sh`' + 'Local-only DR rehearsal harness — exercises 5 of 11 dr-runbook scenarios that don't need production touchpoints. Refuses to act on production hosts (V-510).' + '`../../scripts/load-test/run.mjs`' + 'Autocannon-based load-test harness with named targets + safety rails (V-495).' — pinned so the workspace-setup-self-hosted-mac + cross-cutting-dr-rehearse-5-of-11-V-510 + load-test-V-495 commitment survives", () => {
    expect(body).toMatch(/## Workspace setup/);
    expect(body).toMatch(/\[`self-hosted-mac-local\.md`\]\(self-hosted-mac-local\.md\)/);
    expect(body).toMatch(
      /Set up a complete local stack on macOS \(every workspace, drivers, dev\/E2E shortcuts\)\. Engineering setup only\./,
    );
    expect(body).toMatch(/## Cross-cutting/);
    expect(body).toMatch(
      /\[`\.\.\/\.\.\/scripts\/dr-rehearse\.sh`\]\(\.\.\/\.\.\/scripts\/dr-rehearse\.sh\)/,
    );
    expect(body).toMatch(
      /Local-only DR rehearsal harness — exercises 5 of 11 dr-runbook scenarios that don't need production touchpoints\./,
    );
    expect(body).toMatch(/Refuses to act on production hosts \(V-510\)\./);
    expect(body).toMatch(
      /\[`\.\.\/\.\.\/scripts\/load-test\/run\.mjs`\]\(\.\.\/\.\.\/scripts\/load-test\/run\.mjs\)/,
    );
    expect(body).toMatch(
      /Autocannon-based load-test harness with named targets \+ safety rails \(V-495\)\./,
    );
  });

  it("Filing taxonomy + cadence framing pinned: '## Where to file a new runbook' + '**Customer-facing surface** (incident protocol, security posture as visible to customers) → `apps/marketing-site/` pages under `/security`, `/trust/*`. Internal runbooks STAY internal.' + '**Pre-launch sequence step** that didn't fit the existing runbooks → `docs/operations/<descriptive-name>.md`.' + '**Day-to-day operating concern**' + '**Disaster scenario** → add as a new numbered Scenario in `docs/deployment/dr-runbook.md`. Don't fragment DR into multiple files; it's all one document.' + 'After adding a new runbook, update this README index in the same commit. The index is the navigation surface.' + '## Cadence' + 'After every Tier-3 architectural change.' + 'After every customer-facing incident (verifies the runbook actually told us what to do).' + 'Quarterly post-launch.' — pinned so the 4-filing-category + internal-runbooks-STAY-internal + don't-fragment-DR + index-is-navigation-surface + 3-cadence-trigger commitment survives", () => {
    expect(body).toMatch(/## Where to file a new runbook/);
    expect(body).toMatch(/- \*\*Customer-facing surface\*\* \(incident protocol, security/);
    expect(body).toMatch(/posture as visible to customers\) → `apps\/marketing-site\/`/);
    expect(body).toMatch(/pages under `\/security`, `\/trust\/\*`\. Internal runbooks STAY/);
    expect(body).toMatch(/internal\./);
    expect(body).toMatch(/- \*\*Pre-launch sequence step\*\* that didn't fit the existing/);
    expect(body).toMatch(/runbooks → `docs\/operations\/<descriptive-name>\.md`\./);
    expect(body).toMatch(/- \*\*Day-to-day operating concern\*\*/);
    expect(body).toMatch(/- \*\*Disaster scenario\*\* → add as a new numbered Scenario in/);
    expect(body).toMatch(/`docs\/deployment\/dr-runbook\.md`\. Don't fragment DR into/);
    expect(body).toMatch(/multiple files; it's all one document\./);
    expect(body).toMatch(/After adding a new runbook, update this README index in the/);
    expect(body).toMatch(/same commit\. The index is the navigation surface\./);
    expect(body).toMatch(/## Cadence/);
    expect(body).toMatch(/- After every Tier-3 architectural change\./);
    expect(body).toMatch(/- After every customer-facing incident \(verifies the runbook/);
    expect(body).toMatch(/actually told us what to do\)\./);
    expect(body).toMatch(/- Quarterly post-launch\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
