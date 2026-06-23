// Cookies PULL correlator (founder #48 — live cookie-jar view in the simulator
// drawer). The transport-agnostic CORE of GET /v1/agent-sessions/:id/cookies:
// it issues a `cookiesRequest` over the node's LIVE control WSS and awaits the
// matching `cookiesResult`, correlated by `requestId` (A2 W2816 / A3 W2817 PULL
// contract). A direct mirror of IntentDispatchCorrelator, but keyed by requestId
// and with a single fixed timeout (no per-intent cap), since a cookie pull is a
// one-shot read, not a behavioral intent.
//
// Each FleetControlConnection owns one of these (alongside its dispatch
// correlator). The route calls `request(...)` and awaits a uniform CookiesOutcome
// — the call NEVER rejects, so the route maps each case to a response:
//   ok      → 200 { cookies, status:'ok' }
//   error   → 200 { cookies:null, status:'error', reason }   (node reported a failure)
//   timeout → 200 { cookies:null, status:'timeout' }         (node didn't reply in time)
// (the route handles "no live connection / not wired" before ever calling here).
//
// Ships gated-inert until A3's harness `getAllCookies` WD-extension lands: until
// then a live node never emits `cookiesResult`, so a wired request resolves
// `timeout` — which the GUI renders as the "pending data source" state.

import {
  CookiesResultSchema,
  type CookiesRequest,
  type Cookie,
} from '../schemas/harness-control-protocol.js';

/** The connection's socket send adapts to this (JSON-stringify → ws.send). */
export interface CookiesTransport {
  /** Fire-and-forget send of a cookiesRequest; the result returns via onResultFrame. */
  send(request: CookiesRequest): void;
}

/** A cookie pull is a one-shot read of the live jar — generous but bounded so a
 *  silent (pre-A3) or wedged node can't hang the GET indefinitely. */
export const COOKIES_REQUEST_TIMEOUT_MS = 10_000;

/** Uniform outcome — never rejects, so the route maps each case to a status. */
export type CookiesOutcome =
  | { status: 'ok'; cookies: Cookie[] }
  | { status: 'error'; message: string }
  | { status: 'timeout' };

interface PendingCookies {
  resolve: (outcome: CookiesOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
}

export class CookiesRequestCorrelator {
  private readonly pending = new Map<string, PendingCookies>();

  constructor(private readonly transport: CookiesTransport) {}

  /** Send a cookiesRequest and resolve when its cookiesResult arrives or the
   *  timeout elapses. Never rejects. */
  request(req: CookiesRequest, timeoutMs = COOKIES_REQUEST_TIMEOUT_MS): Promise<CookiesOutcome> {
    return new Promise<CookiesOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(req.requestId, { status: 'timeout' });
      }, timeoutMs);
      this.pending.set(req.requestId, { resolve, timer, sessionId: req.sessionId });
      try {
        this.transport.send(req);
      } catch (err) {
        // socket.send throws synchronously when the WS isn't OPEN (a request
        // racing a remote close). Settle a uniform failure rather than letting
        // this Promise reject — the route contract is that request() never
        // rejects — and so the timer + pending entry don't leak (settle clears them).
        this.settle(req.requestId, {
          status: 'error',
          message: `cookies request send failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  /** Feed an inbound frame expected to be a cookiesResult. Non-cookiesResult
   *  frames are ignored; an unknown requestId is a no-op (already settled). */
  onResultFrame(frame: unknown): void {
    const parsed = CookiesResultSchema.safeParse(frame);
    if (!parsed.success) return; // not a cookiesResult — caller routes other types
    const { requestId, cookies, error } = parsed.data;
    if (error !== undefined) {
      this.settle(requestId, { status: 'error', message: error });
      return;
    }
    // Success with no `cookies` array (empty jar / forward-compat) → [].
    this.settle(requestId, { status: 'ok', cookies: cookies ?? [] });
  }

  /** Fail every in-flight request (the control connection dropped). */
  failAll(message: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, { status: 'error', message });
    }
  }

  /** Number of in-flight requests (test/inspection helper). */
  inFlight(): number {
    return this.pending.size;
  }

  private settle(requestId: string, outcome: CookiesOutcome): void {
    const p = this.pending.get(requestId);
    if (p === undefined) return; // already settled (timeout/result race, or unknown id) — idempotent
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(outcome);
  }
}
