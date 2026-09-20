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

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { IconCheck, IconPause, IconPin, IconTap } from './icons';
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
  /** How many steps have landed this turn — the pulse re-keys on it, so one
   *  ring leaves the bezel per action. */
  steps: number;
  /** The one line the idle stage says about what watching means. */
  idleFact: string;
  onWatchChange: (watch: StageWatch) => void;
  standIn?: ReactNode;
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
      </div>

      <StageFit
        turning={turning}
        steps={steps}
        sessionId={sessionId}
        collapsed={collapsed}
        onWatchChange={onWatchChange}
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

      <div className="ai-facts">
        {starting && <span className="ai-facts-note">This usually takes a few seconds.</span>}
        {/* The one line about what watching MEANS belongs to the first
            impression, not to a finished run: "You watch, the AI drives" under
            a stopped task reads as a promise about something that is over. */}
        {!starting && place === null && caption.idle && (
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
      </div>
    </section>
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
  steps,
  sessionId,
  collapsed,
  onWatchChange,
  standIn,
}: {
  turning: boolean;
  steps: number;
  sessionId: string | null;
  collapsed: boolean;
  onWatchChange: (watch: StageWatch) => void;
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
            ⛔ `is-firing` is gated on there being an action to fire for. With it
            on unconditionally the ring played once on every MOUNT — opening the
            view, or reopening a finished chat from the rail, flashed an action
            ring for a tap that never happened, which is the one thing a ring
            beside a live video must not do. The element itself is never
            conditional: it is a sibling of the rig and a slot that came and went
            is how a video gets remounted. */}
        <div
          key={`pulse-${String(steps)}`}
          className={`ai-pulse${steps > 0 ? ' is-firing' : ''}`}
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
                standIn={standIn}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
