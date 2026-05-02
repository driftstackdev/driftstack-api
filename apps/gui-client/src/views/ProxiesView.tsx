// SOCKS5 proxy management — local-only CRUD UI.
//
// Lives entirely client-side until `CreateSessionRequest` grows a
// `proxy` field on the server (queued, requires WebKit-fork SOCKS5
// integration coordination). Until then this view lets the founder
// curate the proxy list so it's ready when the contract lands.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import {
  addProxy,
  listProxies,
  removeProxy,
  updateProxy,
  validateDraft,
  type DraftValidation,
  type ProxyConfig,
  type ProxyDraft,
} from '../lib/proxies';

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
        await updateProxy(editor.id, draft);
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
      await refresh();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err) }));
    } finally {
      setBusyId(null);
    }
  }

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
        <button type="button" className="btn-primary" onClick={() => setEditor({ kind: 'add' })}>
          New proxy
        </button>
      </header>

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
          onEdit={(id) => setEditor({ kind: 'edit', id })}
          onRemove={(id) => void handleRemove(id)}
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
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded border border-dashed border-surface-divider px-8 py-12 text-center">
      <span className="section-label">{loading ? 'Loading…' : 'No proxies configured'}</span>
      <p className="max-w-md text-sm text-ink-secondary">
        {loading
          ? 'Reading from local store.'
          : 'Click "New proxy" above to add a SOCKS5 endpoint.'}
      </p>
    </div>
  );
}

function ProxyTable({
  proxies,
  busyId,
  onEdit,
  onRemove,
}: {
  proxies: ProxyConfig[];
  busyId: string | null;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
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
          {proxies.map((p) => (
            <tr
              key={p.id}
              className="border-b border-surface-divider last:border-0 hover:bg-surface-elevated/40"
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
                <span className="mono text-ink-muted">
                  {new Date(p.createdAt).toLocaleString()}
                </span>
              </Td>
              <Td>
                <div className="flex justify-end gap-2">
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
          ))}
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
