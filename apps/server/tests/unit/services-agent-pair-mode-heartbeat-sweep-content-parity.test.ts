// Drift guard for apps/server/src/services/agent-pair-mode-heartbeat-sweep.ts.
// Pins the Arc 4 Wave 2.B sub-slice 8.13c heartbeat sweep — closing the
// pair-mode-heartbeat trio (8.13 state-machine transition + 8.13b
// tracker + 8.13c sweep). Load-bearing: defends the 5-step tickOnce
// pipeline + the idempotent-on-ai-driving short-circuit + the
// account-audit emit semantics.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/agent-pair-mode-heartbeat-sweep.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/agent-pair-mode-heartbeat-sweep content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Arc 4 Wave 2.B sub-slice 8.13c module-level framing pinned: 'pair-mode heartbeat sweep. Walks PairModeHeartbeatTracker.findStaleSessions(), fires the heartbeat-timeout state-machine transition for each, persists the post-transition state, and emits an agent_session.pair_mode.timeout customer audit row. Bounded by the in-memory tracker's session count + the TTL — typical sweep touches zero sessions; under heavy use it touches one per stale pair-mode session.' — pinned so the 8.13c anchor + tracker-walk + state-transition + audit-emit pipeline contract + the bounded-by-tracker-count complexity rationale stay documented", () => {
    expect(body).toMatch(
      /\/\/ Arc 4 Wave 2\.B sub-slice 8\.13c \(v2-#8\) — pair-mode heartbeat sweep\./,
    );
    expect(body).toMatch(
      /\/\/ Walks PairModeHeartbeatTracker\.findStaleSessions\(\), fires the\s*\n?\s*\/\/ `heartbeat-timeout` state-machine transition for each, persists\s*\n?\s*\/\/ the post-transition state, and emits an\s*\n?\s*\/\/ `agent_session\.pair_mode\.timeout` customer audit row\./,
    );
  });

  it('Scheduling framing, corrected by V-808: the sweep has been WIRED since 8.13d landed — bootstrap constructs it and drives tickOnce from a 5s setInterval. The 5s cadence and the reason for a timer rather than a durable chain (interactive auto-handback needs sub-minute latency, and a 5s interval reaches its first tick immediately, unlike the 24h timers V-784 moved) are what stay pinned', () => {
    expect(body).toMatch(
      /\/\/ Scheduling: WIRED\. `bootstrap\.ts` constructs this service and drives/,
    );
    expect(body).toMatch(/PAIR_MODE_HEARTBEAT_SWEEP_INTERVAL_MS = 5_000/);
    expect(body, 'the 5s cadence and its reason are the load-bearing part').toMatch(
      /needs sub-minute latency/,
    );
    // V-808 — wired since 8.13d landed; the future-tense promise is retired.
    expect(body).not.toMatch(/for a future\s*\n?\s*\/\/ scheduled-jobs entry/);
    expect(body).not.toMatch(/Sub-slice 8\.13d will wire bootstrap/);
  });

  it("PairModeHeartbeatSweepDeps 5-field shape pinned: tracker + sessions + accountAudit (optional) + ttlMs (optional override) + maxPerTick (default 100). + 'Cap on sessions handled per tick so a flood of stale sessions doesn't block the scheduler. Default 100.' — pinned so the maxPerTick-protects-scheduler rationale + the 100-default + accountAudit-optional contract stay documented (drift to making accountAudit required would force every dev environment to wire up the audit service)", () => {
    expect(body).toMatch(/export interface PairModeHeartbeatSweepDeps \{/);
    expect(body).toMatch(/readonly tracker: PairModeHeartbeatTracker;/);
    expect(body).toMatch(/readonly sessions: AgentSessionsRepo;/);
    expect(body).toMatch(/readonly accountAudit\?: AccountAuditService;/);
    expect(body).toMatch(
      /\/\*\* Override the 30s default for testing\. \*\/\s*\n?\s*readonly ttlMs\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Cap on sessions handled per tick so a flood of stale sessions\s*\n?\s*\*\s+doesn't block the scheduler\. Default 100\. \*\/\s*\n?\s*readonly maxPerTick\?: number;/,
    );
  });

  it("SweepTickResult 3-field shape pinned: inspected + transitioned + truncated. + 'Truncated when the stale set exceeded maxPerTick.' — pinned so the observability surface stays documented (drift to dropping `truncated` would let scheduler operators miss the case where maxPerTick is too low for actual load)", () => {
    expect(body).toMatch(
      /export interface SweepTickResult \{\s*\n?\s*readonly inspected: number;\s*\n?\s*readonly transitioned: number;\s*\n?\s*\/\*\* Truncated when the stale set exceeded maxPerTick\. \*\/\s*\n?\s*readonly truncated: boolean;\s*\n?\s*\}/,
    );
  });

  it('tickOnce 5-step pipeline framing pins lookup, transition, atomic expected-state persistence, best-effort audit, and refresh-safe tracker cleanup', () => {
    expect(body).toMatch(
      /\* Walk one sweep cycle\. For each session whose lastHeartbeatAt is\s*\n?\s*\*\s+older than now - ttlMs:/,
    );
    expect(body).toMatch(
      /\*\s+1\. Look up the session record \(skip if it no longer exists\)\s*\n?\s*\*\s+2\. Compute the heartbeat-timeout transition against the current\s*\n?\s*\*\s+pair_mode_state \(silent no-op when already in ai-driving\)\s*\n?\s*\*\s+3\. Atomically persist only if the active pair-mode row still has the\s*\n?\s*\*\s+inspected state \(a concurrent input\/mode transition wins otherwise\)\s*\n?\s*\*\s+4\. Emit an audit row via accountAudit\.record \(best-effort —\s*\n?\s*\*\s+failures don't break the sweep\)\s*\n?\s*\*\s+5\. Forget only the stale heartbeat snapshot\. If a heartbeat refreshed\s*\n?\s*\*\s+while the database write was in flight, roll back this exact timeout/,
    );
    expect(body).toMatch(/sessions\.compareAndSetPairModeState\(/);
    expect(body).toMatch(/latestHeartbeatAt\?\.getTime\(\) !== observedHeartbeatAt\.getTime\(\)/);
  });

  it("Session-no-longer-exists short-circuit pinned: rec === null → tracker.forget(sessionId) + continue. + 'Session destroyed/gc'd — forget so the tracker doesn't keep flagging.' — pinned so the gc'd-session path + tracker-cleanup contract stay documented (drift to throwing on null would break the sweep on race-with-session-destroy)", () => {
    expect(body).toMatch(
      /if \(rec === null\) \{\s*\n?\s*\/\/ Session destroyed\/gc'd — forget so the tracker doesn't\s*\n?\s*\/\/ keep flagging\.\s*\n?\s*this\.deps\.tracker\.forget\(sessionId\);\s*\n?\s*continue;\s*\n?\s*\}/,
    );
  });

  it("Closed-session short-circuit framing pinned: 'Closed session: the customer's pair-mode session is done. No point firing a heartbeat-timeout transition (closed sessions can't transition state anyway, and the audit row would be misleading — auto-handback after 30s on a row that's been closed for hours). Forget the tracker entry + continue.' — pinned so the closed-status skip-without-audit rationale stays documented (drift to firing the transition anyway would emit misleading 'auto-handback after 30s' rows for sessions closed hours ago)", () => {
    expect(body).toMatch(
      /\/\/ Closed session: the customer's pair-mode session is done\.\s*\n?\s*\/\/ No point firing a heartbeat-timeout transition \(closed\s*\n?\s*\/\/ sessions can't transition state anyway, and the audit row\s*\n?\s*\/\/ would be misleading — "auto-handback after 30s" on a row\s*\n?\s*\/\/ that's been closed for hours\)\. Forget the tracker entry \+\s*\n?\s*\/\/ continue\./,
    );
    expect(body).toMatch(
      /if \(rec\.status === 'closed'\) \{\s*\n?\s*this\.deps\.tracker\.forget\(sessionId\);\s*\n?\s*continue;\s*\n?\s*\}/,
    );
  });

  it("Idempotent-on-ai-driving short-circuit framing pinned: 'The heartbeat-timeout transition is idempotent on ai-driving (silent no-op). The state machine accepts it from every state so the sweep doesn't need to inspect state first.' — pinned so the no-op-on-equal-kind short-circuit + the accept-from-every-state design rationale survive (drift to inspecting state pre-transition would couple sweep to state-machine internals)", () => {
    expect(body).toMatch(
      /\/\/ The heartbeat-timeout transition is idempotent on ai-driving\s*\n?\s*\/\/ \(silent no-op\)\. The state machine accepts it from every state\s*\n?\s*\/\/ so the sweep doesn't need to inspect state first\./,
    );
    expect(body).toMatch(
      /if \(nextState\.kind === currentState\.kind\) \{\s*\n?\s*\/\/ No-op transition \(e\.g\. already in ai-driving\)\. Skip the\s*\n?\s*\/\/ persist \+ audit emit — there's no state change to record\./,
    );
  });

  it("Audit emit best-effort swallow pinned: 'try { await this.deps.accountAudit?.record(...) } catch { /* swallow — sweep continues even when audit emit fails */ }'. Drift to letting errors propagate would let a single audit-emit failure halt the entire sweep batch (breaking the bounded-complexity contract from the module-level comment)", () => {
    expect(body).toMatch(
      /try \{\s*\n?\s*await this\.deps\.accountAudit\?\.record\(\{\s*\n?\s*accountId: rec\.accountId,\s*\n?\s*actorType: 'system',\s*\n?\s*action: 'agent_session\.pair_mode\.timeout',\s*\n?\s*targetResourceId: `agent_session_\$\{sessionId\}`,\s*\n?\s*payload: \{ from: currentState\.kind, to: nextState\.kind \},\s*\n?\s*\}\);\s*\n?\s*\} catch \{\s*\n?\s*\/\* swallow — sweep continues even when audit emit fails \*\/\s*\n?\s*\}/,
    );
  });

  it("Audit-row shape pinned: actorType 'system' + action 'agent_session.pair_mode.timeout' + targetResourceId `agent_session_${sessionId}` + payload { from, to }. Drift would diverge from the audit-log catalog that the dashboard's audit-log page filters on (V-354 + V-399 framings depend on the exact action string)", () => {
    expect(body).toMatch(/actorType: 'system',/);
    expect(body).toMatch(/action: 'agent_session\.pair_mode\.timeout',/);
    expect(body).toMatch(/targetResourceId: `agent_session_\$\{sessionId\}`,/);
    expect(body).toMatch(/payload: \{ from: currentState\.kind, to: nextState\.kind \},/);
  });
});
