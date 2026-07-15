// Device picker for the create-profile flow — a searchable, filterable,
// family-grouped list with a selected-device hero, replacing the prior
// device-card grid. Product-approved redesign (2026-06-25).
//
// Data-driven by design: every device row is derived from the shared
// ARCHETYPE_REGISTRY, and the engine/family/iOS filter axes are computed from
// whatever entries exist. Engine chips are rendered only for engines present
// in the live catalog, so the picker never advertises unavailable roadmap work.
//
// Selectability is the caller's contract: a device is `selectable` iff the
// caller marked it so (SELECTABLE_STATUSES.has(status) at the call site). A
// non-selectable entry still renders — as a muted, non-clickable "reference"
// row — and is never returned by selection or randomize.

import { useId, useMemo, useState, type JSX, type KeyboardEvent } from 'react';

/** One pickable device, flattened from an archetype registry entry. */
export interface PickerDevice {
  /** Canonical archetype slug (the value persisted on the profile). */
  readonly id: string;
  /** Marketing device name, e.g. `iPhone 16 Pro`. */
  readonly device: string;
  /** iOS version segment, e.g. `18.7`. */
  readonly iosVersion: string;
  /** Safari version segment, e.g. `26.4`. */
  readonly safariVersion: string;
  /** Rendering engine — all current entries are WebKit; future-proofed. */
  readonly engine: 'webkit' | 'chrome';
  /** Whether this device can be selected (bit-exact). Non-selectable entries
   *  render as muted "reference" rows. */
  readonly selectable: boolean;
}

// Illustrative logical viewport + DPR per model family, for the hero spec
// strip. Keyed on the marketing device name; an unknown device falls back to a
// neutral readout so a future model never renders a broken spec. DPR is 3 for
// every shipped iPhone. (The fingerprint itself is the fork's concern; this is
// a human-readable spec hint only.)
const DEVICE_DIMS: Record<string, string> = {
  'iPhone 13 mini': '375×812',
  'iPhone 13': '390×844',
  'iPhone 13 Pro': '390×844',
  'iPhone 13 Pro Max': '428×926',
  'iPhone 14': '390×844',
  'iPhone 14 Plus': '428×926',
  'iPhone 14 Pro': '393×852',
  'iPhone 14 Pro Max': '430×932',
  'iPhone 15': '393×852',
  'iPhone 15 Plus': '430×932',
  'iPhone 15 Pro': '393×852',
  'iPhone 15 Pro Max': '430×932',
  'iPhone 16': '393×852',
  'iPhone 16 Plus': '430×932',
  'iPhone 16 Pro': '402×874',
  'iPhone 16 Pro Max': '440×956',
  'iPhone 17': '402×874',
  'iPhone 17 Pro': '402×874',
  'iPhone 17 Pro Max': '440×956',
};

/** Collapse a marketing device name to its family bucket, e.g.
 *  "iPhone 13 Pro Max" → "iPhone 13". Falls back to the full name for an
 *  unrecognised shape so it still groups + filters sanely. */
export function familyOf(device: string): string {
  const m = /iphone\s*(\d+)/i.exec(device);
  return m ? `iPhone ${m[1]}` : device;
}

/** Human label for an engine value (used in rows + the hero "· WebKit"). */
function engineLabel(engine: PickerDevice['engine']): string {
  return engine === 'webkit' ? 'WebKit' : 'Chrome';
}

interface ChipProps {
  label: string;
  on: boolean;
  disabled?: boolean;
  onClick?: () => void;
}
function Chip({ label, on, disabled, onClick }: ChipProps): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-2xs transition-colors ${
        on
          ? 'border-accent bg-accent-subtle text-accent'
          : 'border-surface-divider bg-surface-inset text-ink-secondary hover:text-ink-primary'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
    >
      {label}
    </button>
  );
}

export interface DevicePickerProps {
  /** The full device catalog (selectable + reference), newest-first not
   *  required — the picker groups + orders families itself. */
  devices: readonly PickerDevice[];
  /** Currently-selected archetype id (owned by the caller). */
  selectedId: string;
  /** Called with a slug when a SELECTABLE row is chosen. Reference rows never
   *  fire this. */
  onSelect: (id: string) => void;
  /** Randomize handler — owned by the caller so it shares the caller's
   *  selection state. The picker passes the *current filtered + selectable*
   *  candidate set so the caller can pick only from what's visible. */
  onRandomize: (candidates: readonly PickerDevice[]) => void;
  /** Disable all interaction (e.g. while the parent form is submitting). */
  disabled?: boolean;
}

/**
 * Family ordering: newest-first (17 → 13, then anything unrecognised). Derived
 * from whatever families exist so a new family (18, 19, …) slots in
 * automatically by descending number.
 */
function orderedFamilies(devices: readonly PickerDevice[]): string[] {
  const fams = new Set(devices.map((d) => familyOf(d.device)));
  return [...fams].sort((a, b) => {
    const na = Number(/(\d+)/.exec(a)?.[1] ?? '0');
    const nb = Number(/(\d+)/.exec(b)?.[1] ?? '0');
    if (na !== nb) return nb - na; // newest first
    return a.localeCompare(b);
  });
}

export function DevicePicker({
  devices,
  selectedId,
  onSelect,
  onRandomize,
  disabled = false,
}: DevicePickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [engineFilter, setEngineFilter] = useState<'all' | PickerDevice['engine']>('all');
  // `null` = "All" — a plain string union with 'all' is a redundant constituent.
  const [familyFilter, setFamilyFilter] = useState<string | null>(null);
  const [iosFilter, setIosFilter] = useState<string | null>(null);
  const searchId = useId();

  const selected = useMemo(() => devices.find((d) => d.id === selectedId), [devices, selectedId]);

  // Filter axes derived from the catalog (data-driven, no hardcoded lists).
  const familyOptions = useMemo(() => orderedFamilies(devices), [devices]);
  const engineOptions = useMemo(
    () => [...new Set(devices.map((device) => device.engine))],
    [devices],
  );
  // Sort iOS versions NUMERICALLY by major then minor (mirrors the numeric
  // approach orderedFamilies uses) — a lexicographic sort would place "18.10"
  // before "18.7".
  const iosOptions = useMemo(
    () =>
      [...new Set(devices.map((d) => d.iosVersion))].sort((a, b) => {
        const [amaj, amin] = a.split('.').map((n) => Number(n) || 0);
        const [bmaj, bmin] = b.split('.').map((n) => Number(n) || 0);
        return (amaj ?? 0) - (bmaj ?? 0) || (amin ?? 0) - (bmin ?? 0);
      }),
    [devices],
  );

  // The visible candidate set: search + every active chip.
  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return devices.filter((d) => {
      if (engineFilter !== 'all' && d.engine !== engineFilter) return false;
      if (familyFilter !== null && familyOf(d.device) !== familyFilter) return false;
      if (iosFilter !== null && d.iosVersion !== iosFilter) return false;
      if (terms.length > 0) {
        const hay =
          `${d.device} ios ${d.iosVersion} safari ${d.safariVersion} ${engineLabel(d.engine)}`.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
  }, [devices, query, engineFilter, familyFilter, iosFilter]);

  // Group the filtered set by family, newest-first.
  const grouped = useMemo(() => {
    const groups = new Map<string, PickerDevice[]>();
    for (const d of filtered) {
      const fam = familyOf(d.device);
      const arr = groups.get(fam) ?? [];
      arr.push(d);
      groups.set(fam, arr);
    }
    for (const arr of groups.values()) {
      arr.sort(
        (a, b) =>
          a.device.localeCompare(b.device) || a.safariVersion.localeCompare(b.safariVersion),
      );
    }
    return orderedFamilies(filtered)
      .filter((f) => groups.has(f))
      .map((f) => ({ family: f, items: groups.get(f) ?? [] }));
  }, [filtered]);

  const heroDims = selected ? (DEVICE_DIMS[selected.device] ?? '—') : '—';
  const count = filtered.length;

  // Flat, DOM-order list of the SELECTABLE rows (reference rows aren't tabbable
  // and never take roving focus). Drives ArrowUp/ArrowDown navigation across the
  // grouped list — the footer advertises "↑↓ to move", so the keys must work.
  const selectableOrder = useMemo(
    () => grouped.flatMap((g) => g.items.filter((d) => d.selectable).map((d) => d.id)),
    [grouped],
  );

  // Move roving focus to the selectable row `delta` steps from the focused one.
  // Focus (not selection) follows the arrows; Enter/Space commits the selection.
  // Looks the focused row up by its data-testid so we don't need a ref per row.
  function focusRowByDelta(currentId: string, delta: 1 | -1): void {
    if (selectableOrder.length === 0) return;
    const idx = selectableOrder.indexOf(currentId);
    // From an unfocused/unknown row, ArrowDown lands on the first, ArrowUp the last.
    const nextIdx =
      idx === -1
        ? delta === 1
          ? 0
          : selectableOrder.length - 1
        : (idx + delta + selectableOrder.length) % selectableOrder.length;
    const nextId = selectableOrder[nextIdx];
    if (nextId === undefined) return;
    const el = document.querySelector<HTMLDivElement>(
      `[data-testid="device-row-${CSS.escape(nextId)}"]`,
    );
    el?.focus();
  }

  function rowKeyDown(e: KeyboardEvent<HTMLDivElement>, d: PickerDevice): void {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusRowByDelta(d.id, 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusRowByDelta(d.id, -1);
      return;
    }
    if (!d.selectable) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(d.id);
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-md border border-surface-divider bg-surface-base/40">
      {/* Selected-device hero */}
      <div className="flex items-center gap-3 border-b border-surface-divider bg-surface-base/60 p-3">
        <div
          aria-hidden="true"
          className="flex h-16 w-9 shrink-0 items-center justify-center rounded-md border-2 border-surface-divider bg-surface-inset text-lg text-accent"
        >
          📱
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink-primary" data-testid="hero-device">
            {selected?.device ?? 'No device selected'}
          </p>
          <p className="truncate text-2xs text-ink-secondary">
            {selected
              ? `iOS ${selected.iosVersion} · Safari ${selected.safariVersion} · ${engineLabel(selected.engine)}`
              : 'Pick a device below'}
          </p>
          {selected ? (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
              <span className="text-2xs text-ink-muted">
                Viewport <b className="mono text-ink-primary">{heroDims}</b>
              </span>
              <span className="text-2xs text-ink-muted">
                DPR <b className="mono text-ink-primary">3x</b>
              </span>
              <span className="text-2xs text-ink-muted">
                Engine <b className="text-ink-primary">{engineLabel(selected.engine)}</b>
              </span>
              <span className="text-2xs text-ink-muted">
                Slug <b className="mono text-ink-primary">{selected.id}</b>
              </span>
            </div>
          ) : null}
          {selected?.selectable === true ? (
            <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-status-ready/15 px-2 py-0.5 text-2xs text-status-ready">
              ✓ bit-exact fingerprint
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onRandomize(filtered.filter((d) => d.selectable))}
          disabled={disabled || filtered.filter((d) => d.selectable).length < 2}
          className="btn-secondary shrink-0 self-start text-2xs disabled:cursor-not-allowed"
          title={
            filtered.filter((d) => d.selectable).length < 2
              ? 'Not enough devices to randomize'
              : 'Pick a random device from the current results'
          }
        >
          🎲 Randomize
        </button>
      </div>

      {/* Search + filters */}
      <div className="flex flex-col gap-2.5 border-b border-surface-divider p-3">
        <div className="flex items-center gap-2 rounded border border-surface-divider bg-surface-base px-2 py-1.5">
          <span aria-hidden="true" className="text-ink-muted">
            🔍
          </span>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={disabled}
            aria-label="Search devices"
            placeholder="Search devices — iPhone 17, Safari 26, iOS 18.7 …"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink-primary outline-none placeholder:text-ink-muted"
          />
          <span className="whitespace-nowrap text-2xs text-ink-muted" data-testid="device-count">
            {count} device{count === 1 ? '' : 's'}
          </span>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="radiogroup"
            aria-label="Engine"
          >
            <span className="section-label mr-0.5">Engine</span>
            <Chip label="All" on={engineFilter === 'all'} onClick={() => setEngineFilter('all')} />
            {engineOptions.map((engine) => (
              <Chip
                key={engine}
                label={engine === 'webkit' ? 'Safari · WebKit' : engineLabel(engine)}
                on={engineFilter === engine}
                disabled={disabled}
                onClick={() => setEngineFilter(engine)}
              />
            ))}
          </div>

          <div
            className="flex flex-wrap items-center gap-1.5"
            role="radiogroup"
            aria-label="Family"
          >
            <span className="section-label mr-0.5">Family</span>
            <Chip label="All" on={familyFilter === null} onClick={() => setFamilyFilter(null)} />
            {familyOptions.map((fam) => (
              <Chip
                key={fam}
                label={fam.replace('iPhone ', '')}
                on={familyFilter === fam}
                disabled={disabled}
                onClick={() => setFamilyFilter(fam)}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="iOS">
            <span className="section-label mr-0.5">iOS</span>
            <Chip label="All" on={iosFilter === null} onClick={() => setIosFilter(null)} />
            {iosOptions.map((v) => (
              <Chip
                key={v}
                label={v}
                on={iosFilter === v}
                disabled={disabled}
                onClick={() => setIosFilter(v)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Grouped device list */}
      <div className="max-h-72 overflow-y-auto" role="listbox" aria-label="Devices">
        {grouped.length === 0 ? (
          <div className="px-4 py-9 text-center text-xs text-ink-muted">
            No devices match. Try clearing a filter or the search.
          </div>
        ) : (
          grouped.map(({ family, items }) => (
            <div key={family}>
              <div className="section-label sticky top-0 z-[1] border-b border-surface-divider bg-surface-raised px-4 py-1.5">
                {family} family · {items.length}
              </div>
              {items.map((d) => {
                const on = d.id === selectedId;
                return (
                  <div
                    key={d.id}
                    role="option"
                    aria-selected={on}
                    aria-disabled={!d.selectable}
                    tabIndex={d.selectable && !disabled ? 0 : -1}
                    data-testid={`device-row-${d.id}`}
                    onClick={() => {
                      if (d.selectable && !disabled) onSelect(d.id);
                    }}
                    onKeyDown={(e) => rowKeyDown(e, d)}
                    className={`grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 border-b border-surface-divider/40 px-4 py-2 ${
                      d.selectable && !disabled ? 'cursor-pointer' : 'cursor-default'
                    } ${
                      on
                        ? 'bg-accent-subtle'
                        : d.selectable
                          ? 'hover:bg-surface-inset/60'
                          : 'opacity-60'
                    }`}
                  >
                    <span className="min-w-0 truncate text-xs text-ink-primary">
                      <span aria-hidden="true" className="mr-1.5 opacity-80">
                        📱
                      </span>
                      {d.device}{' '}
                      <span className="text-ink-muted">
                        · iOS {d.iosVersion} · Safari {d.safariVersion}
                      </span>
                    </span>
                    <span className="rounded-full border border-surface-divider px-2 py-0.5 text-2xs text-ink-muted">
                      {engineLabel(d.engine)}
                    </span>
                    <span
                      className={`text-2xs ${d.selectable ? 'text-status-ready' : 'text-ink-muted'}`}
                    >
                      {d.selectable ? '✓ bit-exact' : 'reference'}
                    </span>
                    <span
                      aria-hidden="true"
                      className={`relative h-3.5 w-3.5 rounded-full border-2 ${
                        on ? 'border-accent' : 'border-surface-divider'
                      }`}
                    >
                      {on ? <span className="absolute inset-[3px] rounded-full bg-accent" /> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {/* Footer — a passive "Selected:" status line, NOT a commit action. The
          actual create is the modal's own submit button; a button here that
          only re-asserts the already-current selection was a no-op that read
          like the commit action, so it's demoted to a plain status readout. */}
      <div className="flex items-center justify-between gap-3 border-t border-surface-divider px-3 py-2">
        <span className="text-2xs text-ink-muted">
          Type to search · ↑↓ to move · all are bit-exact verified
        </span>
        {selected?.selectable === true ? (
          <span className="text-2xs text-ink-secondary" data-testid="device-selected">
            Selected: <b className="text-ink-primary">{selected.device}</b>
          </span>
        ) : null}
      </div>
    </div>
  );
}
