// Drift guard for apps/server/src/services/agent-pair-mode-state.ts.
// Pins the Arc 2 sub-slice 8.7 pure pair-mode state machine — the
// 6-state PairModeState discriminated union, the PairModeTransition
// catalog, the state-transition table comment, and the
// PairModeStateInvalidTransitionError surface.
//
// Load-bearing: the state machine is the source of truth for
// takeover/handback transitions. Drift here silently corrupts
// the discriminator semantics that the dashboard SSE consumers
// + the SDK pair-mode error catalog both pin.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/agent-pair-mode-state.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/agent-pair-mode-state content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Arc 2 sub-slice 8.7 module-level framing pinned: 'Pure pair-mode state machine. Lives separate from AgentSessionsRepo so transitions can be tested without an actor boundary. The route layer (sub-slice 8.9) wraps these helpers with a Redis lock (sub-slice 8.8) and persists results via AgentSessionsRepo.setPairModeState.' — pinned so the pure-state-machine + separation-from-repo + Redis-lock cross-reference all stay documented", () => {
    expect(body).toMatch(/\/\/ Arc 2 sub-slice 8\.7 \(v2-#8 AI chat \+ manual side-by-side\)\./);
    expect(body).toMatch(
      /\/\/ Pure pair-mode state machine\. Lives separate from AgentSessionsRepo\s*\/\/ so transitions can be tested without an actor boundary\. The route\s*\/\/ layer \(sub-slice 8\.9\) wraps these helpers with a Redis lock\s*\/\/ \(sub-slice 8\.8\) and persists results via\s*\/\/ AgentSessionsRepo\.setPairModeState\./,
    );
  });

  it('Transition table framing pinned: founder verdict 2026-05-18 implicit queue spec + Wave 2.A 8.11 mid-runTurn queue path. All 7 transitions documented as a Unicode arrow table. Drift would orphan readers from the state-flow diagram', () => {
    expect(body).toMatch(
      /\/\/ States \+ transitions \(founder verdict 2026-05-18 implicit in the\s*\/\/ queue spec; Wave 2\.A 8\.11 adds the mid-runTurn queue path\):/,
    );
    expect(body).toMatch(/\/\/ {3}ai-driving {9}── takeover-request {10}─→ {2}takeover-pending/);
    expect(body).toMatch(
      /\/\/ {3}ai-driving {9}── takeover-request-queued {3}─→ {2}takeover-queued {5}\(Wave 2\.A 8\.11\)/,
    );
    expect(body).toMatch(
      /\/\/ {3}takeover-queued {4}── decompose-settled {9}─→ {2}takeover-pending {4}\(Wave 2\.A 8\.11\)/,
    );
    expect(body).toMatch(
      /\/\/ {3}takeover-queued {4}── takeover-decline {10}─→ {2}ai-driving {10}\(Wave 2\.A 8\.11\)/,
    );
    expect(body).toMatch(/\/\/ {3}takeover-pending {3}── takeover-grant {12}─→ {2}human-driving/);
    expect(body).toMatch(/\/\/ {3}human-driving {6}── handback-request {10}─→ {2}handback-pending/);
    expect(body).toMatch(/\/\/ {3}handback-pending {3}── handback-complete {9}─→ {2}ai-driving/);
  });

  it("Cancellation-paths framing pinned: 'Cancellation paths return to the prior state if the request was declined; explicit takeover-decline / handback-cancel transitions handle the rollback. Any other transition throws PairModeStateInvalidTransitionError (sub-slice 8.10 surfaces it as a typed SDK error).' — pinned so the rollback-on-decline contract + the 8.10 SDK-error cross-reference survive", () => {
    expect(body).toMatch(
      /\/\/ Cancellation paths return to the prior state if the request was\s*\/\/ declined; explicit `takeover-decline` \/ `handback-cancel` transitions\s*\/\/ handle the rollback\. Any other transition throws\s*\/\/ PairModeStateInvalidTransitionError \(sub-slice 8\.10 surfaces it\s*\/\/ as a typed SDK error\)\./,
    );
  });

  it('PairModeState 6-variant discriminated union pins controller identity through handback pending/queued rollback', () => {
    expect(body).toMatch(/export type PairModeState =/);
    expect(body).toMatch(/\| \{ kind: 'ai-driving' \}/);
    expect(body).toMatch(
      /\| \{ kind: 'takeover-pending'; requestedByClientId: string; requestedAt: string \}/,
    );
    expect(body).toMatch(/\| \{ kind: 'human-driving'; clientId: string; sinceAt: string \}/);
    expect(body).toContain("kind: 'handback-pending';");
    expect(body).toContain('clientId?: string;');
    expect(body).toContain('sinceAt?: string;');
    expect(body).toMatch(
      /\| \{ kind: 'takeover-queued'; requestedByClientId: string; queuedAt: string \}/,
    );
    expect(body).toContain("kind: 'handback-queued';");
  });

  it('PairModeTransition 9-variant catalog pinned: takeover-request + takeover-grant + takeover-decline + handback-request + handback-complete + handback-cancel + takeover-request-queued (8.11) + decompose-settled (8.11) + handback-request-queued (8.12) + heartbeat-timeout (8.13). Drift to dropping a transition would either break the route layer that fires it OR (worse) leave a transition fired with no reducer arm to handle it', () => {
    expect(body).toMatch(/export type PairModeTransition =/);
    expect(body).toMatch(/\| \{ kind: 'takeover-request'; clientId: string; at: string \}/);
    expect(body).toMatch(/\| \{ kind: 'takeover-grant'; at: string \}/);
    expect(body).toMatch(/\| \{ kind: 'takeover-decline' \}/);
    expect(body).toMatch(/\| \{ kind: 'handback-request'; at: string \}/);
    expect(body).toMatch(/\| \{ kind: 'handback-complete' \}/);
    expect(body).toMatch(/\| \{ kind: 'handback-cancel' \}/);
    expect(body).toMatch(/\| \{ kind: 'takeover-request-queued'; clientId: string; at: string \}/);
    expect(body).toMatch(/\| \{ kind: 'decompose-settled'; at: string \}/);
    expect(body).toMatch(/\| \{ kind: 'handback-request-queued'; clientId: string; at: string \}/);
    expect(body).toMatch(/\| \{ kind: 'heartbeat-timeout'; at: string \}/);
  });

  it("PairModeStateInvalidTransitionError class pinned: from + transition kind + message format 'Invalid pair-mode transition: <transition> not allowed from <from>'. Drift to a different message would break the SDK's typed-error parsing (the error is mapped to a 409 with this specific text in the body)", () => {
    expect(body).toMatch(/export class PairModeStateInvalidTransitionError extends Error \{/);
    expect(body).toMatch(
      /constructor\(\s*public readonly from: PairModeState\['kind'\],\s*public readonly transition: PairModeTransition\['kind'\],\s*\)/,
    );
    expect(body).toMatch(
      /super\(`Invalid pair-mode transition: \$\{transition\} not allowed from \$\{from\}`\);/,
    );
  });

  it("initialPairModeState() returns { kind: 'ai-driving' } pinned. Drift to a different initial state would silently change the semantics of newly-created agent sessions (the dashboard SSE consumer + the runtime both assume ai-driving as the create-time discriminator)", () => {
    expect(body).toMatch(
      /export function initialPairModeState\(\): PairModeState \{\s*return \{ kind: 'ai-driving' \};\s*\}/,
    );
  });

  it("Wave 2.A 8.11 takeover-queued framing pinned: 'intermediate state when a takeover request lands while AgentRuntime.runTurn is mid-flight (decompose still resolving). The state machine holds the request here until the runtime fires decompose-settled, at which point the queued request flows through to takeover-pending. SSE subscribers see this discriminator so the dashboard can render takeover queued — waiting for the current AI turn to finish.' — pinned so the queue-during-decompose semantics + the SSE-discriminator-rendered-by-dashboard contract stay documented", () => {
    expect(body).toMatch(
      /Arc 4 Wave 2\.A sub-slice 8\.11 \(v2-#8\) — intermediate state when a\s*\*\s+takeover request lands while AgentRuntime\.runTurn is mid-flight/,
    );
    expect(body).toMatch(
      /SSE\s*\*\s+subscribers see this discriminator so the dashboard can render\s*\*\s+"takeover queued — waiting for the current AI turn to finish"\./,
    );
  });

  it("Wave 2.A 8.13 heartbeat-timeout auto-handback framing pinned: 'auto-handback to ai-driving after 30s of no client heartbeat. The state-machine accepts this transition from any non-ai-driving state so the timer service can fire it without inspecting the current state first. Idempotent on ai-driving (silent no-op).' — pinned so the 30s-timeout + accept-from-any-state + idempotent-on-ai-driving contract survives", () => {
    expect(body).toMatch(
      /Arc 4 Wave 2\.A sub-slice 8\.13 \(v2-#8\) — auto-handback to ai-driving\s*\*\s+after 30s of no client heartbeat\. The state-machine accepts this\s*\*\s+transition from any non-ai-driving state so the timer service can\s*\*\s+fire it without inspecting the current state first\. Idempotent on\s*\*\s+ai-driving \(silent no-op\)\./,
    );
  });

  it('applyPairModeTransition() switch-statement structure pinned: 5 case arms (ai-driving + takeover-queued + takeover-pending + human-driving + handback-queued + handback-pending). Drift to dropping a case would let calls to that state silently fall through; drift to dropping the switch would break the discriminator-exhaustive type-checking', () => {
    expect(body).toMatch(/case 'ai-driving':/);
    expect(body).toMatch(/case 'takeover-queued':/);
    expect(body).toMatch(/case 'takeover-pending':/);
    expect(body).toMatch(/case 'human-driving':/);
    expect(body).toMatch(/case 'handback-queued':/);
    expect(body).toMatch(/case 'handback-pending':/);
  });

  it("decompose-settled idempotent silent-no-op from non-queued states pinned: ai-driving + takeover-pending + human-driving + handback-pending all silently return current state on decompose-settled. Drift to throwing would force the runtime to inspect state before firing — which it deliberately doesn't (the runtime fires unconditionally per the 8.11 comment)", () => {
    expect(body).toMatch(
      /\/\/ 'decompose-settled' is a silent no-op from ai-driving — the\s*\/\/ runtime always fires it on decompose completion regardless of\s*\/\/ whether a queue exists, so accepting it here keeps the wire\s*\/\/ contract simple/,
    );
  });

  it('handback-cancel restores the preserved controller; unknown/requestedAt remain legacy-state fallbacks only', () => {
    expect(body).toMatch(
      /\/\/ New states preserve the exact controller identity \+ original takeover\s*\/\/ time\. The fallbacks apply only to persisted pre-fix transient states\./,
    );
    expect(body).toContain("clientId: state.clientId ?? 'unknown'");
    expect(body).toContain('sinceAt: state.sinceAt ?? state.requestedAt');
  });
});
