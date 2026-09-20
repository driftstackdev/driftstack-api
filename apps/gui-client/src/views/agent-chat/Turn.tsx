// One turn of the conversation — what the customer asked, and what the AI did.
//
// Stage 0 of the AI-view rebuild (spec §9): lifted out of AgentChatView.tsx with
// the DOM byte-identical. Every pin the constraints map lists stays where it
// was: the `[data-testid="turn-notice"]` paragraph and its position, the
// `data-component="stopped-turn"` wrapper, the `section-label` headings whose
// text is exactly `Plan` / `Steps that ran` / `Interrupted — these steps ran`,
// the `role="status"` typing row and its accessible name. Stage 2 rebuilds the
// anatomy around those; it does not move them.

import { memo } from 'react';
import {
  type AgentIntentResult,
  type AgentMessageResponse,
  type AgentUsage,
} from '@driftstack/sdk';
import { CHAT_MODELS } from '../../lib/chat-models';
import { type ChatTurn, type InterruptedTurn, type LivePlan } from '../../lib/use-agent-chat';
import { AnswerCard, LiveAnswer } from './AnswerCard';
import { LivePlanList, PlanStepList } from './PlanTimeline';

/** #31 — map a usage model id (e.g. `claude-opus-4-8`) to its human label
 *  ("Opus 4.8") for the per-turn usage badge; falls back to the raw id for a
 *  model not in the picker (older transcript / server-chosen model). */
function modelLabel(id: string): string {
  return CHAT_MODELS.find((m) => m.id === id)?.label ?? id;
}

/** Honest boundary between restored (read-only) history and a fresh session.
 *  Reopening a saved chat does NOT reattach the old agent session — the run-loop
 *  rebuilds context from the server transcript, which for a brand-new session is
 *  empty. So tell the customer plainly that continuing won't carry the above as
 *  memory, instead of pretending it's one seamless conversation. */
export function RestoredHistoryDivider(): JSX.Element {
  return (
    <li data-component="ai-chat-restored-history-divider" className="flex items-center gap-2 py-1">
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
  captureSrc,
}: {
  turn: ChatTurn;
  denied: boolean;
  approved: boolean;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  /** GALLERY SEAM (spec §8) — undefined in the app; a harness scene passes a
   *  drawn image so a captured screenshot renders with no server behind it. */
  captureSrc?: string;
}): JSX.Element {
  if (turn.role === 'user') {
    return (
      <li className="flex justify-end">
        <div className="max-w-[80%] rounded-lg rounded-br-sm bg-accent-subtle px-3 py-2 text-sm text-ink-primary">
          {turn.text}
        </div>
      </li>
    );
  }
  return (
    <li className="flex justify-start">
      <div className="max-w-[85%] rounded-lg rounded-bl-sm border border-surface-divider bg-surface-raised px-3 py-2">
        {turn.interrupted !== undefined && (
          <InterruptedTurnBody
            interrupted={turn.interrupted}
            sessionId={sessionId}
            baseUrl={baseUrl}
            apiKey={apiKey}
            captureSrc={captureSrc}
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
            captureSrc={captureSrc}
          />
        )}
      </div>
    </li>
  );
});

/**
 * B2 — the progress the server streams BEFORE any step has completed.
 *
 * Until this landed, Send produced three dots for 10 to 30 seconds (up to ~150s
 * at worst) with nothing to read. Completed steps render in full (screenshots,
 * links, failures); the rest of the plan sits below them, greyed, so the
 * customer can see how much is left. The settled turn's full response replaces
 * this the moment the turn resolves — and renders the same answer text a beat
 * later, in the same position.
 */
export function LiveTurnRow({
  livePhase,
  liveAnswer,
  liveSteps,
  livePlan,
  liveStepIndex,
  sessionId,
  baseUrl,
  apiKey,
  captureSrc,
}: {
  livePhase: string | null;
  liveAnswer: string | null;
  liveSteps: ReadonlyArray<AgentIntentResult>;
  livePlan: LivePlan | null;
  liveStepIndex: number | null;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  captureSrc?: string;
}): JSX.Element {
  return (
    <li className="flex justify-start" aria-live="polite">
      <div className="max-w-[85%] rounded-lg rounded-bl-sm border border-surface-divider bg-surface-raised px-3 py-2">
        <div className="flex flex-col gap-1.5">
          <p className="section-label flex items-center gap-1.5">
            {livePhase ?? 'Working…'}
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-status-busy" />
          </p>
          {/* The answer, the moment the server publishes it — ahead of the
              terminal body, which is the only reason it is streamed. */}
          {liveAnswer !== null && <LiveAnswer answer={liveAnswer} />}
          <PlanStepList
            results={liveSteps}
            // Live steps are the in-flight turn — a confirmation there is
            // still awaiting a decision, never a resolved approval.
            denied={false}
            approved={false}
            sessionId={sessionId}
            baseUrl={baseUrl}
            apiKey={apiKey}
            captureSrc={captureSrc}
          />
          {livePlan !== null && (
            <LivePlanList
              labels={livePlan.labels}
              ranCount={liveSteps.length}
              currentIndex={liveStepIndex}
            />
          )}
        </div>
      </div>
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
  captureSrc,
}: {
  interrupted: InterruptedTurn;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  captureSrc?: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {interrupted.steps.length > 0 && (
        <>
          <p className="section-label">Interrupted — these steps ran</p>
          <PlanStepList
            results={interrupted.steps}
            denied={false}
            approved={false}
            sessionId={sessionId}
            baseUrl={baseUrl}
            apiKey={apiKey}
            captureSrc={captureSrc}
          />
        </>
      )}
      <p className="text-sm text-status-error">{interrupted.reason}</p>
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

export function AgentResponseBody({
  response,
  denied,
  approved,
  sessionId,
  baseUrl,
  apiKey,
  captureSrc,
}: {
  response: AgentMessageResponse;
  denied: boolean;
  approved: boolean;
  sessionId: string | null;
  baseUrl: string;
  apiKey: string | null;
  captureSrc?: string;
}): JSX.Element {
  switch (response.kind) {
    case 'plan-executed':
      return (
        <div className="flex flex-col gap-1.5">
          {/* B1 — the answer the customer actually asked for, above the steps.
              It was computed, sanitised and billed on every read-back turn and
              then shown nowhere: asking for an IP returned "✓ navigated ·
              ✓ captured screenshot" and not the address. The plan below is now
              supporting detail for it rather than the whole reply. */}
          {response.answer !== undefined && response.answer.length > 0 && (
            <AnswerCard answer={response.answer} />
          )}
          {/* A turn can run every step and still not have finished the task: it
              reached the limit of what it does in one message, or the agent asked
              something part-way through. The steps below are all ticks either
              way, so without this sentence an unfinished task reads as done. */}
          {turnNoticeOf(response) !== null && (
            <p className="whitespace-pre-wrap text-sm text-ink-primary" data-testid="turn-notice">
              {turnNoticeOf(response)}
            </p>
          )}
          {response.results.length === 0 ? (
            // A plan that executed ZERO steps — the decomposer produced no runnable
            // browser actions for this request (the #139 "responds without steps" /
            // "it did nothing" class). Render an honest, actionable message instead of a
            // bare empty "Plan" heading, which reads as a silent bug (server also now
            // converts an empty plan to a clarify, so this is defence-in-depth).
            // ...unless an answer was already rendered above, in which case the
            // turn plainly did something and this copy would contradict it.
            response.answer === undefined || response.answer.length === 0 ? (
              <p className="text-sm text-ink-primary">
                I couldn’t turn that into browser actions to run. Try rephrasing it as a concrete
                step — e.g. “go to example.com and take a screenshot.”
              </p>
            ) : null
          ) : (
            <>
              <p className="section-label">Plan</p>
              <PlanStepList
                results={response.results}
                denied={denied}
                approved={approved}
                sessionId={sessionId}
                baseUrl={baseUrl}
                apiKey={apiKey}
                captureSrc={captureSrc}
              />
            </>
          )}
          {response.usage !== undefined && <UsageBadge usage={response.usage} />}
        </div>
      );
    case 'clarify':
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm text-ink-primary">{response.clarifying_question}</p>
          {response.usage !== undefined && <UsageBadge usage={response.usage} />}
        </div>
      );
    case 'refuse':
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm text-status-error">{response.refuse_reason}</p>
          {response.usage !== undefined && <UsageBadge usage={response.usage} />}
        </div>
      );
    case 'stopped':
      // B2 — the customer pressed Stop. The server's sentence says how far the
      // turn got (and names a step whose outcome it could not confirm); the
      // steps below are exactly what ran — nothing planned-but-not-run is shown.
      return (
        <div className="flex flex-col gap-1.5" data-component="stopped-turn">
          <p className="whitespace-pre-wrap text-sm text-ink-primary" data-testid="turn-notice">
            {response.notice}
          </p>
          {response.results.length > 0 && (
            <>
              <p className="section-label">Steps that ran</p>
              <PlanStepList
                results={response.results}
                denied={denied}
                approved={approved}
                sessionId={sessionId}
                baseUrl={baseUrl}
                apiKey={apiKey}
                captureSrc={captureSrc}
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

export function UsageBadge({ usage }: { usage: AgentUsage }): JSX.Element {
  const parts: string[] = [];
  if (usage.cost_usd_cents !== undefined) parts.push(`$${(usage.cost_usd_cents / 100).toFixed(4)}`);
  const tokens = (usage.anthropic_input_tokens ?? 0) + (usage.anthropic_output_tokens ?? 0);
  if (tokens > 0) parts.push(`${tokens} tokens`);
  if (usage.model !== undefined) parts.push(modelLabel(usage.model));
  // Nothing customer-meaningful to show (no cost/tokens/model) — render nothing
  // rather than leaking the internal decomposer_kind enum (journey audit L5).
  if (parts.length === 0) return <></>;
  return <span className="mono text-2xs text-ink-muted">{parts.join(' · ')}</span>;
}

export function TypingRow({ label }: { label: string }): JSX.Element {
  return (
    <li className="flex justify-start">
      <div
        role="status"
        aria-label={label}
        className="flex items-center gap-2 rounded-lg rounded-bl-sm border border-surface-divider bg-surface-raised px-3 py-2.5"
      >
        <span aria-hidden="true" className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-muted" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-muted [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-muted [animation-delay:300ms]" />
        </span>
        {/* Coarse phase so a multi-second run isn't one opaque dot (journey H3):
            "Starting a session…" while create() is in flight (no session yet),
            "Working on your request…" once the message is running server-side. */}
        <span className="text-xs text-ink-muted">{label}</span>
      </div>
    </li>
  );
}
