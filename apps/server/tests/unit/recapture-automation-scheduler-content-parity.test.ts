// W460.B — drift guard for packages/recapture-automation/src/scheduler.ts.
// V-533.C recapture scheduler. Drift here either drops the SKIP
// branch (latest queued/in_progress against same target) — scheduler
// double-queues identical runs and floods the worker pool — or
// breaks the priority sort (HIGH → MEDIUM → LOW), so the admin
// panel surfaces stale-baseline archetypes before never-captured
// ones and operators triage in the wrong order.
//
//   • V-533.C framing pinned + 'V-533.A shipped the matrix expander
//     + dedup; V-533.B shipped the atlas builder. V-533.C is the
//     scheduler' + 'Pure data — no I/O' framing.
//   • 4 decision rules pinned (HIGH never-captured-against-target,
//     MEDIUM captured-and-completed-against-prior, LOW
//     drifting/error-rate, SKIP queued/in_progress same target).
//   • SchedulePriority 4-value union ('high'|'medium'|'low'|'skip').
//   • ArchetypeRunHistory: 2-field (archetypeId + latestRun nullable).
//   • ScheduleEntry: 4-field (archetypeId + priority + reason +
//     triggerOpts).
//   • ScheduleRecaptureBatchOpts: 5-field with default
//     driftingThreshold 0.95 + erroringThreshold 0.25.
//   • SKIP branch: latest !== null && (queued || in_progress) &&
//     same iosVersion + safariVersion against target.
//   • HIGH branch: latest === null || target mismatch.
//   • errorRate >= erroringThreshold → LOW.
//   • matchRate < driftingThreshold → LOW.
//   • completed + healthy → MEDIUM 'smoke-check pass'.
//   • Failed/cancelled (status !== completed) → HIGH retry, checked
//     BEFORE the health classification (2026-05-31 ordering fix so a
//     low-match failed run isn't mis-scheduled LOW "drift").
//   • Stable sort by priorityRank (high:0, medium:1, low:2, skip:3).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recapture-automation/src/scheduler.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W460.B packages/recapture-automation/src/scheduler.ts content parity', () => {
  const body = read(LIB);

  it("V-533.C framing pinned: 'V-533.C — recapture scheduler.' + 'V-533.A shipped the matrix expander + dedup; V-533.B shipped the atlas builder. V-533.C is the scheduler: given a detected iOS version transition + the per-archetype run history, decide which archetypes need recapture NOW vs which can be deferred to a later pass.' + 'Pure data — no I/O' framing", () => {
    expect(body).toMatch(/\/\/ V-533\.C — recapture scheduler\./);
    expect(body).toMatch(
      /\/\/ Third sub-slice of V-533\. V-533\.A shipped the matrix expander \+\s*\/\/ dedup; V-533\.B shipped the atlas builder\. V-533\.C is the scheduler:\s*\/\/ given a detected iOS version transition \+ the per-archetype run\s*\/\/ history, decide which archetypes need recapture NOW vs which can\s*\/\/ be deferred to a later pass\./,
    );
    expect(body).toMatch(
      /\/\/ Pure data — no I\/O\. The actual cron \/ scheduler driver that calls\s*\/\/ this lives outside this package; this module is the policy layer\s*\/\/ that the driver consumes\./,
    );
  });

  it("4 decision rules pinned (HIGH never-captured-against-target 'Always include'; MEDIUM captured-against-prior + completed; LOW drift > stable threshold OR error rate above error threshold; SKIP queued/in_progress same target 'no point queueing a duplicate')", () => {
    expect(body).toMatch(
      /\/\/\s+- HIGH priority: archetype hasn't been captured against the\s*\/\/\s+incoming iOS version at all, OR its most-recent run against that\s*\/\/\s+version is terminal failed\/cancelled \(retry\)\. Always include\./,
    );
    expect(body).toMatch(
      /\/\/\s+- MEDIUM priority: archetype was captured against the prior\s*\/\/\s+version \(i\.e\. is the "production" archetype for this lane\)\s*\/\/\s+AND the most-recent run was completed \(status === 'completed'\)\./,
    );
    expect(body).toMatch(
      /\/\/\s+- LOW priority: archetype was captured but with diff > stable\s*\/\/\s+threshold \(drifting\) OR error rate above the error threshold\.\s*\/\/\s+Recapture confirms whether the drift \/ error pattern persists\./,
    );
    expect(body).toMatch(
      /\/\/\s+- SKIP: archetype's most-recent run is in_progress or queued\s*\/\/\s+for the SAME target version \(no point queueing a duplicate\)\./,
    );
  });

  it("Output ordering framing pinned: 'an ordered list of TriggerRecaptureOpts, HIGH first, then MEDIUM, then LOW. SKIP archetypes are omitted entirely.'", () => {
    expect(body).toMatch(
      /\/\/ Output: an ordered list of `TriggerRecaptureOpts`, HIGH first,\s*\/\/ then MEDIUM, then LOW\. SKIP archetypes are omitted entirely\./,
    );
  });

  it("SchedulePriority 4-value union ('high'|'medium'|'low'|'skip'); ArchetypeRunHistory 2-field (archetypeId + latestRun nullable); ScheduleEntry 4-field (archetypeId + priority + reason + triggerOpts)", () => {
    expect(body).toMatch(/export type SchedulePriority = 'high' \| 'medium' \| 'low' \| 'skip';/);
    expect(body).toMatch(
      /export interface ArchetypeRunHistory \{\s*archetypeId: string;\s*\/\*\* Most-recent run for this archetype, or null if never captured\. \*\/\s*latestRun: RecaptureRun \| null;\s*\}/,
    );
    expect(body).toMatch(
      /export interface ScheduleEntry \{\s*archetypeId: string;\s*priority: SchedulePriority;\s*reason: string;\s*triggerOpts: TriggerRecaptureOpts;\s*\}/,
    );
  });

  it("ScheduleRecaptureBatchOpts 5-field with default driftingThreshold 0.95 'matches the atlas builder's STABLE_THRESHOLD' + erroringThreshold 0.25 'matches the atlas builder's ERROR_THRESHOLD' + DEFAULT_DRIFTING_THRESHOLD = 0.95 + DEFAULT_ERRORING_THRESHOLD = 0.25 constants", () => {
    expect(body).toMatch(
      /\/\*\* Match-rate below which a surface is considered drifting \(and the\s*\*\s*archetype is LOW priority\)\. Default 0\.95 — matches the atlas\s*\*\s*builder's STABLE_THRESHOLD\. \*\/\s*driftingThreshold\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Error-rate above which an archetype is LOW priority\. Default 0\.25\s*\*\s*— matches the atlas builder's ERROR_THRESHOLD\. \*\/\s*erroringThreshold\?: number;/,
    );
    expect(body).toMatch(/const DEFAULT_DRIFTING_THRESHOLD = 0\.95;/);
    expect(body).toMatch(/const DEFAULT_ERRORING_THRESHOLD = 0\.25;/);
  });

  it("ScheduleRecaptureBatchResult: entries + skipped framing pinned 'Archetypes the scheduler returned with priority=skip, along with the reason. Kept for visibility/logging — empty array if none were skipped.'", () => {
    expect(body).toMatch(
      /export interface ScheduleRecaptureBatchResult \{\s*entries: readonly ScheduleEntry\[\];\s*\/\*\* Archetypes the scheduler returned with priority='skip', along\s*\*\s*with the reason\. Kept for visibility\/logging — empty array if\s*\*\s*none were skipped\. \*\/\s*skipped: ReadonlyArray<\{ archetypeId: string; reason: string \}>;\s*\}/,
    );
  });

  it('SKIP branch (in-flight dedup): latest !== null && (queued || in_progress) && same iosVersion against target — keyed on iosVersion ALONE (NOT iosVersion+safariVersion, which let a same-target/different-Safari in-flight run slip past into a HIGH-retry double-capture); skipped.push with reason `already ${latest.status} against ${targetVersion.iosVersion}`', () => {
    expect(body).toMatch(
      /if \(\s*latest !== null &&\s*\(latest\.status === 'queued' \|\| latest\.status === 'in_progress'\) &&\s*latest\.targetVersion\.iosVersion === targetVersion\.iosVersion\s*\) \{/,
    );
    // toContain (not a single closed regex spanning the if-block) so the
    // staleness check (audit fix 3, 2026-07-01) inserted between the `if (`
    // and the `skipped.push` doesn't break this pin.
    expect(body).toContain('skipped.push({');
    expect(body).toContain('archetypeId: history.archetypeId,');
    expect(body).toContain(
      'reason: `already ${latest.status} against ${targetVersion.iosVersion}`,',
    );
    // The Safari-version equality must NOT be part of the SKIP key (the bug).
    expect(body).not.toMatch(
      /\(latest\.status === 'queued' \|\| latest\.status === 'in_progress'\) &&\s*latest\.targetVersion\.iosVersion === targetVersion\.iosVersion &&\s*latest\.targetVersion\.safariVersion === targetVersion\.safariVersion/,
    );
  });

  it('SKIP branch staleness check (audit fix 3, 2026-07-01): an in-flight run older than STALE_IN_FLIGHT_MS is NOT skipped — rescheduled HIGH instead, distinct reason text from the normal SKIP/retry messages', () => {
    expect(body).toContain('const STALE_IN_FLIGHT_MS =');
    expect(body).toContain('const inFlightSinceMs = latest.startedAtMs ?? latest.createdAtMs;');
    expect(body).toContain('const inFlightAgeMs = nowMs - inFlightSinceMs;');
    expect(body).toContain('if (inFlightAgeMs > STALE_IN_FLIGHT_MS) {');
    expect(body).toContain('stale in-flight run (status=');
  });

  it("HIGH branch: latest === null || target mismatch with reason ternary ('never captured against any version' | `not yet captured against ${targetVersion.iosVersion}`)", () => {
    expect(body).toMatch(
      /if \(latest === null \|\| latest\.targetVersion\.iosVersion !== targetVersion\.iosVersion\) \{\s*entries\.push\(\{\s*archetypeId: history\.archetypeId,\s*priority: 'high',\s*reason:\s*latest === null\s*\? 'never captured against any version'\s*: `not yet captured against \$\{targetVersion\.iosVersion\}`,\s*triggerOpts,\s*\}\);/,
    );
  });

  it("Branches in CORRECTED order (2026-05-31 fix): failed/cancelled (status !== 'completed') → HIGH `prior run terminal=${latest.status}; retry` is checked BEFORE the health classification (else a low-match failed run trips matchRate<threshold and is mis-scheduled LOW); then errorRate >= erroringThreshold → LOW 're-confirm'; matchRate < driftingThreshold → LOW 'drift suspected'; healthy completed → MEDIUM 'smoke-check pass' (now an unconditional push — the old `if (latest.status === 'completed')` guard is gone)", () => {
    // Failed/cancelled → HIGH retry, gated on status !== 'completed', placed
    // BEFORE the health checks (discrete pins; no long backtracking chain).
    expect(body).toMatch(/if \(latest\.status !== 'completed'\) \{/);
    expect(body).toMatch(/reason: `prior run terminal=\$\{latest\.status\}; retry`,/);
    // Health classification (completed runs only).
    expect(body).toMatch(/if \(errorRate >= erroringThreshold\) \{/);
    expect(body).toMatch(
      /reason: `prior run error rate \$\{\(errorRate \* 100\)\.toFixed\(0\)\}%; re-confirm`,/,
    );
    expect(body).toMatch(/if \(matchRate < driftingThreshold\) \{/);
    expect(body).toMatch(
      /reason: `prior run match rate \$\{\(matchRate \* 100\)\.toFixed\(0\)\}%; drift suspected`,/,
    );
    // Healthy completed → MEDIUM, now an unconditional push.
    expect(body).toMatch(/reason: 'prior run healthy; smoke-check pass',/);
    // Regression lock: the MEDIUM push must NOT be guarded by a status check
    // (the failed/cancelled split now happens above, not after the health checks).
    expect(body).not.toMatch(/if \(latest\.status === 'completed'\) \{/);
  });

  it("Health calc: total sums all FIVE outcome buckets (match+diff+error+newSurface+missingSurface, audit fix 1, 2026-07-01 — mirrors atlas.ts's classifyOutcomes so a missing/new-surface-dominated run isn't misclassified healthy); matchRate + errorRate guarded by total === 0; Stable sort by priorityRank (high:0, medium:1, low:2, skip:3) 'Preserves input ordering within a priority tier'", () => {
    expect(body).toMatch(
      /const total =\s*latest\.matchCount \+\s*latest\.diffCount \+\s*latest\.errorCount \+\s*latest\.newSurfaceCount \+\s*latest\.missingSurfaceCount;\s*const matchRate = total === 0 \? 0 : latest\.matchCount \/ total;\s*const errorRate = total === 0 \? 0 : latest\.errorCount \/ total;/,
    );
    expect(body).toMatch(
      /\/\/ Stable sort by priority: high → medium → low\. Preserves input\s*\/\/ ordering within a priority tier\.\s*const priorityRank: Record<SchedulePriority, number> = \{\s*high: 0,\s*medium: 1,\s*low: 2,\s*skip: 3,\s*\};\s*entries\.sort\(\(a, b\) => priorityRank\[a\.priority\] - priorityRank\[b\.priority\]\);/,
    );
  });

  it("triggerOpts construction: trigger:'ios_version_bump' + baselineVersion = latest?.targetVersion ?? {fromIosVersion+targetSafariVersion} fallback + targetVersion from transition.toIosVersion + targetSafariVersion", () => {
    expect(body).toMatch(
      /const targetVersion: IosArchetypeVersion = \{\s*iosVersion: opts\.transition\.toIosVersion,\s*safariVersion: opts\.targetSafariVersion,\s*\};/,
    );
    expect(body).toMatch(
      /const triggerOpts: TriggerRecaptureOpts = \{\s*trigger: 'ios_version_bump',\s*archetypeId: history\.archetypeId,\s*baselineVersion: latest\?\.targetVersion \?\? \{\s*iosVersion: opts\.transition\.fromIosVersion,\s*safariVersion: opts\.targetSafariVersion,\s*\},\s*targetVersion,\s*\};/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
