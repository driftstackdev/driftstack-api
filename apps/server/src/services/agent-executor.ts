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
import type { AccountContext } from './auth.js';
import type { CaptureKind, InteractAction, WaitCondition } from '@driftstack/api-types';

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
  /**
   * AI-B2.b — the caller's AccountContext, required by RealAgentExecutor
   * for ownership-scoped SessionsService dispatch. Optional on the
   * interface so StubAgentExecutor (which ignores it) + existing callers
   * keep working; RealAgentExecutor surfaces a typed failure if it's
   * absent. The runtime threads it once the bootstrap swap (increment
   * 1.5) wires the real executor.
   */
  account?: AccountContext;
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

/**
 * The narrow slice of SessionsService the executor dispatches against.
 * Declared as a port (not the whole SessionsService) so the executor stays
 * decoupled + unit-testable with a mock; the real SessionsService satisfies
 * it structurally.
 */
export interface ExecutorSessionsPort {
  navigate(
    ctx: AccountContext,
    sessionId: string,
    body: { url: string },
  ): Promise<{ finalUrl: string; status: number }>;
  interact(
    ctx: AccountContext,
    sessionId: string,
    body: { action: InteractAction },
  ): Promise<{ durationMs: number }>;
  wait(
    ctx: AccountContext,
    sessionId: string,
    body: { condition: WaitCondition },
  ): Promise<{ satisfied: boolean }>;
  capture(
    ctx: AccountContext,
    sessionId: string,
    body: { kind: CaptureKind },
  ): Promise<{ kind: CaptureKind; byteSize: number }>;
}

export interface RealAgentExecutorDeps {
  sessions: ExecutorSessionsPort;
}

/**
 * AI-B2.b increment 1 — real intent executor. Dispatches each plan intent
 * against the in-process SessionsService (the /v1/sessions/:id/{navigate,
 * interact,capture} surface), halting on first failure, never throwing.
 * Replaces StubAgentExecutor's synthetic success.
 *
 * SCOPE: dispatches navigate / interact:tap / interact:type / interact:scroll /
 * wait / capture against the driver, reconciling the AgentIntent vocab onto the
 * driver's shapes (AI-B2.c): wait.condition selector_visible→{kind:selector},
 * idle→{kind:time} (no driver idle predicate — a bounded time wait is the closest
 * honest mapping); scroll (no AgentIntent delta) → one-viewport vertical scroll,
 * direction/magnitude from the optional `value`. Only `interact:swipe` returns a
 * typed failure — it has no driver gesture AND no direction in AgentIntent
 * (genuinely underspecified; resolved in the customer-schema increment).
 *
 * NOT wired into bootstrap yet — the runtime still uses StubAgentExecutor —
 * pending the real-session-provisioning check (the wired executor 400s without
 * a real /v1/sessions session; agent-runtime uses 'unattached' when none).
 * prod driver is `mock`, so once wired, dispatch hits the deterministic mock
 * until Agent-1's webkit driver lands.
 */
export class RealAgentExecutor implements AgentExecutor {
  constructor(private readonly deps: RealAgentExecutorDeps) {}

  async execute(args: ExecuteArgs): Promise<ExecutorRunResult> {
    const account = args.account;
    if (!account) {
      // The real executor requires the caller's AccountContext for
      // ownership-scoped dispatch. Surface as failure(s) rather than
      // throwing (the never-throw contract).
      const results: IntentResult[] = args.plan.intents.map((intent) => ({
        kind: 'failure',
        intent,
        reason: 'executor missing account context',
      }));
      return { results, ok: results.length === 0 };
    }
    const results: IntentResult[] = [];
    for (const intent of args.plan.intents) {
      const result = await this.dispatch(account, args.sessionId, intent);
      results.push(result);
      if (result.kind === 'failure') return { results, ok: false };
    }
    return { results, ok: true };
  }

  private async dispatch(
    account: AccountContext,
    sessionId: string,
    intent: AgentIntent,
  ): Promise<IntentResult> {
    try {
      switch (intent.kind) {
        case 'navigate': {
          const r = await this.deps.sessions.navigate(account, sessionId, { url: intent.url });
          return {
            kind: 'success',
            intent,
            summary: `navigated → ${r.finalUrl} (status ${r.status})`,
          };
        }
        case 'interact':
          return await this.dispatchInteract(account, sessionId, intent);
        case 'capture': {
          const r = await this.deps.sessions.capture(account, sessionId, { kind: intent.capture });
          return { kind: 'success', intent, summary: `captured ${r.kind} (${r.byteSize} bytes)` };
        }
        case 'wait':
          return await this.dispatchWait(account, sessionId, intent);
        case 'scroll': {
          // Directional viewport scroll → the driver's delta-based scroll
          // (this superseded local-driver path; the harness control-plane
          // executes the persona-shaped flick). amount_px omitted → 600px.
          const delta = (intent.direction === 'up' ? -1 : 1) * (intent.amount_px ?? 600);
          await this.deps.sessions.interact(account, sessionId, {
            action: { kind: 'scroll', delta_x: 0, delta_y: delta },
          });
          return {
            kind: 'success',
            intent,
            summary: `scrolled ${intent.direction}${intent.amount_px !== undefined ? ` ${intent.amount_px}px` : ''}`,
          };
        }
        case 'behavioral_pause':
          // The local driver has no persona-timing; the real persona-shaped
          // pause runs harness-side over the control plane. Acknowledge here.
          return {
            kind: 'success',
            intent,
            summary: 'behavioural pause (executed harness-side; no-op in local-driver executor)',
          };
      }
    } catch (err) {
      return {
        kind: 'failure',
        intent,
        reason: err instanceof Error ? err.message : 'dispatch failed',
      };
    }
  }

  private async dispatchInteract(
    account: AccountContext,
    sessionId: string,
    intent: Extract<AgentIntent, { kind: 'interact' }>,
  ): Promise<IntentResult> {
    switch (intent.action) {
      case 'tap': {
        if (intent.selector === undefined) {
          return { kind: 'failure', intent, reason: 'tap requires a selector' };
        }
        await this.deps.sessions.interact(account, sessionId, {
          action: { kind: 'tap', selector: intent.selector },
        });
        return { kind: 'success', intent, summary: `tapped ${intent.selector}` };
      }
      case 'type': {
        if (intent.selector === undefined || intent.value === undefined) {
          return { kind: 'failure', intent, reason: 'type requires a selector and value' };
        }
        await this.deps.sessions.interact(account, sessionId, {
          action: { kind: 'type', selector: intent.selector, text: intent.value },
        });
        return { kind: 'success', intent, summary: `typed into ${intent.selector}` };
      }
      case 'scroll': {
        // AgentIntent scroll carries no delta — map to a one-viewport vertical
        // scroll (down by default; 'up' via value), honoring an optional
        // selector + a non-negative integer `value` as the pixel magnitude.
        const direction = intent.value === 'up' ? -1 : 1;
        const magnitude =
          intent.value !== undefined && /^\d+$/.test(intent.value) ? Number(intent.value) : 600;
        await this.deps.sessions.interact(account, sessionId, {
          action: {
            kind: 'scroll',
            ...(intent.selector !== undefined ? { selector: intent.selector } : {}),
            delta_x: 0,
            delta_y: direction * magnitude,
          },
        });
        return {
          kind: 'success',
          intent,
          summary: `scrolled ${intent.value === 'up' ? 'up' : 'down'}`,
        };
      }
      case 'swipe':
        // No driver gesture maps to swipe (the driver has scroll, not swipe) and
        // AgentIntent.swipe carries no direction — genuinely underspecified.
        // Resolved in the customer-schema increment (drop or replace with scroll).
        return {
          kind: 'failure',
          intent,
          reason: 'swipe is not supported — use scroll (no driver swipe gesture)',
        };
    }
  }

  private async dispatchWait(
    account: AccountContext,
    sessionId: string,
    intent: Extract<AgentIntent, { kind: 'wait' }>,
  ): Promise<IntentResult> {
    // Reconcile the AgentIntent wait vocab (idle | selector_visible) onto the
    // driver's WaitCondition union. selector_hidden / url_matches aren't
    // reachable from AgentIntent today.
    let condition: WaitCondition;
    if (intent.condition === 'selector_visible') {
      if (intent.selector === undefined) {
        return { kind: 'failure', intent, reason: 'wait selector_visible requires a selector' };
      }
      condition = { kind: 'selector', selector: intent.selector };
    } else {
      // 'idle' has no driver predicate → bounded time wait (clamped to the
      // driver's 0–60_000ms range; defaults to 1s when no timeout given).
      const ms = Math.min(60_000, Math.max(0, intent.timeoutMs ?? 1000));
      condition = { kind: 'time', ms };
    }
    const r = await this.deps.sessions.wait(account, sessionId, { condition });
    return {
      kind: 'success',
      intent,
      summary: `waited (${intent.condition}) → ${r.satisfied ? 'satisfied' : 'timed out'}`,
    };
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
    case 'scroll':
      return `stub scroll ${intent.direction}${intent.amount_px !== undefined ? ' ' + intent.amount_px + 'px' : ''}`;
    case 'behavioral_pause':
      return `stub behavioural pause${intent.reading_word_count !== undefined ? ' (reading ' + intent.reading_word_count + ' words)' : intent.duration_ms !== undefined ? ' (' + intent.duration_ms + 'ms)' : ''}`;
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
