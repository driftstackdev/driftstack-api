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
import type {
  CaptureKind,
  FailureDiagnosis,
  InteractAction,
  WaitCondition,
} from '@driftstack/api-types';
import {
  classifyConsequentialAction,
  type ConsequentialActionCategory,
} from './agent-consequential-action.js';

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
      /** doc-132 §5.3 — machine-readable failure diagnosis (mirrors the
       *  api-types IntentResult failure variant). Optional: only the
       *  control-plane executor populates it today (via intentResultToCustomer);
       *  the driver-path variants omit it. */
      diagnosis?: FailureDiagnosis;
    }
  | {
      // W443/W445 — the executor halted BEFORE dispatching a consequential
      // action (purchase / payment / account-deletion) that needs human
      // confirmation. The customer approves, then the plan re-runs with this
      // action's signature in `approvedConsequentialActions`.
      kind: 'confirmation_required';
      intent: AgentIntent;
      category: ConsequentialActionCategory;
      /** The matched consequential phrase — surfaced in the confirmation prompt. */
      matchedText: string;
    };

export interface ExecutorRunResult {
  results: ReadonlyArray<IntentResult>;
  /** True iff every intent in the plan returned `kind: success`.
   *  False if any intent failed OR the plan halted awaiting confirmation. */
  ok: boolean;
  /** True when the plan halted awaiting human confirmation of a consequential
   *  action (the last result is `kind: confirmation_required`) — distinct from
   *  a plain failure; the customer approves then the plan re-runs. */
  awaitingConfirmation?: boolean;
}

const EMPTY_APPROVED: ReadonlySet<string> = new Set<string>();

/** Stable signature of a consequential action, for the approve → re-run carry
 *  (the confirmation_required result echoes back as an approved signature). */
export function consequentialSignature(
  category: ConsequentialActionCategory,
  matchedText: string,
): string {
  return `${category}:${matchedText.toLowerCase()}`;
}

/** If `intent` is a consequential action not yet approved, returns the
 *  confirmation_required result to halt on; else null. Exported so every
 *  AgentExecutor implementation (Stub / Real / ControlPlane) applies the SAME
 *  human-confirmation gate — swapping executors must never drop it (#139/#130). */
export function consequentialHalt(
  intent: AgentIntent,
  approved: ReadonlySet<string>,
): Extract<IntentResult, { kind: 'confirmation_required' }> | null {
  const v = classifyConsequentialAction(intent);
  if (!v.requiresConfirmation || v.category === undefined || v.matchedText === undefined) {
    return null;
  }
  if (approved.has(consequentialSignature(v.category, v.matchedText))) return null;
  return {
    kind: 'confirmation_required',
    intent,
    category: v.category,
    matchedText: v.matchedText,
  };
}

export interface ExecuteArgs {
  /** /v1/sessions (driftstack `ses_…`) session id the plan runs against. Used by
   *  the legacy driver-path RealAgentExecutor. NULL/`unattached` for a pure
   *  /v1/agent-sessions run (no attached driftstack session) — the fleet path
   *  keys on `agentSessionId` instead. */
  sessionId: string;
  /**
   * #139 — the AGENT session id (`agt_…`). This is the id the fleet control plane
   * dispatched the session to the box under (sessionAssign) AND the key on
   * `agent_sessions.node_id`, so it is THE routing key for the control-plane
   * executor. The runtime always sets it; ControlPlaneAgentExecutor dispatches on
   * it. Optional on the interface so the legacy driver-path executors + existing
   * callers keep compiling (they use `sessionId`).
   */
  agentSessionId?: string;
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
  /** W443/W445 — signatures (consequentialSignature) of consequential actions
   *  the customer has already approved this run. The executor skips the
   *  confirmation halt for these so the re-run after approval proceeds. */
  approvedConsequentialActions?: ReadonlySet<string>;
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
    const approved = args.approvedConsequentialActions ?? EMPTY_APPROVED;
    for (const intent of args.plan.intents) {
      const halt = consequentialHalt(intent, approved);
      if (halt) {
        results.push(halt);
        return Promise.resolve({ results, ok: false, awaitingConfirmation: true });
      }
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
    const approved = args.approvedConsequentialActions ?? EMPTY_APPROVED;
    for (const intent of args.plan.intents) {
      // W443/W445 — halt BEFORE dispatching an unapproved consequential action
      // so the harness never executes it until the customer confirms.
      const halt = consequentialHalt(intent, approved);
      if (halt) {
        results.push(halt);
        return { results, ok: false, awaitingConfirmation: true };
      }
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
      case 'press': {
        // W540 (A3-W677) — key press. `value` carries the key name (e.g.
        // "Enter", "Escape"); driver InteractAction press caps it at 20 chars.
        if (intent.value === undefined || intent.value.length === 0) {
          return { kind: 'failure', intent, reason: 'press requires a value (the key name)' };
        }
        if (intent.value.length > 20) {
          return { kind: 'failure', intent, reason: 'press key name must be ≤20 characters' };
        }
        await this.deps.sessions.interact(account, sessionId, {
          action: { kind: 'press', key: intent.value },
        });
        return { kind: 'success', intent, summary: `pressed ${intent.value}` };
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
 * Neutralize an executor-derived free-text field before it becomes a line in
 * the transcript body that the decomposer replays to the model as history
 * (buildMessages sends `entry.body` verbatim). Two defense-in-depth properties,
 * both behaviour-preserving for legitimate content (summaries/reasons never
 * legitimately contain control characters, and a real URL/selector is well
 * under the cap):
 *  - STRUCTURAL: strip C0/C1 control characters (chiefly CR/LF) so a
 *    page-influenced string — most notably a `navigate` result URL
 *    (agent-intent-result summarize(): `navigated to ${outputData.url}`) or a
 *    harness/webdriver error message that reflects page text — cannot inject a
 *    raw newline and FORGE an extra transcript line (e.g. a fake "(plan
 *    approved)" the next turn would read as its own prior assistant output).
 *    The #139 go-live wired the real ControlPlaneAgentExecutor, so these fields
 *    now carry page-influenced text that was latent under the StubAgentExecutor
 *    (project_agent_runloop_prompt_injection_frame_surfaced). The SYSTEM_PROMPT
 *    already frames history observations as UNTRUSTED and the consequential-gate
 *    still bounds blast radius; this closes the structural line-forging channel
 *    the prose-level framing doesn't cover. The full fix — a distinct
 *    `observation` transcript role so buildMessages delimits these as untrusted
 *    DATA rather than assistant output — is a coordinated, prompt-eval-gated
 *    change; this is the safe interim.
 *  - BLOAT: cap length so a pathological multi-KB URL can't balloon the
 *    transcript / token spend. Mirrors the 200-char cap already applied to the
 *    failure reason in agent-intent-result.ts.
 */
export const MAX_TRANSCRIPT_FIELD_LEN = 512;
export function sanitizeTranscriptText(s: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return stripped.length > MAX_TRANSCRIPT_FIELD_LEN
    ? `${stripped.slice(0, MAX_TRANSCRIPT_FIELD_LEN)}…`
    : stripped;
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
    // `r.intent.kind` / `r.category` are fixed enums (safe); the free-text
    // fields (summary — carries the navigate result URL; reason — carries the
    // harness/webdriver message; matchedText — the matched consequential phrase)
    // are page-influenced now that the real executor is live, so neutralize them
    // before they join the transcript body the model replays as history.
    if (r.kind === 'success') {
      lines.push(`✓ ${sanitizeTranscriptText(r.summary)}`);
    } else if (r.kind === 'confirmation_required') {
      lines.push(
        `⏸ ${r.intent.kind} — confirmation required (${r.category}: "${sanitizeTranscriptText(r.matchedText)}")`,
      );
    } else {
      lines.push(`✗ ${r.intent.kind} — ${sanitizeTranscriptText(r.reason)}`);
    }
  }
  if (runResult.awaitingConfirmation) {
    lines.push('(plan paused — awaiting your confirmation of a consequential action)');
  } else if (runResult.results.some((r) => r.kind === 'failure' && r.intent.kind !== 'wait')) {
    // #139 — a best-effort `wait` failure no longer halts the plan (later steps
    // still run), so `!ok` alone no longer implies a halt. Only a NON-wait failure
    // actually breaks the run; a wait-only failure means the plan ran to completion
    // (its own ✗ line above already records the wait fault). Claiming "halted" when
    // a later step succeeded would contradict the transcript + mislead the next turn.
    lines.push('(plan halted on failure)');
  }
  return {
    at,
    role: 'agent',
    body: lines.join('\n'),
  };
}
