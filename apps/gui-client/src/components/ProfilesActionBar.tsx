// ProfilesView header action bar — search + filter + sort.
//
// 2026-05-21 — Slice B of the BlackBird-inspired GUI overhaul. Adds a
// search input that matches name + description + archetype, a status-
// filter segmented control (All / Running / Idle), and a sort
// dropdown (last-used / name / created). Pure presentational —
// ProfilesView owns the state + the derive-list useMemo; this
// component is the chrome only, kept here so the ProfilesView body
// stays focused on row rendering + launch/stop wiring.

import type { ChangeEvent } from 'react';

export type ProfileStatusFilter = 'all' | 'running' | 'idle';
export type ProfileSortBy = 'name' | 'last-used' | 'created';

export interface ProfilesActionBarProps {
  searchQuery: string;
  onSearchChange: (next: string) => void;
  statusFilter: ProfileStatusFilter;
  onStatusFilterChange: (next: ProfileStatusFilter) => void;
  sortBy: ProfileSortBy;
  onSortByChange: (next: ProfileSortBy) => void;
  visibleCount: number;
  totalCount: number;
}

export function ProfilesActionBar({
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  sortBy,
  onSortByChange,
  visibleCount,
  totalCount,
}: ProfilesActionBarProps): JSX.Element {
  const hasFilter = searchQuery.trim().length > 0 || statusFilter !== 'all';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex min-w-[14rem] flex-1 items-center">
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          aria-hidden="true"
          className="absolute left-2.5 text-ink-muted"
        >
          <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={searchQuery}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onSearchChange(e.target.value)}
          placeholder="Search profiles…"
          aria-label="Search profiles"
          className="form-input pl-8 pr-7"
        />
        {searchQuery.length > 0 && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onSearchChange('')}
            className="absolute right-2 flex h-4 w-4 items-center justify-center
                       rounded-full text-ink-muted hover:text-ink-primary"
          >
            <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
              <path
                d="M3 3l10 10M13 3 3 13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>

      <StatusFilterSegmented value={statusFilter} onChange={onStatusFilterChange} />

      <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
        <span className="section-label">Sort</span>
        <select
          aria-label="Sort profiles"
          value={sortBy}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            onSortByChange(e.target.value as ProfileSortBy)
          }
          className="rounded border border-surface-divider bg-surface-inset px-2 py-1
                     text-xs text-ink-primary
                     focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent-ring"
        >
          <option value="last-used">Last used</option>
          <option value="name">Name</option>
          <option value="created">Created</option>
        </select>
      </label>

      <span className="ml-auto text-2xs text-ink-muted">
        {hasFilter ? (
          <>
            {visibleCount} of {totalCount}
          </>
        ) : (
          <>
            {totalCount} {totalCount === 1 ? 'profile' : 'profiles'}
          </>
        )}
      </span>
    </div>
  );
}

function StatusFilterSegmented({
  value,
  onChange,
}: {
  value: ProfileStatusFilter;
  onChange: (next: ProfileStatusFilter) => void;
}): JSX.Element {
  const opts: ReadonlyArray<{ id: ProfileStatusFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'running', label: 'Running' },
    { id: 'idle', label: 'Idle' },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Filter by status"
      className="inline-flex overflow-hidden rounded border border-surface-divider bg-surface-inset"
    >
      {opts.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            className={
              'px-2.5 py-1 text-xs transition-colors ' +
              (active
                ? 'bg-accent-subtle text-ink-primary'
                : 'text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary')
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
