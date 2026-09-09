// #7 — per-agent-session bounded store of captured screenshots.
//
// A `capture` intent's harness result carries the image inline as
// `screenshot_b64`. The customer IntentResult must NOT carry those bytes: the
// result is persisted in the encrypted transcript, and a 100KB–1MB PNG on every
// screenshot step would bloat it (the reason agent-intent-result deliberately
// dropped them). Instead the executor stores the bytes HERE, mints a `captureId`,
// and puts only that id on the result; GET /v1/agent-sessions/:id/captures/:id
// serves the bytes on demand. The transcript stays lean; the image is fetched
// only when the operator opens it.
//
// Bounded on every axis — the data is live + ephemeral (re-captured as the
// session browses), so dropping a stale one is safe memory hygiene, mirroring
// SessionNetworkLogStore:
//   - at most `perSession` captures per session (oldest captureId evicted),
//   - LRU + TTL across sessions (a session idle past the TTL is swept on the
//     next put, and the stalest session is evicted once the map overflows).
//
// captureId is minted SERVER-SIDE (never harness-supplied): the bytes are
// attacker-influenceable (a node fills them), so the id that addresses them must
// be an unguessable server value, not something a node can choose or collide.

import { randomUUID } from 'node:crypto';

/** One retained capture: the bytes (base64) + how to serve them. */
export interface StoredCapture {
  captureId: string;
  bytesB64: string;
  format: 'png' | 'jpeg';
  /** ms epoch the capture was stored — the TTL/LRU sweep key. */
  at: number;
}

/** Per-session state: captures keyed by id (insertion order = age, oldest first
 *  so the per-session cap evicts the stalest), and the last-write time for the
 *  cross-session TTL sweep. */
interface SessionCaptures {
  captures: Map<string, StoredCapture>;
  at: number;
}

/** Idle-session eviction window — a session whose captures stop arriving is
 *  swept on the next put after this long. Injectable for deterministic tests. */
export const CAPTURE_SESSION_TTL_MS = 30 * 60 * 1000;

/** Per-session capture ceiling — the DevTools-style panel shows recent shots,
 *  not an unbounded roll. */
export const CAPTURES_PER_SESSION = 20;

export class SessionCaptureStore {
  private readonly map = new Map<string, SessionCaptures>();

  constructor(
    /** Hard cap on concurrent sessions (stalest-inserted evicted on overflow). */
    private readonly maxSessions = 2_000,
    /** Per-session capture ceiling. */
    private readonly perSession = CAPTURES_PER_SESSION,
    /** Idle-session lifetime in ms. */
    private readonly ttlMs = CAPTURE_SESSION_TTL_MS,
    /** Clock seam (ms epoch) — overridden in tests. */
    private readonly clock: () => number = () => Date.now(),
    /** captureId minter seam — overridden in tests for determinism. */
    private readonly mintId: () => string = () => `cap_${randomUUID()}`,
  ) {}

  /**
   * Store a capture's bytes and return the minted captureId. Sweeps expired
   * sessions first, caps the session's captures (oldest evicted), then LRU-caps
   * the session map — so neither axis grows unbounded.
   */
  put(sessionId: string, bytesB64: string, format: 'png' | 'jpeg'): string {
    const now = this.clock();
    for (const [id, state] of this.map) {
      if (now - state.at > this.ttlMs) this.map.delete(id);
    }
    // delete+set moves the key to newest insertion order, so the map size cap
    // below evicts the genuinely-stalest session.
    const existing = this.map.get(sessionId);
    this.map.delete(sessionId);
    const state: SessionCaptures = existing ?? { captures: new Map(), at: now };
    const captureId = this.mintId();
    state.captures.set(captureId, { captureId, bytesB64, format, at: now });
    // Per-session cap — evict oldest past the ceiling (`while`: a burst could be
    // several over, though put appends one at a time).
    while (state.captures.size > this.perSession) {
      const oldest = state.captures.keys().next().value;
      if (oldest === undefined) break;
      state.captures.delete(oldest);
    }
    state.at = now;
    this.map.set(sessionId, state);
    while (this.map.size > this.maxSessions) {
      const stalest = this.map.keys().next().value;
      if (stalest === undefined) break;
      this.map.delete(stalest);
    }
    return captureId;
  }

  /** Fetch a stored capture, or undefined for an unknown/swept id. A miss reads
   *  as absent, never an error — the route maps it to a 404. */
  get(sessionId: string, captureId: string): StoredCapture | undefined {
    return this.map.get(sessionId)?.captures.get(captureId);
  }

  /** Drop a session's captures (e.g. on session end); the TTL + LRU bounds are
   *  the backstop if it is never called. */
  delete(sessionId: string): void {
    this.map.delete(sessionId);
  }

  /** Active session count — for tests + size assertions. */
  get size(): number {
    return this.map.size;
  }
}
