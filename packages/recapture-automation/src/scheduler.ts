// V-533.C — recapture scheduler.
//
// Third sub-slice of V-533. V-533.A shipped the matrix expander +
// dedup; V-533.B shipped the atlas builder. V-533.C is the scheduler:
// given a detected iOS version transition + the per-archetype run
// history, decide which archetypes need recapture NOW vs which can
// be deferred to a later pass.
//
// Pure data — no I/O. The actual cron / scheduler driver that calls
// this lives outside this package; this module is the policy layer
// that the driver consumes. Test surface: simple deterministic
// function of (transition, archetypeRunHistory) → schedule.
//
// Decision rules:
//
//   - HIGH priority: archetype hasn't been captured against the
//     incoming iOS version at all, OR its most-recent run against that
//     version is terminal failed/cancelled (retry). Always include.
//   - MEDIUM priority: archetype was captured against the prior
//     version (i.e. is the "production" archetype for this lane)
//     AND the most-recent run was completed (status === 'completed').
//   - LOW priority: archetype was captured but with diff > stable
//     threshold (drifting) OR error rate above the error threshold.
//     Recapture confirms whether the drift / error pattern persists.
//   - SKIP: archetype's most-recent run is in_progress or queued
//     for the SAME target version (no point queueing a duplicate).
//
// Output: an ordered list of `TriggerRecaptureOpts`, HIGH first,
// then MEDIUM, then LOW. SKIP archetypes are omitted entirely.

import type {
  IosArchetypeVersion,
  IosVersionTransition,
  RecaptureRun,
  TriggerRecaptureOpts,
} from './types.js';

export type SchedulePriority = 'high' | 'medium' | 'low' | 'skip';

export interface ArchetypeRunHistory {
  archetypeId: string;
  /** Most-recent run for this archetype, or null if never captured. */
  latestRun: RecaptureRun | null;
}

export interface ScheduleEntry {
  archetypeId: string;
  priority: SchedulePriority;
  reason: string;
  triggerOpts: TriggerRecaptureOpts;
}

export interface ScheduleRecaptureBatchOpts {
  /** The detected version transition (fromIosVersion → toIosVersion). */
  transition: IosVersionTransition;
  /** Safari version corresponding to the target iOS version. */
  targetSafariVersion: string;
  /** Per-archetype run history. One entry per archetype the scheduler
   *  should consider. */
  archetypeHistory: readonly ArchetypeRunHistory[];
  /** Match-rate below which a surface is considered drifting (and the
   *  archetype is LOW priority). Default 0.95 — matches the atlas
   *  builder's STABLE_THRESHOLD. */
  driftingThreshold?: number;
  /** Error-rate above which an archetype is LOW priority. Default 0.25
   *  — matches the atlas builder's ERROR_THRESHOLD. */
  erroringThreshold?: number;
}

export interface ScheduleRecaptureBatchResult {
  entries: readonly ScheduleEntry[];
  /** Archetypes the scheduler returned with priority='skip', along
   *  with the reason. Kept for visibility/logging — empty array if
   *  none were skipped. */
  skipped: ReadonlyArray<{ archetypeId: string; reason: string }>;
}

const DEFAULT_DRIFTING_THRESHOLD = 0.95;
const DEFAULT_ERRORING_THRESHOLD = 0.25;

export function scheduleRecaptureBatch(
  opts: ScheduleRecaptureBatchOpts,
): ScheduleRecaptureBatchResult {
  const driftingThreshold = opts.driftingThreshold ?? DEFAULT_DRIFTING_THRESHOLD;
  const erroringThreshold = opts.erroringThreshold ?? DEFAULT_ERRORING_THRESHOLD;
  const targetVersion: IosArchetypeVersion = {
    iosVersion: opts.transition.toIosVersion,
    safariVersion: opts.targetSafariVersion,
  };

  const entries: ScheduleEntry[] = [];
  const skipped: Array<{ archetypeId: string; reason: string }> = [];

  for (const history of opts.archetypeHistory) {
    const latest = history.latestRun;
    const triggerOpts: TriggerRecaptureOpts = {
      trigger: 'ios_version_bump',
      archetypeId: history.archetypeId,
      baselineVersion: latest?.targetVersion ?? {
        iosVersion: opts.transition.fromIosVersion,
        safariVersion: opts.targetSafariVersion,
      },
      targetVersion,
    };

    // SKIP — already running / queued against this exact target.
    if (
      latest !== null &&
      (latest.status === 'queued' || latest.status === 'in_progress') &&
      latest.targetVersion.iosVersion === targetVersion.iosVersion &&
      latest.targetVersion.safariVersion === targetVersion.safariVersion
    ) {
      skipped.push({
        archetypeId: history.archetypeId,
        reason: `already ${latest.status} against ${targetVersion.iosVersion}`,
      });
      continue;
    }

    // HIGH — no run ever, OR no run against the incoming target.
    if (latest === null || latest.targetVersion.iosVersion !== targetVersion.iosVersion) {
      entries.push({
        archetypeId: history.archetypeId,
        priority: 'high',
        reason:
          latest === null
            ? 'never captured against any version'
            : `not yet captured against ${targetVersion.iosVersion}`,
        triggerOpts,
      });
      continue;
    }

    // From here, latest.targetVersion.iosVersion === target.iosVersion,
    // i.e. the archetype was already captured against this version, and
    // the run is terminal (queued / in_progress were SKIP'd above).

    // Failed / cancelled against the target → HIGH retry. This MUST run
    // BEFORE the health classification below: a non-completed run's
    // match/error counts are partial (it didn't finish), so a typical
    // failed run with few/zero matches would otherwise trip the
    // `matchRate < driftingThreshold` branch and be mis-scheduled as LOW
    // "drift suspected" instead of retried. (Pre-fix the HIGH-retry path
    // was only reachable by a failed run that happened to have
    // matchRate >= threshold — see the regression test.)
    if (latest.status !== 'completed') {
      entries.push({
        archetypeId: history.archetypeId,
        priority: 'high',
        reason: `prior run terminal=${latest.status}; retry`,
        triggerOpts,
      });
      continue;
    }

    // Completed run against the target version — classify by health.
    const total = latest.matchCount + latest.diffCount + latest.errorCount;
    const matchRate = total === 0 ? 0 : latest.matchCount / total;
    const errorRate = total === 0 ? 0 : latest.errorCount / total;

    if (errorRate >= erroringThreshold) {
      entries.push({
        archetypeId: history.archetypeId,
        priority: 'low',
        reason: `prior run error rate ${(errorRate * 100).toFixed(0)}%; re-confirm`,
        triggerOpts,
      });
      continue;
    }

    if (matchRate < driftingThreshold) {
      entries.push({
        archetypeId: history.archetypeId,
        priority: 'low',
        reason: `prior run match rate ${(matchRate * 100).toFixed(0)}%; drift suspected`,
        triggerOpts,
      });
      continue;
    }

    // Healthy completed run against the target version — MEDIUM:
    // re-capture is desired only as a smoke check, not required.
    entries.push({
      archetypeId: history.archetypeId,
      priority: 'medium',
      reason: 'prior run healthy; smoke-check pass',
      triggerOpts,
    });
  }

  // Stable sort by priority: high → medium → low. Preserves input
  // ordering within a priority tier.
  const priorityRank: Record<SchedulePriority, number> = {
    high: 0,
    medium: 1,
    low: 2,
    skip: 3,
  };
  entries.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);

  return { entries, skipped };
}
