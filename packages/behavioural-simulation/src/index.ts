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

export { MAX_SCROLL_PATTERN_TICKS, MockBehaviouralSimulator } from './mock.js';
export {
  generateMouseTrajectory,
  MAX_MOUSE_TRAJECTORY_SAMPLES,
  MIN_MOUSE_TRAJECTORY_SAMPLES,
  MOUSE_ARC_LENGTH_SEGMENTS,
} from './mouse.js';
export { generateTouchEvent, TOUCH_DISTRIBUTIONS } from './touch.js';
export {
  generateScrollVelocityProfile,
  MIN_TICK_INTERVAL_MS,
  SCROLL_VELOCITY_DEFAULTS,
} from './scroll.js';

export type {
  ClickRegion,
  DwellShape,
  GenerateRegionAwareTouchOpts,
  RegionAwareTouchEvent,
} from './dwell.js';
export {
  CLICK_REGIONS,
  DWELL_SHAPES,
  generateRegionAwareTouchEvent,
  MAX_CLICK_REGIONS,
} from './dwell.js';

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
export {
  generateIdlePeriod,
  generateIdleSequence,
  IDLE_DEFAULTS,
  MAX_IDLE_SEQUENCE_ENTRIES,
} from './idle.js';

// V-530.F — keyboard cadence generator (human-realistic typing rhythm).
export type { KeyboardCadenceDefaults } from './keyboard.js';
export { generateKeyboardCadence, KEYBOARD_CADENCE_DEFAULTS, MAX_TEXT_LENGTH } from './keyboard.js';

// V-530.G — canonical behavioural persona catalogue (file 05 §"Persona model").
export type { PersonaId } from './profiles.js';
export { DEFAULT_PERSONA_ID, getProfile, listProfiles, PROFILE_CATALOGUE } from './profiles.js';

// V-530.H — typo-aware typing sequence (file 05 §"Typing behavior").
export type {
  GenerateTypingSequenceOpts,
  KeystrokeEvent,
  TypingSequence,
} from './typing-sequence.js';
export {
  DEFAULT_TYPO_PROBABILITY,
  generateTypingSequence,
  MAX_TYPING_REPLAY_EVENTS,
  MAX_TYPING_REPLAY_INSERTED_CODE_UNITS,
  replayTypingSequence,
} from './typing-sequence.js';

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
  MAX_INTERLEAVED_SAMPLES,
  MAX_INTERLEAVE_FINGERS,
  MAX_SAMPLES_PER_FINGER,
} from './multi-touch.js';
