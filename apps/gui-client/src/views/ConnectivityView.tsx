// Connectivity test — verifies the configured API key + base URL by
// making a real call against the server. Useful when something stops
// working: is the key wrong? is the server down? is the network down?
//
// Hits `client.sessions.list({ limit: 1 })` rather than a dedicated
// /healthz route — every authenticated endpoint exercises the same
// auth + rate-limit + DB chain, and `list` is the cheapest one.

import { useEffect, useState } from 'react';
import { useSettings } from '../lib/SettingsContext';
import { DriftstackError } from '../lib/client';

interface CheckResult {
  ok: boolean;
  durationMs: number;
  detail: string;
  errorKind?: string;
}

interface ServerVersion {
  version: string;
  git_sha: string;
  driver: 'mock' | 'webkit' | 'playwright';
  playwright_browser?: 'webkit' | 'chromium' | 'firefox';
}

export function ConnectivityView(): JSX.Element {
  const { client, settings } = useSettings();
  const [result, setResult] = useState<CheckResult | null>(null);
  const [running, setRunning] = useState(false);
  // V-337 — surface the server's driver mode + version when we can
  // reach the public /version endpoint. Helps the founder spot
  // "you're talking to a mock server" mismatches without running
  // /version manually.
  const [serverInfo, setServerInfo] = useState<ServerVersion | null>(null);

  useEffect(() => {
    let cancelled = false;
    const trimmed = settings.baseUrl.replace(/\/+$/, '');
    fetch(`${trimmed}/version`)
      .then((r) => (r.ok ? (r.json() as Promise<ServerVersion>) : null))
      .then((info) => {
        if (!cancelled && info) setServerInfo(info);
      })
      .catch(() => {
        if (!cancelled) setServerInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [settings.baseUrl]);

  async function runCheck(): Promise<void> {
    if (!client) return;
    setRunning(true);
    const start = performance.now();
    try {
      const page = await client.sessions.list({ limit: 1 });
      const durationMs = Math.round(performance.now() - start);
      setResult({
        ok: true,
        durationMs,
        detail: `API replied with ${page.data.length} session${page.data.length === 1 ? '' : 's'} on the first page.`,
      });
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const detail = err instanceof Error ? err.message : 'unknown error';
      const errorKind = err instanceof DriftstackError ? err.kind : 'unknown';
      setResult({ ok: false, durationMs, detail, errorKind });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <span className="section-label">Network</span>
        <h2 className="text-lg font-medium tracking-tight">
          <span className="bg-gradient-to-br from-ink-primary via-ink-primary to-glow-red bg-clip-text text-transparent">
            Connectivity test
          </span>
        </h2>
        <p className="text-sm text-ink-secondary max-w-2xl">
          Authenticates against the configured server and times the round-trip. Use this when a
          session call starts failing — it isolates whether the issue is the API key, the URL, the
          server, or your network.
        </p>
      </header>

      <div className="flex flex-col gap-2 max-w-2xl">
        <Row label="API base URL">
          <span className="mono text-ink-secondary">{settings.baseUrl}</span>
        </Row>
        <Row label="API key">
          <span className="mono text-ink-secondary">
            {settings.apiKey === null ? (
              <span className="text-status-error">not set — configure under Settings</span>
            ) : (
              `${settings.apiKey.slice(0, 8)}…${settings.apiKey.slice(-4)}`
            )}
          </span>
        </Row>
        {/* V-337 — server-reported driver mode + version. */}
        {serverInfo !== null && (
          <>
            <Row label="Server driver">
              <span className="mono text-ink-secondary">
                {serverInfo.driver}
                {serverInfo.driver === 'playwright' && serverInfo.playwright_browser
                  ? ` (${serverInfo.playwright_browser})`
                  : ''}
              </span>
            </Row>
            <Row label="Server version">
              <span className="mono text-ink-secondary">
                {serverInfo.version}
                {serverInfo.git_sha !== 'unknown' ? ` · ${serverInfo.git_sha.slice(0, 7)}` : ''}
              </span>
            </Row>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          className="btn-primary"
          onClick={() => void runCheck()}
          disabled={!client || running}
        >
          {running ? 'Checking…' : 'Run check'}
        </button>
        {!client && (
          <span className="text-2xs text-ink-muted">Configure an API key under Settings.</span>
        )}
      </div>

      {result !== null && <ResultBlock result={result} />}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[10rem_1fr] items-center gap-3 text-sm">
      <span className="section-label">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function ResultBlock({ result }: { result: CheckResult }): JSX.Element {
  if (result.ok) {
    return (
      <div className="rounded border border-status-ready/30 bg-status-ready/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="status-pip bg-status-ready" />
          <span className="section-label text-status-ready">OK</span>
          <span className="mono text-2xs text-ink-muted">{result.durationMs} ms</span>
        </div>
        <p className="mt-1 text-sm text-ink-primary">{result.detail}</p>
      </div>
    );
  }
  return (
    <div className="rounded border border-status-error/30 bg-status-error/10 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="status-pip bg-status-error" />
        <span className="section-label text-status-error">Failed</span>
        <span className="mono text-2xs text-ink-muted">{result.durationMs} ms</span>
        {result.errorKind !== undefined && (
          <span className="mono text-2xs text-ink-muted">· {result.errorKind}</span>
        )}
      </div>
      <p className="mt-1 text-sm text-ink-primary">{result.detail}</p>
    </div>
  );
}
