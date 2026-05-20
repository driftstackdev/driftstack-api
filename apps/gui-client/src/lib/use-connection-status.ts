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

export interface ConnectionStatus {
  state: ConnectionState;
  lastOkAt: number | null;
  lastError: string | null;
}

export function useConnectionStatus(baseUrl: string): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>({
    state: 'connecting',
    lastOkAt: null,
    lastError: null,
  });
  const probeRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus({ state: 'connecting', lastOkAt: null, lastError: null });

    async function probe(): Promise<void> {
      const trimmed = baseUrl.trim().replace(/\/+$/, '');
      const controller = new AbortController();
      abortRef.current = controller;
      const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${trimmed}/version`, {
          signal: controller.signal,
          // No-store so a misconfigured proxy can't pin "connected" via
          // a stale cache after the upstream goes down.
          cache: 'no-store',
        });
        window.clearTimeout(timer);
        if (cancelled) return;
        if (res.ok) {
          setStatus({ state: 'connected', lastOkAt: Date.now(), lastError: null });
          return;
        }
        setStatus((prev) => ({
          state: 'offline',
          lastOkAt: prev.lastOkAt,
          lastError: `HTTP ${res.status}`,
        }));
      } catch (err) {
        window.clearTimeout(timer);
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
        }));
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
