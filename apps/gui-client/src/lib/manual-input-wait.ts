// A session that is not interactive YET must say which signal it is waiting for.
//
// Owner report 2026-09-16: an OpenVPN session opened, the first page painted, and
// the cockpit then sat on the word "connecting" until the customer closed it 33
// seconds later, never having taken control of the phone. Every unmet part of the
// manual-input predicate rendered that same word, so neither the customer nor we
// could tell a screen that never arrived from a session that never went active
// from a phone that never said it accepts taps. The wait was real; the statement
// about it was missing.
//
// This module is `ownsManualInputAuthority` (views/SimulatorWindow.tsx) read the
// other way round: the SAME inputs, and instead of one boolean it answers which
// group of conjuncts is unmet, in priority order, plus the one plain sentence a
// customer should read for it.
//
// ⛔ It unlocks NOTHING. `ownsManualInputAuthority` stays the only gate on input
// and navigation, unchanged and no looser; this module only describes the wait.
// The two therefore agree by construction in one direction, which is the property
// its guards pin: every state that predicate refuses returns a group here, and a
// fully satisfied state returns null (the vacuity control).
//
// Copy rules (customer-facing): plain words, what is happening and what the
// customer can do. No internal vocabulary — no capability report, no LiveKit, no
// publisher, no data channel, no node, no epoch — and no ticket ids.

import type { SessionMode } from './agent-session-control';
import {
  MANUAL_INPUT_UNAVAILABLE_BADGE,
  MANUAL_INPUT_UNREPORTED_BADGE,
  MANUAL_INPUT_UNREPORTED_TOOLTIP,
  manualInputCapabilityFromFlag,
} from './manual-input-capability';

/**
 * Which group of conjuncts is unmet. The three producers behind the predicate
 * (transport, the session read, the phone's own report) fail in distinguishable
 * ways, and each way is its own group:
 *
 *  - `ended`                 the session reached a terminal end — nothing is coming.
 *  - `stream`                (a) not connected to this session's live view yet.
 *  - `stream-reconnecting`   (a) the connection dropped and is coming back.
 *  - `stream-lost`           (a) the connection is down or failed — not "in a moment".
 *  - `screen`                (b) connected, but the phone's screen has not arrived.
 *  - `screen-blank`          (b) the device reported it is up but showing no video.
 *  - `screen-failed`         (b) the device reported its video FAILED to start.
 *  - `local`                 (f) a control action / mutation of our own is in flight.
 *  - `session-unreadable`    (c) the read of this session's state FAILED.
 *  - `session-unconfirmed`   (c) we have not read this session's state yet.
 *  - `session-paused`        (c) read, and it is paused — a person has to resume it.
 *  - `session-inactive`      (c) read, and it has not started.
 *  - `session-agent-driving` (c) read and running, but the agent holds the controls.
 *  - `input-unreported`      (d) the phone has not reported that input is available.
 *  - `input-unavailable`     (e) the phone reported input UNAVAILABLE (explicit false).
 *
 * ⛔ Three of these are SPLITS of a group that used to answer for several states
 * at once, each one a promise the product had already contradicted on the same
 * screen: a dead transport read "Connecting… this usually takes a few seconds"
 * beside a Reconnect button; a device whose video FAILED read "waiting for the
 * phone's screen to arrive" beside "The device could not start its video."; and
 * a control read that FAILED read "Checking this session's status…" beside a
 * "can't reach this session — Retry". A wait that keeps promising an arrival the
 * product has already ruled out is this item's own defect one layer in: it is
 * still one word for several states, just a politer word.
 */
export type ManualInputWaitGroup =
  | 'ended'
  | 'stream'
  | 'stream-reconnecting'
  | 'stream-lost'
  | 'screen'
  | 'screen-blank'
  | 'screen-failed'
  | 'screen-capture-blocked'
  | 'local'
  | 'session-unreadable'
  | 'session-unconfirmed'
  | 'session-paused'
  | 'session-inactive'
  | 'session-agent-driving'
  | 'input-unreported'
  | 'input-unavailable';

/**
 * Exactly the inputs `ownsManualInputAuthority` reads, spelled as plain values so
 * the derivation is pure and unit-testable without a Room, a store or a render.
 */
export interface ManualInputWaitInputs {
  /** The window's session id; '' before a session exists. */
  sessionId: string;
  /** A live transport object is bound to this window (`room !== null`). */
  roomPresent: boolean;
  /** The window's binding names THIS session and that same transport object. */
  roomBound: boolean;
  /** The transport's connection state; 'connected' is the one that unlocks. */
  connState: string;
  /** Whether the phone's video is arriving; 'publishing' is the one that unlocks. */
  publisherState: string;
  /** The device's OWN verdict on its video, from its report: 'failed' / 'blank'
   *  are answers we already have, not screens still on the way. undefined/null =
   *  it has not said, which is the ordinary pre-arrival wait. */
  streamingState: string | null | undefined;
  /** The control snapshot belongs to this session and to the current authority epoch. */
  authorityCurrent: boolean;
  /** The session's control mode, null while unknown. */
  mode: SessionMode | null;
  /** The mode above came from an authoritative read (not an optimistic guess). */
  modeConfirmed: boolean;
  /** The lifecycle fields below came from an authoritative read. */
  lifecycleConfirmed: boolean;
  /** ⛔ The last read of this session's state FAILED (and nothing has succeeded
   *  since). The window sets `modeConfirmed`/`lifecycleConfirmed` to false on
   *  every control-read rejection, which is indistinguishable from "we have not
   *  read it yet" unless the failure itself is passed in — and the failing path
   *  does not retry, so "checking…" would be a check that is not happening. */
  controlReadFailed: boolean;
  /** The session reached a terminal lifecycle state. */
  lifecycleTerminal: boolean;
  /** The session's lifecycle status; 'active' is the one that unlocks. */
  lifecycleStatus: string | null;
  /** The phone's own verdict: true = input available, false = view only,
   *  null/undefined = it has not said (no report, or the field absent). */
  manualInputAvailable: boolean | null | undefined;
  /** An optimistic control mutation is in flight. */
  mutationPending: boolean;
  /** A control action (mode switch / takeover / handback / end) is in flight. */
  controlActionPending: boolean;
  /** This window latched a terminal session end. */
  sessionEnded: boolean;
}

export interface ManualInputWait {
  group: ManualInputWaitGroup;
  /** The full sentence: tooltips, the on-screen advisory, the full-screen spinner. */
  sentence: string;
  /** The short label for the inline chips beside the address field. */
  chip: string;
  /** The locked address field's placeholder. */
  placeholder: string;
  /** True while the phone's screen itself is not on the glass yet — the states the
   *  full-screen spinner is allowed to speak for. */
  awaitingScreen: boolean;
}

/**
 * The one sentence per group. `input-unavailable` deliberately reuses the wording
 * the view-only badge and its tooltip already ship, so the explicit-false case
 * reads exactly as it does today.
 */
export const MANUAL_INPUT_WAIT_COPY: Readonly<
  Record<ManualInputWaitGroup, Omit<ManualInputWait, 'group'>>
> = {
  ended: {
    sentence: 'This session has ended.',
    chip: 'session ended',
    placeholder: 'this session has ended',
    awaitingScreen: false,
  },
  stream: {
    sentence: 'Connecting to the phone — this usually takes a few seconds.',
    chip: 'connecting…',
    // Unchanged wording: this group IS the state that sentence has always described.
    placeholder: 'connecting… — the address bar unlocks once the device is live',
    awaitingScreen: true,
  },
  // ⛔ The transport's own words, not new ones: the full-screen overlay over the
  // video is up at the same moment (components/AgentSessionPanel.tsx), and two
  // surfaces describing one dropped connection differently is the defect again.
  'stream-reconnecting': {
    sentence: 'Connection dropped — reconnecting…',
    chip: 'reconnecting…',
    placeholder: 'reconnecting… — the address bar unlocks once the phone is back',
    awaitingScreen: true,
  },
  'stream-lost': {
    sentence: 'The live view isn’t connected — try reconnecting, or reopen the session.',
    chip: 'not connected',
    placeholder: 'not connected — try reconnecting, or reopen the session',
    awaitingScreen: false,
  },
  screen: {
    sentence: 'Connected — waiting for the phone’s screen to arrive.',
    chip: 'waiting for the screen…',
    placeholder: 'waiting for the phone’s screen… — the address bar unlocks once it arrives',
    awaitingScreen: true,
  },
  // ⛔ (b) when the device has ALREADY ANSWERED about its video. Both sentences are
  // the video overlay's own, verbatim (views/SimulatorWindow.tsx's
  // `streaming-capability-error`), because both are on screen at the same time: the
  // chip may not promise an arrival the device has ruled out.
  'screen-blank': {
    sentence: 'The device is connected, but no video is showing.',
    chip: 'no video showing',
    placeholder: 'no video is showing — the address bar stays locked',
    awaitingScreen: false,
  },
  'screen-failed': {
    sentence: 'The device could not start its video.',
    chip: 'video didn’t start',
    placeholder: 'the phone’s video didn’t start — the address bar stays locked',
    awaitingScreen: false,
  },
  /**
   * ⛔ NOT A FLAVOUR OF `screen-failed`, and the device is explicit about the
   * difference — it reports this state only for a real permission revocation,
   * "distinct from transient failed". Collapsing the two would tell a customer
   * something transient happened and invite them to retry, when the video is
   * guaranteed black until somebody with access to the machine acts.
   *
   * ⚠️ The sentence says whose it is and does NOT suggest a retry. This is the
   * same rule the crash-memory and egress-verification sentences follow: where
   * retrying cannot help, saying "try again" is a second wrong instruction handed
   * to someone who will have already tried.
   */
  'screen-capture-blocked': {
    sentence:
      'The phone’s screen can’t be captured at the moment. This one is ours, not your setup, and retrying will not clear it.',
    chip: 'screen capture blocked',
    placeholder: 'the phone’s screen can’t be captured — the address bar stays locked',
    awaitingScreen: false,
  },
  local: {
    sentence: 'Finishing the last change to this session — one moment.',
    chip: 'finishing the last change…',
    placeholder: 'finishing the last change… — the address bar unlocks in a moment',
    awaitingScreen: false,
  },
  // ⛔ A read that FAILED is not a check in progress. The failing path fails
  // closed and does not retry, so "checking…" describes a check nobody is
  // running — and the Session pane already says the link is unreachable and
  // offers Retry, in the same render, about the same session.
  'session-unreadable': {
    sentence:
      'We can’t reach this session right now — try again in a moment, or reopen the session.',
    chip: 'can’t reach this session',
    placeholder: 'can’t reach this session — try again, or reopen it',
    awaitingScreen: false,
  },
  'session-unconfirmed': {
    sentence: 'Checking this session’s status…',
    chip: 'checking the session…',
    placeholder: 'checking this session… — the address bar unlocks once it is ready',
    awaitingScreen: false,
  },
  // ⛔ PAUSED IS NOT PRE-START. A paused session HAS started and will NOT start on
  // its own: the device stops on a bot challenge and stays stopped until a person
  // resumes it. "isn't running yet — once it starts" is false twice over, and it
  // tells the customer to wait when the session is waiting on THEM.
  'session-paused': {
    sentence: 'This session is paused — resume it to take control.',
    chip: 'session paused',
    placeholder: 'this session is paused — resume it to take control',
    awaitingScreen: false,
  },
  'session-inactive': {
    sentence: 'This session isn’t running yet — the phone takes taps once it starts.',
    chip: 'session not running yet',
    placeholder: 'this session isn’t running yet — the address bar unlocks once it starts',
    awaitingScreen: false,
  },
  'session-agent-driving': {
    sentence: 'The agent is driving this session — switch to Manual to take control.',
    chip: 'the agent is driving',
    placeholder: 'the agent is driving — switch to Manual to take control',
    awaitingScreen: false,
  },
  // ⛔ (d) and (e) do NOT get their own words here. lib/manual-input-capability.ts
  // already owns the tri-state and the copy every surface speaks it with (the two
  // on-screen badges, the keyboard tooltip, the mode caption); an address bar that
  // re-worded the same two facts would let the chip and the badge over the same
  // session disagree. These two entries are that module's copy, re-used verbatim.
  'input-unreported': {
    sentence: MANUAL_INPUT_UNREPORTED_TOOLTIP,
    chip: 'waiting on the phone…',
    placeholder: MANUAL_INPUT_UNREPORTED_BADGE,
    awaitingScreen: false,
  },
  'input-unavailable': {
    sentence: 'This session is view only because device input is unavailable',
    chip: MANUAL_INPUT_UNAVAILABLE_BADGE,
    placeholder: MANUAL_INPUT_UNAVAILABLE_BADGE,
    awaitingScreen: false,
  },
};

/**
 * Which group is unmet, or null when every conjunct holds.
 *
 * Priority, and why it is this order:
 *  1. `ended` — once the session is over, no other wait is a wait; it is an outcome.
 *  2. the transport groups then the screen groups — the transport is upstream of
 *     everything else, and a
 *     control snapshot read while nothing is connected describes a phone we cannot
 *     reach anyway.
 *  3. `local` — OUR OWN mutation is in flight and is about to change the very
 *     answers below it (a mode switch deliberately un-confirms the snapshot), so
 *     "finishing the last change" beats reporting the state it is mid-way through.
 *  4. the session groups — what the control plane says about this session.
 *  5. the input groups — what the phone itself says. Last because the phone can
 *     only be asked about a session that is connected, running and ours.
 */
export function manualInputWaitGroup(i: ManualInputWaitInputs): ManualInputWaitGroup | null {
  if (i.sessionEnded || i.lifecycleTerminal) return 'ended';
  // ⛔ The transport's state is read by VALUE, not as `!== 'connected'`. A dropped
  // connection and a failed one are not a connection in progress, and the word
  // "connecting" over either is a promise nothing behind it is keeping. Checked
  // before the binding tests because a failed connect leaves the binding in place.
  if (i.connState === 'reconnecting') return 'stream-reconnecting';
  if (i.connState === 'disconnected' || i.connState === 'error') return 'stream-lost';
  if (i.sessionId === '' || !i.roomPresent || !i.roomBound || i.connState !== 'connected')
    return 'stream';
  if (i.publisherState !== 'publishing') {
    // Checked BEFORE 'failed': the device distinguishes a permission revocation
    // from a transient failure, and this is the one that no retry clears.
    if (i.streamingState === 'permission_denied') return 'screen-capture-blocked';
    if (i.streamingState === 'failed') return 'screen-failed';
    if (i.streamingState === 'blank') return 'screen-blank';
    return 'screen';
  }
  if (i.mutationPending || i.controlActionPending) return 'local';
  if (!i.authorityCurrent || !i.lifecycleConfirmed || !i.modeConfirmed || i.mode === null)
    // Same unmet conjunct, two different facts: nobody has answered yet, or the
    // answer came back an error. Only the second is something the customer can act
    // on, and only the second is a state that does not clear itself.
    return i.controlReadFailed ? 'session-unreadable' : 'session-unconfirmed';
  if (i.lifecycleStatus === 'paused') return 'session-paused';
  if (i.lifecycleStatus !== 'active') return 'session-inactive';
  // Mirrors `isHumanControlMode`: manual is the only mode that hands the customer
  // the controls. 'pair' is the agent's to grant, so it reads as agent-driven here.
  if (i.mode !== 'manual') return 'session-agent-driving';
  // ⛔ The tri-state is read from lib/manual-input-capability, never re-spelled as
  // `=== false` / `!== true` here: an absent report and an explicit "no" are
  // different facts and must stay different groups on every surface.
  const capability = manualInputCapabilityFromFlag(i.manualInputAvailable);
  if (capability === 'unavailable') return 'input-unavailable';
  if (capability === 'unreported') return 'input-unreported';
  return null;
}

/** The group plus its customer copy, or null when the session is fully interactive. */
export function describeManualInputWait(i: ManualInputWaitInputs): ManualInputWait | null {
  const group = manualInputWaitGroup(i);
  return group === null ? null : { group, ...MANUAL_INPUT_WAIT_COPY[group] };
}
