// ProfilesTable (2026-06-15) — the list view as a clean, sortable, professional
// table. Surfaces the SAME probe-derived data the grid card uses (country, exit
// IP, UDP, latency) so grid + list are consistent. Pure presentational:
// ProfilesView computes the row view-models + passes handlers. Row click toggles
// selection (matches the grid card); action buttons stopPropagation.
//
// Responsive: the core columns (Profile / Status / Exit IP / UDP / Latency /
// Actions) always show; Device folds into the Profile cell and Last-used hides
// below md, so the table stays fully visible on smaller windows without a
// horizontal scrollbar cutting it off. The Exit IP cell shows the IP with its
// location beneath and, on hover, the bound proxy address + location.

import type { JSX } from 'react';
import { RelativeTime } from './RelativeTime';

export type ProfilesTableSortKey = 'name' | 'status' | 'country' | 'latency' | 'lastUsed';

export interface ProfileTableRow {
  id: string;
  name: string;
  deviceLabel: string;
  running: boolean;
  hasProxy: boolean;
  flag: string;
  countryCode: string | null;
  exitIp: string | null;
  proxyAddress: string | null; // host:port of the bound proxy (hover detail)
  locationLabel: string | null; // resolved country name for the exit IP
  probed: boolean; // a probe has run (even if it returned no exit IP)
  udp: 'ok' | 'fail' | 'unknown';
  latencyMs: number | null;
  folder: string;
  tags: ReadonlyArray<string>;
  lastUsedIso: string | null;
  selected: boolean;
  busy: boolean;
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
  onToggleSelect: (id: string) => void;
  onPrimary: (id: string) => void; // Launch (idle) / Open session (running)
  onWatch: (id: string) => void;
  onStop: (id: string) => void;
  onTest: (id: string) => void;
  onDelete: (id: string) => void;
}

interface Col {
  key: ProfilesTableSortKey | null;
  label: string;
  align?: 'right';
  hideSmall?: boolean;
}

const COLS: ReadonlyArray<Col> = [
  { key: 'name', label: 'Profile' },
  { key: 'status', label: 'Status' },
  { key: 'country', label: 'Exit IP' },
  { key: null, label: 'UDP' },
  { key: 'latency', label: 'Latency', align: 'right' },
  { key: 'lastUsed', label: 'Last used', hideSmall: true },
  { key: null, label: 'Actions', align: 'right' },
];

const HIDE_SMALL = 'hidden md:table-cell';

export function ProfilesTable(p: ProfilesTableProps): JSX.Element {
  return (
    <div className="rounded-lg border border-surface-divider bg-surface-raised">
      <table className="w-full table-fixed border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-surface-divider text-ink-muted">
            {COLS.map((c) => (
              <th
                key={c.label}
                scope="col"
                className={`px-3 py-2 font-medium ${c.align === 'right' ? 'text-right' : ''} ${c.hideSmall ? HIDE_SMALL : ''}`}
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

function Row({ r, p }: { r: ProfileTableRow; p: ProfilesTableProps }): JSX.Element {
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const exitHover = [r.proxyAddress, r.locationLabel].filter((x) => x !== null).join(' · ');
  return (
    <>
      <tr
        onClick={() => p.onToggleSelect(r.id)}
        className={`cursor-pointer border-b border-surface-divider/60 align-top transition-colors last:border-0 ${
          r.selected ? 'bg-accent-subtle' : 'hover:bg-surface-elevated'
        }`}
      >
        {/* Profile: status dot + name + device subtitle + folder/tags */}
        <td className="px-3 py-2">
          <div className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${r.running ? 'bg-status-ready' : 'bg-ink-muted/40'}`}
            />
            <div className="min-w-0">
              <p className="truncate font-medium text-ink-primary">{r.name}</p>
              <p className="truncate text-[10px] text-ink-muted">{r.deviceLabel}</p>
              {(r.folder !== '' || r.tags.length > 0) && (
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  {r.folder !== '' && (
                    <span className="rounded bg-surface-inset px-1 py-px text-[10px] text-ink-secondary">
                      📁 {r.folder}
                    </span>
                  )}
                  {r.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded border border-surface-divider px-1 py-px text-[10px] text-ink-muted"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </td>
        {/* Status */}
        <td className="px-3 py-2">
          <span
            className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              r.running ? 'bg-status-ready/15 text-status-ready' : 'bg-surface-inset text-ink-muted'
            }`}
          >
            {r.running ? 'Live' : 'Idle'}
          </span>
        </td>
        {/* Exit IP + location (hover: proxy address · location) */}
        <td className="px-3 py-2">
          {r.hasProxy ? (
            r.exitIp !== null ? (
              <div title={exitHover.length > 0 ? exitHover : undefined}>
                <div className="flex items-center gap-1.5">
                  <span aria-hidden="true">{r.flag}</span>
                  <span className="mono truncate text-ink-primary">{r.exitIp}</span>
                </div>
                {r.locationLabel !== null && (
                  <p className="truncate text-[10px] text-ink-muted">{r.locationLabel}</p>
                )}
              </div>
            ) : (
              <span className="text-ink-muted">{r.probed ? 'no exit IP' : 'untested'}</span>
            )
          ) : (
            <span className="text-ink-muted">no proxy</span>
          )}
        </td>
        {/* UDP */}
        <td className="px-3 py-2">
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
        {/* Latency */}
        <td className="px-3 py-2 text-right">
          {r.latencyMs !== null ? (
            <span
              className={`mono ${r.latencyMs <= 100 ? 'text-ink-secondary' : 'text-status-busy'}`}
            >
              {r.latencyMs}ms
            </span>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </td>
        {/* Last used (hidden on small screens) */}
        <td className={`px-3 py-2 text-ink-muted ${HIDE_SMALL}`}>
          {r.lastUsedIso !== null ? (
            <RelativeTime iso={r.lastUsedIso} tooltipPrefix="Last used" />
          ) : (
            'never'
          )}
        </td>
        {/* Actions */}
        <td className="px-3 py-2 text-right">
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
                title={r.launchDisabled ? r.launchDisabledReason : undefined}
              >
                {r.busy ? 'Launching…' : 'Launch'}
              </button>
            )}
            {r.hasProxy && (
              <button
                type="button"
                className="text-[11px] text-ink-muted hover:text-ink-primary disabled:opacity-50"
                onClick={stop(() => p.onTest(r.id))}
                disabled={r.testDisabled}
                title="Test proxy — reachability, latency, exit IP"
              >
                {r.testing ? '…' : 'Test'}
              </button>
            )}
            <button
              type="button"
              className="text-[11px] text-ink-muted hover:text-status-error disabled:opacity-50"
              onClick={stop(() => p.onDelete(r.id))}
              disabled={r.busy || r.running}
              title={r.running ? 'Stop the profile before deleting' : undefined}
            >
              Delete
            </button>
          </div>
        </td>
      </tr>
    </>
  );
}

function SortCaret({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }): JSX.Element {
  if (!active) return <span className="text-ink-muted/40">↕</span>;
  return <span className="text-accent">{dir === 'asc' ? '↑' : '↓'}</span>;
}
