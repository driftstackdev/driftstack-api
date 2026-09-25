// One turn of the conversation — what the customer asked, and what the AI did.
//
// Stage 2 of the AI-view rebuild (spec §3.5) gives a turn an ANATOMY, in this
// order, the same live and settled so the hand-off moves nothing:
//
//   1. the BRIEF     — the customer's own words, led by an accent caret
//   2. the ANSWER    — the thing they asked for, as a card (AnswerCard)
//   3. the FLIGHT    — one fixed-height line: the phase while it runs, the
//                      outcome once it has settled, and the step count
//   4. the SEGMENTS  — one bar per planned step (the WORDS are in the flight meta)
//   5. the TIMELINE  — the plan, as rows on a rail (PlanTimeline)
//   6. the USAGE     — inside the collapsible steps region
//   7. the ACTIONS   — what to do next with a turn that finished
//
// ⛔ Every pin the constraints map lists stays where it was: the
// `[data-testid="turn-notice"]` paragraph and its position ABOVE the heading
// whose text is exactly `Plan`, the `data-component="stopped-turn"` wrapper
// whose `li` count equals the steps that ran, the section headings' exact text
// (`Plan` / `Steps that ran` / `Interrupted — these steps ran`), and the
// `role="status"` typing row with its accessible name.

import { memo, useEffect, useId, useRef, useState } from 'react';
import {
  type AgentIntentResult,
  type AgentMessageResponse,
  type AgentUsage,
} from '@driftstack/sdk';
import { CHAT_MODELS } from '../../lib/chat-models';
import {
  type ChatTurn,
  type InterruptedTurn,
  type LivePlan,
  type TurnPlan,
  type TurnTiming,
} from '../../lib/use-agent-chat';
import { AnswerCard, LiveAnswer } from './AnswerCard';
import { elapsedSince, formatElapsed } from './durations';
import { IconCheck, IconPause, IconX } from './icons';
import { LaterStepsRow, LivePlanList, PlanStepList, ReplanRow, answerHost } from './PlanTimeline';

/** #31 — map a usage model id (e.g. `claude-opus-4-8`) to its human label
 *  ("Opus 4.8") for the per-turn usage badge; falls back to the raw id for a
 *  model not in the picker (older transcript / server-chosen model). */
function modelLabel(id: string): string {
  return CHAT_MODELS.find((m) => m.id === id)?.label ?? id;
}

/** What a turn does next, handed down from the view because it owns the
 *  composer, the hook and the save dialog. Every one is optional: a dozen unit
 *  tests render the view with a partial hook double, and a turn that is handed
 *  no actions simply offers none. */
export interface TurnActions {
  /** Send "continue" — the honest action under a failure. */
  onContinue?: () => void;
  /** Put a suggested instruction in the composer WITHOUT sending it. */
  onSuggest?: (text: string) => void;
  /** Open the save-as-task dialog (the same one the bar opens). */
  onSaveAsTask?: () => void;
  /** Focus the composer, so the follow-up is typed where the caret already is. */
  onAskFollowUp?: () => void;
  /** True while this chat still has a live session, which is what makes
   *  "carries on from here" a true sentence rather than a hopeful one. */
  sessionActive?: boolean;
}

/** Honest boundary between restored (read-only) history and a fresh session.
 *  Reopening a saved chat does NOT reattach the old agent session — the run-loop
 *  rebuilds context from the server transcript, which for a brand-new session is
 *  empty. So tell the customer plainly that continuing won't carry the above as
 *  memory, instead of pretending it's one seamless conversation. */
export function RestoredHistoryDivider(): JSX.Element {
  return (
    <li
      data-component="ai-chat-restored-history-divider"
      className="my-3 flex items-center gap-2 py-1"
    >
      <span className="h-px flex-1 bg-surface-divider" aria-hidden="true" />
      <span className="text-2xs text-ink-muted">
        Saved history above · continuing starts a new session — the agent won&apos;t remember it
      </span>
      <span className="h-px flex-1 bg-surface-divider" aria-hidden="true" />
    </li>
  );
}

// Memoized: the transcript is mapped in the same component that owns the composer
// `draft` state, so without this EVERY keystroke re-rendered every turn row (input lag
// in a long chat — audit 2026-07-08). Props are a stable turn ref + a boolean, so memo
// bails on a keystroke and only the changed/added row re-renders.
export const TurnRow = memo(function TurnRow({
  turn,
  denied,
  approved,
  sessionId,
  baseUrl,
  apiKey,
  controlKey,
  captureSrc,
  first = false,
  past = false,
  actions,
}: {
  turn: ChatTurn;
  denied: boolean;
  approved: boolean;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  /** The session's control key, for the capture fetch in a window with no
   *  account key (the Simulator). Undefined in the main window. */
  controlKey?: string | null;
  /** GALLERY SEAM (spec §8) — undefined in the app; a harness scene passes a
   *  drawn image so a captured screenshot renders with no server behind it. */
  captureSrc?: string;
  /** The first row in the log draws no separator above itself. */
  first?: boolean;
  /** An earlier brief clamps to one line: the thing to read now is below it. */
  past?: boolean;
  actions?: TurnActions;
}): JSX.Element {
  if (turn.role === 'user') {
    return (
      <li className={first ? 'ai-brief' : 'ai-brief is-later'}>
        <span className="ai-brief-caret mono" aria-hidden="true">
          ›
        </span>
        {/* clipped copy always carries the whole sentence in a title */}
        <p title={past ? turn.text : undefined}>{turn.text}</p>
      </li>
    );
  }
  return (
    <li className="ai-body">
      {turn.interrupted !== undefined && (
        <InterruptedTurnBody
          interrupted={turn.interrupted}
          sessionId={sessionId}
          baseUrl={baseUrl}
          apiKey={apiKey}
          controlKey={controlKey}
          captureSrc={captureSrc}
          actions={actions}
          // ⛔ §7's two fields are read OFF THE TURN, never threaded in as new
          // props: `turn` is the one prop this memo already depends on, so the
          // durations and the plan captions cost nothing here. A new prop would
          // have to be memoised in the view or every keystroke in the composer
          // would re-render every turn (see TurnActions above).
          plan={turn.plan}
          timing={turn.timing}
        />
      )}
      {turn.response !== undefined && (
        <AgentResponseBody
          response={turn.response}
          denied={denied}
          approved={approved}
          sessionId={sessionId}
          baseUrl={baseUrl}
          apiKey={apiKey}
          controlKey={controlKey}
          captureSrc={captureSrc}
          actions={actions}
          plan={turn.plan}
          timing={turn.timing}
        />
      )}
    </li>
  );
});

// ─── the flight strip ────────────────────────────────────────────────────────

/** The settled strip: a stamp, the section heading, and the end-cap words.
 *
 *  ⛔ `head` is the pinned heading text. `Plan` in particular must be the only
 *  element in the whole view whose text is exactly that — `getByText('Plan')`
 *  is an exact query in three tests. */
function SettledFlight({
  tone,
  head,
  meta,
  steps,
}: {
  tone: 'ok' | 'bad' | 'hold';
  head: string;
  meta: string | null;
  /** The Hide/Show control, when this turn has one. */
  steps?: JSX.Element;
}): JSX.Element {
  return (
    <div className="ai-flight is-settled">
      <span className={`ai-stamp ai-stamp-${tone}`} aria-hidden="true">
        {tone === 'ok' ? <IconCheck /> : tone === 'hold' ? <IconPause /> : <IconX />}
      </span>
      <span className="ai-flight-head">{head}</span>
      {meta !== null && <span className="ai-flight-meta mono">{meta}</span>}
      {steps}
    </div>
  );
}

/** One bar per planned step. `aria-hidden`, because every one of them is said
 *  in words by the flight meta and by the rows underneath. */
function Segments({ states }: { states: ReadonlyArray<SegState> }): JSX.Element | null {
  // One bar spanning the column is a rule, not a progress bar: it says nothing
  // about how far along the turn is and reads as a divider.
  if (states.length < 2) return null;
  return (
    <div className="ai-segs" aria-hidden="true">
      {states.map((s, i) => (
        <i key={i} className={s === 'pending' ? undefined : `is-${s}`}>
          {s === 'run' ? <span className="ai-fill" /> : null}
        </i>
      ))}
    </div>
  );
}

type SegState = 'ok' | 'bad' | 'hold' | 'run' | 'pending';

/** What each bar says, derived from the results that landed and how many steps
 *  were planned. A denied step is neutral, not red: the customer chose it. */
function segmentsFor(
  results: ReadonlyArray<AgentIntentResult>,
  total: number,
  denied: boolean,
  approved: boolean,
  runningIndex: number | null,
): ReadonlyArray<SegState> {
  const out: SegState[] = [];
  for (let i = 0; i < Math.max(total, results.length); i += 1) {
    const r = results[i];
    if (r === undefined) {
      out.push(i === runningIndex ? 'run' : 'pending');
      continue;
    }
    if (r.kind === 'failure') out.push('bad');
    else if (r.kind === 'confirmation_required')
      out.push(denied ? 'pending' : approved ? 'ok' : 'hold');
    else if (r.kind === 'success') out.push('ok');
    else out.push('pending');
  }
  return out;
}

/** The 1-based position of the step a turn came to rest on, or null. */
function haltedAt(
  results: ReadonlyArray<AgentIntentResult>,
  kind: 'failure' | 'gate',
): number | null {
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (r === undefined) continue;
    if (kind === 'failure' && r.kind === 'failure') return i + 1;
    if (kind === 'gate' && r.kind === 'confirmation_required') return i + 1;
  }
  return null;
}

/** "of M", dropped when the total is not known (spec §3.5). */
function ofTotal(total: number | null): string {
  return total === null ? '' : ` of ${String(total)}`;
}

/**
 * §7 — the settled flight meta with "· 0:41" on the end, or UNCHANGED when the
 * turn carries no timing.
 *
 * ⛔ The whole point of this one-liner being a function: there are four places
 * that build that sentence, and an untimed turn has to come out of every one of
 * them reading exactly as it read before §7 — "Finished · 6 of 6 steps", with
 * no trailing separator and no zero.
 */
function withElapsed(meta: string, timing: TurnTiming | undefined): string {
  const elapsed = formatElapsed(timing?.elapsedMs);
  return elapsed === null ? meta : `${meta} · ${elapsed}`;
}

/** How often the live clock re-reads the time. One second: the slot shows
 *  whole seconds, so anything faster is work nobody can see. */
const CLOCK_TICK_MS = 1_000;

/**
 * §7 — the elapsed clock of a turn that is still running.
 *
 * ⛔ IT IS ITS OWN COMPONENT FOR A REASON. The tick is a state update, and a
 * turn can run for minutes; putting it in `LiveTurnRow` would re-render the
 * whole in-flight bubble — the phase line, the segments, every landed step and
 * the pending plan — once a second, for one changing digit. Here, the second
 * hand re-renders one `<b>`.
 *
 * ⛔ AND IT ONLY EXISTS WHEN THE TURN WAS TIMED. `startedAt` is optional and
 * additive (§7): a caller that never sets it renders nothing and schedules no
 * interval at all, which is also why the ~12 unit tests that mock the chat hook
 * with a hand-built object gained no timers with this stage.
 *
 * Reduced motion does not apply: a clock is information, not decoration, and a
 * customer who asked for less movement still wants to know how long this has
 * been going.
 *
 * ⛔ IT IS `aria-hidden`, AND THAT IS NOT AN OVERSIGHT (spec §5, "clocks are NOT
 * live regions … clocks additionally carry aria-hidden, with the elapsed time
 * available in the settled meta"). This sits inside the live turn's
 * `<li aria-live="polite">`, whose DEFAULT `aria-relevant` is "additions text" —
 * so a leaf that rewrites itself once a second makes a screen reader read a new
 * time every second, for as long as the turn runs (up to ~50 minutes), burying
 * the phase line and every landed step it exists to announce. Nothing is lost:
 * the SETTLED meta carries the same duration as static text (`withElapsed`),
 * announced once, which is where the spec puts it.
 *
 * ⛔ THE SEPARATOR GOES INSIDE, for two reasons. It must be hidden with the
 * clock — otherwise the meta is announced as "Step 4 of 6 ·", trailing a
 * separator into nothing. And `elapsedSince` can return null mid-turn (a system
 * clock that jumps backwards), which with the separator outside would leave that
 * same dangling "·" ON SCREEN. `withElapsed` exists to stop exactly that on the
 * settled side; this is the live side of the same rule.
 */
function ElapsedClock({ startedAt }: { startedAt: number }): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, CLOCK_TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, []);
  const text = elapsedSince(startedAt, now);
  return text === null ? null : (
    <span aria-hidden="true">
      {' · '}
      <b>{text}</b>
    </span>
  );
}

// ─── the live turn ───────────────────────────────────────────────────────────

/**
 * B2 — the progress the server streams BEFORE any step has completed.
 *
 * Until this landed, Send produced three dots for 10 to 30 seconds (up to ~150s
 * at worst) with nothing to read. Stage 2 gives that stream a shape: the ONE
 * large phase line in a fixed-height slot (so nothing jumps as it changes), the
 * step count and the segmented bar beside it, then the steps that have landed
 * above the ones still to come — one continuous timeline.
 *
 * ⚠️ Every field it reads is one the hook ALREADY stores. No hook change: the
 * elapsed clock and the per-step durations the spec's meta also names arrive
 * with §7, in stage 3, and are simply absent until then.
 */
export function LiveTurnRow({
  livePhase,
  liveAnswer,
  liveSteps,
  livePlan,
  liveStepIndex,
  liveStartedAt,
  liveStepMs,
  liveNotice,
  sessionId,
  baseUrl,
  apiKey,
  controlKey,
  captureSrc,
}: {
  livePhase: string | null;
  liveAnswer: string | null;
  liveSteps: ReadonlyArray<AgentIntentResult>;
  livePlan: LivePlan | null;
  liveStepIndex: number | null;
  /** §7, optional — when the turn was sent, for the elapsed clock. */
  liveStartedAt?: number | null;
  /** §7, optional — how long each landed step took. */
  liveStepMs?: ReadonlyArray<number | null>;
  /** §7, optional — "the task is not finished", streamed rather than waited
   *  for. It renders in the same place the settled turn renders its own. */
  liveNotice?: string | null;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  /** The session's control key, for the capture fetch in a window with no
   *  account key (the Simulator). Undefined in the main window. */
  controlKey?: string | null;
  captureSrc?: string;
}): JSX.Element {
  // 10 · the tense shift. A step that has just landed replaces the running row,
  // so its future-tense caption leaves upward as the server's past-tense
  // summary rises into its place. Detected by the results list GROWING — the
  // one event that means "the row you were watching is now a result".
  const seen = useRef(0);
  const grew = liveSteps.length > seen.current;
  seen.current = liveSteps.length;
  const landingIndex = grew ? liveSteps.length - 1 : null;
  const landingWas = landingIndex === null ? undefined : livePlan?.labels[landingIndex];

  const phase = livePhase ?? 'Working…';
  const total = livePlan?.total ?? null;
  const at = (liveStepIndex ?? liveSteps.length) + 1;
  const showCount = liveStepIndex !== null || livePlan !== null;
  const thinking = livePlan === null && liveSteps.length === 0;
  // §7 — a re-plan that happened exactly where the landed steps end sits
  // BETWEEN the two lists, which is the only boundary PlanStepList cannot draw
  // for itself (it only knows about the steps it was given).
  const replanHere =
    livePlan?.replanAt?.includes(liveSteps.length) === true && liveSteps.length > 0;
  return (
    <li className="ai-body" aria-live="polite">
      {/* The answer, the moment the server publishes it — ahead of the
          terminal body, which is the only reason it is streamed. It sits at the
          SAME position the settled card will, so the hand-off moves nothing. */}
      {liveAnswer !== null && <LiveAnswer answer={liveAnswer} />}
      {/* §7 — the server's "I did the steps above, but this is not finished"
          sentence, the moment it is streamed instead of at settle. Same place
          in the turn as the settled one (answer → notice → the plan), so the
          hand-off moves nothing; its own testid, because a settled turn
          further up the log may be showing one of these at the same time. */}
      {liveNotice !== null && liveNotice !== undefined && liveNotice.trim().length > 0 && (
        <p className="ai-said" data-testid="live-turn-notice">
          {liveNotice}
        </p>
      )}
      <div className="ai-flight">
        <span className="ai-orbit" aria-hidden="true" />
        {/* the ONE large light line of the turn: always the thing to read now */}
        <span className="ai-voice ai-voice-lg" title={phase}>
          {phase}
        </span>
        {showCount && (
          <span className="ai-flight-meta mono">
            Step <b>{at}</b>
            {ofTotal(total)}
            {/* §7 — "· 0:41", and nothing at all for a turn nobody timed. A
                `typeof` test rather than a truthy one: the field is
                `number | null | undefined`, and it also narrows the prop. The
                separator is INSIDE the clock: it has to disappear with it (see
                ElapsedClock), and it must not be announced on its own. */}
            {typeof liveStartedAt === 'number' && <ElapsedClock startedAt={liveStartedAt} />}
          </span>
        )}
      </div>
      {total !== null && (
        <Segments states={segmentsFor(liveSteps, total, false, false, liveStepIndex)} />
      )}
      {thinking ? (
        <>
          <div aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div className="ai-ghost" key={i}>
                <i className="ai-ghost-bar" style={{ animationDelay: `${String(i * 160)}ms` }} />
                <i
                  className="ai-ghost-bar"
                  style={{
                    width: `${String([58, 44, 66, 38][i] ?? 50)}%`,
                    animationDelay: `${String(i * 160)}ms`,
                  }}
                />
              </div>
            ))}
          </div>
          <p className="ai-aside">
            Working out the steps. Nothing has run on the iPhone yet — each step appears here as it
            happens.
          </p>
        </>
      ) : (
        <>
          <PlanStepList
            results={liveSteps}
            // Live steps are the in-flight turn — a confirmation there is
            // still awaiting a decision, never a resolved approval.
            denied={false}
            approved={false}
            sessionId={sessionId}
            baseUrl={baseUrl}
            apiKey={apiKey}
            controlKey={controlKey}
            captureSrc={captureSrc}
            settled={false}
            lastRow={livePlan === null || liveSteps.length >= livePlan.labels.length}
            landingIndex={landingIndex}
            landingWas={landingWas}
            planLabels={livePlan?.labels}
            stepMs={liveStepMs}
            replanAt={livePlan?.replanAt}
          />
          {replanHere && <ReplanRow />}
          {livePlan !== null && (
            <LivePlanList
              labels={livePlan.labels}
              ranCount={liveSteps.length}
              currentIndex={liveStepIndex}
              kinds={livePlan.kinds}
            />
          )}
        </>
      )}
    </li>
  );
}

/**
 * B6 — a turn that stopped partway.
 *
 * The steps it DID run are the point: they were dispatched, they were billed,
 * and some of them changed a real page. Clearing them (which is what happened
 * before) both hid that work and made repeating the request look free.
 */
export function InterruptedTurnBody({
  interrupted,
  sessionId,
  baseUrl,
  apiKey,
  controlKey,
  captureSrc,
  actions,
  plan,
  timing,
}: {
  interrupted: InterruptedTurn;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  /** The session's control key, for the capture fetch in a window with no
   *  account key (the Simulator). Undefined in the main window. */
  controlKey?: string | null;
  captureSrc?: string;
  actions?: TurnActions;
  /** §7, optional — the captions/kinds/re-plans the live turn announced. */
  plan?: TurnPlan;
  /** §7, optional — what this client timed before the turn was cut off. */
  timing?: TurnTiming;
}): JSX.Element {
  const ran = interrupted.steps.length;
  return (
    <>
      {ran > 0 && (
        <>
          <SettledFlight
            tone="bad"
            head="Interrupted — these steps ran"
            // An interrupted turn has no plan to count against — the server
            // never finished one — so it says how far it got, not "N of N",
            // which would claim the plan was exactly this long.
            meta={withElapsed(
              ran === 1 ? 'Stopped after 1 step' : `Stopped after ${String(ran)} steps`,
              timing,
            )}
          />
          <Segments states={segmentsFor(interrupted.steps, ran, false, false, null)} />
          <PlanStepList
            results={interrupted.steps}
            denied={false}
            approved={false}
            sessionId={sessionId}
            baseUrl={baseUrl}
            apiKey={apiKey}
            controlKey={controlKey}
            captureSrc={captureSrc}
            stagger
            planLabels={plan?.labels}
            stepMs={timing?.stepMs}
            replanAt={plan?.replanAt}
            onContinue={actions?.onContinue}
            onSuggest={actions?.onSuggest}
          />
        </>
      )}
      <TurnNotice body={interrupted.reason} tone="bad" />
    </>
  );
}

/** A neutral card for the things a turn says rather than does: a refusal, a
 *  clarifying question, a plan that produced no runnable steps, the sentence
 *  an interrupted turn ends on. The copy is unchanged; only its container is
 *  new (spec §3.5 "Notice"). */
function TurnNotice({ body, tone = 'calm' }: { body: string; tone?: 'calm' | 'bad' }): JSX.Element {
  return (
    <div className={tone === 'bad' ? 'ai-card ai-notice is-bad' : 'ai-card ai-notice'}>
      <p className={tone === 'bad' ? 'ai-notice-bad' : undefined}>{body}</p>
    </div>
  );
}

/**
 * What a settled turn has to TELL the customer beyond its steps and its answer:
 * that it stopped before the task was finished, or what the agent asked part-way
 * through. Without it a turn that ran out of room shows a column of completed
 * steps and reads as done.
 *
 * Read structurally because the field is newer than the SDK's response type; a
 * server that does not send it yields null and nothing renders. It lives beside
 * the turn, not beside the chat hook, because a dozen view tests replace that
 * module wholesale and a pure function does not need to be part of what they fake.
 */
function turnNoticeOf(response: AgentMessageResponse): string | null {
  if (response.kind !== 'plan-executed' || !('notice' in response)) return null;
  const notice: unknown = response.notice;
  return typeof notice === 'string' && notice.trim().length > 0 ? notice : null;
}

/** The last screenshot a turn captured, hoisted into the answer card when there
 *  is one, WITH the 1-based step it came from. Returns undefined when nothing
 *  was captured.
 *
 *  The step number is here rather than at the card because this is the loop
 *  that already knows it: the card is handed a capture id and has no way back
 *  to the row it was lifted out of. It names the full-size dialog ("Screenshot
 *  from step 4"), so a customer who opens two of them can tell them apart. */
function hoistedCapture(
  results: ReadonlyArray<AgentIntentResult>,
): { id: string; step: number } | undefined {
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const r = results[i];
    if (r === undefined || r.kind !== 'success') continue;
    const id = r.captureId;
    if (id !== undefined && id !== '') return { id, step: i + 1 };
  }
  return undefined;
}

export function AgentResponseBody({
  response,
  denied,
  approved,
  sessionId,
  baseUrl,
  apiKey,
  controlKey,
  captureSrc,
  actions,
  plan,
  timing,
}: {
  response: AgentMessageResponse;
  denied: boolean;
  approved: boolean;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  /** The session's control key, for the capture fetch in a window with no
   *  account key (the Simulator). Undefined in the main window. */
  controlKey?: string | null;
  captureSrc?: string;
  actions?: TurnActions;
  /** §7, optional — the live plan's captions/kinds/re-plans, kept at settle. */
  plan?: TurnPlan;
  /** §7, optional — what this client timed while the turn ran. */
  timing?: TurnTiming;
}): JSX.Element {
  switch (response.kind) {
    case 'plan-executed':
      return (
        <PlanExecutedBody
          response={response}
          denied={denied}
          approved={approved}
          sessionId={sessionId}
          baseUrl={baseUrl}
          apiKey={apiKey}
          controlKey={controlKey}
          captureSrc={captureSrc}
          actions={actions}
          plan={plan}
          timing={timing}
        />
      );
    case 'clarify':
      return (
        <>
          <TurnNotice body={response.clarifying_question} />
          {response.usage !== undefined && <UsageBadge usage={response.usage} />}
        </>
      );
    case 'refuse':
      return (
        <>
          <TurnNotice body={response.refuse_reason} tone="bad" />
          {response.usage !== undefined && <UsageBadge usage={response.usage} />}
        </>
      );
    case 'stopped':
      // B2 — the customer pressed Stop. The server's sentence says how far the
      // turn got (and names a step whose outcome it could not confirm); the
      // steps below are exactly what ran — nothing planned-but-not-run is shown.
      //
      // ⛔ The `li` count inside this wrapper equals the steps that ran; the
      // "later steps" row and the re-plan row are deliberately `div`s.
      return (
        <div data-component="stopped-turn">
          <p className="ai-said" data-testid="turn-notice">
            {response.notice}
          </p>
          {response.results.length > 0 && (
            <>
              <SettledFlight
                tone="bad"
                head="Steps that ran"
                // For a `stopped` response the SDK says `intents` are the steps
                // that RAN, never the ones still to come — so there is no
                // denominator to show, only how far the turn got.
                meta={withElapsed(
                  response.results.length === 1
                    ? 'Stopped after 1 step'
                    : `Stopped after ${String(response.results.length)} steps`,
                  timing,
                )}
              />
              <Segments
                states={segmentsFor(
                  response.results,
                  response.results.length,
                  denied,
                  approved,
                  null,
                )}
              />
              <PlanStepList
                results={response.results}
                denied={denied}
                approved={approved}
                sessionId={sessionId}
                baseUrl={baseUrl}
                apiKey={apiKey}
                controlKey={controlKey}
                captureSrc={captureSrc}
                stagger
                planLabels={plan?.labels}
                stepMs={timing?.stepMs}
                replanAt={plan?.replanAt}
                onContinue={actions?.onContinue}
                onSuggest={actions?.onSuggest}
              />
            </>
          )}
          {response.usage !== undefined && <UsageBadge usage={response.usage} />}
        </div>
      );
    case 'logged-manual':
      return <p className="text-xs italic text-ink-muted">Logged — no AI reply in manual mode.</p>;
    default:
      // Robustness (#14): a persisted chat rehydrated from a newer/older build, or a
      // server that ships a response.kind this build doesn't know, must not render a
      // bare empty bubble (an unhandled switch returns undefined → blank React node).
      // Fall back to a neutral, honest message instead.
      return <p className="text-sm text-ink-muted">This step can’t be shown in this version.</p>;
  }
}

function PlanExecutedBody({
  response,
  denied,
  approved,
  sessionId,
  baseUrl,
  apiKey,
  controlKey,
  captureSrc,
  actions,
  plan,
  timing,
}: {
  response: Extract<AgentMessageResponse, { kind: 'plan-executed' }>;
  denied: boolean;
  approved: boolean;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  /** The session's control key, for the capture fetch in a window with no
   *  account key (the Simulator). Undefined in the main window. */
  controlKey?: string | null;
  captureSrc?: string;
  actions?: TurnActions;
  plan?: TurnPlan;
  timing?: TurnTiming;
}): JSX.Element {
  const stepsId = useId();
  const [showSteps, setShowSteps] = useState(true);

  const results = response.results;
  const notice = turnNoticeOf(response);
  const answer =
    response.answer !== undefined && response.answer.length > 0 ? response.answer : null;
  // `intents` is every step the turn PLANNED, `results` every step that ran —
  // the SDK says the two need not line up, and `intents` is longer when a plan
  // was abandoned part-way. That difference is the "N later steps didn't run"
  // row, and the denominator of "N of M steps".
  // §7 — the live plan is a third witness to how long the turn was meant to be,
  // and the only one that survives a segment the server abandoned before it
  // reported any intent for it. Taking the max keeps "N later steps didn't run"
  // from UNDERCOUNTING; nothing here can make the denominator smaller.
  const planned = Math.max(response.intents.length, results.length, plan?.labels.length ?? 0);
  const gatedAt = denied || approved ? null : haltedAt(results, 'gate');
  const failedAt = haltedAt(results, 'failure');
  const tone = gatedAt !== null ? 'hold' : failedAt !== null ? 'bad' : 'ok';
  const meta = withElapsed(
    gatedAt !== null
      ? `Paused at step ${String(gatedAt)}${ofTotal(planned)}`
      : failedAt !== null
        ? `Stopped at step ${String(failedAt)}${ofTotal(planned)}`
        : `Finished · ${String(results.length)} of ${String(planned)} steps`,
    timing,
  );
  const later = planned - results.length;
  const capture = answer !== null ? hoistedCapture(results) : undefined;
  // A boundary exactly at the end of the rows that ran, with something after
  // it to separate them from. `planSegments` drops it (it is not between two
  // spans), so it is drawn here instead of being silently lost.
  const trailingReplan =
    later > 0 && results.length > 0 && plan?.replanAt?.includes(results.length) === true;

  return (
    <>
      {/* B1 — the answer the customer actually asked for, above the steps.
          It was computed, sanitised and billed on every read-back turn and
          then shown nowhere: asking for an IP returned "✓ navigated ·
          ✓ captured screenshot" and not the address. The plan below is now
          supporting detail for it rather than the whole reply. */}
      {answer !== null && (
        <AnswerCard
          answer={answer}
          host={answerHost(results)}
          captureId={capture?.id}
          captureStep={capture?.step}
          sessionId={sessionId}
          baseUrl={baseUrl}
          apiKey={apiKey}
          controlKey={controlKey}
          captureSrc={captureSrc}
        />
      )}
      {/* A turn can run every step and still not have finished the task: it
          reached the limit of what it does in one message, or the agent asked
          something part-way through. The steps below are all ticks either
          way, so without this sentence an unfinished task reads as done. */}
      {notice !== null && (
        <p className="ai-said" data-testid="turn-notice">
          {notice}
        </p>
      )}
      {results.length === 0 ? (
        // A plan that executed ZERO steps — the decomposer produced no runnable
        // browser actions for this request (the #139 "responds without steps" /
        // "it did nothing" class). Render an honest, actionable message instead of a
        // bare empty "Plan" heading, which reads as a silent bug (server also now
        // converts an empty plan to a clarify, so this is defence-in-depth).
        // ...unless an answer was already rendered above, in which case the
        // turn plainly did something and this copy would contradict it.
        answer === null ? (
          <TurnNotice body="I couldn’t turn that into browser actions to run. Try rephrasing it as a concrete step — e.g. “go to example.com and take a screenshot.”" />
        ) : null
      ) : (
        <>
          <SettledFlight
            tone={tone}
            head="Plan"
            meta={meta}
            steps={
              answer !== null ? (
                <button
                  type="button"
                  aria-expanded={showSteps}
                  aria-controls={stepsId}
                  onClick={() => setShowSteps((s) => !s)}
                  className="ai-linkbtn"
                >
                  {showSteps ? 'Hide steps' : 'Show steps'}
                </button>
              ) : undefined
            }
          />
          <Segments states={segmentsFor(results, planned, denied, approved, null)} />
          <div id={stepsId} hidden={!showSteps}>
            <PlanStepList
              results={results}
              denied={denied}
              approved={approved}
              sessionId={sessionId}
              baseUrl={baseUrl}
              apiKey={apiKey}
              controlKey={controlKey}
              captureSrc={captureSrc}
              hoistedCaptureId={capture?.id}
              stagger
              lastRow={later <= 0}
              planLabels={plan?.labels}
              stepMs={timing?.stepMs}
              replanAt={plan?.replanAt}
              onContinue={actions?.onContinue}
              onSuggest={actions?.onSuggest}
            />
            {/* §7 — a re-plan at the very end of what ran: the agent looked
                again, made a new plan, and the turn stopped before any of it
                did. PlanStepList only draws boundaries BETWEEN its own rows. */}
            {trailingReplan && <ReplanRow index={results.length} stagger />}
            {later > 0 && <LaterStepsRow count={later} />}
            {response.usage !== undefined && <UsageBadge usage={response.usage} />}
          </div>
        </>
      )}
      {response.ok && results.length > 0 && <AfterActions actions={actions} />}
    </>
  );
}

/** What to do next with a turn that finished. Rendered only when the turn
 *  actually succeeded — offering "save this as a task" under a failure would be
 *  offering to repeat it. */
function AfterActions({ actions }: { actions?: TurnActions }): JSX.Element | null {
  if (actions?.onSaveAsTask === undefined && actions?.onAskFollowUp === undefined) return null;
  return (
    <div className="ai-after">
      {actions.onSaveAsTask !== undefined && (
        <button
          type="button"
          onClick={actions.onSaveAsTask}
          className="btn-secondary px-2.5 py-1 text-xs"
        >
          Save as a task
        </button>
      )}
      {actions.onAskFollowUp !== undefined && (
        <button
          type="button"
          onClick={actions.onAskFollowUp}
          // Only true while the session is still up — that is what makes a
          // follow-up carry on from the page the iPhone is already on.
          title={
            actions.sessionActive === true
              ? 'The iPhone is still on this page, so a follow-up carries on from here.'
              : undefined
          }
          className="ai-linkbtn"
        >
          Ask a follow-up
        </button>
      )}
    </div>
  );
}

export function UsageBadge({ usage }: { usage: AgentUsage }): JSX.Element {
  const parts: string[] = [];
  if (usage.cost_usd_cents !== undefined) parts.push(`$${(usage.cost_usd_cents / 100).toFixed(4)}`);
  const tokens = (usage.anthropic_input_tokens ?? 0) + (usage.anthropic_output_tokens ?? 0);
  if (tokens > 0) parts.push(`${tokens} tokens`);
  if (usage.model !== undefined) parts.push(modelLabel(usage.model));
  // Nothing customer-meaningful to show (no cost/tokens/model) — render nothing
  // rather than leaking the internal decomposer_kind enum (journey audit L5).
  if (parts.length === 0) return <></>;
  return <p className="ai-usage mono">{parts.join(' · ')}</p>;
}

export function TypingRow({ label }: { label: string }): JSX.Element {
  return (
    <li className="ai-body mt-3">
      <div role="status" aria-label={label} className="flex items-center gap-2.5">
        <span className="ai-orbit" aria-hidden="true" />
        {/* Coarse phase so a multi-second run isn't one opaque dot (journey H3):
            "Starting a session…" while create() is in flight (no session yet),
            "Working on your request…" once the message is running server-side. */}
        <span className="ai-voice ai-voice-lg">{label}</span>
      </div>
    </li>
  );
}
