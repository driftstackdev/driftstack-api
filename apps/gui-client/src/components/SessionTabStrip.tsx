// W609 — multi-session tab strip ("tabs" for the GUI browser, v1).
//
// Per docs/internal/gui-browser-ux-plan.md item 3: true multi-page-per-
// session tabs are a Phase-4 cross-agent arc, so v1 tabs = the account's
// CONCURRENT SESSIONS. Each tab is its own iPhone — honest about what a
// session is, and it matches how the product scales (concurrency =
// parallel sessions). Clicking a tab switches the live view to that
// session; "+" hands off to the profiles view to launch another phone.
//
// Data source: client.sessions.list() polled every 10s (light — the
// frame poll is 2/s; this is 0.1/s) + an immediate fetch on mount, so a
// session launched from the dashboard/API shows up as a tab without an
// app restart. Non-destroyed statuses all render (an errored session is
// still a tab you can switch to and see the error state for).

import { useCallback, useEffect, useState } from 'react';
import { useSettings } from '../lib/SettingsContext';

const LIST_POLL_INTERVAL_MS = 10_000;

interface TabSession {
  id: string;
  status: string;
  archetype: string;
}

export interface SessionTabStripProps {
  activeSessionId: string;
  onSwitch: (sessionId: string) => void;
  onNewTab: () => void;
}

// Short, stable per-tab label: the device segment of the archetype slug
// (e.g. "iphone16pro" from "iphone17_ios18_7_safari26_4") + the id
// tail so two same-archetype phones stay tellable-apart. Raw-slug style
// matches how SessionsView renders archetypes (mono slug); the GUI
// doesn't carry the api-types display-label registry.
export function tabLabel(s: TabSession): string {
  const device = s.archetype.split('_')[0] ?? s.archetype;
  return `${device} · ${s.id.slice(-4)}`;
}

export function SessionTabStrip({
  activeSessionId,
  onSwitch,
  onNewTab,
}: SessionTabStripProps): JSX.Element | null {
  const { client } = useSettings();
  const [sessions, setSessions] = useState<TabSession[] | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!client) return;
    try {
      const page = await client.sessions.list();
      setSessions(
        page.data
          .filter((s) => s.status !== 'destroyed')
          .map((s) => ({ id: s.id, status: s.status, archetype: s.archetype })),
      );
    } catch {
      // Tolerate failure — the strip is navigation sugar; the live view
      // itself surfaces connectivity errors. Keep the last-known tabs.
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    // Skip the poll while the window is hidden (audit 2026-07-08) — resumes on next visible tick.
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refresh();
    }, LIST_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // The active session always renders as a tab, even before the first
  // list response (or if the list omits it momentarily) — the strip
  // must never look like "no tabs" while you're clearly inside one.
  const known = sessions ?? [];
  const tabs = known.some((s) => s.id === activeSessionId)
    ? known
    : [{ id: activeSessionId, status: 'ready', archetype: '' }, ...known];

  return (
    <nav aria-label="Open sessions" className="flex items-center gap-1 overflow-x-auto">
      {tabs.map((s) => {
        const active = s.id === activeSessionId;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              if (!active) onSwitch(s.id);
            }}
            aria-current={active ? 'page' : undefined}
            title={s.id}
            className={`flex shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1 text-2xs ${
              active
                ? 'border-surface-divider bg-surface-raised text-ink-primary'
                : 'border-transparent bg-surface-base text-ink-muted hover:text-ink-primary'
            }`}
          >
            {s.status === 'errored' && (
              <span aria-hidden="true" className="text-status-error">
                ●
              </span>
            )}
            {s.archetype === '' ? `Session · ${s.id.slice(-4)}` : tabLabel(s)}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onNewTab}
        title="Launch another phone (opens Profiles)"
        aria-label="New tab — launch another phone"
        className="shrink-0 rounded-t-md px-2.5 py-1 text-sm text-ink-muted hover:text-ink-primary"
      >
        +
      </button>
    </nav>
  );
}
