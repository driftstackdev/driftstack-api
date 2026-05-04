// @driftstack/behavioural-simulation public surface.

export type {
  BehaviouralProfile,
  KeyboardCadence,
  MouseTrajectory,
  ScrollPattern,
} from './types.js';

export type {
  BehaviouralSimulator,
  GenerateKeyboardCadenceOpts,
  GenerateMouseTrajectoryOpts,
  GenerateScrollPatternOpts,
} from './interfaces.js';

export { MockBehaviouralSimulator } from './mock.js';
