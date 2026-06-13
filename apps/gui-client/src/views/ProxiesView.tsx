// SOCKS5 proxy management — local-only CRUD UI.
//
// Lives entirely client-side until `CreateSessionRequest` grows a
// `proxy` field on the server (queued, requires WebKit-fork SOCKS5
// integration coordination). Until then this view lets the founder
// curate the proxy list so it's ready when the contract lands.

import { Fragment, useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { RelativeTime } from '../components/RelativeTime';
import { SkeletonRows } from '../components/Skeleton';
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
      <header className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="section-label">Network</span>
          <h2 className="text-lg font-medium text-ink-primary">
            SOCKS5 proxies
            <span className="ml-2 mono text-ink-muted">{state.proxies.length}</span>
          </h2>
          <p className="text-2xs text-ink-muted">
            Stored locally. Wiring to session creation lands when the API contract grows a{' '}
            <span className="mono">proxy</span> field.
          </p>
        </div>
        <div className="flex gap-2">
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
          <button type="button" className="btn-primary" onClick={() => setEditor({ kind: 'add' })}>
            New proxy
          </button>
        </div>
      </header>

      {/* Pool summary — capability-board port. Counts are over TESTED
          proxies only (no fabricated health for never-probed entries). */}
      {tested.length > 0 && (
        <div data-component="proxy-pool-stats" className="grid grid-cols-3 gap-3">
          <PoolStat k="Tested" v={`${String(tested.length)} / ${String(state.proxies.length)}`} />
          <PoolStat k="Healthy" v={String(healthy.length)} tone="ok" />
          <PoolStat k="Full-stack (UDP)" v={String(udpCapable.length)} tone="ok" />
        </div>
      )}

      {state.error !== null && (
        <ErrorBanner
          message={state.error}
          onDismiss={() => setState((s) => ({ ...s, error: null }))}
        />
      )}

      {state.proxies.length === 0 ? (
        <Empty loading={state.loading} />
      ) : (
        <ProxyTable
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

function Empty({ loading }: { loading: boolean }): JSX.Element {
  if (loading) {
    return <SkeletonRows rows={4} label="Loading proxies" />;
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded border border-dashed border-surface-divider px-8 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-md bg-accent-subtle text-accent">
        <svg
          width="24"
          height="24"
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
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-ink-primary">No proxies configured</h3>
        <p className="max-w-md text-sm text-ink-secondary">
          Add a SOCKS5 endpoint to route session traffic through your own egress IP. Proxies are
          stored locally on this device only — never uploaded to the Driftstack control plane.
        </p>
      </div>
      <p className="text-xs text-ink-muted">
        Click <span className="mono">New proxy</span> above to add one. Wiring to session creation
        lands when the API contract grows a <span className="mono">proxy</span> field.
      </p>
    </div>
  );
}

function ProxyTable({
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
    <div className="overflow-auto rounded border border-surface-divider">
      <table className="w-full">
        <thead>
          <tr className="border-b border-surface-divider bg-surface-elevated text-left">
            <Th>Label</Th>
            <Th>Endpoint</Th>
            <Th>Auth</Th>
            <Th>Created</Th>
            <Th>{''}</Th>
          </tr>
        </thead>
        <tbody>
          {proxies.map((p) => {
            const result = testResults[p.id];
            const testing = testingId === p.id;
            return (
              <Fragment key={p.id}>
                <tr
                  className={`hover:bg-surface-elevated/40 ${
                    result === undefined ? 'border-b border-surface-divider last:border-0' : ''
                  }`}
                >
                  <Td>
                    <span className="text-ink-primary">{p.label}</span>
                  </Td>
                  <Td>
                    <span className="mono text-ink-secondary">
                      {p.host}:{p.port}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-ink-secondary">
                      {p.username !== null && p.username.length > 0 ? p.username : '—'}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-ink-muted">
                      <RelativeTime iso={p.createdAt} tooltipPrefix="Added" />
                    </span>
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => onTest(p)}
                        disabled={testing}
                      >
                        {testing ? 'Testing…' : 'Test'}
                      </button>
                      <button type="button" className="btn-secondary" onClick={() => onEdit(p.id)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => onRemove(p.id)}
                        disabled={busyId === p.id}
                      >
                        {busyId === p.id ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  </Td>
                </tr>
                {result !== undefined && (
                  <tr className="border-b border-surface-divider last:border-0">
                    <td colSpan={5} className="px-3 pb-2">
                      <div
                        role="status"
                        className={`flex flex-wrap items-center gap-2 text-2xs ${
                          result.reachable && result.auth_ok
                            ? 'text-status-success'
                            : 'text-status-error'
                        }`}
                      >
                        <span className="font-medium">
                          {result.reachable
                            ? result.auth_ok
                              ? `Reachable · ${result.latency_ms} ms`
                              : 'Auth failed'
                            : 'Not reachable'}
                        </span>
                        {result.reachable && (
                          <span
                            className={`rounded-sm px-1 py-0.5 ${
                              result.udp_associate
                                ? 'bg-status-success/20'
                                : 'bg-surface-divider text-ink-muted'
                            }`}
                          >
                            {result.udp_associate ? 'UDP ✓' : 'UDP ✗'}
                          </span>
                        )}
                        {result.reachable && (
                          // QUIC + WebRTC ride the UDP relay — derived from
                          // the probed UDP ASSOCIATE result, not separately
                          // probed (honest label, no fake independent check).
                          <span
                            className={`rounded-sm px-1 py-0.5 ${
                              result.udp_associate
                                ? 'bg-status-success/20'
                                : 'bg-surface-divider text-ink-muted'
                            }`}
                            title={
                              result.udp_associate
                                ? 'UDP ASSOCIATE works — sessions can speak h3 and gather WebRTC candidates through this exit.'
                                : 'No UDP relay — sessions fall back to h2 and TURN-over-TCP through this exit.'
                            }
                          >
                            {result.udp_associate
                              ? 'QUIC + WebRTC ✓ (rides UDP)'
                              : 'QUIC + WebRTC ✗ — h2 / TURN-over-TCP fallback'}
                          </span>
                        )}
                        {result.reachable && result.auth_ok && p.id in exitResults && (
                          <span className="rounded-sm bg-surface-inset px-1 py-0.5 text-ink-secondary">
                            {exitResults[p.id] !== null && exitResults[p.id] !== undefined ? (
                              <>
                                exit {exitResults[p.id]?.ip}
                                {exitResults[p.id]?.country !== null &&
                                  ` · ${exitResults[p.id]?.country ?? ''}`}
                              </>
                            ) : (
                              'exit geo unavailable (server update pending)'
                            )}
                          </span>
                        )}
                        <span className="text-ink-secondary">{result.message}</span>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
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
      className="flex flex-col gap-3 rounded border border-surface-divider bg-surface-raised p-4"
    >
      <div className="flex items-center justify-between">
        <span className="section-label">{mode === 'add' ? 'Add proxy' : 'Edit proxy'}</span>
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
    <div className="rounded border border-surface-divider bg-surface-raised px-3 py-2">
      <p className="section-label">{k}</p>
      <p
        className={`mono text-lg font-semibold ${
          tone === 'ok' ? 'text-status-success' : 'text-ink-primary'
        }`}
      >
        {v}
      </p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }): JSX.Element {
  return <th className="px-3 py-2 section-label">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }): JSX.Element {
  return <td className="px-3 py-2 align-middle text-sm">{children}</td>;
}

// ─── helpers ──────────────────────────────────────────────────────

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
