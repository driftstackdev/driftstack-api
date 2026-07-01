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
  /** Clock seam for the stale in-flight lease-expiry check (see
   *  STALE_IN_FLIGHT_MS) — overridden in tests for deterministic age math.
   *  Defaults to `Date.now`. */
  now?: () => number;
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

// Fix 3 (2026-07-01 audit): how long an in-flight (`queued` / `in_progress`)
// run is trusted before it's treated as abandoned. Captures are expensive,
// multi-surface WKWebView walks (docs/internal/v533-cross-agent-contract.md
// — Agent 1's fork worker opens a WKWebView per archetype and walks the
// whole file-121 surface catalogue), so a healthy run can legitimately take
// a while; this is deliberately generous (hours, not minutes — an order of
// magnitude above e.g. the 5-minute in-flight reclaim window used for fast
// HTTP-scale work elsewhere in this codebase) so a run that's still
// genuinely working is never mistaken for abandoned. Without SOME staleness
// check, a run stuck at 'in_progress' because its worker crashed before
// ever calling finalizeRun() would SKIP its archetype forever.
const STALE_IN_FLIGHT_MS = 6 * 60 * 60 * 1000; // 6 hours

export function scheduleRecaptureBatch(
  opts: ScheduleRecaptureBatchOpts,
): ScheduleRecaptureBatchResult {
  const driftingThreshold = opts.driftingThreshold ?? DEFAULT_DRIFTING_THRESHOLD;
  const erroringThreshold = opts.erroringThreshold ?? DEFAULT_ERRORING_THRESHOLD;
  const nowMs = (opts.now ?? Date.now)();
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

    // SKIP — already running / queued against this target. The in-flight
    // dedup unit is the iOS version (the archetype lane), consistent with the
    // HIGH classification below which keys "captured against this version"
    // solely on `iosVersion`. Keying the SKIP on iosVersion AND safariVersion
    // (as it once did) let an in-flight run whose Safari version differs only
    // by a point release slip past the dedup: it isn't SKIP'd, the iosVersion
    // matches so it isn't HIGH "not yet captured", and a non-completed run
    // then falls to the HIGH-retry path — queueing a DUPLICATE capture against
    // a target already in flight (double-capture). Dedup on iosVersion so a
    // same-target / different-Safari-version in-flight run is treated as the
    // same unit and skipped.
    if (
      latest !== null &&
      (latest.status === 'queued' || latest.status === 'in_progress') &&
      latest.targetVersion.iosVersion === targetVersion.iosVersion
    ) {
      // Fix 3 (2026-07-01 audit): before honoring the SKIP, check whether
      // the in-flight run is actually still alive. `startedAtMs` is set the
      // moment the run transitions to 'in_progress' (first recordComparison
      // call); a run still 'queued' never got that far, so fall back to
      // `createdAtMs` — the age of "nothing has happened on this run yet".
      const inFlightSinceMs = latest.startedAtMs ?? latest.createdAtMs;
      const inFlightAgeMs = nowMs - inFlightSinceMs;
      if (inFlightAgeMs > STALE_IN_FLIGHT_MS) {
        // Abandoned, not merely slow — the worker backing this run likely
        // crashed or was killed before ever calling finalizeRun(). Without
        // this branch the archetype would be SKIP'd forever. Reschedule at
        // HIGH (same tier as "never captured" / terminal-failure retry) so
        // it isn't starved behind healthy archetypes; the reason is worded
        // distinctly from both the normal SKIP message below and the
        // terminal-failure retry message further down so operators can tell
        // a genuinely-stuck run apart from a fast failed/cancelled one.
        entries.push({
          archetypeId: history.archetypeId,
          priority: 'high',
          reason:
            `stale in-flight run (status=${latest.status}, ` +
            `${Math.round(inFlightAgeMs / 60_000)}m since last activity > ` +
            `${Math.round(STALE_IN_FLIGHT_MS / 60_000)}m threshold); rescheduling`,
          triggerOpts,
        });
        continue;
      }
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
    //
    // KNOWN GAP (Fix 4, 2026-07-01 audit — intentionally deferred): this
    // branch retries at 'high' priority on EVERY scheduling pass, forever,
    // with no cap/backoff for a permanently-broken archetype. The minimal
    // safe fix would be a consecutive-failure counter, but
    // `ArchetypeRunHistory` only carries a single `latestRun` (not a run
    // history), and its 2-field shape (archetypeId + latestRun) is pinned
    // byte-for-byte by a content-parity guard in apps/server — a repo this
    // change is explicitly scoped OUT of touching, so widening the shape
    // here would silently desync that pin instead of getting reviewed
    // alongside it. A "simpler proxy" using only data available on the
    // CURRENT run (e.g. downgrading using this run's own error/diff counts)
    // was considered and rejected: it can't distinguish "failed once" from
    // "failed 50 times in a row" — the whole point of this finding — so it
    // would conflate a single bad run with a chronic one, which is worse
    // than leaving the gap open. Deferred until `ArchetypeRunHistory` can be
    // widened (e.g. an optional `consecutiveFailureCount`) as part of a
    // change reviewed against that pin, or the caller starts passing a
    // short run-history slice instead of just `latestRun`.
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
    //
    // Fix 1 (2026-07-01 audit): `total` sums all FIVE outcome buckets
    // (match/diff/error/new_surface/missing_surface), mirroring the atlas
    // builder's classifyOutcomes (atlas.ts) — NOT just match+diff+error.
    // A run dominated by missing_surface (e.g. after an iOS bump wiped out
    // most of an archetype's fingerprint surfaces) must show up as a LOW
    // matchRate here too; summing only 3 of the 5 buckets let such a run
    // compute matchRate=1.0 on the tiny remaining matched slice and get
    // misclassified healthy/MEDIUM instead of flagging the surface loss.
    // errorRate deliberately stays errorCount/total (capture_error only,
    // NOT new/missing) — same as atlas.ts's errorRate — so a surface-loss
    // run is caught via the matchRate/driftingThreshold branch below, the
    // same mechanism atlas.ts uses to fold new/missing into its matchRate.
    const total =
      latest.matchCount +
      latest.diffCount +
      latest.errorCount +
      latest.newSurfaceCount +
      latest.missingSurfaceCount;
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
