// SOCKS5 proxy management — local-only CRUD UI.
//
// Lives entirely client-side until `CreateSessionRequest` grows a
// `proxy` field on the server (queued, requires WebKit-fork SOCKS5
// integration coordination). Until then this view lets the founder
// curate the proxy list so it's ready when the contract lands.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmptyState } from '../components/EmptyState';
import { RelativeTime } from '../components/RelativeTime';
import { SkeletonRows } from '../components/Skeleton';
import { ProxyCapabilityChips } from '../components/ProxyCapabilities';
import {
  addProxy,
  listProxies,
  removeProxy,
  testProxy,
  updateProxy,
  validateDraft,
  type DraftValidation,
  type ProxyConfig,
  type ProxyDraft,
  type ProxyTestResult,
} from '../lib/proxies';
import { invalidateProbe, saveExitResult, saveProbeResult } from '../lib/proxy-probe-cache';
import { probeProxyExit, type ProxyExitProbeResult } from '../lib/proxies';

interface ListState {
  proxies: ProxyConfig[];
  loading: boolean;
  error: string | null;
}

const EMPTY_DRAFT: ProxyDraft = {
  label: '',
  host: '',
  port: 1080,
  username: null,
  password: null,
};

export function ProxiesView(): JSX.Element {
  const [state, setState] = useState<ListState>({ proxies: [], loading: true, error: null });
  const [editor, setEditor] = useState<
    { kind: 'idle' } | { kind: 'add' } | { kind: 'edit'; id: string }
  >({ kind: 'idle' });
  const [busyId, setBusyId] = useState<string | null>(null);
  // Native SOCKS5 probe per saved proxy — reachability + UDP-associate
  // support. Keyed by proxy id so each row keeps its own last result.
  const [testingId, setTestingId] = useState<string | null>(null);
  // E-2 exit-geo: per-proxy echo result (null entry = probed but
  // unavailable — native command or server endpoint not live yet).
  const [exitResults, setExitResults] = useState<Record<string, ProxyExitProbeResult | null>>({});
  const [testResults, setTestResults] = useState<Record<string, ProxyTestResult>>({});

  const refresh = useCallback(async (): Promise<void> => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const proxies = await listProxies();
      setState({ proxies, loading: false, error: null });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: friendlyError(err) }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSave(draft: ProxyDraft): Promise<void> {
    try {
      if (editor.kind === 'add') {
        await addProxy(draft);
      } else if (editor.kind === 'edit') {
        const editId = editor.id;
        const prev = state.proxies.find((p) => p.id === editId);
        await updateProxy(editId, draft);
        // If the connection target changed, the cached probe (capability +
        // exit-geo) no longer describes this proxy — drop it so cards fall
        // back to the honest "untested" state until the next Test, rather
        // than advertising the OLD endpoint's reachability/UDP/exit-geo.
        // A label-only rename keeps the probe (same endpoint).
        const connChanged =
          prev === undefined ||
          prev.host !== draft.host ||
          prev.port !== draft.port ||
          prev.username !== draft.username ||
          prev.password !== draft.password;
        if (connChanged) {
          void invalidateProbe(editId).catch(() => undefined);
          setTestResults((r) => dropKey(r, editId));
          setExitResults((r) => dropKey(r, editId));
        }
      }
      setEditor({ kind: 'idle' });
      await refresh();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err) }));
    }
  }

  async function handleRemove(id: string): Promise<void> {
    setBusyId(id);
    try {
      await removeProxy(id);
      // Drop the cached probe too, else its exit-IP/geo orphans in the
      // cache (and a future re-minted id could inherit stale geo).
      void invalidateProbe(id).catch(() => undefined);
      setTestResults((r) => dropKey(r, id));
      setExitResults((r) => dropKey(r, id));
      await refresh();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err) }));
    } finally {
      setBusyId(null);
    }
  }

  async function handleTest(p: ProxyConfig): Promise<void> {
    setTestingId(p.id);
    try {
      const result = await testProxy({
        host: p.host,
        port: p.port,
        username: p.username,
        password: p.password,
      });
      setTestResults((r) => ({ ...r, [p.id]: result }));
      // Night-arc B: persist so profile cards can render egress
      // capability (UDP badge) without re-probing. Best-effort.
      void saveProbeResult(p.id, result, Date.now()).catch(() => undefined);
      // E-2: exit-geo through the proxy (graceful null pre-deploy /
      // pre-native-command — renders 'geo unavailable').
      if (result.reachable && result.auth_ok) {
        const exit = await probeProxyExit({
          host: p.host,
          port: p.port,
          username: p.username,
          password: p.password,
        });
        setExitResults((r) => ({ ...r, [p.id]: exit }));
        if (exit !== null) {
          void saveExitResult(p.id, exit.ip, exit.country).catch(() => undefined);
        }
      } else {
        // Proxy is no longer usable (not reachable / auth failed) — drop any
        // exit-geo from a prior successful probe so the card can't show a
        // stale "exit IP · country" next to "Auth failed" / "Not reachable".
        setExitResults((r) => dropKey(r, p.id));
      }
    } catch (err) {
      setTestResults((r) => ({
        ...r,
        [p.id]: {
          reachable: false,
          auth_ok: false,
          udp_associate: false,
          latency_ms: 0,
          message: err instanceof Error ? err.message : String(err),
        },
      }));
      setExitResults((r) => dropKey(r, p.id));
    } finally {
      setTestingId(null);
    }
  }

  // Capability-board port (approved proxy-health demo, 2026-06-12):
  // probe ALL saved proxies sequentially. Sequential by design — the
  // native probe opens real sockets; parallel probes through consumer
  // egress endpoints skew each other's latency numbers.
  const [testingAll, setTestingAll] = useState(false);
  async function handleTestAll(): Promise<void> {
    setTestingAll(true);
    try {
      for (const p of state.proxies) {
        await handleTest(p);
      }
    } finally {
      setTestingAll(false);
    }
  }

  const tested = state.proxies.filter((p) => testResults[p.id] !== undefined);
  const healthy = tested.filter((p) => {
    const r = testResults[p.id];
    return r !== undefined && r.reachable && r.auth_ok;
  });
  const udpCapable = tested.filter((p) => {
    const r = testResults[p.id];
    return r !== undefined && r.udp_associate;
  });

  const editing =
    editor.kind === 'edit' ? (state.proxies.find((p) => p.id === editor.id) ?? null) : null;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* HERO strip (console.html) — section-label + title with at-a-glance
          context on the left; quiet Test-all + primary New-proxy on the
          right. Mirrors the Profiles hub hero rhythm. */}
      <div
        data-component="proxies-hero"
        className="flex flex-wrap items-start gap-4 border-b border-surface-divider pb-3"
      >
        <div className="min-w-0">
          <span className="section-label">Network</span>
          <h2 className="mt-0.5 text-[19px] font-semibold tracking-tight text-ink-primary">
            SOCKS5 proxies
            <span className="mono ml-2 text-base font-normal text-ink-muted">
              {state.proxies.length}
            </span>
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
            {tested.length > 0 ? (
              <>
                <b className="font-semibold text-status-ready">{healthy.length}</b> healthy
                <span className="text-surface-divider">·</span>
                <b className="font-semibold text-ink-primary">{udpCapable.length}</b> full-stack
                <span className="text-surface-divider">·</span>
                <span className="text-ink-muted">stored locally — never uploaded</span>
              </>
            ) : (
              <span className="text-ink-muted">
                Stored locally on this device — never uploaded to the control plane.
              </span>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {state.proxies.length > 0 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleTestAll()}
              disabled={testingAll || testingId !== null}
            >
              {testingAll ? 'Testing all…' : 'Test all'}
            </button>
          )}
          <button
            type="button"
            className="btn-primary flex items-center gap-1.5"
            onClick={() => setEditor({ kind: 'add' })}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M8 3v10M3 8h10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            <span>New proxy</span>
          </button>
        </div>
      </div>

      {/* Pool summary — capability-board port. Counts are over TESTED
          proxies only (no fabricated health for never-probed entries). */}
      {tested.length > 0 && (
        <div
          data-component="proxy-pool-stats"
          className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-surface-divider bg-surface-divider"
        >
          <PoolStat k="Tested" v={`${String(tested.length)} / ${String(state.proxies.length)}`} />
          <PoolStat k="Healthy" v={String(healthy.length)} tone="ok" />
          <PoolStat k="WebRTC + QUIC" v={String(udpCapable.length)} tone="ok" />
        </div>
      )}

      {state.error !== null && (
        <ErrorBanner
          message={state.error}
          onDismiss={() => setState((s) => ({ ...s, error: null }))}
        />
      )}

      {state.proxies.length === 0 ? (
        <Empty loading={state.loading} onAdd={() => setEditor({ kind: 'add' })} />
      ) : (
        <ProxyList
          proxies={state.proxies}
          busyId={busyId}
          testingId={testingId}
          testResults={testResults}
          exitResults={exitResults}
          onEdit={(id) => setEditor({ kind: 'edit', id })}
          onRemove={(id) => void handleRemove(id)}
          onTest={(p) => void handleTest(p)}
        />
      )}

      {(editor.kind === 'add' || editor.kind === 'edit') && (
        <ProxyForm
          initial={editing !== null ? toDraft(editing) : EMPTY_DRAFT}
          mode={editor.kind}
          onCancel={() => setEditor({ kind: 'idle' })}
          onSave={(d) => void handleSave(d)}
        />
      )}
    </div>
  );
}

// ─── subcomponents ────────────────────────────────────────────────

function Empty({ loading, onAdd }: { loading: boolean; onAdd: () => void }): JSX.Element {
  if (loading) {
    return <SkeletonRows rows={4} label="Loading proxies" />;
  }
  return (
    <EmptyState
      icon={
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 2v6m0 8v6M4.93 4.93l4.24 4.24m5.66 5.66l4.24 4.24M2 12h6m8 0h6M4.93 19.07l4.24-4.24m5.66-5.66l4.24-4.24" />
        </svg>
      }
      title="No proxies configured"
      description="Add a SOCKS5 endpoint to route session traffic through your own egress IP. Proxies are stored locally on this device only — never uploaded to the Driftstack control plane."
      action={
        <button type="button" className="btn-primary px-4 py-2 text-sm" onClick={onAdd}>
          Add a proxy
        </button>
      }
    />
  );
}

function ProxyList({
  proxies,
  busyId,
  testingId,
  testResults,
  exitResults,
  onEdit,
  onRemove,
  onTest,
}: {
  proxies: ProxyConfig[];
  busyId: string | null;
  testingId: string | null;
  testResults: Record<string, ProxyTestResult>;
  exitResults: Record<string, ProxyExitProbeResult | null>;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onTest: (p: ProxyConfig) => void;
}): JSX.Element {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {proxies.map((p) => (
        <ProxyCard
          key={p.id}
          proxy={p}
          busy={busyId === p.id}
          testing={testingId === p.id}
          result={testResults[p.id]}
          exit={p.id in exitResults ? exitResults[p.id] : undefined}
          onEdit={() => onEdit(p.id)}
          onRemove={() => onRemove(p.id)}
          onTest={() => onTest(p)}
        />
      ))}
    </div>
  );
}

// Console proxy card — mirrors the Profiles hub proxy-row treatment:
// country flag + exit IP (mono) + latency + inline meter + health pill +
// UDP badge + last-checked, with Test / Edit / Remove as quiet actions.
// All facts come from the REAL probe result (no fabricated health).
function ProxyCard({
  proxy: p,
  busy,
  testing,
  result,
  exit,
  onEdit,
  onRemove,
  onTest,
}: {
  proxy: ProxyConfig;
  busy: boolean;
  testing: boolean;
  result: ProxyTestResult | undefined;
  // undefined = exit-geo never recorded for this proxy; null = probed but
  // unavailable (server endpoint / native command not live yet).
  exit: ProxyExitProbeResult | null | undefined;
  onEdit: () => void;
  onRemove: () => void;
  onTest: () => void;
}): JSX.Element {
  const reachable = result?.reachable ?? false;
  const authOk = result?.auth_ok ?? false;
  const healthy = reachable && authOk;
  const lat = result?.latency_ms;
  // latency meter fill: 0–250ms mapped to 0–100% (clamped). Mirrors the
  // hub card's latFill mapping.
  const latFill = lat !== undefined && lat > 0 ? Math.max(6, Math.min(100, (lat / 250) * 100)) : 0;
  const latGood = lat !== undefined && lat <= 100;
  const exitIp = exit?.ip;
  const exitCountry = exit?.country ?? null;

  return (
    <article
      className={`group flex flex-col gap-2.5 rounded-lg border bg-surface-raised p-3 transition-all hover:-translate-y-px hover:shadow-md ${
        result === undefined
          ? 'border-surface-divider hover:border-ink-muted/60'
          : healthy
            ? 'border-status-ready/50 hover:border-status-ready'
            : 'border-status-error/40 hover:border-status-error/60'
      }`}
    >
      {/* HEADER — label + health pill on the right. */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold tracking-tight text-ink-primary">
            {p.label}
          </p>
          <p className="mt-0.5 flex items-center gap-1 text-[10.5px] text-ink-muted">
            <span aria-hidden="true">🔒</span>
            SOCKS5
            {p.username !== null && p.username.length > 0 && (
              <>
                <span className="text-surface-divider">·</span>
                <span className="mono truncate">{p.username}</span>
              </>
            )}
          </p>
        </div>
        <HealthPill result={result} healthy={healthy} latGood={latGood} />
      </div>

      {/* PROXY row — flag + exit IP (mono) + latency + inline meter, on a
          surface-inset panel, exactly like the hub card. Honest 'untested'
          when never probed. */}
      <div className="flex flex-col gap-1 rounded-lg bg-surface-inset px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-[13px] leading-none">
            {exitCountry !== null ? flagEmoji(exitCountry) : '🌍'}
          </span>
          <span className="mono min-w-0 truncate text-[10.5px] text-ink-secondary">
            {exitIp ?? `${p.host}:${p.port}`}
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-ink-muted">
            {lat !== undefined && reachable ? (
              <>
                <span className="mono">{lat}ms</span>
                <span className="inline-block h-1 w-[34px] overflow-hidden rounded-[2px] bg-surface-divider">
                  <span
                    className="block h-full rounded-[2px]"
                    style={{
                      width: `${latFill.toFixed(0)}%`,
                      background: latGood
                        ? 'rgb(var(--status-ready-rgb))'
                        : 'rgb(var(--status-busy-rgb))',
                    }}
                  />
                </span>
              </>
            ) : (
              <span className="mono opacity-60">{result !== undefined ? 'down' : '—'}</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="mono truncate text-[10px] text-ink-muted">
            {p.host}:{p.port}
          </span>
          <span className="ml-auto shrink-0 text-[9.5px] text-ink-muted">
            <RelativeTime iso={p.createdAt} tooltipPrefix="Added" />
          </span>
        </div>
        {/* Protocol capabilities — honest "Has WebRTC / QUIC / HTTP-2"
            breakdown derived from the probe (replaces the bare UDP badge). */}
        {result !== undefined && reachable ? (
          <ProxyCapabilityChips result={result} size="xs" />
        ) : (
          <span
            className="w-fit rounded-sm bg-surface-divider/60 px-1 py-px text-[9px] text-ink-muted"
            title={
              result !== undefined
                ? 'Exit down on last test — no protocols verified.'
                : 'Never probed — click Test to check egress protocols.'
            }
          >
            {result !== undefined ? 'no egress' : 'untested'}
          </span>
        )}
      </div>

      {/* TEST DETAIL — shown only once probed. Exit-geo line + QUIC/WebRTC
          derivation + the raw probe message, all from the real result. */}
      {result !== undefined && (
        <div role="status" className="flex flex-col gap-1 text-[10px]">
          {healthy && exit !== undefined && (
            <span className="text-ink-secondary">
              {exit !== null ? (
                <>
                  exit <span className="mono">{exit.ip}</span>
                  {exit.country !== null && ` · ${exit.country}`}
                </>
              ) : (
                'exit geo unavailable (server update pending)'
              )}
            </span>
          )}
          {result.message.length > 0 && (
            <span
              className={`truncate ${healthy ? 'text-ink-muted' : 'text-status-error'}`}
              title={result.message}
            >
              {result.message}
            </span>
          )}
        </div>
      )}

      {/* ACTIONS — Test is the primary affordance; Edit / Remove are quiet. */}
      <div className="mt-auto flex items-center gap-2 pt-1">
        <button
          type="button"
          className="btn-primary flex-1 text-xs"
          onClick={onTest}
          disabled={testing}
        >
          {testing ? 'Testing…' : result !== undefined ? 'Re-test' : 'Test'}
        </button>
        <button
          type="button"
          className="text-xs text-ink-muted transition-colors hover:text-ink-primary"
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          type="button"
          className="text-xs text-ink-muted transition-colors hover:text-status-error disabled:opacity-60"
          onClick={onRemove}
          disabled={busy}
        >
          {busy ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </article>
  );
}

// Health pill — the single at-a-glance verdict for a proxy card. Quiet
// 'untested' before the first probe; ready/error tone after.
function HealthPill({
  result,
  healthy,
  latGood,
}: {
  result: ProxyTestResult | undefined;
  healthy: boolean;
  latGood: boolean;
}): JSX.Element {
  if (result === undefined) {
    return (
      <span className="shrink-0 rounded-[5px] bg-surface-inset px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ink-muted">
        untested
      </span>
    );
  }
  if (!healthy) {
    const label = result.reachable ? 'auth fail' : 'unreachable';
    return (
      <span className="shrink-0 rounded-[5px] bg-status-error/12 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-status-error">
        {label}
      </span>
    );
  }
  return (
    <span
      className={`shrink-0 rounded-[5px] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
        latGood ? 'bg-status-ready/12 text-status-ready' : 'bg-status-busy/14 text-status-busy'
      }`}
    >
      {latGood ? 'healthy' : 'slow'}
    </span>
  );
}

function ProxyForm({
  initial,
  mode,
  onCancel,
  onSave,
}: {
  initial: ProxyDraft;
  mode: 'add' | 'edit';
  onCancel: () => void;
  onSave: (d: ProxyDraft) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<ProxyDraft>(initial);
  const [validation, setValidation] = useState<DraftValidation>({ ok: true, errors: {} });

  function setField<K extends keyof ProxyDraft>(key: K, value: ProxyDraft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const v = validateDraft(draft);
    setValidation(v);
    if (!v.ok) return;
    onSave(draft);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-surface-divider bg-surface-raised p-4 shadow-sm"
    >
      <div className="flex items-center justify-between border-b border-surface-divider pb-2">
        <span className="section-label">{mode === 'add' ? 'Add proxy' : 'Edit proxy'}</span>
        <span className="mono text-2xs text-ink-muted">SOCKS5</span>
      </div>
      <Field label="Label" error={validation.errors.label}>
        <input
          type="text"
          className="form-input"
          value={draft.label}
          onChange={(e) => setField('label', e.target.value)}
          placeholder="prod-eu-west"
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <Field label="Host" error={validation.errors.host}>
            <input
              type="text"
              className="form-input mono"
              value={draft.host}
              onChange={(e) => setField('host', e.target.value)}
              placeholder="proxy.example.com"
            />
          </Field>
        </div>
        <Field label="Port" error={validation.errors.port}>
          <input
            type="number"
            className="form-input mono"
            min={1}
            max={65535}
            value={draft.port}
            onChange={(e) => setField('port', Number(e.target.value))}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Username (optional)">
          <input
            type="text"
            className="form-input mono"
            value={draft.username ?? ''}
            onChange={(e) =>
              setField('username', e.target.value.length > 0 ? e.target.value : null)
            }
            autoComplete="off"
          />
        </Field>
        <Field label="Password (optional)">
          <input
            type="password"
            className="form-input mono"
            value={draft.password ?? ''}
            onChange={(e) =>
              setField('password', e.target.value.length > 0 ? e.target.value : null)
            }
            autoComplete="off"
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary">
          {mode === 'add' ? 'Add proxy' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs text-ink-muted">{label}</span>
      {children}
      {error !== undefined && <span className="text-2xs text-status-error">{error}</span>}
    </label>
  );
}

function PoolStat({ k, v, tone }: { k: string; v: string; tone?: 'ok' }): JSX.Element {
  return (
    <div className="bg-surface-raised px-3 py-2.5">
      <p className="section-label">{k}</p>
      <p
        className={`mono mt-0.5 text-lg font-semibold tracking-tight ${
          tone === 'ok' ? 'text-status-ready' : 'text-ink-primary'
        }`}
      >
        {v}
      </p>
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────

/** Map an ISO-3166 alpha-2 country code to its flag emoji (mirrors the
 *  Profiles hub helper). Returns a globe for an unrecognised code. */
function flagEmoji(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return '🌍';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function toDraft(p: ProxyConfig): ProxyDraft {
  return {
    label: p.label,
    host: p.host,
    port: p.port,
    username: p.username,
    password: p.password,
  };
}

function friendlyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

/** Return a copy of `rec` without `key` (same reference if absent, so React
 *  state updates short-circuit). Used to evict a proxy's in-memory probe
 *  results when its endpoint changes or it is deleted. */
function dropKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}
