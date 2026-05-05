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
