// @driftstack/behavioural-simulation public surface.

export type {
  BehaviouralProfile,
  ElementBounds,
  ElementClass,
  KeyboardCadence,
  MouseTrajectory,
  ScrollPattern,
  TouchDistribution,
  TouchEvent,
  TouchSample,
} from './types.js';

export type {
  BehaviouralSimulator,
  GenerateKeyboardCadenceOpts,
  GenerateMouseTrajectoryOpts,
  GenerateScrollPatternOpts,
  GenerateTouchEventOpts,
} from './interfaces.js';

export { MockBehaviouralSimulator } from './mock.js';
export { generateTouchEvent, TOUCH_DISTRIBUTIONS } from './touch.js';
