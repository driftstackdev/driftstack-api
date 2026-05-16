// AI-COMPOSE — AgentRuntime composes the three AI-CHAT primitives
// (AgentDecomposer + AgentSessionsRepo + AgentExecutor) into the
// single end-to-end loop the dashboard chat UI hits per turn:
//
//   user-message → load AgentSession → decomposer.decompose() →
//     (refuse | clarify | plan→executor.execute) → debit tokens →
//     append transcripts → return turn result
//
// This is the FIRST place where the three primitive interfaces meet,
// so the contract is testable end-to-end without any of them needing
// a real backend. Each can be swapped (Deterministic→Claude;
// Stub→Wired; InMemory→Drizzle) without changing the runtime.

import type { AgentDecomposer, DecomposeResult } from './agent-decomposer.js';
import type { AgentExecutor, ExecutorRunResult } from './agent-executor.js';
import { runResultToTranscriptEntry } from './agent-executor.js';
import type { AgentSessionRecord, AgentSessionsRepo } from './agent-sessions.js';

export interface RunTurnArgs {
  agentSessionId: string;
  /** Customer's free-text task. */
  userMessage: string;
  /**
   * Wall-clock for transcript entries + updatedAt. Defaulted to
   * `new Date()` by callers; injected here for deterministic tests.
   */
  now?: Date;
}

export type RunTurnResult =
  | {
      kind: 'plan-executed';
      decomposer: DecomposeResult;
      executor: ExecutorRunResult;
      session: AgentSessionRecord;
    }
  | {
      kind: 'clarify';
      decomposer: Extract<DecomposeResult, { kind: 'clarify' }>;
      session: AgentSessionRecord;
    }
  | {
      kind: 'refuse';
      decomposer: Extract<DecomposeResult, { kind: 'refuse' }>;
      session: AgentSessionRecord;
    }
  | {
      kind: 'session-closed';
      reason: string;
      session: AgentSessionRecord;
    };

export interface AgentRuntimeDeps {
  decomposer: AgentDecomposer;
  executor: AgentExecutor;
  sessions: AgentSessionsRepo;
  archetype: string;
}

export class AgentRuntime {
  constructor(private readonly deps: AgentRuntimeDeps) {}

  async runTurn(args: RunTurnArgs): Promise<RunTurnResult> {
    const at = (args.now ?? new Date()).toISOString();
    const session = await this.deps.sessions.get(args.agentSessionId);
    if (session === null) {
      throw new Error(`AgentSession ${args.agentSessionId} not found`);
    }
    if (session.status !== 'active') {
      // Closed/paused sessions return a short-circuit result. The
      // caller (route handler) maps this to a 409 Conflict — the
      // chat UI prompts the customer to start a new agent session.
      return {
        kind: 'session-closed',
        reason: session.closedReason ?? `session ${session.status}`,
        session,
      };
    }

    // Append the user turn FIRST so the decomposer sees its own
    // prior plans + the new user task in the history.
    await this.deps.sessions.appendTranscript(session.id, {
      at,
      role: 'user',
      body: args.userMessage,
    });
    const sessionWithUser = (await this.deps.sessions.get(session.id))!;

    const decomposed = await this.deps.decomposer.decompose({
      task: args.userMessage,
      archetype: this.deps.archetype,
      history: sessionWithUser.transcript,
      budgetTokensRemaining: sessionWithUser.tokenBudgetRemaining,
    });

    // Always debit the decomposer's tokens (even on refuse —
    // the input was processed). Budget-exhausted refusals charge
    // 0 per the AgentDecomposer contract.
    if (decomposed.tokensConsumed > 0) {
      await this.deps.sessions.debitTokens(session.id, decomposed.tokensConsumed);
    }

    if (decomposed.kind === 'refuse') {
      const updated = await this.deps.sessions.appendTranscript(session.id, {
        at,
        role: 'agent',
        body: `refused: ${decomposed.refuseReason}`,
      });
      return { kind: 'refuse', decomposer: decomposed, session: updated };
    }

    if (decomposed.kind === 'clarify') {
      const updated = await this.deps.sessions.appendTranscript(session.id, {
        at,
        role: 'agent',
        body: `clarify: ${decomposed.clarifyingQuestion}`,
      });
      return { kind: 'clarify', decomposer: decomposed, session: updated };
    }

    // Plan path — execute against the attached driftstack session if
    // present; otherwise the executor runs against a synthetic id (the
    // stub doesn't care, but the wired executor will 400 without a
    // real session). The dashboard chat-UI is responsible for
    // attaching a driftstack session before letting the customer
    // request plan-actionable tasks.
    const targetSessionId = sessionWithUser.driftstackSessionId ?? 'unattached';
    const executorResult = await this.deps.executor.execute({
      sessionId: targetSessionId,
      plan: decomposed,
    });

    const updated = await this.deps.sessions.appendTranscript(
      session.id,
      runResultToTranscriptEntry(executorResult, at),
    );

    return {
      kind: 'plan-executed',
      decomposer: decomposed,
      executor: executorResult,
      session: updated,
    };
  }
}
