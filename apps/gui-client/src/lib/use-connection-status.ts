// 2026-05-20 — live connection status hook.
//
// Pings `GET /version` on the configured baseUrl every 30s and reports
// connected / connecting / offline so the TitleBar can render a status
// pill instead of forcing the customer to discover connectivity issues
// via a stack trace deep inside a view's error banner. /version is the
// cheapest reachability probe the API exposes — it's auth-free, returns
// a tiny JSON envelope, and Cloudflare caches nothing about it.
//
// State machine:
//   - initial: 'connecting' (first probe in flight)
//   - probe ok (any 2xx response): 'connected' + lastOkAt timestamp
//   - probe answered 429 / 5xx: 'degraded' + lastError msg (GUI audit #20 —
//     the server IS reachable; it is busy. "Offline" sent customers off to
//     check their own network.)
//   - probe fail, no answer at all: 'degraded' ("Server busy", NOT_ANSWERING_YET)
//     and a re-check every 3 s while the outage is young — a restart looks like
//     this for a few seconds — then 'offline' once it has lasted
//     (client.ts RIDE_OUT_BUDGET_MS, shared with the API client's reads)
//   - probe fail (timeout / any other non-2xx): 'offline' + lastError msg
//   - on baseUrl change: reset to 'connecting' + probe immediately
//
// 30s cadence chosen so the pill catches real outages within a single
// minute without thrashing the API. Customers stuck on a long-running
// page (e.g. LiveSessionView) get a near-real-time signal if their
// session goes offline mid-run.

import { useEffect, useRef, useState } from 'react';
import { disposeResponseBody } from './dispose-response-body';
import { readBoundedDiagnosticJson } from './read-bounded-json';
import { humanizeError } from './humanize-error';
import {
  apiReachability,
  noteApiAnswered,
  noteApiUnreachable,
  subscribeApiReachability,
} from './client';

const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 8_000;
/** While the server is not answering, check again this often rather than
 *  every 30 s, so the pill turns back to Connected soon after a restart. */
const RETRY_PROBE_MS = 3_000;

/** The pill's calm status while a restart is ridden out (client.ts): the
 *  server is not answering, and nothing is wrong on the customer's side yet.
 *  "Offline" is kept for an outage that lasts. */
export const NOT_ANSWERING_YET = 'The server is not answering right now. Retrying automatically.';

export type ConnectionState = 'connecting' | 'connected' | 'degraded' | 'offline';

/** W625 — the session driver the connected server runs (from /version).
 *  `mock` means launches won't open a real browser, so the GUI can warn
 *  up front instead of letting the customer discover it post-launch. */
export type ServerDriver = 'mock' | 'webkit' | 'playwright';

/** #139 — whether AI Browser Automation EXECUTES for real (fleet control plane
 *  wired) vs runs the simulated stub. This is the correct "is it a mock" signal —
 *  distinct from `driver`, which is the LOCAL driver ('mock' in prod even though
 *  automation is live via the fleet path). */
export type AgentExecution = 'live' | 'simulated';

export interface ConnectionStatus {
  state: ConnectionState;
  lastOkAt: number | null;
  lastError: string | null;
  /** W625 — null until a /version probe succeeds (or if the field is absent
   *  on an older server). */
  driver: ServerDriver | null;
  /** #139 — null until a /version probe succeeds (or if the field is absent on an
   *  older server — treat null as "unknown", NOT as simulated). */
  agentExecution: AgentExecution | null;
}

export function useConnectionStatus(baseUrl: string): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>({
    state: 'connecting',
    lastOkAt: null,
    lastError: null,
    driver: null,
    agentExecution: null,
  });
  const probeRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;
    setStatus({
      state: 'connecting',
      lastOkAt: null,
      lastError: null,
      driver: null,
      agentExecution: null,
    });

    const scheduleRetryProbe = (): void => {
      if (retryTimer !== null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (!cancelled) void probe();
      }, RETRY_PROBE_MS);
    };

    // The API client and this probe share one view of the server. When the
    // client's reads find it not answering, the pill says so calmly at once;
    // when they find it answering again, the pill re-checks now rather than up
    // to 30 s later.
    let lastSeen = apiReachability(baseUrl).state;
    // Our own probe's notes are handled where they are made, not echoed back.
    let noting = false;
    const unsubscribe = subscribeApiReachability(() => {
      if (cancelled || noting) return;
      const now = apiReachability(baseUrl);
      if (now.state === lastSeen) return;
      const was = lastSeen;
      lastSeen = now.state;
      if (now.state === 'retrying') {
        setStatus((prev) => ({ ...prev, state: 'degraded', lastError: NOT_ANSWERING_YET }));
        scheduleRetryProbe();
      } else if (now.state === 'down') {
        setStatus((prev) => ({
          ...prev,
          state: 'offline',
          lastError: "Couldn't reach Driftstack. Check your connection and try again.",
        }));
      } else if (was !== 'answering') {
        void probe();
      }
    });

    async function probe(): Promise<void> {
      // Guard a missing/blank base URL: the host may not be resolved yet on the
      // first render (or a caller may pass an empty value), and a bare
      // `baseUrl.trim()` on undefined THROWS inside this fire-and-forget
      // `void probe()` → an unhandled rejection (which, post-boot, the global
      // handler now downgrades — but the probe should not throw in the first
      // place). Treat "no host yet" as the benign not-yet-connected state (already
      // set on mount above) and retry on the next interval tick once it's set.
      const trimmed = (typeof baseUrl === 'string' ? baseUrl : '').trim().replace(/\/+$/, '');
      if (trimmed === '') return;
      const controller = new AbortController();
      // Leak fix — abort any still-in-flight probe (e.g. a stalled body read)
      // before we orphan its controller by reassigning abortRef.
      abortRef.current?.abort();
      abortRef.current = controller;
      // Leak fix — keep this timer armed until the body is parsed (cleared in
      // the finally below), so PROBE_TIMEOUT_MS bounds res.json() too. A proxy
      // that returns 200 headers then stalls the body would otherwise hang the
      // fetch forever, accumulating orphaned controllers on each interval tick.
      const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${trimmed}/version`, {
          signal: controller.signal,
          // No-store so a misconfigured proxy can't pin "connected" via
          // a stale cache after the upstream goes down.
          cache: 'no-store',
        });
        if (cancelled) {
          await disposeResponseBody(res);
          return;
        }
        if (res.ok) {
          // W625 — parse the driver from /version so the UI can warn on mock.
          // #139 — also parse agent_execution (the real "is automation live" signal).
          let driver: ServerDriver | null = null;
          let agentExecution: AgentExecution | null = null;
          try {
            const body = await readBoundedDiagnosticJson<{
              driver?: unknown;
              agent_execution?: unknown;
            }>(res);
            if (
              body.driver === 'mock' ||
              body.driver === 'webkit' ||
              body.driver === 'playwright'
            ) {
              driver = body.driver;
            }
            if (body.agent_execution === 'live' || body.agent_execution === 'simulated') {
              agentExecution = body.agent_execution;
            }
          } catch {
            // /version body unreadable — leave fields null (banners just won't show).
          }
          if (cancelled) return;
          noting = true;
          noteApiAnswered(trimmed);
          noting = false;
          lastSeen = 'answering';
          setStatus({
            state: 'connected',
            lastOkAt: Date.now(),
            lastError: null,
            driver,
            agentExecution,
          });
          return;
        }
        await disposeResponseBody(res);
        // A 4xx is the server itself answering, so it is reachable.
        if (res.status < 500) {
          noting = true;
          noteApiAnswered(trimmed);
          noting = false;
          lastSeen = 'answering';
        }
        // GUI audit #20 — an answer is reachability: a rate-limited or failing
        // server is busy, not offline.
        const busy = res.status === 429 || res.status >= 500;
        setStatus((prev) => ({
          state: busy ? 'degraded' : 'offline',
          lastOkAt: prev.lastOkAt,
          lastError: probeResponseError(res.status),
          driver: prev.driver,
          agentExecution: prev.agentExecution,
        }));
      } catch (err) {
        if (cancelled) return;
        const errorName = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
        if (errorName !== 'AbortError') {
          // No answer at all. A restart looks exactly like this for a few
          // seconds, so it reads as "not answering, retrying" until it has
          // lasted (client.ts RIDE_OUT_BUDGET_MS), and only then as Offline.
          noting = true;
          const reach = noteApiUnreachable(trimmed, 'GET /version → network failure');
          noting = false;
          lastSeen = reach.state;
          if (reach.state === 'retrying') {
            setStatus((prev) => ({ ...prev, state: 'degraded', lastError: NOT_ANSWERING_YET }));
            scheduleRetryProbe();
            return;
          }
        }
        const message =
          errorName === 'AbortError'
            ? 'Connection check timed out. Check your connection and try again.'
            : humanizeError(err, 'Connection check failed. Open Settings and try again.');
        setStatus((prev) => ({
          state: 'offline',
          lastOkAt: prev.lastOkAt,
          lastError: message,
          driver: prev.driver,
          agentExecution: prev.agentExecution,
        }));
      } finally {
        // Leak fix — clear only after the body read (or its failure), so the
        // timeout bounds res.json() rather than being disarmed at headers.
        window.clearTimeout(timer);
      }
    }

    void probe();
    probeRef.current = window.setInterval(() => void probe(), PROBE_INTERVAL_MS);

    return () => {
      cancelled = true;
      unsubscribe();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (probeRef.current !== null) {
        window.clearInterval(probeRef.current);
        probeRef.current = null;
      }
      abortRef.current?.abort();
    };
  }, [baseUrl]);

  return status;
}

function probeResponseError(status: number): string {
  if (status === 401 || status === 403) {
    return 'Your sign-in or API key was not accepted. Check Settings and try again.';
  }
  if (status === 429) return 'The server is receiving too many requests. Try again shortly.';
  if (status >= 500) return 'The service is temporarily unavailable. Try again shortly.';
  return 'The server returned an unexpected response. Check Settings and try again.';
}
