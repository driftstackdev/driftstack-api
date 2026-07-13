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
import { disposeResponseBody } from '../lib/dispose-response-body';
import { readBoundedDiagnosticJson } from '../lib/read-bounded-json';
import { maskApiKey } from '../components/ApiKeyMaskedSpan';
import { humanizeError } from '../lib/humanize-error';

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

export function ConnectivityView({ embedded = false }: { embedded?: boolean } = {}): JSX.Element {
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
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8_000);
    fetch(`${trimmed}/version`, { signal: controller.signal, cache: 'no-store' })
      .then(async (r) => {
        if (r.ok) return readBoundedDiagnosticJson<ServerVersion>(r);
        await disposeResponseBody(r);
        return null;
      })
      .then((info) => {
        if (!cancelled && info) setServerInfo(info);
      })
      .catch(() => {
        if (!cancelled) setServerInfo(null);
      })
      .finally(() => {
        window.clearTimeout(timer);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
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
      const detail =
        err instanceof DriftstackError
          ? `${err.title}: ${err.detail ?? err.message}`
          : humanizeError(
              err,
              'Connectivity check failed. Verify the API URL and key in Settings, then try again.',
            );
      const errorKind = err instanceof DriftstackError ? err.kind : 'unknown';
      setResult({ ok: false, durationMs, detail, errorKind });
    } finally {
      setRunning(false);
    }
  }

  // Embedded inside Settings' "Connection test" panel, which already provides
  // the icon-led card chrome — render the lean inline form there. Standalone,
  // lead with a gradient hero card (icon chip + identity glow) matching the
  // Command Center / Settings language.
  const probe = (
    <>
      <div className="flex flex-col gap-2 max-w-2xl">
        <Row label="API base URL">
          <span className="mono text-ink-secondary">{settings.baseUrl}</span>
        </Row>
        <Row label="API key">
          <span className="mono text-ink-secondary">
            {settings.apiKey === null ? (
              <span className="text-status-error">not set — configure under Settings</span>
            ) : (
              // Use the shared, prefix-aware mask (strips the known ds_live_
              // prefix + shows 4+4 of the random body) so on-screen exposure
              // matches the project's masking standard everywhere a key is
              // shown. The old inline slice(0,8)…slice(-4) was a non-standard,
              // prefix-unaware mask; this is a consistency fix. (audit)
              maskApiKey(settings.apiKey)
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
    </>
  );

  if (embedded) {
    return <div className="flex flex-col gap-4">{probe}</div>;
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-6 overflow-y-auto p-6">
      {/* Page hero — gradient + identity glow; an accent icon chip + the
          Network section label, mirroring the Command Center card language. */}
      <header className="relative overflow-hidden rounded-2xl border border-surface-divider bg-surface-raised p-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full opacity-40 blur-3xl"
          style={{
            background: 'radial-gradient(circle, rgb(var(--accent-rgb)/0.55), transparent 70%)',
          }}
        />
        <div className="relative flex flex-wrap items-start gap-4">
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent"
            aria-hidden="true"
          >
            <IconActivity />
          </span>
          <div className="min-w-0">
            <span className="section-label text-accent">Network</span>
            <h2 className="mt-0.5 text-2xl font-semibold tracking-tight text-ink-primary">
              Connectivity test
            </h2>
            <p className="mt-1 max-w-xl text-sm text-ink-secondary">
              Authenticates against the configured server and times the round-trip. Use this when a
              session call starts failing — it isolates whether the issue is the API key, the URL,
              the server, or your network.
            </p>
          </div>
        </div>
      </header>

      {/* Probe card — the detail rows + run action + result, in the shared
          rounded card surface. */}
      <section className="flex flex-col gap-4 rounded-xl border border-surface-divider bg-surface-raised px-5 py-4 shadow-sm">
        {probe}
      </section>
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
      <div className="rounded-xl border border-status-ready/30 bg-status-ready/10 px-4 py-3">
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
    <div className="rounded-xl border border-status-error/30 bg-status-error/10 px-4 py-3">
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

// ─── icons (Lucide-shape, inline, no dependency) — matches CommandCenterView ──
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
function IconActivity(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="17" height="17" {...stroke}>
      <path d="M1.5 8h2.75l1.5-4.5 3 9 1.5-4.5h4.25" />
    </svg>
  );
}
