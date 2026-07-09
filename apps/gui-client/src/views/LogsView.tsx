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
    // Only flip to "Copied" on a RESOLVED write — a locked-down WebView can reject
    // clipboard access, and the old unconditional setCopied falsely showed success on a
    // failed copy (audit 2026-07-08). On rejection we leave the label at "Copy".
    void navigator.clipboard.writeText(formatLogEntries()).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {
        /* clipboard denied — don't claim success */
      },
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Page hero — an accent icon chip + a radial identity glow, the live
          entry count / error tally, and the Copy + Clear actions anchored on
          the right. Matches the Command Center / Settings gradient-card
          language. */}
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
            <IconTerminal />
          </span>
          <div className="min-w-0">
            <span className="section-label text-accent">Diagnostics</span>
            <h2 className="mt-0.5 flex items-baseline gap-2 text-2xl font-semibold tracking-tight text-ink-primary">
              Logs
              <span className="mono text-base font-medium text-ink-muted">{entries.length}</span>
              {errorCount > 0 && (
                <span className="text-sm font-normal text-status-error">
                  {errorCount} {errorCount === 1 ? 'error' : 'errors'}
                </span>
              )}
            </h2>
            <p className="mt-1 text-2xs text-ink-muted">
              Captured console output + uncaught errors for this app session — newest at the bottom.
              Held in memory (most recent 500); cleared on restart.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
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
        </div>
      </header>

      {/* Controls — segmented level filter + free-text search, in a raised card
          matching the hero rhythm. */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-surface-divider bg-surface-raised px-4 py-3 shadow-sm">
        <span aria-hidden="true" className="text-ink-muted">
          <IconFilter />
        </span>
        <div
          className="flex items-center gap-1 rounded-lg bg-surface-inset p-1"
          role="group"
          aria-label="Filter by level"
        >
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              className={
                filter === f.id
                  ? 'rounded-md bg-accent-subtle px-2.5 py-1 text-xs font-medium text-ink-primary shadow-sm'
                  : 'rounded-md px-2.5 py-1 text-xs text-ink-muted transition-colors hover:text-ink-primary'
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

// ─── icons (Lucide-shape, inline, no dependency) — matches CommandCenterView ──
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
// A terminal/console glyph for the diagnostics hero.
function IconTerminal(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" {...stroke}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
      <path d="M4.75 6.25 6.75 8l-2 1.75M8.25 10h3" />
    </svg>
  );
}
function IconFilter(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <path d="M2 3.5h12L9.25 9v4l-2.5-1.5V9Z" />
    </svg>
  );
}
