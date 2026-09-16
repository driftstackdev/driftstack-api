// ITEM 1 (owner report, live 2026-09-16) — an OpenVPN session opened, the first page
// painted, and the cockpit then said "connecting" until the customer closed it 33
// seconds later, never having taken control of the phone. The control plane showed the
// node reporting normally throughout.
//
// The defect guarded here is not the cause of that wait: it is that the wait had ONE
// word for six different unmet signals. `ownsManualInputAuthority` (SimulatorWindow) is
// a 13-way AND over three independent producers, and every unmet conjunct rendered the
// same "connecting…" — so a missing screen, a session that never went active, an agent
// still driving and a phone that never reported were indistinguishable to the customer
// AND to us.
//
// `lib/manual-input-wait.ts` is that predicate read the other way round: same inputs,
// answering WHICH group is unmet plus the sentence a customer should read. These guards
// pin four properties:
//
//   1. every group is reachable and says something DIFFERENT from every other group;
//   2. a fully satisfied predicate says nothing at all (the vacuity control — without
//      it a derivation that always returned a sentence would pass every other test);
//   3. flipping ANY single conjunct off yields a group — the derivation never goes
//      quiet on a state the predicate refuses, which is the defect itself;
//   4. the copy stays customer-facing: no internal vocabulary, no ticket ids, and the
//      two input groups keep lib/manual-input-capability's shared wording.

import { describe, expect, it } from 'vitest';

import {
  MANUAL_INPUT_UNAVAILABLE_BADGE,
  MANUAL_INPUT_UNREPORTED_BADGE,
  MANUAL_INPUT_UNREPORTED_TOOLTIP,
} from '../../src/lib/manual-input-capability';
import {
  MANUAL_INPUT_WAIT_COPY,
  describeManualInputWait,
  manualInputWaitGroup,
  type ManualInputWaitGroup,
  type ManualInputWaitInputs,
} from '../../src/lib/manual-input-wait';

/** Every conjunct satisfied — the state in which the address bar and remote control
 *  are BOTH unlocked. Each case below flips exactly one thing off it. */
function live(): ManualInputWaitInputs {
  return {
    sessionId: 'agt_live',
    roomPresent: true,
    roomBound: true,
    connState: 'connected',
    publisherState: 'publishing',
    streamingState: 'live',
    authorityCurrent: true,
    mode: 'manual',
    modeConfirmed: true,
    lifecycleConfirmed: true,
    controlReadFailed: false,
    lifecycleTerminal: false,
    lifecycleStatus: 'active',
    manualInputAvailable: true,
    mutationPending: false,
    controlActionPending: false,
    sessionEnded: false,
  };
}

/** The fixture for each group, and the one thing it changes. */
const FIXTURES: ReadonlyArray<{
  group: ManualInputWaitGroup;
  patch: Partial<ManualInputWaitInputs>;
}> = [
  { group: 'ended', patch: { sessionEnded: true } },
  { group: 'stream', patch: { connState: 'connecting' } },
  { group: 'stream-reconnecting', patch: { connState: 'reconnecting' } },
  { group: 'stream-lost', patch: { connState: 'error' } },
  { group: 'screen', patch: { publisherState: 'waiting' } },
  { group: 'screen-blank', patch: { publisherState: 'waiting', streamingState: 'blank' } },
  { group: 'screen-failed', patch: { publisherState: 'waiting', streamingState: 'failed' } },
  { group: 'local', patch: { controlActionPending: true } },
  {
    group: 'session-unreadable',
    patch: { lifecycleConfirmed: false, controlReadFailed: true },
  },
  { group: 'session-unconfirmed', patch: { lifecycleConfirmed: false } },
  { group: 'session-paused', patch: { lifecycleStatus: 'paused' } },
  { group: 'session-inactive', patch: { lifecycleStatus: 'provisioning' } },
  { group: 'session-agent-driving', patch: { mode: 'ai' } },
  { group: 'input-unreported', patch: { manualInputAvailable: null } },
  { group: 'input-unavailable', patch: { manualInputAvailable: false } },
];

describe('which signal a not-yet-interactive session is waiting for', () => {
  it('CRITICAL every group is reachable from its own fixture and each says something DIFFERENT — the owner could not tell a missing screen from a phone that never reported, because all six rendered the word "connecting" (MUTATION: give two groups the same sentence → red)', () => {
    const seen = new Map<ManualInputWaitGroup, string>();
    for (const { group, patch } of FIXTURES) {
      const wait = describeManualInputWait({ ...live(), ...patch });
      expect(wait, `${group} must produce a wait`).not.toBeNull();
      expect(wait?.group, JSON.stringify(patch)).toBe(group);
      seen.set(group, wait?.sentence ?? '');
    }
    expect(seen.size).toBe(FIXTURES.length);
    // Distinct on all three surfaces — a shared sentence with a distinct group token
    // is exactly the defect (one word, six states) wearing a type.
    for (const field of ['sentence', 'chip', 'placeholder'] as const) {
      const values = FIXTURES.map(
        ({ patch }) => describeManualInputWait({ ...live(), ...patch })?.[field] ?? '',
      );
      expect(
        new Set(values).size,
        `${field} must be distinct per group: ${values.join(' | ')}`,
      ).toBe(FIXTURES.length);
      for (const value of values) expect(value.length).toBeGreaterThan(0);
    }
  });

  it('CRITICAL VACUITY CONTROL — a fully satisfied predicate waits for nothing and says nothing (MUTATION: return a wait unconditionally → red)', () => {
    expect(describeManualInputWait(live())).toBeNull();
    expect(manualInputWaitGroup(live())).toBeNull();
  });

  it('CRITICAL flipping ANY single conjunct off yields a group — the derivation is never silent on a state the gate refuses (MUTATION: drop one branch, e.g. the mode check → red)', () => {
    const flips: ReadonlyArray<Partial<ManualInputWaitInputs>> = [
      { sessionId: '' },
      { roomPresent: false },
      { roomBound: false },
      { connState: 'reconnecting' },
      { connState: 'disconnected' },
      { connState: 'error' },
      { publisherState: 'waiting' },
      { publisherState: 'none' },
      { authorityCurrent: false },
      { mode: null },
      { mode: 'ai' },
      { mode: 'pair' },
      { modeConfirmed: false },
      { lifecycleConfirmed: false },
      { lifecycleTerminal: true },
      { lifecycleStatus: null },
      { lifecycleStatus: 'provisioning' },
      { lifecycleStatus: 'paused' },
      { lifecycleStatus: 'closed' },
      { manualInputAvailable: false },
      { manualInputAvailable: null },
      { manualInputAvailable: undefined },
      { mutationPending: true },
      { controlActionPending: true },
      { sessionEnded: true },
    ];
    for (const patch of flips) {
      const wait = describeManualInputWait({ ...live(), ...patch });
      expect(wait, `silent on ${JSON.stringify(patch)}`).not.toBeNull();
      expect(wait?.sentence.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('priority is transport → our own in-flight change → the session → the phone: a deeper blocker is reported over a shallower one it makes unknowable (MUTATION: test the phone before the transport → red)', () => {
    // Nothing is connected AND nothing is reported: the phone cannot have answered
    // about a session we are not connected to, so "connecting" is the honest word.
    expect(
      manualInputWaitGroup({
        ...live(),
        connState: 'connecting',
        publisherState: 'waiting',
        manualInputAvailable: null,
        lifecycleStatus: 'provisioning',
      }),
    ).toBe('stream');
    // Connected, no screen yet, and the session read has not landed — the screen wins.
    expect(
      manualInputWaitGroup({ ...live(), publisherState: 'waiting', lifecycleConfirmed: false }),
    ).toBe('screen');
    // ⛔ A mode switch deliberately un-confirms the snapshot while it is in flight, so
    // "checking this session" would blame the read for our own pending change.
    expect(
      manualInputWaitGroup({ ...live(), mutationPending: true, modeConfirmed: false, mode: 'ai' }),
    ).toBe('local');
    // A terminal end outranks everything: it is an outcome, not a wait.
    expect(
      manualInputWaitGroup({ ...live(), lifecycleTerminal: true, connState: 'connecting' }),
    ).toBe('ended');
  });

  it('CRITICAL the phone’s three answers stay three: an ABSENT report is never the device’s "no" (MUTATION: fold unreported into unavailable → red)', () => {
    for (const absent of [null, undefined]) {
      const wait = describeManualInputWait({ ...live(), manualInputAvailable: absent });
      expect(wait?.group, String(absent)).toBe('input-unreported');
      // The shared copy from lib/manual-input-capability, verbatim — the chip, the
      // badge and the keyboard tooltip must not word the same fact differently.
      expect(wait?.sentence).toBe(MANUAL_INPUT_UNREPORTED_TOOLTIP);
      expect(wait?.placeholder).toBe(MANUAL_INPUT_UNREPORTED_BADGE);
    }
    const explicit = describeManualInputWait({ ...live(), manualInputAvailable: false });
    expect(explicit?.group).toBe('input-unavailable');
    expect(explicit?.chip).toBe(MANUAL_INPUT_UNAVAILABLE_BADGE);
    expect(explicit?.sentence).toBe(
      'This session is view only because device input is unavailable',
    );
  });

  it('only the two transport groups claim the screen is not up yet — the spinner over the video speaks for those and no others', () => {
    const awaiting = FIXTURES.filter(
      ({ patch }) => describeManualInputWait({ ...live(), ...patch })?.awaitingScreen === true,
    ).map(({ group }) => group);
    // ⛔ NOT the states the device has already ANSWERED about (a failed or blank
    // video, a dead transport): a spinner there is a promise of an arrival we have
    // been told is not coming.
    expect(awaiting).toEqual(['stream', 'stream-reconnecting', 'screen']);
  });

  it('CRITICAL a control read that FAILED is not a check in progress — the state that never clears itself says so (MUTATION: ignore controlReadFailed → "Checking this session’s status…" forever → red)', () => {
    // The window blanks modeConfirmed/lifecycleConfirmed on EVERY control-read
    // rejection and raises its own "we cannot reach this session" at the same
    // moment. Given only the blanked fields, the derivation cannot tell that from a
    // first load — and the failing paths do not retry, so "checking…" describes a
    // check nobody is running, beside the pane's own Retry.
    const failed = describeManualInputWait({
      ...live(),
      lifecycleConfirmed: false,
      modeConfirmed: false,
      mode: null,
      controlReadFailed: true,
    });
    expect(failed?.group).toBe('session-unreadable');
    expect(failed?.sentence).not.toBe(MANUAL_INPUT_WAIT_COPY['session-unconfirmed'].sentence);
    expect(failed?.sentence).toMatch(/try again|reopen/i);
    // The genuine first load — no error yet — keeps the "checking" wording.
    expect(describeManualInputWait({ ...live(), lifecycleConfirmed: false })?.group).toBe(
      'session-unconfirmed',
    );
    // And a read failure alone, on a session whose snapshot IS confirmed, is not a
    // wait at all: the bar is unlocked and the pane's badge speaks for it.
    expect(manualInputWaitGroup({ ...live(), controlReadFailed: true })).toBeNull();
  });

  it('CRITICAL the transport’s five states are not one promise — a dropped or failed connection never says "this usually takes a few seconds" (MUTATION: collapse back to connState !== "connected" → red)', () => {
    const sentenceFor = (connState: string): string =>
      describeManualInputWait({ ...live(), connState })?.sentence ?? '';
    // Only the two states that really ARE a connection in progress keep that copy.
    expect(sentenceFor('idle')).toBe(MANUAL_INPUT_WAIT_COPY.stream.sentence);
    expect(sentenceFor('connecting')).toBe(MANUAL_INPUT_WAIT_COPY.stream.sentence);
    for (const dead of ['reconnecting', 'disconnected', 'error']) {
      expect(sentenceFor(dead), dead).not.toBe(MANUAL_INPUT_WAIT_COPY.stream.sentence);
      expect(sentenceFor(dead), dead).not.toMatch(/usually takes a few seconds/);
    }
    expect(sentenceFor('disconnected')).toBe(sentenceFor('error'));
    expect(sentenceFor('reconnecting')).not.toBe(sentenceFor('disconnected'));
    expect(
      new Set(['idle', 'connecting', 'reconnecting', 'disconnected', 'error'].map(sentenceFor))
        .size,
    ).toBe(3);
  });

  it('CRITICAL a PAUSED session has started and will not restart on its own — it is never described as one that has not started yet (MUTATION: drop the paused branch → the "isn’t running yet" sentence → red)', () => {
    const paused = describeManualInputWait({ ...live(), lifecycleStatus: 'paused' });
    expect(paused?.group).toBe('session-paused');
    expect(paused?.sentence).not.toBe(MANUAL_INPUT_WAIT_COPY['session-inactive'].sentence);
    expect(paused?.sentence).not.toMatch(/isn’t running yet|once it starts/);
    // It waits on the PERSON, so it says what they do about it.
    expect(paused?.sentence).toMatch(/resume/i);
    // The genuine pre-start statuses keep the "isn’t running yet" wording.
    for (const pre of ['creating', 'provisioning', null]) {
      expect(describeManualInputWait({ ...live(), lifecycleStatus: pre })?.group, String(pre)).toBe(
        'session-inactive',
      );
    }
  });

  it('CRITICAL a device that REPORTED its video failed is never told its screen is on the way (MUTATION: key the screen group on publisherState alone → red)', () => {
    const noScreen = { publisherState: 'waiting' } as const;
    const failed = describeManualInputWait({ ...live(), ...noScreen, streamingState: 'failed' });
    expect(failed?.group).toBe('screen-failed');
    expect(failed?.sentence).not.toBe(MANUAL_INPUT_WAIT_COPY.screen.sentence);
    expect(failed?.sentence).not.toMatch(/waiting for|arrive/i);
    const blank = describeManualInputWait({ ...live(), ...noScreen, streamingState: 'blank' });
    expect(blank?.group).toBe('screen-blank');
    expect(blank?.sentence).not.toBe(failed?.sentence);
    // No answer from the device yet — the ordinary pre-arrival wait is unchanged.
    for (const quiet of ['provisioning', 'live', null, undefined]) {
      expect(
        describeManualInputWait({ ...live(), ...noScreen, streamingState: quiet })?.group,
        String(quiet),
      ).toBe('screen');
    }
  });

  it('the copy is customer-facing: no internal vocabulary and no ticket ids anywhere in the table', () => {
    // The words this product's internals use for these signals. A sentence carrying
    // one of them is engineering shorthand shown to a paying customer.
    const forbidden =
      /capability report|livekit|publisher|conjunct|data ?channel|harness|epoch|room|track|\bnode\b|\bW\d{3,}\b|\bV-\d+\b/i;
    for (const [group, copy] of Object.entries(MANUAL_INPUT_WAIT_COPY)) {
      for (const field of ['sentence', 'chip', 'placeholder'] as const) {
        expect(copy[field], `${group}.${field}`).not.toMatch(forbidden);
      }
    }
  });
});
