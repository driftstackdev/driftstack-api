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
import { RecipesView } from './views/RecipesView';
import { ProfilesView } from './views/ProfilesView';
import { ProxiesView } from './views/ProxiesView';
import { RecordingPlayerView } from './views/RecordingPlayerView';
import { RecordingsView } from './views/RecordingsView';
import { FleetView } from './views/FleetView';
import { SessionsHistoryView } from './views/SessionsHistoryView';
import { TeamView } from './views/TeamView';
import { SessionsView } from './views/SessionsView';
import { SettingsView } from './views/SettingsView';
import { BillingView } from './views/BillingView';
import { UpdateBanner } from './components/UpdateBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { checkForUpdate, type AvailableUpdate } from './lib/updater';

export type View =
  | { kind: 'home' }
  | { kind: 'ai'; profileId?: string }
  | { kind: 'recipes' }
  | { kind: 'sessions' }
  | { kind: 'live-session'; sessionId: string }
  | { kind: 'sessions-history' }
  | { kind: 'profiles'; profileId?: string }
  | { kind: 'recordings' }
  | { kind: 'recording-player'; recordingId: string }
  | { kind: 'proxies' }
  | { kind: 'connectivity' }
  | { kind: 'fleet' }
  | { kind: 'team' }
  | { kind: 'billing' }
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
  const { settings, loading, authExpired, dismissAuthExpired } = useSettings();
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
      label: 'Go to AI Browser Automation',
      kind: 'view',
      glyph: '✦',
      keywords: ['nav', 'ai', 'chat', 'agent', 'automate', 'browser', 'automation'],
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
      id: 'nav-billing',
      label: 'Go to Billing',
      kind: 'view',
      glyph: '◇',
      keywords: [
        'nav',
        'billing',
        'cost',
        'usage',
        'pay',
        'crypto',
        'top up',
        'invoice',
        'receipt',
      ],
      run: () => setView({ kind: 'billing' }),
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
    try {
      await kbUpdate({
        apiKey: null,
        baseUrl: kbSettings.baseUrl,
        telemetryOptIn: kbSettings.telemetryOptIn,
      });
    } catch (err) {
      // A failed clear (keychain hiccup) must not reach the global handler and
      // blank the app. Still drop the in-memory key + return to the wizard so
      // the user is signed out for this session.
      console.warn('[app] sign-out persist failed (cleared in-memory anyway):', err);
    }
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
        {/* Central re-auth prompt — a key that expired / was revoked mid-session
            makes every call 401; SettingsContext flips authExpired once (via the
            client's fetch observer) so this single banner replaces the scattered
            per-view 401 copy. */}
        {authExpired ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-b border-status-error/40 bg-status-error/10 px-4 py-2 text-xs text-status-error"
          >
            <span>Your API key expired or was revoked — re-authenticate to keep working.</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded border border-status-error/40 px-2 py-0.5 font-medium hover:bg-status-error/15"
                onClick={() => {
                  dismissAuthExpired();
                  setView({ kind: 'settings' });
                }}
              >
                Go to Settings
              </button>
              <button
                type="button"
                aria-label="Dismiss"
                className="px-1 text-sm leading-none hover:text-ink-primary"
                onClick={dismissAuthExpired}
              >
                ×
              </button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            current={sidebarSectionFor(view)}
            onNavigate={(kind) => setView({ kind })}
            onSignOut={() => void handleSignOut()}
          />
          {/* key by view.kind so switching views replays the fade-in (5→10
              G8 polish); same element + classes, so no layout-chain change. */}
          {/* min-w-0 is load-bearing: without it a flex item keeps min-width:auto
              and refuses to shrink below its content's intrinsic width, so a wide
              table (Profiles list view) blows the whole layout past the viewport
              instead of letting its own overflow-x-auto scroll. (founder 2026-06-16) */}
          <main
            key={view.kind}
            className="min-w-0 flex-1 overflow-auto bg-surface-base animate-view-in"
          >
            {/* Scope a view render-crash to this panel — the sidebar/chrome
                stay alive and the customer gets a Retry, instead of an
                unexpected throw bubbling to RootErrorBoundary and blanking the
                whole window (no recover path there). Keyed by view.kind so
                navigating to another view always lands a fresh boundary. */}
            <ErrorBoundary
              key={view.kind}
              fallback={(retry) => (
                <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
                  <div className="max-w-md space-y-2">
                    <h2 className="text-base font-semibold text-ink-primary">
                      This view ran into a problem
                    </h2>
                    <p className="text-sm text-ink-muted">
                      Something went wrong rendering this screen. The rest of the app is still
                      running — you can retry, or switch to another view in the sidebar.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={retry}
                    className="rounded border border-surface-divider px-3 py-1.5 text-sm font-medium text-ink-primary hover:bg-surface-raised"
                  >
                    Retry
                  </button>
                </div>
              )}
            >
              <CurrentView view={view} onNavigate={setView} />
            </ErrorBoundary>
          </main>
        </div>
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
      return (
        <CommandCenterView
          onNavigate={(kind) => onNavigate({ kind })}
          onOpenProfile={(profileId) => onNavigate({ kind: 'profiles', profileId })}
        />
      );
    case 'ai':
      return <AgentChatView initialProfileId={view.profileId} />;
    case 'recipes':
      return <RecipesView />;
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
          initialProfileId={view.profileId}
          onGoToSettings={() => onNavigate({ kind: 'settings' })}
          onOpenSession={(sessionId) => onNavigate({ kind: 'live-session', sessionId })}
          onAssist={(profileId) => onNavigate({ kind: 'ai', profileId })}
        />
      );
    case 'sessions-history':
      return <SessionsHistoryView />;
    case 'fleet':
      return <FleetView />;
    case 'team':
      return <TeamView />;
    case 'billing':
      return <BillingView />;
  }
}

// ─── chrome ───────────────────────────────────────────────────────

// Map the active view to the sidebar section that should read as "you are here".
// Most views are 1:1 with a sidebar item, but the DRILLED-IN sub-views
// ('live-session', 'recording-player') aren't sidebar entries — without this
// they fell through the old `view.kind as SidebarViewKind` cast and matched
// nothing, so the nav lost its active highlight. Fold them onto their parent
// section so drilling in keeps the section lit.
export function sidebarSectionFor(view: View): SidebarViewKind {
  switch (view.kind) {
    case 'live-session':
      return 'sessions';
    case 'recording-player':
      return 'recordings';
    default:
      return view.kind;
  }
}

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
