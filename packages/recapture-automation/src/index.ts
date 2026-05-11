// @driftstack/recapture-automation public surface.

export type {
  FingerprintComparison,
  FingerprintComparisonOutcome,
  IosArchetypeVersion,
  IosVersionTransition,
  RecaptureRun,
  RecaptureStatus,
  RecaptureTrigger,
  TriggerRecaptureOpts,
} from './types.js';

export type {
  IosVersionWatcher,
  ListRunsOpts,
  ListRunsPage,
  RecaptureService,
} from './interfaces.js';

export {
  MockIosVersionWatcher,
  MockRecaptureService,
  type MockIosVersionWatcherDeps,
  type MockRecaptureServiceDeps,
} from './mock.js';

// V-533.A — capture matrix runner + dedup.
export type { CaptureMatrixSpec, ComparisonSummary } from './matrix.js';
export {
  dedupComparisons,
  expandCaptureMatrix,
  groupComparisonsByCategory,
  summarizeComparisons,
} from './matrix.js';

// V-533.B — atlas builder.
export type {
  ArchetypeVersionSnapshot,
  Atlas,
  BuildAtlasOpts,
  SurfaceStability,
  VersionTransitionImpact,
} from './atlas.js';
export { buildAtlas, classifyOutcomes } from './atlas.js';

// V-533.C — recapture scheduler.
export type {
  ArchetypeRunHistory,
  SchedulePriority,
  ScheduleEntry,
  ScheduleRecaptureBatchOpts,
  ScheduleRecaptureBatchResult,
} from './scheduler.js';
export { scheduleRecaptureBatch } from './scheduler.js';
