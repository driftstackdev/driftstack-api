// V-179 — recapture automation types.
//
// When Apple ships a new iOS minor version (e.g. iOS 18.7 → iOS 18.8),
// the entire fingerprint reference set captured against the old version
// MAY have drifted. Recapture automation detects the version bump,
// triggers a recapture pass against representative archetypes, and
// validates that the new captures match the prior baseline (or surfaces
// a diff for manual review).
//
// Phase 3+ workstream. Today the workflow is manual: when Agent 1
// notices a new iOS version on Apple's release notes, the founder runs
// the BS Automate capture batches manually. This package's mock
// implementation models the SAME workflow programmatically so a future
// scheduled-job + alerting layer can drop in.

/** Identifier for a particular iOS + Safari version pair. */
export interface IosArchetypeVersion {
  /** iOS major.minor version, e.g. `'18.7'`. */
  iosVersion: string;
  /** Safari major.minor version, e.g. `'26.4'`. */
  safariVersion: string;
}

/** Why a recapture run was triggered. */
export type RecaptureTrigger =
  | 'ios_version_bump'
  | 'safari_version_bump'
  | 'baseline_drift_detected'
  | 'manual_request';

/** Status of a recapture run. */
export type RecaptureStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

/** Per-fingerprint comparison outcome from a recapture validation. */
export type FingerprintComparisonOutcome =
  /** Recaptured value matches baseline byte-for-byte. */
  | 'match'
  /** Recaptured value differs; baseline is now stale. */
  | 'diff'
  /** Capture failed at this surface (network, timeout, browser crash). */
  | 'capture_error'
  /** Surface didn't exist in baseline; new since last capture. */
  | 'new_surface'
  /** Surface existed in baseline but no longer reachable. */
  | 'missing_surface';

export interface FingerprintComparison {
  /** Surface identifier — file 121 category + sub-id (e.g. `'webgl.G3.renderer'`). */
  surfaceId: string;
  outcome: FingerprintComparisonOutcome;
  baselineValue: string | null;
  recapturedValue: string | null;
  /** Free-form reason when outcome != 'match'. */
  notes: string | null;
}

/**
 * One recapture run. A run targets ONE archetype (defined by
 * archetypeId + the iOS/Safari version pair). The per-surface
 * comparisons accumulate into the `comparisons` array as the run
 * progresses; on completion, the aggregate `matchCount` /
 * `diffCount` / `errorCount` reflect the validation outcome.
 */
export interface RecaptureRun {
  id: string;
  trigger: RecaptureTrigger;
  /** Archetype being recaptured, e.g. `'iphone17_ios18_7_safari26_4'`. */
  archetypeId: string;
  baselineVersion: IosArchetypeVersion;
  /** New version triggering the recapture. May equal baselineVersion for manual reruns. */
  targetVersion: IosArchetypeVersion;
  status: RecaptureStatus;
  /** Per-fingerprint comparisons. Empty until the run starts. */
  comparisons: readonly FingerprintComparison[];
  matchCount: number;
  diffCount: number;
  errorCount: number;
  newSurfaceCount: number;
  missingSurfaceCount: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  createdAtMs: number;
}

/** Parameters for triggering a new recapture. */
export interface TriggerRecaptureOpts {
  trigger: RecaptureTrigger;
  archetypeId: string;
  baselineVersion: IosArchetypeVersion;
  targetVersion: IosArchetypeVersion;
  /** Optional human-readable note (e.g. "Apple release notes reference 18.8 dropped 2026-08-01"). */
  reason?: string;
}

/**
 * Detected iOS version transition. Today this comes from manual
 * inspection of Apple's release notes; future: scraper / RSS feed
 * watcher. The detection layer is OUT OF SCOPE for this package —
 * this type is the boundary the detection layer hands off to the
 * recapture trigger.
 */
export interface IosVersionTransition {
  fromIosVersion: string;
  toIosVersion: string;
  detectedAtMs: number;
  /** Free-form source of the transition (URL, file path, notebook entry). */
  source: string;
}
