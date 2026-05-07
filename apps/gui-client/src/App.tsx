// App shell — outer chrome + view routing.
//
// GUI1 landed the static shell; GUI2 wires the SettingsProvider and
// adds two real views (Sessions, Settings). The routing model is
// state-based, not URL-based — no need for react-router in a
// single-window desktop app, and Tauri's window doesn't have a real
// history stack to integrate with.

import { useEffect, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { RecordingsProvider } from './lib/recordings';
import { SettingsProvider, useSettings } from './lib/SettingsContext';
import { ConnectivityView } from './views/ConnectivityView';
import { FirstRunWizard } from './views/FirstRunWizard';
import { LiveSessionView } from './views/LiveSessionView';
import { ProfilesView } from './views/ProfilesView';
import { ProxiesView } from './views/ProxiesView';
import { RecordingPlayerView } from './views/RecordingPlayerView';
import { RecordingsView } from './views/RecordingsView';
import { SessionsView } from './views/SessionsView';
import { SettingsView } from './views/SettingsView';

type View =
  | { kind: 'sessions' }
  | { kind: 'live-session'; sessionId: string }
  | { kind: 'sessions-history' }
  | { kind: 'profiles' }
  | { kind: 'recordings' }
  | { kind: 'recording-player'; recordingId: string }
  | { kind: 'proxies' }
  | { kind: 'connectivity' }
  | { kind: 'fleet' }
  | { kind: 'settings' };

export function App(): JSX.Element {
  return (
    <SettingsProvider>
      <RecordingsProvider>
        <Shell />
      </RecordingsProvider>
    </SettingsProvider>
  );
}

function Shell(): JSX.Element {
  const { settings, loading } = useSettings();
  const [view, setView] = useState<View>({ kind: 'sessions' });
  // V-244 — track wizard state. Customer with no apiKey on boot
  // sees the wizard; once apiKey is set (via wizard or any other
  // path) the regular shell takes over. `wizardDismissed` lets the
  // customer skip the wizard mid-flow without leaving them stuck on
  // it forever; once true, they get the normal shell + can still
  // configure via Settings.
  const [wizardDismissed, setWizardDismissed] = useState(false);

  // V-263 — Cmd+, shortcut. MUST live above any conditional returns
  // below; React hooks order is positional, so registering the effect
  // after an early-return pulls the hooks count out of sync between
  // the wizard render (early return) and the post-wizard render (full
  // shell), which unmounts the entire tree and shows a black screen.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.metaKey && e.key === ',') {
        e.preventDefault();
        setView({ kind: 'settings' });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // While settings load, render nothing rather than flashing the wizard.
  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-surface-base">
        <span className="section-label text-ink-muted">Loading…</span>
      </div>
    );
  }

  // V-244 — first-run gate. No apiKey + not dismissed → wizard.
  if (settings.apiKey === null && !wizardDismissed) {
    return <FirstRunWizard onComplete={() => setWizardDismissed(true)} />;
  }

  const mode = deploymentLabel(settings.baseUrl);
  return (
    <div className="flex h-screen w-screen flex-col bg-surface-base">
      <TitleBar subtitle={mode} right={<span className="section-label">v0.0.1</span>} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar current={view} onNavigate={setView} />
        <main className="flex-1 overflow-auto bg-surface-base">
          <CurrentView view={view} onNavigate={setView} />
        </main>
      </div>
      <StatusFooter />
    </div>
  );
}

function CurrentView({
  view,
  onNavigate,
}: {
  view: View;
  onNavigate: (v: View) => void;
}): JSX.Element {
  switch (view.kind) {
    case 'sessions':
      return (
        <SessionsView
          onView={(sessionId) => onNavigate({ kind: 'live-session', sessionId })}
          onGoToSettings={() => onNavigate({ kind: 'settings' })}
        />
      );
    case 'live-session':
      return (
        <LiveSessionView
          sessionId={view.sessionId}
          onBack={() => onNavigate({ kind: 'sessions' })}
        />
      );
    case 'settings':
      return <SettingsView />;
    case 'proxies':
      return <ProxiesView />;
    case 'recordings':
      return (
        <RecordingsView
          onOpen={(recordingId) => onNavigate({ kind: 'recording-player', recordingId })}
        />
      );
    case 'recording-player':
      return (
        <RecordingPlayerView
          recordingId={view.recordingId}
          onBack={() => onNavigate({ kind: 'recordings' })}
        />
      );
    case 'connectivity':
      return <ConnectivityView />;
    case 'profiles':
      return <ProfilesView onGoToSettings={() => onNavigate({ kind: 'settings' })} />;
    case 'sessions-history':
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

// V-240 — derive deployment-mode label from the configured API base
// URL. Cloud customers see "cloud"; self-hosted customers see
// "self-hosted". The label is informational (titlebar mode indicator),
// not a feature gate. Hostname-match logic: anything ending in
// `driftstack.dev` is cloud; everything else (localhost, customer's
// own domain, IP, etc.) is self-hosted.
function deploymentLabel(baseUrl: string): 'cloud' | 'self-hosted' {
  try {
    const host = new URL(baseUrl).hostname;
    if (host === 'driftstack.dev' || host.endsWith('.driftstack.dev')) {
      return 'cloud';
    }
    return 'self-hosted';
  } catch {
    // Malformed URL — default to self-hosted (the safer assumption
    // since cloud customers wouldn't typo their base URL).
    return 'self-hosted';
  }
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
          active={current.kind === 'profiles'}
          onClick={() => onNavigate({ kind: 'profiles' })}
        >
          Profiles
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
        {settings.apiKey !== null && (
          <span className="mono">
            {settings.apiKey.slice(0, 8)}…{settings.apiKey.slice(-4)}
          </span>
        )}
      </div>
      <div className="mono">{redactBaseUrl(settings.baseUrl)}</div>
    </footer>
  );
}

function redactBaseUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}
