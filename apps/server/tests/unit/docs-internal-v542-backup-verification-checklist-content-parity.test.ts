// W563.C — drift guard for /docs/internal/v542-backup-verification-checklist.md.
// V-542 CHECKLIST doc 2026-05-11 Wave-21. Drift here either weakens
// the dr-rehearse.sh-V-510-pass/fail-criteria, drops the A-E 5-band
// rehearsal phases, or unsets the V-542.B automation deferral with
// 3-implementation-requirement pre-condition.
//
//   • V-542. CHECKLIST. Manual verification artifact.
//   • V-510 dr-rehearse.sh already exists; V-542 closes pass/fail gap.
//   • When-to-run: weekly pre-launch + every-data-migration + every-
//     marketing-wave + quarterly post-launch.
//   • A-pre + B-execution + C-restore-completeness + D-roll-forward
//     + E-cleanup phases.
//   • B or C item failure = rehearsal FAILS.
//   • V-542.B automation BullMQ weekly→quarterly + 3-impl-req.
//   • V-542.C admin-status integration later.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v542-backup-verification-checklist.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W563.C /docs/internal/v542-backup-verification-checklist.md content parity', () => {
  const body = read(LIB);

  it("Header + V-542-CHECKLIST + V-510-dr-rehearse + when-to-run framing pinned: '# V-542 — backup + DR verification checklist' + '**Date:** 2026-05-11' + '**Wave:** 21' + '**Status:** CHECKLIST — manual verification artifact. Automation deferred to' + 'V-542.B (scheduled job that runs the checklist + posts results to admin' + '`scripts/dr-rehearse.sh` (already exists from V-510) rehearses a disaster-' + 'recovery scenario: spin up a fresh Postgres + Redis, run migrations,' + 'until V-542 nobody had a structured pass/fail checklist for' + '## When to run' + '**Weekly during pre-launch** — until the first paying customer, weekly' + 'rehearsal catches schema drift early.' + '**After every Drizzle migration that touches data tables** — confirms' + '**Before each marketing-site launch wave**' + '**Quarterly post-launch** — production rehearsal cadence.' — pinned so the V-542-CHECKLIST-Wave-21 + V-542.B-automation-deferred + V-510-dr-rehearse.sh-Postgres-Redis-migrations + structured-pass/fail-gap + 4-when-to-run-cadence commitment survives", () => {
    expect(body).toMatch(/^# V-542 — backup \+ DR verification checklist$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-11/);
    expect(body).toMatch(/\*\*Wave:\*\* 21/);
    expect(body).toMatch(
      /\*\*Status:\*\* CHECKLIST — manual verification artifact\. Automation deferred to/,
    );
    expect(body).toMatch(
      /V-542\.B \(scheduled job that runs the checklist \+ posts results to admin/,
    );
    expect(body).toMatch(
      /`scripts\/dr-rehearse\.sh` \(already exists from V-510\) rehearses a disaster-/,
    );
    expect(body).toMatch(/recovery scenario: spin up a fresh Postgres \+ Redis, run migrations,/);
    expect(body).toMatch(/until V-542 nobody had a structured pass\/fail checklist for/);
    expect(body).toMatch(/## When to run/);
    expect(body).toMatch(
      /- \*\*Weekly during pre-launch\*\* — until the first paying customer, weekly/,
    );
    expect(body).toMatch(/rehearsal catches schema drift early\./);
    expect(body).toMatch(
      /- \*\*After every Drizzle migration that touches data tables\*\* — confirms/,
    );
    expect(body).toMatch(/- \*\*Before each marketing-site launch wave\*\*/);
    expect(body).toMatch(/- \*\*Quarterly post-launch\*\* — production rehearsal cadence\./);
  });

  it("A-E 5-phase rehearsal checklist framing pinned: '### A. Pre-rehearsal state' + '**A1.** Production HEAD recorded' + '/tmp/dr-rehearse-pre-head.txt' + '**A2.** Postgres production snapshot available within last 24h.' + 'Neon's automated daily snapshot' + '### B. Rehearsal execution' + '**B1.** `bash scripts/dr-rehearse.sh` runs end-to-end without' + '**B2.** Postgres container starts within 30s; Drizzle migrations' + '**B4.** Control plane boots; `/health` returns 200 with the expected' + '`{ \"ok\": true }`' + the B5 derive-and-compare instruction (V-819 replaced two remembered figures that were each about half of reality) + '### C. Restore-completeness verification' + '**C1.** Account count in restored DB matches production account' + '**C3.** R2 object count match — sample 10 random object keys' + '**C4.** Sub-processor configuration sanity — Postmark / Sentry /' + 'The rehearsal must NOT use production sub-processor' + '### D. Roll-forward decision' + '**D2.** Rehearsal duration recorded — full A→C path should' + 'complete in under 5 minutes. Above 10 min indicates infra drift' + '### E. Post-rehearsal cleanup' + '**E1.** Rehearsal containers + volumes destroyed.' + '**E3.** Checklist results logged with date + pass/fail per item' + 'docs/runbooks/incidents.md' + 'docs/runbooks/dr-rehearsal-history.md' — pinned so the A1-/tmp/dr-rehearse-pre-head.txt + A2-Neon-daily-snapshot + B1-end-to-end-no-non-zero + B2-30s-Postgres-start + B4-/health-200-{ok:true} + B5-derive-both-sides-and-match-production + C1-account-count + C3-10-random-R2-keys + C4-no-prod-sub-proc-creds + D2-5min-10min-infra-drift + E3-incidents.md-dr-rehearsal-history.md commitment survives", () => {
    expect(body).toMatch(/### A\. Pre-rehearsal state/);
    expect(body).toMatch(/\*\*A1\.\*\* Production HEAD recorded/);
    expect(body).toMatch(/\/tmp\/dr-rehearse-pre-head\.txt/);
    expect(body).toMatch(/\*\*A2\.\*\* Postgres production snapshot available within last 24h\./);
    expect(body).toMatch(/Neon's automated daily snapshot/);
    expect(body).toMatch(/### B\. Rehearsal execution/);
    expect(body).toMatch(/\*\*B1\.\*\* `bash scripts\/dr-rehearse\.sh` runs end-to-end without/);
    expect(body).toMatch(/\*\*B2\.\*\* Postgres container starts within 30s; Drizzle migrations/);
    expect(body).toMatch(
      /\*\*B4\.\*\* Control plane boots; `\/health` returns 200 with the expected/,
    );
    expect(body).toMatch(/`\{ "ok": true \}`/);
    expect(body).toMatch(/\*\*B5\.\*\* Control plane registers every route\./);
    expect(body).toMatch(
      /Do NOT eyeball this\s*\n\s*against a remembered number — derive both sides:/,
    );
    expect(body).toMatch(
      /require the restored instance to MATCH the same two commands\s*\n\s*run against production\./,
    );

    // V-819 SENTINELS — the retired figures must not return. Both were about
    // half of reality, which is worse than absent: a DR completeness check
    // whose floor sits that low passes a restore that came up a third built.
    expect(body, 'the stale module count must not return').not.toMatch(/production: 32 modules/);
    expect(body, 'the stale path floor must not return').not.toMatch(/expect ≥ ~80/);
    expect(body).toMatch(/### C\. Restore-completeness verification/);
    expect(body).toMatch(/\*\*C1\.\*\* Account count in restored DB matches production account/);
    expect(body).toMatch(/\*\*C3\.\*\* R2 object count match — sample 10 random object keys/);
    expect(body).toMatch(/\*\*C4\.\*\* Sub-processor configuration sanity — Postmark \/ Sentry \//);
    expect(body).toMatch(/The rehearsal must NOT use production sub-processor/);
    expect(body).toMatch(/### D\. Roll-forward decision/);
    expect(body).toMatch(/\*\*D2\.\*\* Rehearsal duration recorded — full A→C path should/);
    expect(body).toMatch(/complete in under 5 minutes\. Above 10 min indicates infra drift/);
    expect(body).toMatch(/### E\. Post-rehearsal cleanup/);
    expect(body).toMatch(/\*\*E1\.\*\* Rehearsal containers \+ volumes destroyed\./);
    expect(body).toMatch(/\*\*E3\.\*\* Checklist results logged with date \+ pass\/fail per item/);
    expect(body).toMatch(/docs\/runbooks\/incidents\.md/);
    expect(body).toMatch(/docs\/runbooks\/dr-rehearsal-history\.md/);
  });

  it("Pass/fail + V-542.B automation + V-542.A-this-wave framing pinned: '## Pass/fail criteria' + 'The rehearsal **PASSES** when every B + C item ticks. A and D items are' + 'informational' + 'The rehearsal **FAILS** when any B or C item doesn't tick.' + 'Failure must be logged with a root-cause note and a follow-up V-NNN slice' + '## Automation target (V-542.B — later wave)' + 'A scheduled BullMQ job runs the rehearsal weekly during pre-launch (then' + 'quarterly post-launch).' + 'Pass: log to status page admin view \"DR rehearsal passed YYYY-MM-DD\".' + 'Fail: Postmark alert to admin email' + '`scripts/dr-rehearse.sh` extended with structured pass/fail output' + '(JSON to stdout) instead of just exit code.' + 'Job runner (`apps/server/src/services/jobs/dr-rehearsal-job.ts`)' + 'Migration adding `dr_rehearsal_log` table (date + pass/fail + harness' + '## V-542.A this wave' + 'This document is the V-542.A artifact.' + 'V-542.B automates it. V-542.C (later) integrates the' + 'results into the admin status surface.' + '## Verification' + 'V-205 + V-211 regex sweep: zero hits.' + '`scripts/dr-rehearse.sh` exists at expected path.' — pinned so the B+C-must-pass + A+D-informational + FAILS-root-cause-V-NNN-followup + V-542.B-BullMQ-weekly→quarterly + Postmark-fail-alert + 3-impl-req (JSON-pass/fail + dr-rehearsal-job.ts + dr_rehearsal_log-table) + V-542.A-this-doc + V-542.C-admin-status-later + dr-rehearse.sh-exists commitment survives", () => {
    expect(body).toMatch(/## Pass\/fail criteria/);
    expect(body).toMatch(
      /The rehearsal \*\*PASSES\*\* when every B \+ C item ticks\. A and D items are/,
    );
    expect(body).toMatch(/informational/);
    expect(body).toMatch(/The rehearsal \*\*FAILS\*\* when any B or C item doesn't tick\./);
    expect(body).toMatch(/Failure must/);
    expect(body).toMatch(/be logged with a root-cause note and a follow-up V-NNN slice/);
    expect(body).toMatch(/## Automation target \(V-542\.B — later wave\)/);
    expect(body).toMatch(
      /A scheduled BullMQ job runs the rehearsal weekly during pre-launch \(then/,
    );
    expect(body).toMatch(/quarterly post-launch\)\./);
    expect(body).toMatch(
      /- Pass: log to status page admin view "DR rehearsal passed YYYY-MM-DD"\./,
    );
    expect(body).toMatch(/- Fail: Postmark alert to admin email/);
    expect(body).toMatch(
      /1\. `scripts\/dr-rehearse\.sh` extended with structured pass\/fail output/,
    );
    expect(body).toMatch(/\(JSON to stdout\) instead of just exit code\./);
    expect(body).toMatch(
      /2\. Job runner \(`apps\/server\/src\/services\/jobs\/dr-rehearsal-job\.ts`\)/,
    );
    expect(body).toMatch(
      /3\. Migration adding `dr_rehearsal_log` table \(date \+ pass\/fail \+ harness/,
    );
    expect(body).toMatch(/## V-542\.A this wave/);
    expect(body).toMatch(/This document is the V-542\.A artifact\./);
    expect(body).toMatch(/V-542\.B automates it\. V-542\.C \(later\) integrates the/);
    expect(body).toMatch(/results into the admin status surface\./);
    expect(body).toMatch(/## Verification/);
    expect(body).toMatch(/- V-205 \+ V-211 regex sweep: zero hits\./);
    expect(body).toMatch(/- Cross-reference: `scripts\/dr-rehearse\.sh` exists at expected path\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
