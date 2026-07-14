// DevLogPanel (GUI W232 item d) — a toggleable in-app view of the captured
// console + error log (see lib/log-buffer). Lets a self-hosted operator see
// what the app is doing without remote devtools (off in release builds).
//
// Rendered at the app root (resilient to view-level errors). Closed by default
// as a small floating pill; opens to a scrollable panel with Copy + Clear.

import { useEffect, useReducer, useRef, useState } from 'react';
import {
  clearLogEntries,
  formatLogEntries,
  getLogEntries,
  subscribeLogs,
  type LogLevel,
} from '../lib/log-buffer';
import { writeClipboardText } from '../lib/clipboard';

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'text-red-400',
  warn: 'text-amber-400',
  info: 'text-ink-secondary',
  debug: 'text-white/40',
  log: 'text-white/70',
};

export function DevLogPanel(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const copyTimerRef = useRef<number | null>(null);
  // The buffer mutates in place, so subscribe + force a re-render on change
  // rather than relying on reference identity.
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeLogs(forceRender), []);
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const copyLogs = (): void => {
    if (copyState === 'copying') return;
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    setCopyState('copying');
    void writeClipboardText(formatLogEntries()).then(
      () => {
        setCopyState('copied');
        copyTimerRef.current = window.setTimeout(() => {
          copyTimerRef.current = null;
          setCopyState('idle');
        }, 1200);
      },
      () => setCopyState('failed'),
    );
  };

  const entries = getLogEntries();

  // Auto-scroll to newest while open.
  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [open, entries.length]);

  const errorCount = entries.reduce((n, e) => (e.level === 'error' ? n + 1 : n), 0);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-dev-logs-toggle
        title="Show dev logs"
        className="fixed bottom-3 right-3 z-[9998] rounded-full border border-white/15 bg-black/70 px-3 py-1.5 text-xs text-white/70 shadow-lg backdrop-blur hover:text-white"
      >
        Logs{entries.length > 0 ? ` (${entries.length.toString()})` : ''}
        {errorCount > 0 ? <span className="ml-1 text-red-400">●</span> : null}
      </button>
    );
  }

  return (
    <div
      data-dev-logs-panel
      className="fixed bottom-3 right-3 z-[9998] flex h-[60vh] w-[min(560px,92vw)] flex-col overflow-hidden rounded-lg border border-white/15 bg-black/90 text-xs shadow-2xl backdrop-blur"
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="font-medium text-white/80">Dev logs</span>
        <span className="text-white/40">{entries.length.toString()} entries</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={copyLogs}
            aria-busy={copyState === 'copying'}
            disabled={copyState === 'copying'}
            className="rounded border border-white/15 px-2 py-0.5 text-white/70 hover:text-white disabled:cursor-wait disabled:opacity-70"
          >
            {copyState === 'copying'
              ? 'Copying…'
              : copyState === 'copied'
                ? 'Copied'
                : copyState === 'failed'
                  ? 'Copy failed — retry'
                  : 'Copy'}
          </button>
          <button
            type="button"
            onClick={() => clearLogEntries()}
            className="rounded border border-white/15 px-2 py-0.5 text-white/70 hover:text-white"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded border border-white/15 px-2 py-0.5 text-white/70 hover:text-white"
          >
            Close
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-auto p-2 font-mono leading-relaxed">
        {entries.length === 0 ? (
          <div className="px-1 py-2 text-white/30">No log entries yet.</div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="whitespace-pre-wrap break-words px-1">
              <span className="text-white/30">{new Date(e.ts).toLocaleTimeString()}</span>{' '}
              <span className={LEVEL_COLOR[e.level]}>{e.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
