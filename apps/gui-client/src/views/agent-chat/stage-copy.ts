// What the stage SAYS — the chip, the note, the caption under the phone, the
// start-up beats and the one fact about where the phone is browsing.
//
// Stage 4 of the AI-view rebuild (spec §3.4). Every one of these is a pure
// function over plain data, for the reason `mission-phase.ts` gives: the stage
// answers "what is it doing" from four independent sources (the chat, the
// session lifecycle, whether WE are watching a stream, and whether the
// deployment can run browser actions at all), and four places deriving that
// separately is how a header came to show a green "Session open" beside a red
// "Stopped at step 3". One derivation, unit-tested without a DOM.
//
// ⚠️ EVERY read is optional-chained: about a dozen view tests mock the chat hook
// with a partial object, and an absent field must produce copy, never a throw.
//
// ⛔ AN ABSENCE IS RENDERED AS AN ABSENCE. `browsingFrom` returns null when the
// device has not reported where it is; the caption falls back to the phase word
// only when the plan has no caption for the step. Nothing here invents a place,
// a step name or a number — the stage sits beside a live video of the thing it
// is describing, so a guess is visible as a guess.

import type { AgentIntentResult } from '@driftstack/sdk';
import type { ChatTurn, LivePlan } from '../../lib/use-agent-chat';
import type { MissionPhase } from './mission-phase';

/**
 * What the live pane is doing, as ONE word, reported upward by
 * `LiveAutomationPanel` (spec §3.4: the panel keeps `React.memo` and primitive
 * props, so it hands the stage a string rather than its whole state).
 *
 * `ended` is the panel's terminal-end LATCH, not a watch state of its own: the
 * stream is still nominally live and the panel is showing its "Session ended"
 * overlay. It is folded in here so the stage has one thing to switch on.
 */
export type StageWatch = 'idle' | 'loading' | 'live' | 'simulated' | 'error' | 'ended';

/** The lifecycle of the chat's session, as far as the stage cares: is a device
 *  still being found for it? Spec §3.4's "session provisioning" row. */
export type StageSessionState = 'none' | 'provisioning' | 'open' | 'ended';

export type StageChipTone = 'quiet' | 'warm' | 'live' | 'hold' | 'open';
/** What sits inside the chip before its word: a coloured dot, a pause glyph, or
 *  nothing. The dot beats ONLY in the `live` tone (spec §4 item 13). */
export type StageChipMark = 'pip' | 'pip-beat' | 'pip-ready' | 'pause';

export interface StageHud {
  /** The chip's word. Upper case in the DOM, as the mockup draws it — it is a
   *  state name, and the text gate measures it as real text. */
  chip: string;
  tone: StageChipTone;
  mark: StageChipMark;
  /** The sentence beside the chip. Never a live region: it duplicates the log. */
  note: string;
}

export interface StageInput {
  /** The deployment cannot carry out browser actions at all (`agent_execution`
   *  is `simulated`). Outranks everything: there is no iPhone to promise. */
  preview?: boolean;
  watch?: StageWatch;
  session?: StageSessionState;
  sending?: boolean;
  /** A decision is pending — the stage is holding. */
  gated?: boolean;
  /** The last agent turn went wrong (phase `trouble`), so an open session does
   *  not get the green pip. */
  trouble?: boolean;
}

/**
 * The chip and the note (spec §3.4's table).
 *
 * The table is a list of conditions, and conditions overlap — a paused chat on
 * a live stream matches three rows. This is the precedence, most important
 * first, each one a thing the customer needs to know MORE than the next:
 *
 *   1. preview   — there is no live iPhone here at all.
 *   2. ended     — the session this chat ran on is over; nothing else is true
 *                  of it any more.
 *   3. paused    — a decision is waiting. This is the one state a customer must
 *                  not miss, so it outranks the stream's own state.
 *   4. error     — we cannot show the stream, and saying "LIVE" would be false.
 *   5. live      — a stream is up and the AI is driving it.
 *   6. starting  — something is coming up.
 *   7. open      — a stream is up and nothing is running on it.
 *   8. standby   — nothing is happening.
 */
export function stageHud(input: StageInput): StageHud {
  const watch = input.watch ?? 'idle';
  if (input.preview === true || watch === 'simulated') {
    return { chip: 'PREVIEW', tone: 'warm', mark: 'pip', note: 'Live view' };
  }
  if (watch === 'ended' || input.session === 'ended') {
    return { chip: 'ENDED', tone: 'quiet', mark: 'pip', note: 'Read-only' };
  }
  if (input.gated === true) {
    return {
      chip: 'PAUSED',
      tone: 'hold',
      mark: 'pause',
      note: 'Nothing moves until you decide',
    };
  }
  if (watch === 'error') {
    return { chip: 'UNAVAILABLE', tone: 'quiet', mark: 'pip', note: 'Live view' };
  }
  if (watch === 'live' && input.sending === true) {
    return {
      chip: 'LIVE',
      tone: 'live',
      mark: 'pip-beat',
      note: 'Read-only — the AI is driving',
    };
  }
  if (input.sending === true || input.session === 'provisioning' || watch === 'loading') {
    return { chip: 'STARTING', tone: 'warm', mark: 'pip', note: 'Getting the iPhone ready' };
  }
  if (watch === 'live') {
    return {
      chip: 'SESSION OPEN',
      tone: 'open',
      mark: input.trouble === true ? 'pip' : 'pip-ready',
      note: 'Read-only',
    };
  }
  return { chip: 'STANDBY', tone: 'quiet', mark: 'pip', note: 'Live view' };
}

/** True while the start-up strip replaces the caption (spec §3.4). */
export function stageIsStarting(hud: StageHud): boolean {
  return hud.chip === 'STARTING';
}

export interface StageCaption {
  /** The lead-in, or null when the caption is a two-line idle block. */
  lead: string | null;
  /** The bold half — the thing to read. */
  subject: string;
  /** The second line, idle/preview only. */
  body?: string;
  /** Which glyph goes in front, if any. */
  icon: 'tap' | 'pause' | 'check' | null;
  /** The two-line, centred idle form. */
  idle: boolean;
  /**
   * May the stage's one sentence about what WATCHING MEANS ("You watch, the AI
   * drives — and you can stop it at any time.") follow this caption?
   *
   * ⛔ IT IS NOT THE SAME QUESTION AS `idle`, AND IT USED TO BE. One boolean
   * answered two: "draw the centred two-line block" (a look) and "the promise
   * about watching still holds" (a fact). They agree in every state but one —
   * PREVIEW, which is a resting caption whose whole content is that there is
   * nothing to watch — and the `preview` scene showed the consequence the day
   * it existed: "Live view unavailable · Browser actions run in preview mode,
   * so there is no live view." with "You watch, the AI drives" underneath it.
   * Splitting them also lets the facts row mark itself EMPTY in preview, which
   * `idle` was keeping it from doing (see `data-empty` in Stage).
   */
  reassure: boolean;
}

export interface CaptionInput {
  phase?: MissionPhase;
  preview?: boolean;
  /** The plan the turn is running, for the step's own caption. */
  livePlan?: LivePlan | null;
  liveStepIndex?: number | null;
  livePhase?: string | null;
  /** The gated step's caption, when a decision is pending. */
  gatedLabel?: string | null;
  /** How many steps ran in the turn that went wrong. */
  stoppedAfter?: number | null;
  /** A session is still open, so the phone really is still on that page. */
  sessionActive?: boolean;
}

/** The caption under the phone — it mirrors the timeline and never sits over
 *  the video (spec §3.4). It is real text, not `aria-hidden`, but it is NOT a
 *  live region: every word of it is already in the log. */
export function stageCaption(input: CaptionInput): StageCaption {
  if (input.preview === true) {
    return {
      lead: null,
      subject: 'Live view unavailable',
      body: 'Browser actions run in preview mode, so there is no live view.',
      icon: null,
      idle: true,
      // There is no iPhone here to watch and nothing running to stop.
      reassure: false,
    };
  }
  const phase = input.phase ?? 'idle';
  if (phase === 'paused') {
    const label = firstNonEmpty(input.gatedLabel);
    return {
      lead: 'Holding before',
      subject: label ?? 'the next step',
      icon: 'pause',
      idle: false,
      reassure: false,
    };
  }
  if (phase === 'acting' || phase === 'thinking') {
    const planned = input.livePlan?.labels[input.liveStepIndex ?? -1];
    const label = firstNonEmpty(planned) ?? firstNonEmpty(input.livePhase);
    // Nothing to point at yet — the start-up strip covers the STARTING window,
    // and a turn already under way with no caption still says it is working.
    return {
      lead: 'Now',
      subject: label ?? 'Working…',
      icon: 'tap',
      idle: false,
      reassure: false,
    };
  }
  if (phase === 'done') {
    return {
      lead: 'Finished',
      subject: input.sessionActive === true ? 'the iPhone is still on this page' : '',
      icon: 'check',
      idle: false,
      reassure: false,
    };
  }
  if (phase === 'trouble') {
    const n = input.stoppedAfter;
    const lead = typeof n === 'number' && n > 0 ? `Stopped at step ${String(n)}` : 'Stopped';
    return {
      lead,
      subject: input.sessionActive === true ? 'the iPhone is still on this page' : '',
      icon: null,
      idle: false,
      reassure: false,
    };
  }
  return {
    lead: null,
    subject: 'Nothing running yet',
    body: 'Send a task and a real iPhone appears here, live.',
    icon: null,
    idle: true,
    reassure: true,
  };
}

export type BootBeatState = 'done' | 'active' | 'waiting';
export interface BootBeat {
  label: string;
  state: BootBeatState;
}

/**
 * The start-up strip: `iPhone reserved` → `Starting the browser` → `Live view`
 * (spec §3.4).
 *
 * ⛔ IT CARRIES NO CLOCK. Stage 3's rule: nothing whose text rewrites itself on
 * a timer may sit un-hidden near the log's live region, and a customer watching
 * a device come up does not need a stopwatch — they need to know which of three
 * things is happening. The sentence under it says how long it usually takes.
 */
export function startupBeats(input: {
  hasSession?: boolean;
  session?: StageSessionState;
  watch?: StageWatch;
}): ReadonlyArray<BootBeat> {
  const watch = input.watch ?? 'idle';
  const reserved = input.hasSession === true;
  const browserUp = watch === 'live';
  const browserStarting = !browserUp && (reserved || input.session === 'provisioning');
  return [
    { label: 'iPhone reserved', state: reserved ? 'done' : 'active' },
    {
      label: 'Starting the browser',
      state: browserUp ? 'done' : browserStarting ? 'active' : 'waiting',
    },
    { label: 'Live view', state: browserUp ? 'active' : 'waiting' },
  ];
}

/** The shape the device's capability report has, as far as this file reads it —
 *  every field nullable, because each is "not observed yet" until it arrives. */
export interface StageExitReport {
  exit_ip?: string | null;
  exit_country?: string | null;
  exit_timezone?: string | null;
}

export interface BrowsingFrom {
  /** "Browsing from Berlin, DE" — what the facts row under the phone shows. */
  label: string;
  /** "Berlin, DE" — the same fact with no room for a preposition. The narrow
   *  tier has no facts row, so the place rides up into the HUD beside the state
   *  chip, where the stage is 252px wide and the full sentence is cut mid-word.
   *  The `title` carries the whole of it either way. */
  short: string;
  /** The same, plus the address and the zone: the chip's `title`. */
  detail: string;
  /** The address, shown inline only in the wide tier (spec D4). */
  ip: string | null;
}

/**
 * Where the phone is browsing from — or null.
 *
 * ⛔ THE CITY IS THE TIMEZONE'S OWN LAST SEGMENT, not a lookup. `Europe/Berlin`
 * is the only place-name the device reports, so "Berlin" is a fact and anything
 * else would be a guess dressed as one. When the zone is missing or is not a
 * `Region/City` pair, the chip says the country alone. With neither, it says
 * nothing at all: an empty facts row is honest, and "Browsing from —" is not.
 */
export function browsingFrom(report: StageExitReport | null | undefined): BrowsingFrom | null {
  if (report === null || report === undefined) return null;
  const country = nonEmpty(report.exit_country);
  const zone = nonEmpty(report.exit_timezone);
  const ip = nonEmpty(report.exit_ip);
  const city = cityFromTimezone(zone);
  const place =
    city !== null && country !== null ? `${city}, ${country}` : (city ?? country ?? null);
  if (place === null) return null;
  const detail = [`Browsing from ${place}`, ip, zone].filter((p) => p !== null).join(' · ');
  return { label: `Browsing from ${place}`, short: place, detail, ip };
}

/** `Europe/Berlin` → `Berlin`; `America/New_York` → `New York`. Anything that
 *  is not a `Region/City` pair yields null rather than the raw zone. */
function cityFromTimezone(zone: string | null): string | null {
  if (zone === null) return null;
  const parts = zone.split('/');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  if (last === undefined || last === '') return null;
  return last.replace(/_/g, ' ');
}

function nonEmpty(v: string | null | undefined): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function firstNonEmpty(v: string | null | undefined): string | null {
  return nonEmpty(v);
}

/**
 * How many steps the last agent turn ran — the N in "Stopped at step N".
 *
 * ⛔ BOTH SHAPES OF A TURN THAT WENT WRONG COUNT, and they are different
 * objects. A turn that FAILED settles with a `plan-executed` response whose
 * results end in a failure; a turn that was INTERRUPTED (the connection
 * dropped, the customer stopped it) never settles into a response at all and
 * keeps what ran under `interrupted.steps`. Reading only the first left the
 * commonest trouble state saying "Stopped" with no number beside a timeline
 * that plainly showed one.
 *
 * null when there is nothing to count — and then the caption says "Stopped",
 * which is true, rather than "Stopped at step 0", which is not.
 */
export function stepsThatRan(turns: ReadonlyArray<ChatTurn> | undefined): number | null {
  const list = turns ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const turn = list[i];
    if (turn === undefined || turn.role !== 'agent') continue;
    if (turn.interrupted !== undefined) return countRan(turn.interrupted.steps);
    const response = turn.response;
    if (response === undefined || response.kind !== 'plan-executed') return null;
    return countRan(response.results);
  }
  return null;
}

function countRan(results: ReadonlyArray<AgentIntentResult>): number {
  return results.length;
}
