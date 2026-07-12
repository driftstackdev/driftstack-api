// LogsView live-update regression. lib/log-buffer.getLogEntries() returns the
// LIVE array (mutated in place), so its reference is stable across renders.
// LogsView derives `filtered`/`errorCount` via useMemo — if those memos key
// only on the stable `entries` ref, a re-render triggered by subscribeLogs
// would NOT recompute them and new log lines would never show. This test
// drives the real staleness path: push into the in-place array, fire the
// subscriber, and assert the new entry + updated error count appear.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import type { LogEntry } from '../../src/lib/log-buffer';

// A single in-place array shared across renders (reproduces the real buffer).
const store: LogEntry[] = [];
let notify: (() => void) | null = null;
let nextId = 1;

vi.mock('../../src/lib/log-buffer', () => ({
  getLogEntries: () => store, // SAME ref every call — the bug's precondition
  subscribeLogs: (fn: () => void) => {
    notify = fn;
    return () => {
      notify = null;
    };
  },
  clearLogEntries: () => {
    store.length = 0;
    notify?.();
  },
  formatLogEntries: () => store.map((e) => e.text).join('\n'),
}));

const { LogsView } = await import('../../src/views/LogsView');

function pushLog(level: LogEntry['level'], text: string): void {
  act(() => {
    store.push({ id: nextId++, ts: 1_700_000_000_000 + nextId, level, text });
    notify?.();
  });
}

describe('LogsView live updates (in-place buffer)', () => {
  beforeEach(() => {
    cleanup();
    store.length = 0;
    notify = null;
    nextId = 1;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders log lines pushed AFTER mount (memo busts on subscriber notify)', () => {
    render(<LogsView />);
    // Empty state first.
    expect(screen.getByText('No log entries yet')).toBeTruthy();

    pushLog('log', 'first line after mount');
    expect(screen.getByText('first line after mount')).toBeTruthy();

    pushLog('warn', 'a later warning');
    expect(screen.getByText('a later warning')).toBeTruthy();
    // The first line is still present (not replaced).
    expect(screen.getByText('first line after mount')).toBeTruthy();
  });

  it('updates the error count as error entries arrive', () => {
    render(<LogsView />);
    pushLog('error', 'boom one');
    expect(screen.getByText('1 error')).toBeTruthy();
    pushLog('error', 'boom two');
    expect(screen.getByText('2 errors')).toBeTruthy();
  });

  it('keeps the active filter applied to newly-arrived entries', () => {
    render(<LogsView />);
    pushLog('log', 'an info line');
    pushLog('error', 'an error line');
    // Switch to the Errors filter.
    fireEvent.click(screen.getByRole('button', { name: 'Errors' }));
    expect(screen.getByText('an error line')).toBeTruthy();
    expect(screen.queryByText('an info line')).toBeNull();
    // A new error arriving while filtered must still appear.
    pushLog('error', 'a fresh error');
    expect(screen.getByText('a fresh error')).toBeTruthy();
  });

  it('surfaces clipboard denial as a retryable Copy failure', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    render(<LogsView />);
    pushLog('error', 'copy me');

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: /Copy failed — retry/i })).toBeEnabled();
  });
});
