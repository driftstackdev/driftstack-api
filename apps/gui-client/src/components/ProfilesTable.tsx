// ProfilesTable (2026-06-15, v2) — the list view as a clean, sortable,
// professional table. Surfaces the SAME probe-derived data the grid card uses.
// Pure presentational: ProfilesView computes the row view-models + passes
// handlers.
//
// v2 (founder batch #2):
//  - Keyboard-selectable: a real checkbox column (+ header select-all) so AT /
//    keyboard users can select rows for the bulk bar; row-click still selects
//    for mouse (the checkbox stops propagation so the two don't cancel out).
//  - Exit IP cell consolidates everything egress: flag + IP + location
//    (city · region · country when known) + latency + an inline Test button —
//    so Test/latency are no longer separate columns crowding Actions.
//  - Overflow fixed: auto layout + overflow-x-auto, so action buttons never
//    spill outside the table; wide content scrolls within the bordered box.
//  - More useful columns: Tags, Created, Last used, Notes.

import { useRef, useState, type JSX } from 'react';
import { RelativeTime } from './RelativeTime';

export type ProfilesTableSortKey = 'name' | 'status' | 'country' | 'created' | 'lastUsed';

export interface ProfileTableRow {
  id: string;
  name: string;
  icon?: string;
  deviceLabel: string;
  running: boolean;
  /** Worktimer — ISO start time of the bound running session (null when idle
   *  or the start time isn't known). Drives the live "running for" elapsed. */
  runningSinceIso?: string | null;
  hasProxy: boolean;
  flag: string;
  countryCode: string | null;
  exitIp: string | null;
  proxyAddress: string | null; // host:port of the bound proxy (hover detail)
  locationLabel: string | null; // resolved city · region · country (or country)
  probed: boolean;
  udp: 'ok' | 'fail' | 'unknown';
  latencyMs: number | null;
  folder: string;
  tags: ReadonlyArray<string>;
  note: string;
  /** doc-150 item 5 — already-formatted per-profile storage size (e.g. "2.4 MiB"
   *  or "—" when never saved). The parent formats it via fmtBytes. */
  sizeLabel: string;
  /** True when existing profile save metadata proves saved browser state is
   *  available. The tab count itself is encrypted and intentionally not guessed. */
  savedTabsReopen?: boolean;
  createdAtIso: string | null;
  lastUsedIso: string | null;
  selected: boolean;
  busy: boolean;
  /** True only while this row is creating a session. */
  launching: boolean;
  testing: boolean;
  testDisabled: boolean;
  launchDisabled: boolean;
  launchDisabledReason?: string;
}

export interface ProfilesTableProps {
  rows: ReadonlyArray<ProfileTableRow>;
  sortKey: ProfilesTableSortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: ProfilesTableSortKey) => void;
  allSelected: boolean;
  onToggleSelectAll: () => void;
  onToggleSelect: (id: string) => void;
  /** True when SOME profile is busy (a global single-flight is held — e.g.
   *  another row launching through the ~12s server probe). The mutate actions
   *  (Duplicate / Trim / Delete) early-return on that global guard, so they're
   *  disabled with a tooltip rather than silently no-op'ing on a click. */
  anyBusy?: boolean;
  onPrimary: (id: string) => void; // Launch (idle) / Open session (running)
  onWatch: (id: string) => void;
  onStop: (id: string) => void;
  onTest: (id: string) => void;
  onEdit: (id: string) => void;
  /** Duplicate a profile (server clone). Disabled at the tier cap. Optional —
   *  when omitted (founder 2026-06-20 CLONE_ENABLED=false) the Duplicate action
   *  is hidden entirely; the handler is kept so it can be re-enabled. */
  onClone?: (id: string) => void;
  cloneDisabled?: boolean;
  cloneDisabledReason?: string;
  /** doc-150 §8 — "Clear cache, keep logins". Trims the profile's re-fetchable
   *  caches. Disabled while the row is busy. */
  onTrim: (id: string) => void;
  onDelete: (id: string) => void;
  // Inline note editing (founder batch #2 "Add note"). Called with the trimmed
  // note on commit (Enter / blur); empty string clears the note.
  onSaveNote: (id: string, note: string) => string | null | void | Promise<string | null | void>;
}

interface Col {
  key: ProfilesTableSortKey | null;
  label: string;
  align?: 'right';
  hideSmall?: boolean;
  hideMed?: boolean;
}

const COLS: ReadonlyArray<Col> = [
  { key: 'name', label: 'Profile' },
  { key: null, label: 'Tags', hideSmall: true },
  { key: 'status', label: 'Status', hideMed: true },
  { key: 'country', label: 'Exit IP' },
  { key: null, label: 'UDP', hideMed: true },
  { key: 'created', label: 'Created', hideSmall: true },
  { key: 'lastUsed', label: 'Last used', hideSmall: true },
  // doc-150 item 5 — per-profile sealed-store size. Collapses on narrow widths
  // with the other secondary columns.
  { key: null, label: 'Storage', hideSmall: true, align: 'right' },
  { key: null, label: 'Notes', hideSmall: true },
  { key: null, label: 'Actions', align: 'right' },
];

// Two responsive tiers so the table fits narrow windows without assuming a
// full-width viewport (founder 2026-06-16). These are CONTAINER queries
// (see .ds-table-shell + @container in styles/index.css), NOT viewport
// breakpoints: the table area is the window minus the nav sidebar AND the
// folder/tag rail, so md:/lg: misfired and the table scrolled instead of
// fitting. Keyed off the card's own width: under 1000px the secondary
// columns (Tags/Created/Last used/Notes) collapse; under 720px Status + UDP
// also collapse, leaving the essentials — select · Profile · Exit IP · Actions.
const HIDE_SMALL = 'ds-col-l';
const HIDE_MED = 'ds-col-m';

export function ProfilesTable(p: ProfilesTableProps): JSX.Element {
  return (
    <div className="ds-table-shell overflow-x-auto rounded-lg border border-surface-divider bg-surface-raised">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-surface-divider text-ink-muted">
            <th scope="col" className="w-9 px-3 py-2">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 cursor-pointer accent-accent"
                checked={p.allSelected}
                onChange={p.onToggleSelectAll}
                aria-label="Select all profiles"
                title="Select all"
              />
            </th>
            {COLS.map((c) => (
              <th
                key={c.label}
                scope="col"
                className={`px-3 py-2 font-medium ${c.align === 'right' ? 'text-right' : ''} ${c.hideSmall ? HIDE_SMALL : ''} ${c.hideMed ? HIDE_MED : ''}`}
              >
                {c.key !== null ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-ink-primary"
                    onClick={() => p.onSort(c.key as ProfilesTableSortKey)}
                  >
                    {c.label}
                    <SortCaret active={p.sortKey === c.key} dir={p.sortDir} />
                  </button>
                ) : (
                  <span className="uppercase tracking-wide">{c.label}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => (
            <Row key={r.id} r={r} p={p} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const OTHER_BUSY_HINT = 'Another profile is busy — wait for it to finish';

function Row({ r, p }: { r: ProfileTableRow; p: ProfilesTableProps }): JSX.Element {
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  // A global single-flight (busyId) makes the mutate handlers early-return; when
  // ANOTHER row holds it, disable this row's mutate actions with a hint so the
  // click gives feedback instead of silently no-op'ing. `r.busy` is THIS row.
  const otherBusy = (p.anyBusy ?? false) && !r.busy;
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(r.note);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteSaveInFlightRef = useRef(false);
  const commitNote = async (): Promise<void> => {
    if (noteSaveInFlightRef.current) return;
    noteSaveInFlightRef.current = true;
    setNoteSaving(true);
    setNoteError(null);
    try {
      const error = await p.onSaveNote(r.id, noteDraft.trim());
      if (typeof error === 'string' && error.length > 0) {
        setNoteError(error.slice(0, 240));
        return;
      }
      setEditingNote(false);
    } catch {
      setNoteError("Couldn't save the note. Check your connection and try again.");
    } finally {
      noteSaveInFlightRef.current = false;
      setNoteSaving(false);
    }
  };
  const exitHover = [r.proxyAddress, r.locationLabel].filter((x) => x !== null).join(' · ');
  return (
    <tr
      onClick={() => p.onToggleSelect(r.id)}
      className={`cursor-pointer border-b border-surface-divider/60 align-top transition-colors last:border-0 ${
        r.selected ? 'bg-accent-subtle' : 'hover:bg-surface-elevated'
      }`}
    >
      {/* select checkbox — keyboard path; stopPropagation so it doesn't double-
          toggle with the row click. */}
      <td className="px-3 py-2">
        <input
          type="checkbox"
          className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-accent"
          checked={r.selected}
          onClick={(e) => e.stopPropagation()}
          onChange={() => p.onToggleSelect(r.id)}
          aria-label={`Select ${r.name}`}
        />
      </td>
      {/* Profile: status dot + icon + name + device subtitle + folder */}
      <td className="px-3 py-2">
        <div className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${r.running ? 'bg-status-ready' : 'bg-ink-muted/40'}`}
          />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate font-medium text-ink-primary">
              {r.icon ? (
                <span aria-hidden="true" className="text-[13px] leading-none">
                  {r.icon}
                </span>
              ) : null}
              <span className="truncate">{r.name}</span>
            </p>
            <p className="truncate text-[10px] text-ink-muted">
              {r.deviceLabel}
              {r.folder !== '' ? ` · 📁 ${r.folder}` : ''}
            </p>
            {r.savedTabsReopen === true && !r.running ? (
              <p
                data-component="saved-tabs-reopen"
                title="This profile's saved tabs reopen when you launch it"
                className="mt-0.5 text-[10px] font-medium text-accent"
              >
                ↻ Saved tabs reopen
              </p>
            ) : null}
          </div>
        </div>
      </td>
      {/* Tags */}
      <td className={`px-3 py-2 ${HIDE_SMALL}`}>
        {r.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {r.tags.map((t) => (
              <span
                key={t}
                className="rounded border border-surface-divider px-1 py-px text-[10px] text-ink-muted"
              >
                {t}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-ink-muted">—</span>
        )}
      </td>
      {/* Status (collapses below md) — running rows show a live worktimer. */}
      <td className={`px-3 py-2 ${HIDE_MED}`}>
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            r.running ? 'bg-status-ready/15 text-status-ready' : 'bg-surface-inset text-ink-muted'
          }`}
        >
          {r.running ? 'Live' : 'Idle'}
        </span>
        {r.running && r.runningSinceIso != null && r.runningSinceIso.length > 0 && (
          <span
            className="mono mt-0.5 block text-[10px] text-ink-muted"
            title={`Running since ${new Date(r.runningSinceIso).toLocaleString()}`}
          >
            {formatElapsed(r.runningSinceIso)}
          </span>
        )}
      </td>
      {/* Exit IP — flag + IP + location + latency + inline Test */}
      <td className="px-3 py-2">
        {r.hasProxy ? (
          <div className="flex flex-col gap-0.5">
            <div
              className="flex items-center gap-1.5"
              title={exitHover.length > 0 ? exitHover : undefined}
            >
              <span aria-hidden="true">{r.flag}</span>
              {r.exitIp !== null ? (
                <span className="mono truncate text-ink-primary">{r.exitIp}</span>
              ) : (
                <span className="text-ink-muted">{r.probed ? 'no exit IP' : 'untested'}</span>
              )}
              <button
                type="button"
                className="ml-1 shrink-0 rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary hover:bg-surface-divider hover:text-ink-primary disabled:opacity-50"
                onClick={stop(() => p.onTest(r.id))}
                disabled={r.testDisabled}
                title="Test proxy — reachability, latency, exit IP"
              >
                {r.testing ? '…' : 'Test'}
              </button>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-ink-muted">
              {r.locationLabel !== null && <span className="truncate">{r.locationLabel}</span>}
              {r.latencyMs !== null && (
                <span className={`mono ${r.latencyMs <= 100 ? '' : 'text-status-busy'}`}>
                  {r.latencyMs}ms
                </span>
              )}
            </div>
          </div>
        ) : (
          <span className="text-ink-muted">no proxy</span>
        )}
      </td>
      {/* UDP (collapses below md) */}
      <td className={`px-3 py-2 ${HIDE_MED}`}>
        {r.udp === 'unknown' ? (
          <span className="text-ink-muted">–</span>
        ) : (
          <span
            className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
              r.udp === 'ok'
                ? 'bg-status-ready/20 text-status-ready'
                : 'bg-status-error/20 text-status-error'
            }`}
            title={
              r.udp === 'ok'
                ? 'UDP relay verified (WebRTC + QUIC)'
                : 'No UDP relay — WebRTC/QUIC fall back to TCP'
            }
          >
            {r.udp === 'ok' ? '✓' : '✗'}
          </span>
        )}
      </td>
      {/* Created */}
      <td className={`whitespace-nowrap px-3 py-2 text-ink-muted ${HIDE_SMALL}`}>
        {r.createdAtIso !== null ? (
          <RelativeTime iso={r.createdAtIso} tooltipPrefix="Created" />
        ) : (
          '—'
        )}
      </td>
      {/* Last used */}
      <td className={`whitespace-nowrap px-3 py-2 text-ink-muted ${HIDE_SMALL}`}>
        {r.lastUsedIso !== null ? (
          <RelativeTime iso={r.lastUsedIso} tooltipPrefix="Last used" />
        ) : (
          'never'
        )}
      </td>
      {/* Storage — per-profile sealed-store size ("—" = never saved). */}
      <td
        className={`mono whitespace-nowrap px-3 py-2 text-right text-ink-muted ${HIDE_SMALL}`}
        title="Stored profile size (encrypted browser state)"
      >
        {r.sizeLabel}
      </td>
      {/* Notes — click to edit inline (founder batch #2 "Add note"). The cell
          stops click propagation so editing never toggles row selection. */}
      <td className={`px-3 py-2 ${HIDE_SMALL}`} onClick={(e) => e.stopPropagation()}>
        {editingNote ? (
          <div aria-busy={noteSaving} className="flex max-w-[16rem] flex-col gap-1">
            <input
              autoFocus
              aria-label={`Note for ${r.name}`}
              value={noteDraft}
              disabled={noteSaving}
              maxLength={280}
              placeholder="Add a note…"
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitNote();
                else if (e.key === 'Escape' && !noteSaving) {
                  setNoteDraft(r.note);
                  setNoteError(null);
                  setEditingNote(false);
                }
              }}
              onBlur={() => void commitNote()}
              className="w-full rounded border border-surface-divider bg-surface-inset px-1.5 py-0.5 text-xs text-ink-primary placeholder:text-ink-muted focus:border-accent focus:outline-none disabled:opacity-60"
            />
            {noteSaving ? <span className="text-[10px] text-ink-muted">Saving…</span> : null}
            {noteError !== null ? (
              <span role="alert" className="text-[10px] text-status-error">
                {noteError}
              </span>
            ) : null}
          </div>
        ) : r.note.trim() !== '' ? (
          <button
            type="button"
            onClick={() => {
              setNoteDraft(r.note);
              setNoteError(null);
              setEditingNote(true);
            }}
            className="block max-w-[16rem] truncate text-left text-ink-secondary hover:text-ink-primary"
            title="Click to edit note"
          >
            {r.note}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setNoteDraft('');
              setNoteError(null);
              setEditingNote(true);
            }}
            className="text-ink-muted transition-colors hover:text-ink-primary"
            title="Add a note"
          >
            + note
          </button>
        )}
      </td>
      {/* Actions */}
      <td className="whitespace-nowrap px-3 py-2 text-right">
        <div className="inline-flex items-center gap-1.5">
          {r.running ? (
            <>
              <button
                type="button"
                className="rounded bg-surface-elevated px-2 py-1 text-[11px] font-medium text-ink-primary hover:bg-surface-divider disabled:opacity-50"
                onClick={stop(() => p.onWatch(r.id))}
                disabled={r.busy}
              >
                Live view
              </button>
              <button
                type="button"
                className="rounded border border-status-error/40 bg-status-error/10 px-2 py-1 text-[11px] font-medium text-status-error hover:bg-status-error/20 disabled:opacity-50"
                onClick={stop(() => p.onStop(r.id))}
                disabled={r.busy}
              >
                {r.busy ? 'Stopping…' : 'Stop'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="rounded bg-accent px-2 py-1 text-[11px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
              onClick={stop(() => p.onPrimary(r.id))}
              disabled={r.busy || r.launchDisabled}
              aria-busy={r.launching}
              title={r.launchDisabled ? r.launchDisabledReason : undefined}
            >
              {r.launching ? (
                <span className="inline-flex items-center justify-center gap-1.5">
                  <span
                    aria-hidden="true"
                    data-component="launch-spinner"
                    className="h-3 w-3 animate-spin rounded-full border-2 border-white/35 border-t-white"
                  />
                  Launching…
                </span>
              ) : (
                'Launch'
              )}
            </button>
          )}
          <button
            type="button"
            className="text-[11px] text-ink-muted hover:text-ink-primary disabled:opacity-50"
            onClick={stop(() => p.onEdit(r.id))}
            disabled={r.busy}
          >
            Edit
          </button>
          {p.onClone && (
            <button
              type="button"
              className="text-[11px] text-ink-muted hover:text-ink-primary disabled:opacity-50"
              onClick={stop(() => p.onClone?.(r.id))}
              disabled={r.busy || p.cloneDisabled || otherBusy}
              title={
                p.cloneDisabled ? p.cloneDisabledReason : otherBusy ? OTHER_BUSY_HINT : undefined
              }
            >
              Duplicate
            </button>
          )}
          {/* doc-150 §8 — Trim: clear re-fetchable caches, keep logins. */}
          <button
            type="button"
            className="text-[11px] text-ink-muted hover:text-ink-primary disabled:opacity-50"
            onClick={stop(() => p.onTrim(r.id))}
            disabled={r.busy || otherBusy}
            title={otherBusy ? OTHER_BUSY_HINT : 'Clear cache, keep logins'}
          >
            Trim
          </button>
          <button
            type="button"
            className="text-[11px] text-ink-muted hover:text-status-error disabled:opacity-50"
            onClick={stop(() => p.onDelete(r.id))}
            disabled={r.busy || r.running || otherBusy}
            title={
              r.running
                ? 'Stop the profile before deleting'
                : otherBusy
                  ? OTHER_BUSY_HINT
                  : undefined
            }
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Worktimer — compact elapsed since an ISO start ("12s" / "4m" / "1h 2m" /
 *  "2d 3h"). Recomputed on each render; the parent's poll re-renders it. */
function formatElapsed(startIso: string): string {
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (sec < 60) return `${sec.toString()}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min.toString()}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr.toString()}h ${(min % 60).toString()}m`;
  return `${Math.floor(hr / 24).toString()}d ${(hr % 24).toString()}h`;
}

function SortCaret({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }): JSX.Element {
  if (!active) return <span className="text-ink-muted/40">↕</span>;
  return <span className="text-accent">{dir === 'asc' ? '↑' : '↓'}</span>;
}
