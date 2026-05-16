// AI-B2 — intent executor. Maps a DecomposeResult `plan` onto calls
// against the existing /v1/sessions/:id/{navigate,interact,wait,
// capture} surface so the dashboard chat UI can run an end-to-end
// turn (decompose → execute → append transcript → debit tokens →
// repeat) without hand-wiring the dispatch.
//
// This slice ships the deterministic stub variant — every intent
// returns a synthetic success result. The real harness-wired
// executor (AI-B2.b follow-up) replaces the stub with a SessionsService
// dispatch + capture aggregator; the interface surface here is
// stable so the dashboard + agent-decomposer integration tests can
// pin against it now.
//
// Why not call the HTTP routes directly via fetch: the agent layer
// runs in the same process as the routes; round-tripping through
// HTTP would double the latency budget + lose typed-error context.
// AI-B2.b dispatches against the in-process SessionsService instead.

import type { AgentIntent, DecomposeResult, TranscriptEntry } from './agent-decomposer.js';

/**
 * Per-intent execution result. The discriminated union lets callers
 * branch on success vs failure without throwing — the dashboard chat
 * UI renders each result inline so customers see WHICH intent failed
 * if a plan halts partway.
 */
export type IntentResult =
  | {
      kind: 'success';
      intent: AgentIntent;
      /** Free-form summary string for the transcript log. AI-B2.b
       *  populates this with the underlying SessionsService response
       *  (e.g. "navigated to {url}; status 200") so the agent's next
       *  turn can reason about real page state. */
      summary: string;
      /** Optional capture id (sets when intent.kind === 'capture'). */
      captureId?: string;
    }
  | {
      kind: 'failure';
      intent: AgentIntent;
      /** Customer-facing failure reason. Comes from the SessionsService
       *  problem-type response in the wired variant. */
      reason: string;
    };

export interface ExecutorRunResult {
  results: ReadonlyArray<IntentResult>;
  /** True iff every intent in the plan returned `kind: success`.
   *  False if any intent failed; the executor halts on first
   *  failure (the agent's next plan can pick up from there). */
  ok: boolean;
}

export interface ExecuteArgs {
  /** /v1/sessions session id the plan runs against. */
  sessionId: string;
  /** The plan to execute. Refuse + clarify results are no-ops here —
   *  the caller (agent runtime) handles those before reaching the
   *  executor. The narrowing happens at the type level. */
  plan: Extract<DecomposeResult, { kind: 'plan' }>;
}

export interface AgentExecutor {
  /**
   * Run a plan's intents in order. Halts on first failure (returns
   * partial results). Never throws — failures surface as
   * IntentResult discriminants instead.
   *
   * AI-B2.b will accept an optional cancellation signal and
   * propagate it to the underlying SessionsService dispatch.
   */
  execute(args: ExecuteArgs): Promise<ExecutorRunResult>;
}

/**
 * Stub executor — returns synthetic success for every intent. Useful
 * for end-to-end tests of the decompose → execute → append-transcript
 * loop, and for the dashboard chat-UI to render a believable
 * turn-by-turn flow during pre-launch demos.
 */
export class StubAgentExecutor implements AgentExecutor {
  execute(args: ExecuteArgs): Promise<ExecutorRunResult> {
    const results: IntentResult[] = [];
    for (const intent of args.plan.intents) {
      results.push({
        kind: 'success',
        intent,
        summary: stubSummary(intent),
        ...(intent.kind === 'capture'
          ? { captureId: `cap_stub_${args.sessionId}_${results.length + 1}` }
          : {}),
      });
    }
    return Promise.resolve({ results, ok: true });
  }
}

function stubSummary(intent: AgentIntent): string {
  switch (intent.kind) {
    case 'navigate':
      return `stub navigate → ${intent.url} (returns 200; no real fetch)`;
    case 'interact':
      return `stub ${intent.action}${intent.selector ? ' on ' + intent.selector : ''}${intent.value !== undefined ? ' with value ' + intent.value : ''}`;
    case 'wait':
      return `stub wait ${intent.condition}${intent.selector ? ' on ' + intent.selector : ''}${intent.timeoutMs !== undefined ? ' (' + intent.timeoutMs + 'ms)' : ''}`;
    case 'capture':
      return `stub captured ${intent.capture}`;
  }
}

/**
 * Helper for the dashboard chat-UI: render an ExecutorRunResult as a
 * TranscriptEntry the agent's next turn can read. Keeps the
 * serialization rule in one place — every consumer that wants to
 * append executor results to a transcript must use this so the
 * decomposer sees consistent output formatting in `history`.
 */
export function runResultToTranscriptEntry(
  runResult: ExecutorRunResult,
  at: string,
): TranscriptEntry {
  const lines: string[] = [];
  for (const r of runResult.results) {
    if (r.kind === 'success') {
      lines.push(`✓ ${r.summary}`);
    } else {
      lines.push(`✗ ${r.intent.kind} — ${r.reason}`);
    }
  }
  if (!runResult.ok) {
    lines.push('(plan halted on failure)');
  }
  return {
    at,
    role: 'agent',
    body: lines.join('\n'),
  };
}
