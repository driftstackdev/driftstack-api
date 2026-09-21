// THE STAGE — where the iPhone stands.
//
// Stage 4 of the AI-view rebuild (spec §3.4, §1, §4). Stage 0 created this file
// as a seam that drew nothing; this is the body it was waiting for. It is the
// piece of the view a customer remembers: a real iPhone standing in the middle
// of a room whose light says what the AI is doing, with the live stream mounted
// in its screen.
//
// ⛔ THE FRAME IS AROUND THE PANEL, NEVER OVER IT. Three rules hold, and each
// one is a defect this stage could otherwise have shipped:
//
//   1. `.ai-rig > .ai-device > .ai-device-screen` are ALWAYS rendered, never keyed,
//      never conditionally wrapped. `AgentSessionPanel`'s connect effect depends
//      on `[ws_url, token, retryNonce]`, so a remount RECONNECTS the LiveKit
//      room: the customer would watch the video go black and come back every
//      time the window was resized or the chat changed phase. Even the Dynamic
//      Island and the side keys are rendered unconditionally and hidden in CSS,
//      so no sibling slot ever appears or disappears beside the screen.
//   2. NOTHING with a filter, a mask or a live 3D transform is an ANCESTOR of
//      the video. The rig's turn is a `transform` on `.ai-rig` — an ancestor —
//      and that is why it is keyed on `data-ai-rig="rest"`, which means
//      "nothing is mounted in the screen". By the time a stream exists the rig
//      is back at `transform: none`, which imposes no rasterisation. The room,
//      the aura, the floor pool and the pulse are all SIBLINGS of the rig.
//   3. The panel keeps `React.memo` and primitive props. This component
//      re-renders on every composer keystroke (the view owns the draft); the
//      panel must not.
//
// The stage is a DARK ROOM IN BOTH THEMES (spec D2, the SimulatorWindow
// precedent): `data-mode="dark"` is pinned on the section, so the panel's own
// overlays — which are `ink-primary` on black — resolve to dark-theme ink in the
// light theme instead of near-black on black. In the light theme the room is
// drawn as a recessed well with a hard edge rather than a hole in the page.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { usePresentedFrameRate } from '../../lib/use-presented-frame-rate';
import { IconCheck, IconPause, IconPin, IconSignal, IconTap } from './icons';
import { LiveAutomationPanel } from './LiveAutomationPanel';
import { useDeviceFit } from './use-device-fit';
import {
  startupBeats,
  stageIsStarting,
  type BrowsingFrom,
  type StageCaption,
  type StageHud,
  type StageSessionState,
  type StageWatch,
} from './stage-copy';

/** How long the rig's turn lasts (`--ai-dur-turn`). The `will-change` that pays
 *  for it is removed by a TIMER, never by `transitionend`: under the app's
 *  reduced-motion clamp a transition can be over before a listener is attached,
 *  and an element the clamp hides fires no event at all — a promotion that
 *  leaks is a compositor layer that never comes back. */
const RIG_TURN_MS = 800;

export function Stage({
  sessionId,
  collapsed,
  hud,
  caption,
  place,
  watch,
  session,
  hasSession,
  atRest,
  steps,
  idleFact,
  onWatchChange,
  standIn,
  frameRate,
}: {
  sessionId: string | null;
  /** The customer collapsed the live view (Toggle live view). The section is
   *  `hidden`, never `fixed`: there is no slide-over any more — the stage is
   *  inline at every supported width, so the only thing a toggle can do is take
   *  it away and give the room to the conversation. */
  collapsed: boolean;
  hud: StageHud;
  caption: StageCaption;
  /** Where the device is browsing from, or null when it has not said. */
  place: BrowsingFrom | null;
  watch: StageWatch;
  session: StageSessionState;
  hasSession: boolean;
  /** Nothing is mounted in the screen: the phone is a product shot, turned
   *  away, with its Dynamic Island drawn in. */
  atRest: boolean;
  /** How many steps have landed this turn. The action ring watches this for
   *  GROWTH BY ONE (see `ringSeq` below) — the number itself is never the
   *  trigger, because "there are steps" is true of a mount that only opened
   *  onto them. */
  steps: number;
  /** The one line the idle stage says about what watching means. */
  idleFact: string;
  onWatchChange: (watch: StageWatch) => void;
  standIn?: ReactNode;
  /**
   * GALLERY SEAM (spec §8) — the frame rate to SHOW instead of measuring one.
   * Undefined in the app, always. A scene mounts a drawn page in the screen and
   * a picture presents no frames, so the gallery cannot measure the chip into
   * existence; without this the one state the chip lives in would be the one
   * state no gate can see.
   *
   * ⛔ IT DISABLES THE MEASUREMENT RATHER THAN RACING IT: with a value here no
   * callback is armed and no interval runs (`video` below goes null), so a
   * scene stays a still picture for the screenshot gates and the number on
   * screen has exactly one source.
   */
  frameRate?: number;
}): JSX.Element {
  // ⛔ The turn's `will-change` exists only while the turn does (spec §4 item 8:
  // "0 elements with will-change at rest"). It is added when `atRest` FLIPS,
  // not while it holds.
  const [turning, setTurning] = useState(false);
  const previousRest = useRef(atRest);
  useEffect(() => {
    if (previousRest.current === atRest) return undefined;
    previousRest.current = atRest;
    setTurning(true);
    const handle = setTimeout(() => setTurning(false), RIG_TURN_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [atRest]);

  // ⛔ ONE RING PER STEP THAT ARRIVED — NOT PER MOUNT THAT HAS STEPS.
  // Stage 4 gated the ring on `steps > 0`, which closed the common case
  // (opening the view, reopening a finished chat) and left the one its own
  // review recorded: a mount whose `liveSteps` are ALREADY populated — a
  // reopened running chat, a reattach that adopts a turn mid-flight — still
  // flashed one action ring for a tap that happened before this mount existed.
  // "There are steps" is a state; "a step landed" is an event, and only the
  // event may ring.
  //
  // `steps === previous + 1` is the event, and the +1 is deliberate: a chat
  // SWITCH replaces the whole list and jumps the count by an arbitrary delta
  // (or drops it), which is not a step arriving. `ringSeq` starts at 0 and is
  // what re-keys the element, so the first ring of a mount is also the first
  // time the class is on at all.
  //
  // In an effect, not during render: effects run after the commit and twice
  // under StrictMode's simulated remount, where the second run sees the ref
  // already advanced and does nothing — a ref bumped during render would
  // count that remount as an action.
  const previousSteps = useRef(steps);
  const [ringSeq, setRingSeq] = useState(0);
  useEffect(() => {
    const arrived = steps === previousSteps.current + 1;
    previousSteps.current = steps;
    if (arrived) setRingSeq((n) => n + 1);
  }, [steps]);

  // ─── the frame-rate chip ─────────────────────────────────────────────────
  //
  // ⛔ THE ELEMENT IS HELD, NEVER RENDERED FROM HERE. `AgentSessionPanel` hands
  // its `<video>` up through `LiveAutomationPanel`; this only reads it. The
  // setter is a state setter (stable identity, no deps) because it is a prop on
  // a memo'd component that owns a LiveKit room, and it fires twice in the life
  // of a stream — once with the element, once with null — so holding it in
  // state costs two renders per session rather than one per frame.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const onVideoEl = useCallback((el: HTMLVideoElement | null) => {
    setVideoEl(el);
  }, []);
  const measured = usePresentedFrameRate({
    video: frameRate === undefined ? videoEl : null,
    live: watch === 'live',
  });
  // A fixture outranks the measurement and both are gated on the SAME
  // condition, so the gallery cannot show the chip in a state the app would
  // not. Null in every state that has no honest number: no element, no frame
  // API on this WebView, the first two seconds of a stream, a frozen picture,
  // and every state that is not a live stream at all.
  const fps = frameRate ?? measured;
  const showFps = watch === 'live' && fps !== null;
  const starting = stageIsStarting(hud);
  return (
    <section
      // ⛔ CLASS-NAME PIN (agent-chat-save-recipe). It used to read `hidden`
      // when the pane was closed and `fixed` once the slide-over opened. It now
      // reads `hidden` only when the customer collapsed it, and NEVER `fixed` —
      // the `hidden` attribute goes with it so the stage leaves the
      // accessibility tree and the tab order together with the picture.
      className={`ai-stage${collapsed ? ' hidden' : ''}`}
      hidden={collapsed}
      data-mode="dark"
      aria-label="Live view"
      data-component="ai-automation-live-pane"
    >
      <div className="ai-room" aria-hidden="true" />

      {/* The HUD: one state word and one sentence. Plain spans — NOT a live
          region: every word of this is already announced by the log, and a
          second announcement of the same fact is what makes a screen reader
          unusable during a run. */}
      <div className="ai-hud">
        <span className={`ai-chip ai-chip-state ai-chip-${hud.tone}`}>
          {hud.mark === 'pause' ? (
            <span className="ai-chip-ico" aria-hidden="true">
              <IconPause />
            </span>
          ) : (
            <i
              className={`ai-pip${hud.mark === 'pip-beat' ? ' ai-beat' : ''}${
                hud.mark === 'pip-ready' ? ' is-ready' : ''
              }`}
              aria-hidden="true"
            />
          )}
          {hud.chip}
        </span>
        <span className="ai-hud-note">{hud.note}</span>
        {/* Narrow tier only (CSS): the facts row goes and the place comes up
            here, because "where is this browsing from" is the one fact that
            cannot be read anywhere else in the view. */}
        {place !== null && (
          <span className="ai-chip ai-facts-inline" title={place.detail}>
            <span className="ai-chip-ico" aria-hidden="true">
              <IconPin />
            </span>
            {place.short}
          </span>
        )}
        {/* The same fact, in the tier where the row below has gone. It is a
            SECOND ELEMENT rather than a moved one, exactly as the place chip
            above is: one of the two is `display: none` at every width, and a
            node that moved between parents on a resize would take its
            measurement's element with it. */}
        {showFps && <FrameRateChip fps={fps} narrowOnly />}
      </div>

      <StageFit
        turning={turning}
        ringSeq={ringSeq}
        sessionId={sessionId}
        collapsed={collapsed}
        onWatchChange={onWatchChange}
        onVideoEl={onVideoEl}
        standIn={standIn}
      />

      {starting ? (
        <ol className="ai-boot" aria-label="Getting the iPhone ready">
          {startupBeats({ hasSession, session, watch }).map((beat) => (
            <li key={beat.label} className={`ai-boot-${beat.state}`}>
              <span className="ai-boot-b" aria-hidden="true">
                {beat.state === 'done' ? <IconCheck /> : null}
              </span>
              {beat.label}
            </li>
          ))}
        </ol>
      ) : (
        <p className={`ai-now${caption.idle ? ' is-idle' : ''}`}>
          {caption.icon !== null && (
            <span className="ai-now-ico" aria-hidden="true">
              {caption.icon === 'pause' ? (
                <IconPause />
              ) : caption.icon === 'check' ? (
                <IconCheck />
              ) : (
                <IconTap />
              )}
            </span>
          )}
          <span className="ai-now-say">
            {caption.lead !== null && `${caption.lead}${caption.subject === '' ? '' : ' · '}`}
            {caption.subject !== '' && <b>{caption.subject}</b>}
          </span>
          {caption.body !== undefined && <span className="ai-now-sub">{caption.body}</span>}
        </p>
      )}

      {/* ⛔ `data-empty` IS LOAD-BEARING, NOT A HOOK FOR A TEST. The row has a
          22px `min-height` so the caption above it does not jump when a fact
          arrives — and in the two states that have NO fact to show (a stopped
          turn on a closed session; a session that ended) that min-height was a
          22px band of nothing under the phone, the one place the `trouble`
          stage looked unfinished. The attribute says "nothing rendered here",
          and the CSS gives the height back to the phone. Derived from the same
          FOUR conditions the children are — the frame-rate chip is the fourth,
          and a row holding only that chip is not an empty row — so it can never
          disagree with what is actually in the row. */}
      <div
        className="ai-facts"
        data-empty={starting || place !== null || caption.reassure || showFps ? undefined : ''}
      >
        {starting && <span className="ai-facts-note">This usually takes a few seconds.</span>}
        {/* The one line about what watching MEANS belongs to the first
            impression, not to a finished run: "You watch, the AI drives" under
            a stopped task reads as a promise about something that is over.
            ⛔ `caption.reassure`, NOT `caption.idle`. They were one boolean and
            they answer two questions; the `preview` scene, the first thing ever
            to render that state, put "You watch, the AI drives — and you can
            stop it at any time." directly under "Browser actions run in preview
            mode, so there is no live view." `data-empty` above reads the same
            flag, so the preview row now reports itself empty and gives its 22px
            back to the phone instead of leaving a band of nothing. */}
        {!starting && place === null && caption.reassure && (
          <span className="ai-facts-note">{idleFact}</span>
        )}
        {!starting && place !== null && (
          <span className="ai-chip" title={place.detail}>
            <span className="ai-chip-ico" aria-hidden="true">
              <IconPin />
            </span>
            {place.label}
            {place.ip !== null && <span className="ai-facts-ip mono">{place.ip}</span>}
          </span>
        )}
        {!starting && showFps && <FrameRateChip fps={fps} />}
      </div>
    </section>
  );
}

/**
 * `30 fps` — how many frames of the live picture the customer is being shown.
 *
 * ⛔ IT IS RENDERED ONLY WHEN IT HAS BEEN MEASURED. There is no placeholder, no
 * dash and no remembered value: `Stage` passes a number or renders nothing at
 * all, because the one thing a readout beside a live video must never do is
 * print a plausible figure nobody measured. See `use-presented-frame-rate.ts`.
 *
 * ⛔ IT IS `aria-hidden`, and that is the same rule the live clock follows
 * (spec §5: clocks are not live regions and additionally carry `aria-hidden`).
 * Nothing here is inside an `aria-live` region — the HUD and the facts row are
 * plain spans by design — but a leaf that rewrites itself once a second is
 * still noise to a screen reader moving through the stage, and it says nothing
 * the state chip beside it does not: whether the customer is watching a live
 * picture is announced by the log and by the chip's own word, in words.
 *
 * ⚠️ THE CONSEQUENCE, WRITTEN DOWN: `scripts/gui-text-quality.mjs` exempts
 * anything under `aria-hidden="true"` from its CONTRAST check (it still
 * measures size and truncation). The chip therefore carries no new colour of
 * its own — it is the bare `.ai-chip`, ink and surface identical to the place
 * chip beside it, which the gate DOES measure in both themes on this same
 * surface. Its contrast is the place chip's contrast, by construction.
 */
function FrameRateChip({ fps, narrowOnly }: { fps: number; narrowOnly?: boolean }): JSX.Element {
  return (
    <span
      className={`ai-chip ai-fps${narrowOnly === true ? ' ai-fps-inline' : ''}`}
      aria-hidden="true"
    >
      <span className="ai-chip-ico">
        <IconSignal />
      </span>
      {/* ONE text node. Two (`{fps} fps`) would split the reading in the DOM,
          and the loaded-state markers the privacy scan and the every-scene
          arm wait on are substring matches over the text nodes as they stand. */}
      {`${String(fps)} fps`}
    </span>
  );
}

/**
 * The box the phone is sized inside, and the phone.
 *
 * Its own component for one reason: `useDeviceFit` needs a ref to `.ai-fit`,
 * and hanging that off the section would put the hook above the early-return
 * shape the stage's states want. Nothing here is conditional — see rule 1 in
 * the header.
 */
function StageFit({
  turning,
  ringSeq,
  sessionId,
  collapsed,
  onWatchChange,
  onVideoEl,
  standIn,
}: {
  turning: boolean;
  /** How many action rings have been EARNED on this mount (see the note on
   *  `ringSeq` above). 0 means none yet, which is also the state of a mount
   *  that opened onto a chat which already had steps. */
  ringSeq: number;
  sessionId: string | null;
  collapsed: boolean;
  onWatchChange: (watch: StageWatch) => void;
  /** Passed straight through to the panel — see the note where the stage
   *  creates it. Stable, like `onWatchChange`. */
  onVideoEl: (el: HTMLVideoElement | null) => void;
  standIn?: ReactNode;
}): JSX.Element {
  const fitRef = useRef<HTMLDivElement>(null);
  useDeviceFit(fitRef);
  return (
    <div className="ai-fit" ref={fitRef}>
      <div className="ai-center">
        {/* the room light: ONE animated wrapper, three discs that cross-fade */}
        <div className="ai-aura" aria-hidden="true">
          <i className="ai-aura-disc ai-aura-accent" />
          <i className="ai-aura-disc ai-aura-busy" />
          <i className="ai-aura-disc ai-aura-ready" />
        </div>
        {/* One ring leaves the bezel PER ACTION (spec §4 item 7). Re-keyed so
            the one-shot replays; nothing listens for its end.
            ⛔ BOTH THE KEY AND THE CLASS COME FROM `ringSeq`, WHICH COUNTS
            ARRIVALS, NOT STEPS. Keyed on the step COUNT it replayed for any
            change in that number, and gated on `steps > 0` it fired once for a
            mount that merely OPENED onto a chat with steps in it — a ring for a
            tap that happened before this mount existed, which is the one thing
            a ring beside a live video must not do. `ringSeq` is 0 until a step
            actually lands here, so a mount rings nothing and every landing
            rings exactly once. The element itself is never conditional: it is a
            sibling of the rig and a slot that came and went is how a video gets
            remounted. */}
        <div
          key={`pulse-${String(ringSeq)}`}
          className={`ai-pulse${ringSeq > 0 ? ' is-firing' : ''}`}
          aria-hidden="true"
        />
        <div className="ai-floor" aria-hidden="true" />
        <div className={`ai-rig${turning ? ' is-turning' : ''}`}>
          <div className="ai-device">
            <span className="ai-key is-l k1" aria-hidden="true" />
            <span className="ai-key is-l k2" aria-hidden="true" />
            <span className="ai-key is-l k3" aria-hidden="true" />
            <span className="ai-key is-r k4" aria-hidden="true" />
            {/* Drawn only in the product shot (CSS keys it on `data-ai-rig`),
                but ALWAYS in the DOM: a sibling that came and went beside
                `.ai-device-screen` is exactly the kind of change that remounts a
                video. Never over a stream — frame it, don't cover it. */}
            <span className="ai-island" aria-hidden="true" />
            <div className="ai-device-screen">
              <LiveAutomationPanel
                sessionId={sessionId}
                visible={!collapsed}
                onWatchChange={onWatchChange}
                onVideoEl={onVideoEl}
                standIn={standIn}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
