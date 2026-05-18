// Arc 2 sub-slice 8.3 (v2-#8 AI chat + manual side-by-side).
//
// In-process pub/sub for agent-session transcript events. Mirrors
// the V-295e IncidentEventBus shape so a future redis-backed
// implementation drops in without changing the call sites.
//
// SSE consumers (sub-slice 8.3 route) subscribe per-sessionId and
// receive every transcript entry appended after the subscription
// instant. The route layer is responsible for replaying past entries
// from the repo before live-streaming new ones — the bus does NOT
// buffer history.
//
// Decoupled from AgentRuntime so the bus can be wired only when the
// SSE endpoint is registered; AgentRuntime publishes via an injected
// optional `eventBus` (no-op when omitted).

import type { TranscriptEntry } from './agent-decomposer.js';

/** What subscribers receive — one event per transcript append. */
export interface AgentSessionTranscriptEvent {
  agentSessionId: string;
  /** Index of the entry in the session's transcript array AFTER the
   *  append. Drives the SSE event-id so clients can resume via
   *  Last-Event-ID after a disconnect. */
  index: number;
  entry: TranscriptEntry;
}

export type AgentSessionTranscriptHandler = (event: AgentSessionTranscriptEvent) => void;

export class AgentSessionEventBus {
  private readonly subscribers = new Map<string, Set<AgentSessionTranscriptHandler>>();

  /** Subscribe to one agent session's transcript appends. Returns an
   *  unsubscribe function the caller MUST call on disconnect. */
  subscribe(sessionId: string, handler: AgentSessionTranscriptHandler): () => void {
    const existing = this.subscribers.get(sessionId) ?? new Set();
    existing.add(handler);
    this.subscribers.set(sessionId, existing);
    return () => {
      const set = this.subscribers.get(sessionId);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) this.subscribers.delete(sessionId);
    };
  }

  publish(event: AgentSessionTranscriptEvent): void {
    const set = this.subscribers.get(event.agentSessionId);
    if (!set) return;
    for (const handler of set) {
      // Best-effort: a buggy handler MUST NOT block other handlers
      // or the publisher (AgentRuntime).
      try {
        handler(event);
      } catch {
        /* swallow */
      }
    }
  }

  /** Test-only — surfaces the current subscriber count for a given
   *  session id, so tests can assert subscribe / unsubscribe lifecycle. */
  subscriberCount(sessionId: string): number {
    return this.subscribers.get(sessionId)?.size ?? 0;
  }
}
