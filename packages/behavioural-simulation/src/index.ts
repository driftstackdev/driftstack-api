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
  GenerateScrollVelocityProfileOpts,
  GenerateTouchEventOpts,
} from './interfaces.js';

export type {
  ScrollVelocityClassDefaults,
  ScrollVelocityProfile,
  ScrollVelocityTick,
} from './scroll.js';

export { MockBehaviouralSimulator } from './mock.js';
export { generateTouchEvent, TOUCH_DISTRIBUTIONS } from './touch.js';
export { generateScrollVelocityProfile, SCROLL_VELOCITY_DEFAULTS } from './scroll.js';

export type {
  ClickRegion,
  DwellShape,
  GenerateRegionAwareTouchOpts,
  RegionAwareTouchEvent,
} from './dwell.js';
export { CLICK_REGIONS, DWELL_SHAPES, generateRegionAwareTouchEvent } from './dwell.js';

// V-530.D — idle-period jitter generator.
export type {
  GenerateIdlePeriodOpts,
  GenerateIdleSequenceOpts,
  IdleClass,
  IdleClassDefaults,
  IdlePeriod,
  IdleSequence,
  IdleSequenceEntry,
} from './idle.js';
export { generateIdlePeriod, generateIdleSequence, IDLE_DEFAULTS } from './idle.js';

// V-530.E — multi-touch gesture sequencing.
export type {
  FingerSample,
  FingerTrack,
  GestureKind,
  GeneratePinchOpts,
  GenerateTwoFingerScrollOpts,
  GenerateThreeFingerSwipeOpts,
  MultiTouchGesture,
} from './multi-touch.js';
export {
  generatePinchGesture,
  generateTwoFingerScrollGesture,
  generateThreeFingerSwipeGesture,
  interleaveGestureStream,
} from './multi-touch.js';
