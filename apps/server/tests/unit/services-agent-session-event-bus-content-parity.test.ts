// Drift guard for apps/server/src/services/agent-session-event-bus.ts.
// Pins the Arc 2 sub-slice 8.3 in-process pub/sub for agent-session
// transcript events — mirrors V-295e IncidentEventBus shape so a
// future redis swap is invisible to call sites.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/agent-session-event-bus.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/agent-session-event-bus content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Arc 2 sub-slice 8.3 module-level framing pinned: 'In-process pub/sub for agent-session transcript events. Mirrors the V-295e IncidentEventBus shape so a future redis-backed implementation drops in without changing the call sites.' — pinned so the 8.3 anchor + V-295e cross-reference + invisible-redis-swap contract stay documented", () => {
    expect(body).toMatch(/\/\/ Arc 2 sub-slice 8\.3 \(v2-#8 AI chat \+ manual side-by-side\)\./);
    expect(body).toMatch(
      /\/\/ In-process pub\/sub for agent-session transcript events\. Mirrors\s*\/\/ the V-295e IncidentEventBus shape so a future redis-backed\s*\/\/ implementation drops in without changing the call sites\./,
    );
  });

  it("SSE-consumer semantics framing pinned: 'SSE consumers (sub-slice 8.3 route) subscribe per-sessionId and receive every transcript entry appended after the subscription instant. The route layer is responsible for replaying past entries from the repo before live-streaming new ones — the bus does NOT buffer history.' — pinned so the no-history-buffer + route-replays-from-repo contract stays explicit (drift to in-bus buffering would couple bus memory to transcript size + duplicate the repo's history role)", () => {
    expect(body).toMatch(
      /\/\/ SSE consumers \(sub-slice 8\.3 route\) subscribe per-sessionId and\s*\/\/ receive every transcript entry appended after the subscription\s*\/\/ instant\. The route layer is responsible for replaying past entries\s*\/\/ from the repo before live-streaming new ones — the bus does NOT\s*\/\/ buffer history\./,
    );
  });

  it("Decoupled-from-AgentRuntime framing pinned: 'Decoupled from AgentRuntime so the bus can be wired only when the SSE endpoint is registered; AgentRuntime publishes via an injected optional eventBus (no-op when omitted).' — pinned so the optional-bus + no-op-when-omitted contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Decoupled from AgentRuntime so the bus can be wired only when the\s*\/\/ SSE endpoint is registered; AgentRuntime publishes via an injected\s*\/\/ optional `eventBus` \(no-op when omitted\)\./,
    );
  });

  it('AgentSessionTranscriptEvent 3-field shape pinned: agentSessionId + index (post-append index, drives SSE event-id for Last-Event-ID resume) + entry. Drift to dropping index would break the SSE resume-via-Last-Event-ID contract after a disconnect', () => {
    expect(body).toMatch(/export interface AgentSessionTranscriptEvent \{/);
    expect(body).toMatch(/agentSessionId: string;/);
    expect(body).toMatch(
      /\/\*\* Index of the entry in the session's transcript array AFTER the\s*\*\s+append\. Drives the SSE event-id so clients can resume via\s*\*\s+Last-Event-ID after a disconnect\. \*\/\s*index: number;/,
    );
    expect(body).toMatch(/entry: TranscriptEntry;/);
  });

  it('AgentSessionTranscriptHandler type alias pinned: callback receiving an AgentSessionTranscriptEvent (void return). Drift to async handler would invite back-pressure surprises (the publisher does not await)', () => {
    expect(body).toMatch(
      /export type AgentSessionTranscriptHandler = \(event: AgentSessionTranscriptEvent\) => void;/,
    );
  });

  it('AgentSessionEventBus 3-method surface pinned: subscribe (returns unsubscribe fn) + publish + subscriberCount (test-only). Drift to dropping the unsubscribe-returning-fn pattern would force callers to track sessionId+handler pairs for manual deregistration', () => {
    expect(body).toMatch(/export class AgentSessionEventBus \{/);
    expect(body).toMatch(
      /subscribe\(sessionId: string, handler: AgentSessionTranscriptHandler\): \(\) => void/,
    );
    expect(body).toMatch(/publish\(event: AgentSessionTranscriptEvent\): void/);
    expect(body).toMatch(/subscriberCount\(sessionId: string\): number/);
  });

  it("subscribe()-unsubscribe-cleans-empty-set pinned: 'set.delete(handler); if (set.size === 0) this.subscribers.delete(sessionId);' — pinned so the Map doesn't accumulate empty Sets after last-handler-unsubscribe (drift would leak memory on long-running buses with high subscriber churn)", () => {
    expect(body).toMatch(
      /set\.delete\(handler\);\s*if \(set\.size === 0\) this\.subscribers\.delete\(sessionId\);/,
    );
  });

  it("publish() best-effort swallow-handler-errors pinned: 'Best-effort: a buggy handler MUST NOT block other handlers or the publisher (AgentRuntime).' — pinned so a single buggy handler can't take down the runtime that publishes to it (drift to letting errors propagate would couple every SSE subscriber's bug-tolerance to the runtime's reliability)", () => {
    expect(body).toMatch(
      /\/\/ Best-effort: a buggy handler MUST NOT block other handlers\s*\/\/ or the publisher \(AgentRuntime\)\.\s*try \{\s*handler\(event\);\s*\} catch \{\s*\/\* swallow \*\/\s*\}/,
    );
  });
});
