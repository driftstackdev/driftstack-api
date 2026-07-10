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
//   - probe fail (network error / non-2xx): 'offline' + lastError msg
//   - on baseUrl change: reset to 'connecting' + probe immediately
//
// 30s cadence chosen so the pill catches real outages within a single
// minute without thrashing the API. Customers stuck on a long-running
// page (e.g. LiveSessionView) get a near-real-time signal if their
// session goes offline mid-run.

import { useEffect, useRef, useState } from 'react';

const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 8_000;

export type ConnectionState = 'connecting' | 'connected' | 'offline';

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
    setStatus({
      state: 'connecting',
      lastOkAt: null,
      lastError: null,
      driver: null,
      agentExecution: null,
    });

    async function probe(): Promise<void> {
      const trimmed = baseUrl.trim().replace(/\/+$/, '');
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
        if (cancelled) return;
        if (res.ok) {
          // W625 — parse the driver from /version so the UI can warn on mock.
          // #139 — also parse agent_execution (the real "is automation live" signal).
          let driver: ServerDriver | null = null;
          let agentExecution: AgentExecution | null = null;
          try {
            const body = (await res.json()) as { driver?: unknown; agent_execution?: unknown };
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
          setStatus({
            state: 'connected',
            lastOkAt: Date.now(),
            lastError: null,
            driver,
            agentExecution,
          });
          return;
        }
        setStatus((prev) => ({
          state: 'offline',
          lastOkAt: prev.lastOkAt,
          lastError: `HTTP ${res.status}`,
          driver: prev.driver,
          agentExecution: prev.agentExecution,
        }));
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof Error
            ? err.name === 'AbortError'
              ? 'Probe timed out'
              : err.message
            : String(err);
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
      if (probeRef.current !== null) {
        window.clearInterval(probeRef.current);
        probeRef.current = null;
      }
      abortRef.current?.abort();
    };
  }, [baseUrl]);

  return status;
}
