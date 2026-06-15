// App shell — outer chrome + view routing.
//
// GUI1 landed the static shell; GUI2 wires the SettingsProvider and
// adds two real views (Sessions, Settings). The routing model is
// state-based, not URL-based — no need for react-router in a
// single-window desktop app, and Tauri's window doesn't have a real
// history stack to integrate with.

import { useEffect, useState } from 'react';
import { ConnectionPill } from './components/ConnectionPill';
import { Sidebar, type SidebarViewKind } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { ThemeSwitcher } from './components/ThemeSwitcher';
import { ShortcutsCheatsheet } from './components/ShortcutsCheatsheet';
import { NotificationToastStack } from './components/NotificationToastStack';
import { RecordingsProvider } from './lib/recordings';
import { SettingsProvider, useSettings } from './lib/SettingsContext';
import { useConnectionStatus } from './lib/use-connection-status';
import { ConnectivityView } from './views/ConnectivityView';
import { FirstRunWizard } from './views/FirstRunWizard';
import { LiveSessionView } from './views/LiveSessionView';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { ToastProvider } from './lib/toasts';
import { AgentChatView } from './views/AgentChatView';
import { CommandCenterView } from './views/CommandCenterView';
import { LogsView } from './views/LogsView';
import { RecipesView } from './views/RecipesView';
import { ProfilesView } from './views/ProfilesView';
import { ProxiesView } from './views/ProxiesView';
import { RecordingPlayerView } from './views/RecordingPlayerView';
import { RecordingsView } from './views/RecordingsView';
import { FleetView } from './views/FleetView';
import { SessionsHistoryView } from './views/SessionsHistoryView';
import { SessionsView } from './views/SessionsView';
import { SettingsView } from './views/SettingsView';
import { UpdateBanner } from './components/UpdateBanner';
import { checkForUpdate, type AvailableUpdate } from './lib/updater';

type View =
  | { kind: 'home' }
  | { kind: 'ai'; profileId?: string }
  | { kind: 'recipes' }
  | { kind: 'logs' }
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
  // 2026-06-14 — Command Center ('home') is the default landing (5→10 G4):
  // it leads with Automate (Ask AI / recipes) + an account/session overview,
  // making automation the primary surface; Profiles/Sessions are one click away.
  const [view, setView] = useState<View>({ kind: 'home' });
  // ⌘K command palette (demo-concepts arc) — global hotkey, view navigation.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Keyboard-shortcuts cheatsheet (5→10 polish) — `?` or ⌘/. `?` is suppressed
  // while typing in a field so it doesn't hijack a literal question mark.
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setCheatsheetOpen((v) => !v);
        return;
      }
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        const typing =
          t !== null &&
          (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.tagName === 'SELECT' ||
            t.isContentEditable);
        if (typing) return;
        e.preventDefault();
        setCheatsheetOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const paletteActions: PaletteAction[] = [
    {
      id: 'nav-home',
      label: 'Go to Home',
      kind: 'view',
      glyph: '◳',
      keywords: ['nav', 'home', 'command center', 'overview', 'dashboard'],
      run: () => setView({ kind: 'home' }),
    },
    {
      id: 'nav-ai',
      label: 'Go to AI chat',
      kind: 'view',
      glyph: '✦',
      keywords: ['nav', 'ai', 'chat', 'agent', 'automate'],
      run: () => setView({ kind: 'ai' }),
    },
    {
      id: 'nav-recipes',
      label: 'Go to Recipes',
      kind: 'view',
      glyph: '❡',
      keywords: ['nav', 'recipes', 'automation', 'flows'],
      run: () => setView({ kind: 'recipes' }),
    },
    {
      id: 'nav-logs',
      label: 'Go to Logs',
      kind: 'view',
      glyph: '≣',
      keywords: ['nav', 'logs', 'debug', 'diagnostics'],
      run: () => setView({ kind: 'logs' }),
    },
    {
      id: 'nav-profiles',
      label: 'Go to Profiles',
      kind: 'view',
      glyph: '◎',
      keywords: ['nav'],
      run: () => setView({ kind: 'profiles' }),
    },
    {
      id: 'nav-sessions',
      label: 'Go to Sessions',
      kind: 'view',
      glyph: '⊟',
      keywords: ['nav'],
      run: () => setView({ kind: 'sessions' }),
    },
    {
      id: 'nav-recordings',
      label: 'Go to Recordings',
      kind: 'view',
      glyph: '◉',
      keywords: ['nav'],
      run: () => setView({ kind: 'recordings' }),
    },
    {
      id: 'nav-proxies',
      label: 'Go to Proxies',
      kind: 'view',
      glyph: '⇄',
      keywords: ['nav'],
      run: () => setView({ kind: 'proxies' }),
    },
    {
      id: 'nav-settings',
      label: 'Go to Settings',
      kind: 'view',
      glyph: '⚙',
      keywords: ['nav', 'appearance', 'theme'],
      run: () => setView({ kind: 'settings' }),
    },
    {
      id: 'show-shortcuts',
      label: 'Keyboard shortcuts',
      kind: 'help',
      glyph: '⌨',
      keywords: ['keyboard', 'shortcuts', 'keys', 'cheatsheet', 'help'],
      run: () => setCheatsheetOpen(true),
    },
  ];
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
  // V-263 — Cmd+, opens Settings. 2026-05-20 — Cmd+Shift+L triggers
  // Sign out (forgets the local key + re-arms the wizard). Cmd+Shift+Q
  // is the macOS "Quit all apps" combo; pick Cmd+Shift+L instead so
  // we don't fight the OS shortcut.
  const { settings: kbSettings, update: kbUpdate } = useSettings();
  // 2026-05-20 — confirm() prompts in Tauri WKWebView can be flaky and
  // were swallowing the customer's sign-out clicks. Drop the dialog —
  // sign-out is reversible (key still lives on the server, the wizard
  // re-mints it on the next browser sign-in), so the friction wasn't
  // earning anything. One-click is the reliable shape.
  const handleSignOut = async (): Promise<void> => {
    if (kbSettings.apiKey === null) return;
    await kbUpdate({
      apiKey: null,
      baseUrl: kbSettings.baseUrl,
      telemetryOptIn: kbSettings.telemetryOptIn,
    });
    setWizardDismissed(false);
    setView({ kind: 'profiles' });
  };
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.metaKey && e.key === ',') {
        e.preventDefault();
        setView({ kind: 'settings' });
        return;
      }
      if (e.metaKey && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        void handleSignOut();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kbSettings.apiKey, kbSettings.baseUrl, kbSettings.telemetryOptIn, kbUpdate]);

  // V-243 — check for a signed app update once on startup. Best-effort:
  // checkForUpdate() never throws (offline / no endpoint / dev context
  // all resolve to null), so it can't block the shell; the banner below
  // lets the customer install when they choose. MUST be above the early
  // returns (hooks-order rule, like the keydown effect above).
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  useEffect(() => {
    void checkForUpdate().then(setUpdate);
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
    <ToastProvider>
      <div className="flex h-screen w-screen flex-col bg-surface-base">
        {/* 2026-05-20 — GUI panel notification overlay. Mounts at the
          shell level (above any view) so cost / incident / audit /
          session.errored toasts surface regardless of which view the
          customer is on. Subscribes via useNotifications() — auto-
          closes on sign-out (apiKey flips null). */}
        <NotificationToastStack />
        <TitleBar
          subtitle={mode}
          right={
            <>
              <ThemeSwitcher />
              <span className="text-surface-divider">|</span>
              <LiveConnectionPill
                baseUrl={settings.baseUrl}
                onClick={() => setView({ kind: 'settings' })}
              />
              <span className="section-label">v0.0.1</span>
            </>
          }
        />
        {update && !updateDismissed ? (
          <UpdateBanner update={update} onDismiss={() => setUpdateDismissed(true)} />
        ) : null}
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            current={view.kind as SidebarViewKind}
            onNavigate={(kind) => setView({ kind })}
            onSignOut={() => void handleSignOut()}
          />
          {/* key by view.kind so switching views replays the fade-in (5→10
              G8 polish); same element + classes, so no layout-chain change. */}
          <main key={view.kind} className="flex-1 overflow-auto bg-surface-base animate-view-in">
            <CurrentView view={view} onNavigate={setView} />
          </main>
        </div>
        <StatusFooter />
        <CommandPalette
          open={paletteOpen}
          actions={paletteActions}
          onClose={() => setPaletteOpen(false)}
        />
        <ShortcutsCheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
      </div>
    </ToastProvider>
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
    case 'home':
      return <CommandCenterView onNavigate={(kind) => onNavigate({ kind })} />;
    case 'ai':
      return <AgentChatView initialProfileId={view.profileId} />;
    case 'recipes':
      return <RecipesView />;
    case 'logs':
      return <LogsView />;
    case 'sessions':
      return (
        <SessionsView
          onView={(sessionId) => onNavigate({ kind: 'live-session', sessionId })}
          onGoToSettings={() => onNavigate({ kind: 'settings' })}
        />
      );
    case 'live-session':
      return (
        // W609 — key by sessionId so a tab switch fully remounts the view
        // (fresh frame poll, URL bar, fps window — no stale-session bleed).
        <LiveSessionView
          key={view.sessionId}
          sessionId={view.sessionId}
          onBack={() => onNavigate({ kind: 'sessions' })}
          onSwitchSession={(sessionId) => onNavigate({ kind: 'live-session', sessionId })}
          onNewTab={() => onNavigate({ kind: 'profiles' })}
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
      return (
        <ProfilesView
          onGoToSettings={() => onNavigate({ kind: 'settings' })}
          onOpenSession={(sessionId) => onNavigate({ kind: 'live-session', sessionId })}
          onAssist={(profileId) => onNavigate({ kind: 'ai', profileId })}
        />
      );
    case 'sessions-history':
      return <SessionsHistoryView />;
    case 'fleet':
      return <FleetView />;
  }
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

function StatusFooter(): JSX.Element {
  // V-318 — surface tier + concurrent usage in the footer so the
  // customer sees "starter · 2 / 4 sessions" at-a-glance, matching the
  // file-127 enforcement-aware UX intent. accountMe comes from the
  // SettingsContext (V-239 pre-fetch); when it's null we fall back to
  // the prior connection-only chrome rather than blocking.
  // 2026-05-21 — Slice E expansion: also surface profile_count / cap
  // alongside sessions so the customer sees both caps at-a-glance
  // (matches the Sidebar's per-item count badges; the footer is the
  // always-visible mirror that survives across every view).
  const { settings, client, accountMe, activeWorkspace } = useSettings();
  const connected = client !== null;
  const atCap =
    accountMe !== null && accountMe.concurrent_session_active >= accountMe.concurrent_session_cap;
  const atProfileCap =
    accountMe !== null &&
    accountMe.profile_cap !== null &&
    accountMe.profile_count >= accountMe.profile_cap;
  return (
    <footer
      className="flex h-6 items-center justify-between border-t
                 border-surface-divider bg-surface-raised px-3
                 text-2xs text-ink-muted"
    >
      <div className="flex items-center gap-2">
        <span className={`status-pip ${connected ? 'bg-status-ready' : 'bg-status-idle'}`} />
        <span>{connected ? 'connected' : 'not connected'}</span>
        {/* account/me is self-scoped (it ignores X-Driftstack-Account), so
            its tier + session/profile caps describe the SIGNED-IN account,
            not the active team. In a team workspace those personal numbers
            don't govern the work — profiles + sessions there count against
            the owner's caps — so showing them would mislead. Surface the
            workspace context instead; the personal caps return on Personal. */}
        {accountMe !== null && activeWorkspace === null && (
          <>
            <span className="text-ink-muted">·</span>
            <span className="section-label">{accountMe.tier}</span>
            <span className={atCap ? 'mono text-status-error' : 'mono'}>
              {accountMe.concurrent_session_active} / {accountMe.concurrent_session_cap} sessions
            </span>
            <span className="text-ink-muted">·</span>
            <span className={atProfileCap ? 'mono text-status-error' : 'mono'}>
              {accountMe.profile_count}
              {accountMe.profile_cap !== null ? ` / ${accountMe.profile_cap}` : ''} profiles
            </span>
          </>
        )}
        {activeWorkspace !== null && (
          <>
            <span className="text-ink-muted">·</span>
            <span
              className="section-label"
              title="In a team workspace, plan limits are managed by the workspace owner — your personal caps don't apply here."
            >
              team workspace
            </span>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        {settings.apiKey !== null && (
          <span className="mono" title="API key (truncated for screen-share safety)">
            {settings.apiKey.slice(0, 8)}…{settings.apiKey.slice(-4)}
          </span>
        )}
        <span className="text-ink-muted">·</span>
        <span className="mono">{redactBaseUrl(settings.baseUrl)}</span>
      </div>
    </footer>
  );
}

function redactBaseUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

/**
 * 2026-05-20 — title-bar pill that surfaces the live connection state
 * by polling /version every 30s (see useConnectionStatus). Click jumps
 * to Settings so the customer can fix URL / mode without hunting
 * through the sidebar.
 */
function LiveConnectionPill({
  baseUrl,
  onClick,
}: {
  baseUrl: string;
  onClick: () => void;
}): JSX.Element {
  const status = useConnectionStatus(baseUrl);
  return <ConnectionPill status={status} baseUrl={baseUrl} onClick={onClick} />;
}
