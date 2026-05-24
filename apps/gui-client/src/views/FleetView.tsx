// V-346 — Fleet view. Lists Mac mini fleet members the founder has
// declared locally; pings each member's /version on demand to surface
// reachability + driver mode + version.
//
// Local-only registry (tauri-plugin-store). The fleet is the
// founder's choice of API server URLs to ping; no server-side fleet
// management. Each member is a (label, baseUrl) pair.
//
// This view replaces the V-244 NotYet placeholder for the
// "Cluster → Mac mini fleet" sidebar entry.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addFleetMember,
  listFleetMembers,
  pingFleetMember,
  removeFleetMember,
  updateFleetMember,
  validateDraft,
  type FleetMember,
  type FleetMemberDraft,
  type FleetMemberPing,
  type DraftValidation,
} from '../lib/fleet-members';

interface FormState {
  draft: FleetMemberDraft;
  errors: DraftValidation['errors'];
  editingId: string | null;
  visible: boolean;
}

const EMPTY_DRAFT: FleetMemberDraft = {
  label: '',
  baseUrl: '',
  notes: null,
};

export function FleetView(): JSX.Element {
  const [members, setMembers] = useState<FleetMember[]>([]);
  const [pings, setPings] = useState<Record<string, FleetMemberPing | 'pending'>>({});
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>({
    draft: EMPTY_DRAFT,
    errors: {},
    editingId: null,
    visible: false,
  });
  const formRef = useRef<HTMLFormElement | null>(null);

  const refresh = useCallback(async () => {
    const all = await listFleetMembers();
    setMembers(all);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ping = useCallback(async (member: FleetMember) => {
    setPings((prev) => ({ ...prev, [member.id]: 'pending' }));
    const result = await pingFleetMember(member);
    setPings((prev) => ({ ...prev, [member.id]: result }));
  }, []);

  const pingAll = useCallback(async () => {
    await Promise.all(members.map((m) => ping(m)));
  }, [members, ping]);

  function startCreate(): void {
    setForm({
      draft: EMPTY_DRAFT,
      errors: {},
      editingId: null,
      visible: true,
    });
    setTimeout(() => formRef.current?.querySelector('input')?.focus(), 0);
  }

  function startEdit(member: FleetMember): void {
    setForm({
      draft: { label: member.label, baseUrl: member.baseUrl, notes: member.notes },
      errors: {},
      editingId: member.id,
      visible: true,
    });
    setTimeout(() => formRef.current?.querySelector('input')?.focus(), 0);
  }

  function cancelForm(): void {
    setForm({ ...form, visible: false, errors: {} });
  }

  async function submitForm(): Promise<void> {
    const v = validateDraft(form.draft);
    if (!v.ok) {
      setForm({ ...form, errors: v.errors });
      return;
    }
    if (form.editingId) {
      await updateFleetMember(form.editingId, form.draft);
    } else {
      await addFleetMember(form.draft);
    }
    setForm({ ...EMPTY_DRAFT_FORM });
    await refresh();
  }

  async function destroy(member: FleetMember): Promise<void> {
    if (!window.confirm(`Remove "${member.label}" from the fleet?`)) return;
    await removeFleetMember(member.id);
    setPings((prev) => {
      const next = { ...prev };
      delete next[member.id];
      return next;
    });
    await refresh();
  }

  const sorted = useMemo(
    () => [...members].sort((a, b) => a.label.localeCompare(b.label)),
    [members],
  );

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <span className="section-label">Cluster</span>
          <h2 className="mt-1 text-lg font-medium tracking-tight">
            <span className="bg-gradient-to-br from-ink-primary via-ink-primary to-glow-red bg-clip-text text-transparent">
              Mac mini fleet
            </span>
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-secondary">
            Local-only registry of Driftstack control-plane URLs. Add each Mac mini's API server
            URL; "Ping all" hits every member's <code className="mono">/version</code> and surfaces
            reachability, driver mode, and version. The fleet topology lives in this app's settings
            store; nothing is sent to a server.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void pingAll()}
            disabled={members.length === 0}
          >
            Ping all
          </button>
          <button type="button" className="btn-primary" onClick={startCreate}>
            Add member
          </button>
        </div>
      </header>

      {form.visible && (
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault();
            void submitForm();
          }}
          className="rounded border border-surface-divider bg-surface-raised p-4"
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Label" error={form.errors.label}>
              <input
                type="text"
                placeholder="mac-mini-eu-west-1"
                value={form.draft.label}
                onChange={(e) =>
                  setForm({ ...form, draft: { ...form.draft, label: e.target.value } })
                }
                className="w-full rounded bg-surface-inset px-2.5 py-1.5 text-sm text-ink-primary border border-surface-divider focus-visible:border-accent focus-visible:outline-none"
              />
            </Field>
            <Field label="Base URL" error={form.errors.baseUrl}>
              <input
                type="text"
                placeholder="http://10.0.0.5:3000"
                value={form.draft.baseUrl}
                onChange={(e) =>
                  setForm({ ...form, draft: { ...form.draft, baseUrl: e.target.value } })
                }
                className="mono w-full rounded bg-surface-inset px-2.5 py-1.5 text-sm text-ink-primary border border-surface-divider focus-visible:border-accent focus-visible:outline-none"
              />
            </Field>
            <div className="md:col-span-2">
              <Field label="Notes (optional)" error={undefined}>
                <input
                  type="text"
                  placeholder="rack 3, port 8 — workflow A"
                  value={form.draft.notes ?? ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      draft: { ...form.draft, notes: e.target.value || null },
                    })
                  }
                  className="w-full rounded bg-surface-inset px-2.5 py-1.5 text-sm text-ink-primary border border-surface-divider focus-visible:border-accent focus-visible:outline-none"
                />
              </Field>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={cancelForm}>
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              {form.editingId ? 'Save' : 'Add'}
            </button>
          </div>
        </form>
      )}

      {!loading && sorted.length === 0 && !form.visible && (
        <div className="rounded border border-surface-divider bg-surface-raised p-8 text-center text-sm text-ink-secondary">
          No fleet members yet. Click "Add member" to register the first Mac mini's API URL.
        </div>
      )}

      {sorted.length > 0 && (
        <ul className="divide-y divide-surface-divider rounded border border-surface-divider bg-surface-raised">
          {sorted.map((m) => {
            const p = pings[m.id];
            return (
              <li key={m.id} className="flex items-start justify-between gap-4 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-ink-primary">{m.label}</p>
                    {p === 'pending' && <span className="text-2xs text-ink-muted">pinging…</span>}
                    {p && p !== 'pending' && p.ok && (
                      <span className="rounded-full bg-status-ready/20 px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-status-ready">
                        ok · {p.durationMs}ms
                      </span>
                    )}
                    {p && p !== 'pending' && !p.ok && (
                      <span className="rounded-full bg-status-error/20 px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-status-error">
                        unreachable
                      </span>
                    )}
                  </div>
                  <p className="mt-1 mono text-2xs text-ink-secondary">{m.baseUrl}</p>
                  {m.notes !== null && <p className="mt-1 text-2xs text-ink-muted">{m.notes}</p>}
                  {p && p !== 'pending' && p.ok && (
                    <p className="mt-1 text-2xs text-ink-muted">
                      driver: <span className="mono">{p.driver ?? 'unknown'}</span>
                      {p.playwrightBrowser ? ` (${p.playwrightBrowser})` : ''}
                      {p.version ? ` · v${p.version}` : ''}
                    </p>
                  )}
                  {p && p !== 'pending' && !p.ok && p.error && (
                    <p className="mt-1 text-2xs text-status-error">{p.error}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    className="text-2xs text-ink-secondary hover:text-ink-primary"
                    onClick={() => void ping(m)}
                  >
                    Ping
                  </button>
                  <button
                    type="button"
                    className="text-2xs text-ink-secondary hover:text-ink-primary"
                    onClick={() => startEdit(m)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-2xs text-status-error hover:opacity-80"
                    onClick={() => void destroy(m)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const EMPTY_DRAFT_FORM: FormState = {
  draft: EMPTY_DRAFT,
  errors: {},
  editingId: null,
  visible: false,
};

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error: string | undefined;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      {children}
      {error !== undefined && <span className="text-2xs text-status-error">{error}</span>}
    </label>
  );
}
