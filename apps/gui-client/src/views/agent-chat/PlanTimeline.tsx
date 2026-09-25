// The plan timeline — one row per step the AI ran, and the rows still to come.
//
// Stage 2 of the AI-view rebuild (spec §3.5) turns the flat glyph list into a
// TIMELINE: a connecting rail down the left, a node per row whose shape says
// what happened, the server's own caption as the label, a mono FACT CHIP saying
// what the step actually did, and — under a failed row — a diagnosis card that
// explains the failure in the customer's language.
//
// ⛔ PINNED DOM, unchanged by any of that:
//   · `<ol data-testid="live-plan">` with the `i < ranCount ? null : <li>` rule;
//   · exactly one `li[data-current="true"]`;
//   · that `li`'s textContent is EXACTLY `'▶ ' + label` / `'· ' + label`.
// The glyph is a visually-hidden span (it stays in textContent, where the test
// reads it, and is never announced twice because the row has no other text),
// every icon is an `aria-hidden` `<svg>` with no `<title>`, the running wash is
// an empty span, and the word "now" is CSS generated content — none of which
// reaches textContent.
//
// ⛔ A SELECTOR IS NOT CUSTOMER COPY. `intentLabel` renders the raw action and
// its CSS selector ("tap #place-order"); before stage 2 that string was the
// visible label of every failed and every gated row. It now appears in exactly
// ONE place: the `<details>What was tried</details>` line under a diagnosis
// card. Everything a customer reads comes from the server's caption, from
// `humanIntentLabel`, or from a fact chip that can only ever carry a host, the
// text that was typed, or an image count.

import { Fragment, type CSSProperties } from 'react';
import { type AgentIntent, type AgentIntentResult } from '@driftstack/sdk';
import { CaptureThumbnail, captureIdOf } from '../../components/CaptureThumbnail';
import { diagnosisCopy } from '../../lib/agent-diagnosis-copy';
import { categoryLabel } from './ApprovalDock';
import { formatStepDuration } from './durations';
import {
  IconCamera,
  IconCheck,
  IconClock,
  IconDot,
  IconEmpty,
  IconEnter,
  IconEye,
  IconGo,
  IconPause,
  IconRedo,
  IconScroll,
  IconTap,
  IconType,
  IconX,
} from './icons';

// ─── what a finished step DID, as a fact ─────────────────────────────────────

/** A fact chip's content. `kind` picks the icon; `text` is what is shown, and
 *  is already safe to render — a masked value for a sensitive field, a host for
 *  a navigation, a count for a capture. */
export interface StepFact {
  kind: 'host' | 'typed' | 'image';
  text: string;
}

/** The mask a sensitive typed value is shown as. Six bullets, not the length of
 *  the real value: a card number and a PIN must not be told apart by width. */
export const SENSITIVE_MASK = '••••••';

/** The longest typed value shown in full; past this it is clipped with an
 *  ellipsis and the whole value goes in the chip's `title`. */
const TYPED_LIMIT = 40;

/** The longest path kept beside a host (spec §3.5). A longer one says nothing a
 *  customer can read at 10.5px and pushes the label off the row. */
const PATH_LIMIT = 24;

/**
 * What to show beside a finished step's caption, or null for nothing.
 *
 * ⛔ NEVER A SELECTOR, and that is a property of the code rather than of a
 * filter: the only values this can return are a host parsed out of a URL, the
 * `value` of a `type` step (masked when the server marked it sensitive), and
 * the literal "1 image". A `tap`, a `press`, a `wait` and a `scroll` return
 * null — there is nothing to say about them until the server sends a human
 * label, and their selector is not it.
 *
 * Only a SUCCESS result gets a chip: a failure's story is its diagnosis card,
 * and a step waiting for approval has not done anything yet.
 */
export function stepFact(result: AgentIntentResult): StepFact | null {
  if (result.kind !== 'success') return null;
  const intent = result.intent;
  switch (intent.kind) {
    case 'navigate':
      return hostFact(intent.url);
    case 'interact': {
      if (intent.action !== 'type') return null;
      if (intent.sensitive === true) return { kind: 'typed', text: SENSITIVE_MASK };
      const typed = typeof intent.value === 'string' ? intent.value.trim() : '';
      if (typed.length === 0) return null;
      const shown = typed.length > TYPED_LIMIT ? `${typed.slice(0, TYPED_LIMIT)}…` : typed;
      return { kind: 'typed', text: `“${shown}”` };
    }
    case 'capture':
      return intent.capture === 'screenshot' ? { kind: 'image', text: '1 image' } : null;
    default:
      return null;
  }
}

/** The URL a navigation used, parsed — or null when this build cannot read it.
 *  An unparseable URL yields nothing rather than the raw string, which is how a
 *  selector-shaped value could otherwise reach a chip. */
function parseUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname === '' ? null : parsed;
  } catch {
    return null;
  }
}

/** The host a navigation landed on, plus a short path — never a query string,
 *  which is where session ids and search terms live. */
function hostFact(url: string): StepFact | null {
  const parsed = parseUrl(url);
  if (parsed === null) return null;
  const path = parsed.pathname;
  const keepPath = path !== '/' && path.length <= PATH_LIMIT && parsed.search === '';
  return { kind: 'host', text: keepPath ? `${parsed.hostname}${path}` : parsed.hostname };
}

/**
 * The page an answer was read from: the host of the LAST navigation in the
 * turn. Undefined when the turn navigated nowhere this build can parse — the
 * answer card then omits its whole provenance line rather than guessing, which
 * is the difference between "Read from the page shop.example.com" and a claim.
 */
export function answerHost(results: ReadonlyArray<AgentIntentResult>): string | undefined {
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const r = results[i];
    if (r === undefined || r.intent.kind !== 'navigate') continue;
    const parsed = parseUrl(r.intent.url);
    if (parsed !== null) return parsed.hostname;
  }
  return undefined;
}

function FactIcon({ kind }: { kind: StepFact['kind'] }): JSX.Element {
  if (kind === 'host') return <IconGo />;
  if (kind === 'typed') return <IconType />;
  return <IconCamera />;
}

// ─── what a step IS, in words a customer can read ────────────────────────────

/**
 * A plain-language name for a step, derived from its intent.
 *
 * This is the FALLBACK. The server writes a caption for every planned step
 * ("Search the store"), and a successful result carries its own `summary`; both
 * are better than anything derivable here. But a FAILED step has neither today
 * — the captions are discarded when a turn settles (spec §7 keeps them, in
 * stage 3) — and the old fallback was `intentLabel`, which put a CSS selector
 * in front of the customer. This says what kind of thing was attempted and
 * stops there.
 */
export function humanIntentLabel(intent: AgentIntent): string {
  switch (intent.kind) {
    case 'navigate': {
      const fact = hostFact(intent.url);
      return fact === null ? 'Open a page' : `Open ${fact.text}`;
    }
    case 'interact':
      switch (intent.action) {
        case 'type':
          return 'Type into the page';
        case 'press':
          return 'Press a key';
        case 'scroll':
        case 'swipe':
          return 'Scroll the page';
        default:
          return 'Tap something on the page';
      }
    case 'wait':
      return 'Wait for the page';
    case 'capture':
      return intent.capture === 'screenshot' ? 'Take a screenshot' : 'Capture the page';
    case 'scroll':
      return `Scroll ${intent.direction} the page`;
    case 'behavioral_pause':
      return 'Pause for a moment';
    default:
      return 'Carry out this step';
  }
}

/**
 * The raw action and its selector, for the ONE place a selector may appear: the
 * `<details>What was tried</details>` line under a diagnosis card. Built from
 * `intentLabel` so there is a single source of truth for the technical text.
 */
export function technicalStepLine(intent: AgentIntent): string {
  const raw = intentLabel(intent);
  const space = raw.indexOf(' ');
  return space === -1 ? raw : `${raw.slice(0, space)} · ${raw.slice(space + 1)}`;
}

/**
 * What a screen reader hears about a step whose outcome was a DECISION —
 * `confirmation required (“…”)`, `approved, ran (“…”)`, `denied, skipped (“…”)`
 * — and null for every other kind of row, whose visible words already say it.
 *
 * ⛔ WITHOUT THE SELECTOR. `describeResult` is the pinned source of those words
 * and it prefixes them with `intentLabel(intent)`, which for a tap is
 * `tap #place-order` — the exact string stage 2 exists to keep away from a
 * customer. A SCREEN-READER USER IS A CUSTOMER: a visually-hidden span is not a
 * place where a CSS selector becomes acceptable, and neither the text gate nor
 * the gallery's privacy scan can see one there, because both read what is
 * painted. So the pinned tail is kept and that prefix is dropped.
 *
 * `describeResult` itself is untouched and still exported —
 * `an-approved-step-is-past-tense…` reads the function, not the DOM.
 *
 * The prefix must match EXACTLY or nothing is spoken: a describeResult that one
 * day stops leading with `intentLabel` must fall to silence (the row's own
 * words still say what happened), never to "whatever is left", which is how a
 * selector would come back.
 */
export function spokenOutcome(
  result: AgentIntentResult,
  denied: boolean,
  approved: boolean,
): string | null {
  if (result.kind !== 'confirmation_required') return null;
  const full = describeResult(result, denied, approved).text;
  const prefix = `${intentLabel(result.intent)} — `;
  return full.startsWith(prefix) ? full.slice(prefix.length) : null;
}

/** How a settled row is drawn, and therefore what its node says happened. */
type StepTone = 'is-done' | 'is-fail' | 'is-hold' | 'is-skip' | 'is-next';

function toneOf(result: AgentIntentResult, denied: boolean, approved: boolean): StepTone {
  switch (result.kind) {
    case 'success':
      return 'is-done';
    case 'failure':
      return 'is-fail';
    case 'confirmation_required':
      if (denied) return 'is-skip';
      if (approved) return 'is-done';
      return 'is-hold';
    default:
      // A result kind this build does not model (a newer server, a rehydrated
      // chat): a hollow node and the honest sentence describeResult supplies.
      return 'is-next';
  }
}

function NodeIcon({ tone }: { tone: StepTone }): JSX.Element {
  switch (tone) {
    case 'is-done':
      return <IconCheck />;
    case 'is-fail':
      return <IconX />;
    case 'is-hold':
      return <IconPause />;
    default:
      return <IconEmpty />;
  }
}

/**
 * The drawing for a planned step that has NOT RUN, from the kind the server
 * published with the plan (spec §3.5's row-kind table). An unknown kind — and
 * every kind at all against a server that sends none — is `null`, which the
 * live list renders as the hollow node it rendered before §7.
 *
 * ⛔ OPEN SET. A kind this build has never heard of must fall to the hollow
 * node, not to a plausible neighbour: the icon would be a confident claim about
 * a step nobody here understands.
 */
export function stepKindIcon(kind: string | null | undefined): JSX.Element | null {
  switch (kind) {
    case 'navigate':
      return <IconGo />;
    case 'tap':
    case 'click':
      return <IconTap />;
    case 'type':
      return <IconType />;
    case 'scroll':
    case 'swipe':
      return <IconScroll />;
    case 'press':
      return <IconEnter />;
    case 'wait':
      return <IconClock />;
    case 'capture':
      return <IconCamera />;
    case 'read':
    case 'read_page':
      return <IconEye />;
    case 'behavioral_pause':
      return <IconPause />;
    default:
      return null;
  }
}

/**
 * "Looked at the page and updated the plan" — the seam between two segments of
 * one turn (spec §3.5).
 *
 * ⛔ A `div`, never an `li`. The `stopped-turn` receipt pins that the `li` count
 * inside it equals the steps that RAN, and this row is not a step: nothing was
 * done here, the agent simply looked again.
 *
 * It arrives the way the rows around it do (`.ai-step-in`, motion #9, with the
 * same opt-in `--i` stagger): a settled plan reveals as ONE cascade, and a row
 * sitting at full opacity in the middle of it while its neighbours are still
 * fading in reads as a rendering fault rather than as a seam. The global
 * reduced-motion clamp settles it on its end state, exactly as it does a step.
 */
export function ReplanRow({
  index,
  stagger = false,
}: {
  /** Turn-wide position of the step BELOW this seam — the cascade slot it
   *  belongs in. Only read when `stagger` is on. */
  index?: number;
  /** A first reveal or a restore cascades; a boundary that lands mid-stream
   *  arrives alone, with no siblings to wait for (`--i` falls back to 0). */
  stagger?: boolean;
}): JSX.Element {
  return (
    <div
      className="ai-replan ai-step-in"
      style={stagger ? ({ '--i': index ?? 0 } as CSSProperties) : undefined}
    >
      <span className="ai-replan-node" aria-hidden="true" />
      <span>Looked at the page and updated the plan</span>
    </div>
  );
}

/** The visible label and the optional sub-line under it, per row kind. Colour
 *  is never the only signal (spec §5): the sub-line says in words what the
 *  amber, the green and the dashed node mean.
 *
 *  `planned` is the server's own caption for this step, kept across the settle
 *  by §7 (`ChatTurn.plan.labels[i]`). It is preferred for the two rows that
 *  have no words of their own — a FAILURE and a step waiting for approval —
 *  because "Place the order" is what the agent said it was about to do, and
 *  `humanIntentLabel`'s honest-but-vague "Tap something on the page" is only
 *  what can be derived without it. A SUCCESS keeps `result.summary`: that is
 *  written after the fact and says what actually happened. */
function rowCopy(
  result: AgentIntentResult,
  denied: boolean,
  approved: boolean,
  planned?: string,
): { label: string; sub: string | null } {
  const intended = planned !== undefined && planned.trim().length > 0 ? planned : null;
  switch (result.kind) {
    case 'success':
      return { label: result.summary, sub: null };
    case 'failure':
      return { label: intended ?? humanIntentLabel(result.intent), sub: null };
    case 'confirmation_required': {
      const label = intended ?? humanIntentLabel(result.intent);
      if (denied) return { label, sub: 'You denied this — it was skipped' };
      if (approved) return { label, sub: 'You approved this — it ran' };
      return {
        label,
        sub: `A ${categoryLabel(result.category)} — waiting for your approval below`,
      };
    }
    default:
      return { label: 'This step can’t be shown in this version.', sub: null };
  }
}

export function PlanStep({
  result,
  denied,
  approved,
  sessionId,
  baseUrl,
  apiKey,
  controlKey,
  captureSrc,
  hoistedCaptureId,
  index = 0,
  last = false,
  stagger = false,
  landing = false,
  was,
  planned,
  durationMs,
  onContinue,
  onSuggest,
}: {
  result: AgentIntentResult;
  denied: boolean;
  approved: boolean;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  /** The session's control key, for the capture fetch in a window with no
   *  account key (the Simulator). Undefined in the main window. */
  controlKey?: string | null;
  /** GALLERY SEAM (spec §8) — undefined in the app; a harness scene passes a
   *  drawn image so a finished step's screenshot renders with no server. */
  captureSrc?: string;
  /** The capture this turn's answer card already shows. A screenshot must
   *  appear ONCE: hoisted into the card when there is an answer, under its own
   *  step when there is not. */
  hoistedCaptureId?: string;
  /** Position in its list, for the reveal stagger. */
  index?: number;
  /** The rail stops at the last row of the last list. */
  last?: boolean;
  /** A first reveal or a restore cascades (45ms per row); a streamed step
   *  arrives alone and must not wait for a stagger that has no siblings. */
  stagger?: boolean;
  /** This row just REPLACED the running row: the future-tense caption leaves
   *  upward as the server's past-tense summary rises into its place. */
  landing?: boolean;
  /** The caption this row replaced, drawn as generated content so it never
   *  reaches textContent or the accessibility tree. */
  was?: string;
  /** §7 — the server's own caption for this step, kept across the settle. Used
   *  only where the result carries no words of its own (see rowCopy). */
  planned?: string;
  /** §7 — how long this step took, in ms, or undefined/null when it was never
   *  timed. An untimed step shows NO duration; it never shows a zero. */
  durationMs?: number | null;
  /** Send "continue" — the honest action under a failure, because there is no
   *  step-retry API. Absent ⇒ no actions are offered. */
  onContinue?: () => void;
  /** Put a suggested instruction in the composer WITHOUT sending it. */
  onSuggest?: (text: string) => void;
}): JSX.Element {
  const tone = toneOf(result, denied, approved);
  const { label, sub } = rowCopy(result, denied, approved, planned);
  // §7 — the third grid column of the row. `formatStepDuration` is the ONE
  // place that decides an unknown duration is an absence, so a row with no
  // timing simply has no third column rather than a "0.0s" in it.
  const duration = formatStepDuration(durationMs);
  const fact = stepFact(result);
  // #7 — the screenshot the agent captured on this step (captureIdOf returns
  // one only for a successful capture on a store-wired server).
  const own = captureIdOf(result);
  const captureId = own === hoistedCaptureId ? undefined : own;
  // The pinned wording (`describeResult`) is what a screen reader hears for a
  // step whose outcome is a decision — "approved, ran", "denied, skipped",
  // "confirmation required". The eye gets the calm row; the wording survives,
  // minus the `intentLabel` prefix that would put a selector in a blind
  // customer's ear (see spokenOutcome).
  const spoken = spokenOutcome(result, denied, approved);
  return (
    <li
      className={['ai-step ai-step-in', tone, last ? 'is-last' : '', landing ? 'landing' : '']
        .filter((c) => c !== '')
        .join(' ')}
      style={stagger ? ({ '--i': index } as CSSProperties) : undefined}
    >
      <span className={landing ? 'ai-node ai-tick' : 'ai-node'} aria-hidden="true">
        <NodeIcon tone={tone} />
      </span>
      <span className="ai-step-label" data-was={was}>
        {spoken !== null && <span className="sr-only">{spoken}</span>}
        <span className={landing ? 'ai-tense-in' : undefined}>{label}</span>
        {fact !== null && (
          <span className="ai-fact" title={fact.text}>
            <FactIcon kind={fact.kind} />
            {fact.text}
          </span>
        )}
        {sub !== null && <span className="ai-step-sub">{sub}</span>}
        {captureId !== undefined && (
          <CaptureThumbnail
            baseUrl={baseUrl}
            apiKey={apiKey}
            controlKey={controlKey}
            sessionId={sessionId}
            captureId={captureId}
            src={captureSrc}
          />
        )}
      </span>
      {/* §7 — NOT aria-hidden. How long a step took is information, and a
          sighted customer getting it while a screen-reader user does not is
          the same asymmetry the visually-hidden outcome line exists to close. */}
      {duration !== null && <span className="ai-dur mono">{duration}</span>}
      {result.kind === 'failure' && (
        <StepDiagnosis
          result={result}
          stepsBefore={index}
          onContinue={onContinue}
          onSuggest={onSuggest}
        />
      )}
    </li>
  );
}

/**
 * Why a step failed, said plainly — and what the customer can actually do next.
 *
 * The server's `reason` is rendered verbatim: it is the one sentence written
 * about THIS failure. Everything around it is derived: a title from the
 * category (open set, safe fallback), the "worth retrying" tag from
 * `diagnosis.retryable`, and two honest actions. "Continue from here" sends
 * "continue" — there is no step-retry API, so nothing here claims to replay a
 * step. The suggestion FILLS the composer and sends nothing.
 */
function StepDiagnosis({
  result,
  stepsBefore,
  onContinue,
  onSuggest,
}: {
  result: Extract<AgentIntentResult, { kind: 'failure' }>;
  /** How many steps finished above this one — the sentence that stops the rest
   *  of the plan from reading as "also failed". */
  stepsBefore: number;
  onContinue?: () => void;
  onSuggest?: (text: string) => void;
}): JSX.Element {
  const copy = diagnosisCopy(result.diagnosis?.category);
  const retryable = result.diagnosis?.retryable === true;
  const above =
    stepsBefore === 0
      ? 'Nothing after this one ran.'
      : stepsBefore === 1
        ? 'The step above finished; nothing after this one ran.'
        : `The ${String(stepsBefore)} steps above finished; nothing after this one ran.`;
  return (
    <div className="ai-card ai-diag">
      <h4>
        {copy.title}
        {retryable && <span className="ai-tag">worth retrying</span>}
      </h4>
      <p>
        {result.reason} {above}
      </p>
      {(onContinue !== undefined || (copy.suggestion !== undefined && onSuggest !== undefined)) && (
        <div className="ai-acts">
          {onContinue !== undefined && (
            <button
              type="button"
              onClick={onContinue}
              className="btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1 text-xs"
            >
              <IconRedo />
              Continue from here
            </button>
          )}
          {copy.suggestion !== undefined && onSuggest !== undefined && (
            <button
              type="button"
              onClick={() => onSuggest(copy.suggestion ?? '')}
              title="Puts this in the message box — nothing is sent until you press Send"
              className="btn-secondary px-2.5 py-1 text-xs"
            >
              {copy.suggestion}
            </button>
          )}
        </div>
      )}
      <details>
        <summary>What was tried</summary>
        <code>{technicalStepLine(result.intent)}</code>
      </details>
    </div>
  );
}

/**
 * Where one `<ol>` ends and the next begins: a turn is a LOOP, and each time
 * the agent looked at the page and made a new plan, the steps below that point
 * belong to a different plan than the steps above it (spec §3.5).
 *
 * Returns the [start, end) spans of `results`, in order. A turn with no
 * re-plans — every turn stored before §7, and every turn that got it right
 * first time — is ONE span, which renders the single `<ol>` this list has
 * always rendered. Boundaries outside the results, duplicated, or out of order
 * cannot produce an empty or overlapping span.
 */
export function planSegments(
  count: number,
  replanAt: ReadonlyArray<number> | undefined,
): ReadonlyArray<{ from: number; to: number }> {
  const cuts = [...new Set(replanAt ?? [])]
    .filter((n) => Number.isInteger(n) && n > 0 && n < count)
    .sort((a, b) => a - b);
  const spans: { from: number; to: number }[] = [];
  let from = 0;
  for (const cut of cuts) {
    spans.push({ from, to: cut });
    from = cut;
  }
  spans.push({ from, to: count });
  return spans;
}

/** The steps a settled turn actually ran, as one timeline. The same `<ol>`
 *  serves a plan-executed turn, a stopped turn and an interrupted one — and,
 *  since §7, one `<ol>` per plan segment with a re-plan row between them. */
export function PlanStepList({
  results,
  denied,
  approved,
  sessionId,
  baseUrl,
  apiKey,
  controlKey,
  captureSrc,
  hoistedCaptureId,
  settled = true,
  stagger = false,
  lastRow = true,
  landingIndex = null,
  landingWas,
  planLabels,
  stepMs,
  replanAt,
  onContinue,
  onSuggest,
}: {
  results: ReadonlyArray<AgentIntentResult>;
  denied: boolean;
  approved: boolean;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  /** The session's control key, for the capture fetch in a window with no
   *  account key (the Simulator). Undefined in the main window. */
  controlKey?: string | null;
  captureSrc?: string;
  hoistedCaptureId?: string;
  /** A settled plan is set tighter than a live one — there is no running row
   *  in it to give room to. */
  settled?: boolean;
  stagger?: boolean;
  /** False when another list follows this one (the pending steps, or a later
   *  plan segment), so the rail carries on instead of stopping mid-turn. */
  lastRow?: boolean;
  landingIndex?: number | null;
  landingWas?: string;
  /** §7 — the server's caption per planned step, by turn-wide index. */
  planLabels?: ReadonlyArray<string>;
  /** §7 — how long each step took, by the same index. */
  stepMs?: ReadonlyArray<number | null>;
  /** §7 — the step positions a new plan started at. */
  replanAt?: ReadonlyArray<number>;
  onContinue?: () => void;
  onSuggest?: (text: string) => void;
}): JSX.Element {
  const spans = planSegments(results.length, replanAt);
  const cls = settled ? 'ai-plan is-settled' : 'ai-plan';
  const step = (r: AgentIntentResult, i: number, isLast: boolean): JSX.Element => (
    <PlanStep
      key={i}
      result={r}
      denied={denied}
      approved={approved}
      sessionId={sessionId}
      baseUrl={baseUrl}
      apiKey={apiKey}
      controlKey={controlKey}
      captureSrc={captureSrc}
      hoistedCaptureId={hoistedCaptureId}
      // ⛔ The index stays TURN-WIDE across every segment: it is the reveal
      // stagger, and it is `stepsBefore` for the diagnosis card's "the N steps
      // above finished" — per-segment numbering would undercount both.
      index={i}
      stagger={stagger}
      last={isLast}
      landing={landingIndex === i}
      was={landingIndex === i ? landingWas : undefined}
      planned={planLabels?.[i]}
      durationMs={stepMs?.[i]}
      onContinue={onContinue}
      onSuggest={onSuggest}
    />
  );
  // The common case — no re-plan — is byte-for-byte the list this rendered
  // before §7: one `<ol>`, no Fragment wrapper, no extra rows.
  if (spans.length === 1) {
    return (
      <ol className={cls}>
        {results.map((r, i) => step(r, i, lastRow && i === results.length - 1))}
      </ol>
    );
  }
  return (
    <>
      {spans.map((span, s) => (
        <Fragment key={span.from}>
          {s > 0 && <ReplanRow index={span.from} stagger={stagger} />}
          <ol className={cls}>
            {results
              .slice(span.from, span.to)
              .map((r, j) =>
                step(r, span.from + j, lastRow && span.from + j === results.length - 1),
              )}
          </ol>
        </Fragment>
      ))}
    </>
  );
}

/** The rest of the plan, under the steps that have already landed.
 *
 *  ⛔ PINNED DOM. `data-testid="live-plan"`, the `i < ranCount ? null : <li>`
 *  rule (a landed step is rendered by PlanStepList, never twice), exactly one
 *  `data-current="true"`, and an `li` whose textContent is exactly the glyph,
 *  a space and the label. Several tests read those, and the icon, the wash and
 *  the word "now" are all built so that they cannot change it. */
export function LivePlanList({
  labels,
  ranCount,
  currentIndex,
  kinds,
}: {
  labels: ReadonlyArray<string>;
  ranCount: number;
  currentIndex: number | null;
  /** §7 — the kind of each planned step, so a row that has not run yet can say
   *  what it is about to do. Absent ⇒ the hollow nodes this list had before. */
  kinds?: ReadonlyArray<string | null>;
}): JSX.Element {
  const lastIndex = labels.length - 1;
  return (
    <ol className="ai-plan" data-testid="live-plan">
      {labels.map((label, i) => {
        const kindIcon = stepKindIcon(kinds?.[i]);
        return i < ranCount ? null : (
          <li
            key={i}
            data-current={i === currentIndex ? 'true' : undefined}
            className={
              i === currentIndex
                ? 'ai-step ai-step-in is-run'
                : i === lastIndex
                  ? 'ai-step ai-step-in is-next is-last'
                  : 'ai-step ai-step-in is-next'
            }
          >
            {/* the wash that sweeps the running row. An empty span: nothing in
                it, so nothing of it reaches textContent. */}
            {i === currentIndex && (
              <span className="ai-wash" aria-hidden="true">
                <span className="ai-sweep" />
              </span>
            )}
            {/* §7 — the step's own kind, when the server said what it is. A
                kind it never sent, or one this build does not model, keeps the
                hollow ring: a guessed icon is a claim about what a step that
                has NOT RUN is going to do. The running row falls back to the
                travelling dot rather than to nothing. */}
            <span className="ai-node" aria-hidden="true">
              {kindIcon ?? (i === currentIndex ? <IconDot /> : null)}
            </span>
            <span className="ai-step-label">
              {/* ⛔ the glyph stays in textContent — a-turn-of-several-segments-
                  renders-as-one-step-list asserts exactly `'▶ ' + label`. */}
              <span className="sr-only">{i === currentIndex ? '▶ ' : '· '}</span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** "N later steps didn't run" — a dashed hollow node closing a turn that
 *  stopped before its plan did. A `div`, never an `li`: the `stopped-turn`
 *  receipt pins that its `li` count equals the steps that ran. */
export function LaterStepsRow({ count }: { count: number }): JSX.Element {
  return (
    <div className="ai-step is-skip is-last">
      <span className="ai-node" aria-hidden="true" />
      <span className="ai-step-label">
        {count === 1 ? '1 later step didn’t run' : `${String(count)} later steps didn’t run`}
      </span>
    </div>
  );
}

// Exported so the confirmation-gate past-tense rendering is unit-tested without a
// component harness — the same pattern as extractPendingConfirmation/adoptionOutcome.
export function describeResult(
  result: AgentIntentResult,
  denied: boolean,
  approved: boolean,
): { glyph: string; cls: string; text: string } {
  switch (result.kind) {
    case 'success':
      return { glyph: '✓', cls: 'text-status-ready', text: result.summary };
    case 'failure':
      return {
        glyph: '✗',
        cls: 'text-status-error',
        text: `${intentLabel(result.intent)} — ${result.reason}`,
      };
    case 'confirmation_required':
      // A resolved consequential step is no longer waiting: show its outcome, not the
      // ⏸ busy framing that reads as still awaiting a decision (#135 GUI sweep).
      // DENIED → skipped/muted; APPROVED → past-tense "approved, ran" (otherwise the
      // step stayed stuck on "confirmation required" forever after it actually ran).
      if (denied)
        return {
          glyph: '🚫',
          cls: 'text-ink-muted',
          text: `${intentLabel(result.intent)} — denied, skipped (“${result.matchedText}”)`,
        };
      if (approved)
        return {
          glyph: '✓',
          cls: 'text-status-ready',
          text: `${intentLabel(result.intent)} — approved, ran (“${result.matchedText}”)`,
        };
      return {
        glyph: '⏸',
        cls: 'text-status-busy',
        text: `${intentLabel(result.intent)} — confirmation required (“${result.matchedText}”)`,
      };
    default:
      // Robustness (#14): an unknown result.kind from a newer server / rehydrated chat
      // must not fall through to `undefined` — PlanStep destructures { glyph, cls, text }
      // from this and would throw on undefined. Render a neutral, honest step instead.
      return {
        glyph: '•',
        cls: 'text-ink-muted',
        text: 'This step can’t be shown in this version.',
      };
  }
}

export function intentLabel(intent: AgentIntent): string {
  switch (intent.kind) {
    case 'navigate':
      return `navigate ${intent.url}`;
    case 'interact':
      return `${intent.action}${intent.selector !== undefined ? ` ${intent.selector}` : ''}`;
    case 'wait':
      return `wait (${intent.condition})`;
    case 'capture':
      return `capture ${intent.capture}`;
    case 'scroll':
      return `scroll ${intent.direction}`;
    case 'behavioral_pause':
      return 'pause';
    default:
      // Robustness (#14): a newer server (or a rehydrated persisted chat) may carry an
      // intent.kind this build doesn't model. Surface the raw kind rather than letting
      // the switch fall through to `undefined`, which would render literal 'undefined —
      // <reason>' inside describeResult's failure/confirmation text.
      return (intent as { kind?: string }).kind ?? 'action';
  }
}
