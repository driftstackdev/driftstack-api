// Logs viewer — the full-screen complement to the floating DevLogPanel
// (lib/log-buffer). Shows the in-app console + error ring buffer with a
// level filter, free-text search, and Clear / Copy actions, so a self-
// hosted operator can triage what the app is doing without remote devtools
// (off in release builds).
//
// Pure client-side: reads the in-memory buffer and subscribes for live
// updates. No SDK / network — the data source is lib/log-buffer, not the
// control plane, so this view works regardless of API connection state.

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import {
  clearLogEntries,
  formatLogEntries,
  getLogEntries,
  subscribeLogs,
  type LogEntry,
  type LogLevel,
} from '../lib/log-buffer';

// UI-level filter. The buffer carries five console levels; group the
// quiet ones under "Info" so no captured entry is ever invisible (an
// operator triaging a problem must be able to see everything).
type LevelFilter = 'all' | 'info' | 'warn' | 'error';

const FILTERS: ReadonlyArray<{ id: LevelFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'info', label: 'Info' },
  { id: 'warn', label: 'Warnings' },
  { id: 'error', label: 'Errors' },
];

const INFO_LEVELS: ReadonlySet<LogLevel> = new Set<LogLevel>(['log', 'info', 'debug']);

function matchesFilter(level: LogLevel, filter: LevelFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'info':
      return INFO_LEVELS.has(level);
    case 'warn':
      return level === 'warn';
    case 'error':
      return level === 'error';
  }
}

// Level → pill styling, using the shared status tokens (accent reserved
// for primary actions / active state, per the Console aesthetic).
const LEVEL_PILL: Record<LogLevel, string> = {
  error: 'bg-status-error/15 text-status-error',
  warn: 'bg-status-busy/15 text-status-busy',
  info: 'bg-surface-inset text-ink-secondary',
  log: 'bg-surface-inset text-ink-muted',
  debug: 'bg-surface-inset text-ink-muted',
};

export function LogsView(): JSX.Element {
  // The buffer mutates IN PLACE (getLogEntries returns the live array, not a
  // copy), so its reference is stable across renders. We subscribe + force a
  // re-render on change; `version` bumps on every buffer mutation and is fed
  // into the derived memos below so they actually recompute — without it, the
  // referentially-stable `entries` dep would keep `filtered`/`errorCount`
  // pinned to their first value and new log lines would never appear (the
  // header's non-memoised `entries.length` would tick up while the list went
  // stale). Mirrors DevLogPanel, which sidesteps this by filtering inline.
  const [version, forceRender] = useReducer((n: number) => n + 1, 0);
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeLogs(forceRender), []);

  const entries = getLogEntries();

  const filtered = useMemo<readonly LogEntry[]>(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(
      (e) => matchesFilter(e.level, filter) && (q.length === 0 || e.text.toLowerCase().includes(q)),
    );
    // `version` busts the memo on in-place buffer growth (see note above).
  }, [entries, filter, query, version]);

  // Auto-scroll to the newest matching entry as the buffer grows.
  useEffect(() => {
    if (scrollRef.current !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered.length]);

  const errorCount = useMemo(
    () => entries.reduce((n, e) => (e.level === 'error' ? n + 1 : n), 0),
    // `version` busts the memo on in-place buffer growth (see note above).
    [entries, version],
  );

  function handleCopy(): void {
    void navigator.clipboard.writeText(formatLogEntries());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="section-label">Diagnostics</span>
          <h2 className="text-lg font-medium tracking-tight text-ink-primary">
            Logs
            <span className="ml-2 mono text-ink-muted">{entries.length}</span>
            {errorCount > 0 && (
              <span className="ml-2 text-sm font-normal text-status-error">
                {errorCount} {errorCount === 1 ? 'error' : 'errors'}
              </span>
            )}
          </h2>
          <p className="text-2xs text-ink-muted">
            Captured console output + uncaught errors for this app session — newest at the bottom.
            Held in memory (most recent 500); cleared on restart.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={handleCopy}
            disabled={entries.length === 0}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => clearLogEntries()}
            disabled={entries.length === 0}
          >
            Clear
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1" role="group" aria-label="Filter by level">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              className={
                filter === f.id
                  ? 'rounded bg-accent-subtle px-2.5 py-1 text-xs font-medium text-ink-primary'
                  : 'rounded px-2.5 py-1 text-xs text-ink-muted hover:text-ink-primary'
              }
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="form-input ml-auto w-64 text-sm"
          placeholder="Search messages…"
          aria-label="Search log messages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 6h16" />
              <path d="M4 12h16" />
              <path d="M4 18h10" />
            </svg>
          }
          title="No log entries yet"
          description="Console output and uncaught errors from this app session show up here as the app runs."
        />
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-surface-divider px-6 py-12 text-center">
          <p className="text-sm text-ink-muted">
            No entries match the current filter.{' '}
            <button
              type="button"
              className="text-accent underline-offset-2 hover:underline"
              onClick={() => {
                setFilter('all');
                setQuery('');
              }}
            >
              Reset
            </button>
          </p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto rounded-lg border border-surface-divider bg-surface-raised"
        >
          <ul className="divide-y divide-surface-divider mono text-xs">
            {filtered.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-4 py-2">
                <span
                  className="shrink-0 pt-0.5 text-ink-muted"
                  title={new Date(e.ts).toISOString()}
                >
                  {new Date(e.ts).toLocaleTimeString()}
                </span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide ${LEVEL_PILL[e.level]}`}
                >
                  {e.level}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink-primary">
                  {e.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
