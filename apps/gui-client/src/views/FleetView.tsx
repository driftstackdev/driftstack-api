// V-346 — Fleet view. Lists Mac mini fleet members the founder has
// declared locally; pings each member's /version on demand to surface
// reachability + version.
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
import { useConfirm } from '../components/ConfirmProvider';
import { SkeletonRows } from '../components/Skeleton';
import { humanizeError } from '../lib/humanize-error';

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
  const confirm = useConfirm();
  const [members, setMembers] = useState<FleetMember[]>([]);
  const [pings, setPings] = useState<Record<string, FleetMemberPing | 'pending'>>({});
  const [loading, setLoading] = useState(true);
  // A failed registry read must not leave the view stuck on a blank
  // perpetual-loading screen — surface it with a retry instead.
  const [loadError, setLoadError] = useState<string | null>(null);
  // A failed add/update/remove (registry write) must surface here, not escape as
  // an unhandled rejection (which would blank the whole app via the fatal overlay).
  const [actionError, setActionError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({
    draft: EMPTY_DRAFT,
    errors: {},
    editingId: null,
    visible: false,
  });
  const formRef = useRef<HTMLFormElement | null>(null);
  const pingPromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const all = await listFleetMembers();
      setMembers(all);
    } catch (err) {
      setLoadError(
        humanizeError(
          err,
          "Couldn't read your saved servers. Check the app's file permissions and try again.",
        ),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ping = useCallback((member: FleetMember): Promise<void> => {
    const existing = pingPromisesRef.current.get(member.id);
    if (existing !== undefined) return existing;

    const task = (async () => {
      setPings((prev) => ({ ...prev, [member.id]: 'pending' }));
      try {
        const result = await pingFleetMember(member);
        setPings((prev) => ({ ...prev, [member.id]: result }));
      } catch (err) {
        // A THROWN ping (vs a resolved {ok:false}) would strand the row on "pending"
        // forever and reject pingAll's Promise.all (audit 2026-07-08). Synthesize an
        // unreachable result so the row resolves and "Ping all" can't fail the batch.
        setPings((prev) => ({
          ...prev,
          [member.id]: {
            ok: false,
            durationMs: 0,
            error: humanizeError(
              err,
              "Couldn't reach this server. Check its address and try again.",
            ),
          },
        }));
      }
    })();
    pingPromisesRef.current.set(member.id, task);
    const release = (): void => {
      if (pingPromisesRef.current.get(member.id) === task) {
        pingPromisesRef.current.delete(member.id);
      }
    };
    void task.then(release, release);
    return task;
  }, []);

  // "Ping all" fans out to every member. Track batch-in-flight so the button
  // reflects progress (it was a dead-looking click on a slow/large fleet — the
  // per-row 'pending' pills were the only signal, easy to miss up top).
  const [pingingAll, setPingingAll] = useState(false);
  const pingingAllRef = useRef(false);
  const pingAll = useCallback(async () => {
    if (pingingAllRef.current) return;
    pingingAllRef.current = true;
    setPingingAll(true);
    try {
      await Promise.all(members.map((m) => ping(m)));
    } finally {
      pingingAllRef.current = false;
      setPingingAll(false);
    }
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
    if (savingRef.current) return;
    const v = validateDraft(form.draft);
    if (!v.ok) {
      setForm({ ...form, errors: v.errors });
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      setActionError(null);
      if (form.editingId) {
        const editedId = form.editingId;
        await updateFleetMember(editedId, form.draft);
        // The edit may have changed baseUrl, which makes the cached ping
        // (reachability / driver / version, keyed by member.id) stale and
        // misleading. Drop it so the row shows un-pinged until re-checked,
        // rather than the OLD URL's result (audit 2026-09-08).
        setPings((prev) => {
          if (prev[editedId] === undefined) return prev;
          const next = { ...prev };
          delete next[editedId];
          return next;
        });
      } else {
        await addFleetMember(form.draft);
      }
      setForm({ ...EMPTY_DRAFT_FORM });
      await refresh();
    } catch (err) {
      setActionError(
        humanizeError(
          err,
          "Couldn't save this server. Check the app's file permissions and try again.",
        ),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function destroy(member: FleetMember): Promise<void> {
    if (
      !(await confirm(`Remove "${member.label}" from your saved servers?`, {
        confirmLabel: 'Remove',
      }))
    )
      return;
    try {
      setActionError(null);
      await removeFleetMember(member.id);
      setPings((prev) => {
        const next = { ...prev };
        delete next[member.id];
        return next;
      });
      await refresh();
    } catch (err) {
      setActionError(
        humanizeError(
          err,
          `Couldn't remove "${member.label}". Check the app's file permissions and try again.`,
        ),
      );
    }
  }

  const sorted = useMemo(
    () => [...members].sort((a, b) => a.label.localeCompare(b.label)),
    [members],
  );

  // At-a-glance fleet health, derived purely from the loaded members + their
  // ping results (no new data / no extra fetch). Drives the icon-led KPI strip.
  const reachable = members.filter((m) => {
    const p = pings[m.id];
    return p !== undefined && p !== 'pending' && p.ok;
  }).length;
  const unreachable = members.filter((m) => {
    const p = pings[m.id];
    return p !== undefined && p !== 'pending' && !p.ok;
  }).length;
  const pinged = reachable + unreachable;

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-y-auto p-6 [&>*]:shrink-0">
      {/* Page hero — an accent icon chip + a radial identity glow, the
          local-only-registry framing, and the Ping all + Add member actions on
          the right. Matches the Command Center / Settings / Sessions gradient
          card language. */}
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
            <IconServer />
          </span>
          <div className="min-w-0 flex-1">
            <span className="section-label text-accent-text">Self-hosted</span>
            <h2 className="mt-0.5 text-2xl font-semibold tracking-tight text-ink-primary">
              Your servers
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-ink-secondary">
              A list of your own Driftstack servers, saved only on this computer and never uploaded.
              Add each server's address, then use “Check all” to see whether each one is reachable
              and which version it runs.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void pingAll()}
              disabled={members.length === 0 || pingingAll}
              aria-busy={pingingAll}
            >
              {pingingAll ? 'Checking…' : 'Check all'}
            </button>
            <button type="button" className="btn-primary" onClick={startCreate}>
              Add server
            </button>
          </div>
        </div>
      </header>

      {/* Fleet KPI strip — icon-led at-a-glance cards derived from the loaded
          members + ping results (no new data / no new fetch), matching the
          Command Center / Sessions stat strips. Only shown once there's a fleet
          to summarize. */}
      {sorted.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat icon={<IconServer />} l="Servers" value={members.length} sub="saved addresses" />
          <Stat
            icon={<IconCheck />}
            l="Reachable"
            value={reachable}
            accent
            sub={pinged > 0 ? `${pinged} checked` : 'run “Check all”'}
          />
          <Stat
            icon={<IconAlert />}
            l="Unreachable"
            value={unreachable}
            // ⛔ "all healthy" USED TO SHOW WHENEVER NOTHING HAD FAILED — which
            // includes when nothing has been dialled. On first open the strip
            // claimed, simultaneously, "Unreachable 0 — all healthy" and "Not
            // checked N — run Check all", and a customer reads the green health
            // claim rather than the audit of it sitting next to it.
            //
            // `unreachable > 0` is a PRESENCE test over settled results: it can
            // see a server that was measured and failed, and cannot see one that
            // was never measured at all. Health may only be asserted once every
            // member has actually answered.
            sub={
              unreachable > 0
                ? 'needs attention'
                : pinged === 0
                  ? 'none checked yet'
                  : pinged < members.length
                    ? `${members.length - pinged} still unchecked`
                    : 'all healthy'
            }
          />
          <Stat
            icon={<IconClock />}
            l="Not checked"
            value={Math.max(0, members.length - pinged)}
            sub={pinged < members.length ? 'run “Check all”' : 'all checked'}
          />
        </div>
      )}

      {actionError !== null && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-lg border border-status-error/40 bg-status-error/10 px-3 py-2 text-sm text-status-error"
        >
          <span>{actionError}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 text-status-error/70 transition hover:text-status-error"
            onClick={() => setActionError(null)}
          >
            ×
          </button>
        </div>
      )}

      {form.visible && (
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault();
            void submitForm();
          }}
          className="rounded-xl border border-surface-divider bg-surface-raised p-4 shadow-sm"
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Label" error={form.errors.label}>
              <input
                type="text"
                disabled={saving}
                placeholder="office-server"
                value={form.draft.label}
                onChange={(e) =>
                  setForm({ ...form, draft: { ...form.draft, label: e.target.value } })
                }
                className="w-full rounded bg-surface-inset px-2.5 py-1.5 text-sm text-ink-primary border border-surface-divider focus-visible:border-accent focus-visible:outline-none"
              />
            </Field>
            <Field label="Server address" error={form.errors.baseUrl}>
              <input
                type="text"
                disabled={saving}
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
                  disabled={saving}
                  placeholder="Main office — used for workflow A"
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
            <button type="button" className="btn-secondary" onClick={cancelForm} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving} aria-busy={saving}>
              {saving ? 'Saving…' : form.editingId ? 'Save' : 'Add'}
            </button>
          </div>
        </form>
      )}

      {loading && <SkeletonRows rows={3} label="Loading your servers…" />}

      {!loading && loadError !== null && (
        <div className="flex flex-col items-center gap-3 rounded border border-surface-divider bg-surface-raised p-8 text-center">
          <span className="section-label text-status-error">Couldn't load your server list</span>
          <p className="max-w-md text-sm text-ink-secondary">{loadError}</p>
          <button type="button" className="btn-secondary" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      )}

      {!loading && loadError === null && sorted.length === 0 && !form.visible && (
        <section className="flex flex-col items-center gap-4 rounded-2xl border border-surface-divider bg-surface-raised px-8 py-12 text-center shadow-sm">
          <span
            className="grid h-12 w-12 place-items-center rounded-xl bg-surface-inset text-ink-muted"
            aria-hidden="true"
          >
            <IconServer />
          </span>
          <p className="max-w-md text-sm leading-relaxed text-ink-secondary">
            No servers yet. Click "Add server" to save the address of your first Driftstack server.
          </p>
        </section>
      )}

      {sorted.length > 0 && (
        <ul className="divide-y divide-surface-divider overflow-hidden rounded-xl border border-surface-divider bg-surface-raised shadow-sm">
          {sorted.map((m) => {
            const p = pings[m.id];
            // The leading identity chip is tinted by reachability so a member
            // reads its state at a glance: ready when its last ping was ok,
            // error when unreachable, quiet otherwise (unpinged / pinging).
            const reached = p !== undefined && p !== 'pending' && p.ok;
            const failed = p !== undefined && p !== 'pending' && !p.ok;
            const chipClass = reached
              ? 'bg-status-ready/15 text-status-ready'
              : failed
                ? 'bg-status-error/12 text-status-error'
                : 'bg-surface-inset text-ink-muted';
            return (
              <li
                key={m.id}
                className="flex items-start justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-surface-elevated"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span
                    className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg ${chipClass}`}
                    aria-hidden="true"
                  >
                    <IconServer />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-ink-primary">{m.label}</p>
                      {p === 'pending' && (
                        <span className="text-2xs text-ink-muted">checking…</span>
                      )}
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
                    {/* Only the version is customer copy. The ping also learns the
                        server's driver mode, which describes how the server runs and
                        is deliberately not shown (owner directive 2026-09-15). */}
                    {p && p !== 'pending' && p.ok && p.version && (
                      <p className="mt-1 text-2xs text-ink-muted">Version {p.version}</p>
                    )}
                    {p && p !== 'pending' && !p.ok && p.error && (
                      <p className="mt-1 text-2xs text-status-error">{p.error}</p>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-2xs text-ink-secondary transition-colors hover:bg-surface-inset hover:text-ink-primary"
                    onClick={() => void ping(m)}
                    disabled={p === 'pending'}
                    aria-busy={p === 'pending'}
                  >
                    {p === 'pending' ? 'Checking…' : 'Check'}
                  </button>
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-2xs text-ink-secondary transition-colors hover:bg-surface-inset hover:text-ink-primary"
                    onClick={() => startEdit(m)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-2xs text-status-error transition-colors hover:bg-status-error/10 hover:opacity-80"
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

// Icon-led KPI card — an icon chip + an uppercase label + a big mono numeral +
// a sub-line, matching the Command Center / Sessions stat strips. `accent`
// tints the chip + numeral (light → accent, dark → ready) for the highlighted
// metric. Pure presentation over the derived fleet counts.
function Stat({
  icon,
  l,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  l: string;
  value: number;
  sub: string;
  accent?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-surface-divider bg-surface-raised px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2">
        <span
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
            accent ? 'bg-accent/15 text-accent' : 'bg-surface-inset text-ink-secondary'
          }`}
          aria-hidden="true"
        >
          {icon}
        </span>
        <span className="section-label">{l}</span>
      </div>
      <span
        className={`mono text-2xl font-semibold leading-none tracking-tight tabular-nums ${
          accent ? 'text-accent-text dark:text-status-ready' : 'text-ink-primary'
        }`}
      >
        {value}
      </span>
      <span className="text-[10.5px] text-ink-muted">{sub}</span>
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
// A stacked-server / rack glyph, echoing the Mac mini fleet framing.
function IconServer(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
      <rect x="2" y="9" width="12" height="4.5" rx="1" />
      <path d="M4.5 4.75h.01M4.5 11.25h.01" />
    </svg>
  );
}
function IconCheck(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.25 8.25 7.25 10.25 11 6" />
    </svg>
  );
}
function IconAlert(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <path d="M8 1.75 14.5 13.5H1.5Z" />
      <path d="M8 6.25v3M8 11.5h.01" />
    </svg>
  );
}
function IconClock(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}
