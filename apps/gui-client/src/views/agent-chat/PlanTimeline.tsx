// The plan timeline — one row per step the AI ran, and the rows still to come.
//
// Stage 0 of the AI-view rebuild (spec §9): lifted out of AgentChatView.tsx with
// the DOM byte-identical. In particular the live list keeps its pinned shape —
// `<ol data-testid="live-plan">`, exactly one `data-current="true"`, and an
// `li` whose textContent is exactly `'▶ ' + label` or `'· ' + label`. Stage 2
// rebuilds the rows around those pins; it does not move them.

import { CaptureThumbnail, captureIdOf } from '../../components/CaptureThumbnail';
import { type AgentIntent, type AgentIntentResult } from '@driftstack/sdk';

export function PlanStep({
  result,
  denied,
  approved,
  sessionId,
  baseUrl,
  apiKey,
  captureSrc,
}: {
  result: AgentIntentResult;
  denied: boolean;
  approved: boolean;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  /** GALLERY SEAM (spec §8) — undefined in the app; a harness scene passes a
   *  drawn image so a finished step's screenshot renders with no server. */
  captureSrc?: string;
}): JSX.Element {
  const { glyph, cls, text } = describeResult(result, denied, approved);
  // doc-132 §5.3 — the server's structured diagnosis (optional; older servers
  // omit it). Only the retryable hint is surfaced as a chip: the category's
  // human framing already lives in the reason text, but "worth retrying" vs
  // "change the request" is a real decision the customer makes per failed step.
  const retryable = result.kind === 'failure' && result.diagnosis?.retryable === true;
  // #7 — the screenshot the agent captured on this step (captureIdOf returns one
  // only for a successful capture on a store-wired server; a failure, a
  // non-capture step, or an older server all yield undefined and render nothing).
  const captureId = captureIdOf(result);
  return (
    <li className="flex items-start gap-1.5 text-xs">
      <span className={`mt-px shrink-0 ${cls}`} aria-hidden="true">
        {glyph}
      </span>
      <span className="min-w-0 text-ink-secondary">
        {text}
        {retryable && (
          <span className="ml-1.5 rounded-full bg-status-busy/10 px-1.5 py-px text-2xs text-status-busy">
            worth retrying
          </span>
        )}
        {captureId !== undefined && (
          <CaptureThumbnail
            baseUrl={baseUrl}
            apiKey={apiKey}
            sessionId={sessionId}
            captureId={captureId}
            src={captureSrc}
          />
        )}
      </span>
    </li>
  );
}

/** The steps a settled turn actually ran, as one list. The same `<ol>` serves a
 *  plan-executed turn, a stopped turn and an interrupted one — it was three
 *  identical literals before this file existed. */
export function PlanStepList({
  results,
  denied,
  approved,
  sessionId,
  baseUrl,
  apiKey,
  captureSrc,
}: {
  results: ReadonlyArray<AgentIntentResult>;
  denied: boolean;
  approved: boolean;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  captureSrc?: string;
}): JSX.Element {
  return (
    <ol className="flex flex-col gap-1">
      {results.map((r, i) => (
        <PlanStep
          key={i}
          result={r}
          denied={denied}
          approved={approved}
          sessionId={sessionId}
          baseUrl={baseUrl}
          apiKey={apiKey}
          captureSrc={captureSrc}
        />
      ))}
    </ol>
  );
}

/** The rest of the plan, greyed, under the steps that have already landed.
 *
 *  ⛔ PINNED DOM. `data-testid="live-plan"`, the `i < ranCount ? null : <li>`
 *  rule (a landed step is rendered by PlanStepList, never twice), exactly one
 *  `data-current="true"`, and an `li` whose textContent is exactly the glyph,
 *  a space and the label. Several tests read those. */
export function LivePlanList({
  labels,
  ranCount,
  currentIndex,
}: {
  labels: ReadonlyArray<string>;
  ranCount: number;
  currentIndex: number | null;
}): JSX.Element {
  return (
    <ol className="flex flex-col gap-1" data-testid="live-plan">
      {labels.map((label, i) =>
        i < ranCount ? null : (
          <li
            key={i}
            data-current={i === currentIndex ? 'true' : undefined}
            className={i === currentIndex ? 'text-xs text-ink-primary' : 'text-xs text-ink-muted'}
          >
            {i === currentIndex ? '▶ ' : '· '}
            {label}
          </li>
        ),
      )}
    </ol>
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
