// App shell — outer chrome + view routing.
//
// GUI1 landed the static shell; GUI2 wires the SettingsProvider and
// adds two real views (Sessions, Settings). The routing model is
// state-based, not URL-based — no need for react-router in a
// single-window desktop app, and Tauri's window doesn't have a real
// history stack to integrate with.

import { useState } from 'react';
import { SettingsProvider, useSettings } from './lib/SettingsContext';
import { SessionsView } from './views/SessionsView';
import { SettingsView } from './views/SettingsView';

type View =
  | { kind: 'sessions' }
  | { kind: 'sessions-history' }
  | { kind: 'recordings' }
  | { kind: 'proxies' }
  | { kind: 'connectivity' }
  | { kind: 'fleet' }
  | { kind: 'settings' };

export function App(): JSX.Element {
  return (
    <SettingsProvider>
      <Shell />
    </SettingsProvider>
  );
}

function Shell(): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'sessions' });
  return (
    <div className="flex h-screen w-screen flex-col bg-surface-base">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar current={view} onNavigate={setView} />
        <main className="flex-1 overflow-auto bg-surface-base">
          <CurrentView view={view} />
        </main>
      </div>
      <StatusFooter />
    </div>
  );
}

function CurrentView({ view }: { view: View }): JSX.Element {
  switch (view.kind) {
    case 'sessions':
      return <SessionsView />;
    case 'settings':
      return <SettingsView />;
    case 'sessions-history':
    case 'recordings':
    case 'proxies':
    case 'connectivity':
    case 'fleet':
      return <NotYet label={view.kind} />;
  }
}

function NotYet({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <span className="section-label">{label}</span>
      <p className="max-w-md text-sm text-ink-secondary">Lands in a later GUI phase.</p>
    </div>
  );
}

// ─── chrome ───────────────────────────────────────────────────────

function TitleBar(): JSX.Element {
  return (
    <div
      data-tauri-drag-region="true"
      className="flex h-9 select-none items-center justify-between
                 border-b border-surface-divider bg-surface-raised px-3"
    >
      <div className="flex items-center gap-2">
        <div className="h-3.5 w-3.5 rounded-sm bg-accent" />
        <span className="text-sm font-medium text-ink-primary">Driftstack</span>
        <span className="mono text-ink-muted">·</span>
        <span className="mono text-ink-secondary">self-hosted</span>
      </div>
      <div className="flex items-center gap-2 text-ink-muted">
        <span className="section-label">v0.0.1</span>
      </div>
    </div>
  );
}

interface SidebarProps {
  current: View;
  onNavigate: (v: View) => void;
}

function Sidebar({ current, onNavigate }: SidebarProps): JSX.Element {
  return (
    <aside className="flex w-56 flex-col border-r border-surface-divider bg-surface-raised">
      <SidebarSection label="Sessions">
        <SidebarItem
          active={current.kind === 'sessions'}
          onClick={() => onNavigate({ kind: 'sessions' })}
        >
          Active
        </SidebarItem>
        <SidebarItem
          active={current.kind === 'sessions-history'}
          onClick={() => onNavigate({ kind: 'sessions-history' })}
        >
          History
        </SidebarItem>
        <SidebarItem
          active={current.kind === 'recordings'}
          onClick={() => onNavigate({ kind: 'recordings' })}
        >
          Recordings
        </SidebarItem>
      </SidebarSection>
      <SidebarSection label="Network">
        <SidebarItem
          active={current.kind === 'proxies'}
          onClick={() => onNavigate({ kind: 'proxies' })}
        >
          Proxies
        </SidebarItem>
        <SidebarItem
          active={current.kind === 'connectivity'}
          onClick={() => onNavigate({ kind: 'connectivity' })}
        >
          Connectivity test
        </SidebarItem>
      </SidebarSection>
      <SidebarSection label="Cluster">
        <SidebarItem
          active={current.kind === 'fleet'}
          onClick={() => onNavigate({ kind: 'fleet' })}
        >
          Mac mini fleet
        </SidebarItem>
        <SidebarItem
          active={current.kind === 'settings'}
          onClick={() => onNavigate({ kind: 'settings' })}
        >
          Settings
        </SidebarItem>
      </SidebarSection>
    </aside>
  );
}

function SidebarSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-px py-2">
      <div className="px-3 py-1">
        <span className="section-label">{label}</span>
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function SidebarItem({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-tauri-no-drag
      onClick={onClick}
      className={
        'flex items-center gap-2 px-3 py-1 text-sm transition-colors text-left ' +
        (active === true
          ? 'bg-accent-subtle text-ink-primary'
          : 'text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary')
      }
    >
      {children}
    </button>
  );
}

function StatusFooter(): JSX.Element {
  const { settings, client } = useSettings();
  const connected = client !== null;
  return (
    <footer
      className="flex h-6 items-center justify-between border-t
                 border-surface-divider bg-surface-raised px-3
                 text-2xs text-ink-muted"
    >
      <div className="flex items-center gap-2">
        <span className={`status-pip ${connected ? 'bg-status-ready' : 'bg-status-idle'}`} />
        <span>{connected ? 'connected' : 'not connected'}</span>
      </div>
      <div className="mono">{redactBaseUrl(settings.baseUrl)}</div>
    </footer>
  );
}

function redactBaseUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}
