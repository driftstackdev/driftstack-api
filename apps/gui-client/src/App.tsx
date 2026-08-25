// App shell — outer chrome + view routing.
//
// GUI1 landed the static shell; GUI2 wires the SettingsProvider and
// adds two real views (Sessions, Settings). The routing model is
// state-based, not URL-based — no need for react-router in a
// single-window desktop app, and Tauri's window doesn't have a real
// history stack to integrate with.

import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import { ConnectionPill } from './components/ConnectionPill';
import { Sidebar, type SidebarViewKind } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { ThemeSwitcher } from './components/ThemeSwitcher';
import { ShortcutsCheatsheet } from './components/ShortcutsCheatsheet';
import { NotificationToastStack } from './components/NotificationToastStack';
import { NotificationBell } from './components/NotificationBell';
import { useNotifications } from './lib/use-notifications';
import { RecordingsProvider } from './lib/recordings';
import { SettingsProvider, useSettings } from './lib/SettingsContext';
import { useConnectionStatus } from './lib/use-connection-status';
import { isCloudBaseUrl } from './lib/telemetry';
import { useAppVersion } from './lib/app-version';
import { listProxies, testProxy, type ProxyConfig } from './lib/proxies';
import { loadProbeCache, saveProbeResult } from './lib/proxy-probe-cache';
import { runSweep, SWEEP_INTERVAL_MS } from './lib/proxy-probe-sweeper';
import { FirstRunWizard } from './views/FirstRunWizard';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { ToastProvider, useToasts } from './lib/toasts';
import { CommandCenterView } from './views/CommandCenterView';
import { UpdateBanner } from './components/UpdateBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  checkForUpdate,
  isSessionRunning,
  shouldAutoInstall,
  type AvailableUpdate,
} from './lib/updater';
import { buildClient } from './lib/client';
import { dispatchDeepLink } from './lib/deep-link';
import { openSessionById } from './lib/open-simulator';
import { friendlySimulatorOpenReason } from './lib/simulator-open-error';
import { installAppDeepLinkSources } from './lib/app-deep-link-listener';

// The default Command Center and boot/first-run surfaces stay eager. Every other
// destination is loaded only when selected, keeping crypto/billing, profile tooling,
// recordings, and admin/team code out of the initial Tauri window parse. Each module
// exposes named exports, so adapt them to React.lazy's default-export contract.
const AgentChatView = lazy(async () => ({
  default: (await import('./views/AgentChatView')).AgentChatView,
}));
const RecipesView = lazy(async () => ({
  default: (await import('./views/RecipesView')).RecipesView,
}));
const ProfilesView = lazy(async () => ({
  default: (await import('./views/ProfilesView')).ProfilesView,
}));
const ProxiesView = lazy(async () => ({
  default: (await import('./views/ProxiesView')).ProxiesView,
}));
const RecordingPlayerView = lazy(async () => ({
  default: (await import('./views/RecordingPlayerView')).RecordingPlayerView,
}));
const RecordingsView = lazy(async () => ({
  default: (await import('./views/RecordingsView')).RecordingsView,
}));
const FleetView = lazy(async () => ({ default: (await import('./views/FleetView')).FleetView }));
const SessionsHistoryView = lazy(async () => ({
  default: (await import('./views/SessionsHistoryView')).SessionsHistoryView,
}));
const TeamView = lazy(async () => ({ default: (await import('./views/TeamView')).TeamView }));
const SessionsView = lazy(async () => ({
  default: (await import('./views/SessionsView')).SessionsView,
}));
const SettingsView = lazy(async () => ({
  default: (await import('./views/SettingsView')).SettingsView,
}));
// Billing moved to the web dashboard only — the desktop hub is gone, and this
// destination now just points at the one surface that owns billing.
const BillingMovedView = lazy(async () => ({
  default: (await import('./views/BillingMovedView')).BillingMovedView,
}));
const ConnectivityView = lazy(async () => ({
  default: (await import('./views/ConnectivityView')).ConnectivityView,
}));

export type View =
  | { kind: 'home' }
  | { kind: 'ai'; profileId?: string }
  | { kind: 'recipes' }
  | { kind: 'sessions' }
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

/** One transition-owned state boundary for every navigation entry point. A lazy
 * destination may suspend, but React keeps the already-revealed view visible
 * until its chunk is ready instead of committing the full-panel fallback. */
export function useViewNavigation(
  initial: View,
): readonly [View, (next: View) => void, (next: View) => void] {
  const [view, setView] = useState<View>(initial);
  const [, startNavigation] = useTransition();
  const navigate = useCallback((next: View): void => {
    startNavigation(() => setView(next));
  }, []);
  // Account/workspace replacement is not ordinary navigation: it must remove a
  // stale entity payload before the new scoped child's passive effects run.
  // Keep this immediate setter private to the workspace boundary's layout
  // reconciliation; every user navigation entry point uses `navigate` above.
  const replaceForScope = useCallback((next: View): void => setView(next), []);
  return [view, navigate, replaceForScope] as const;
}

/** Recording players need independent scroll positions; every other destination
 * is one sidebar surface even when it was opened with an initial entity id. */
export function viewScrollKey(view: View): string {
  return view.kind === 'recording-player' ? `${view.kind}:${view.recordingId}` : view.kind;
}

/** An entity deep link belongs to the workspace where it was opened. A workspace
 * switch keeps the destination but drops that old profile id before the fresh
 * view's effects can resolve or act on it. */
export function viewAfterWorkspaceChange(view: View): View {
  if (view.kind === 'ai' && view.profileId !== undefined) return { kind: 'ai' };
  if (view.kind === 'profiles' && view.profileId !== undefined) return { kind: 'profiles' };
  return view;
}

/** Derive the view rendered for the current workspace before React creates its
 * child subtree. The stored navigation state is reconciled in layout, but the
 * fresh workspace can never render or run effects with an old entity payload. */
export function useWorkspaceScopedView(
  view: View,
  replaceView: (next: View) => void,
  activeWorkspace: string | null,
): View {
  const previousWorkspaceRef = useRef(activeWorkspace);
  const workspaceChanged = previousWorkspaceRef.current !== activeWorkspace;
  const scopedView = workspaceChanged ? viewAfterWorkspaceChange(view) : view;

  useLayoutEffect(() => {
    if (!workspaceChanged) return;
    previousWorkspaceRef.current = activeWorkspace;
    if (scopedView !== view) replaceView(scopedView);
  }, [activeWorkspace, replaceView, scopedView, view, workspaceChanged]);

  return scopedView;
}

const VIEW_SCROLL_CACHE_LIMIT = 32;

function rememberViewScroll(positions: Map<string, number>, key: string, scrollTop: number): void {
  // Refresh insertion order so the bounded map behaves as a tiny LRU. Recording
  // deep links are the only source of more keys than the fixed view taxonomy.
  positions.delete(key);
  positions.set(key, scrollTop);
  if (positions.size <= VIEW_SCROLL_CACHE_LIMIT) return;
  const oldest = positions.keys().next().value;
  if (oldest !== undefined) positions.delete(oldest);
}

export function StableViewPanel({
  destinationKey,
  contentIdentity,
  children,
  loadingFallback,
  errorFallback,
}: {
  destinationKey: string;
  /** Opaque account/workspace identity. Changing it remounts only the active
   * view child and namespaces scroll/error state; shell/main/boundary persist. */
  contentIdentity: string;
  children: ReactNode;
  loadingFallback: ReactNode;
  errorFallback: (retry: () => void) => ReactNode;
}): JSX.Element {
  const mainRef = useRef<HTMLElement>(null);
  const scrollPositionsRef = useRef<Map<string, number>>(new Map());
  const scopedDestinationKey = `${contentIdentity}\0${destinationKey}`;

  // Restore before paint. The view component itself still unmounts normally,
  // so inactive polls/live media clean up rather than running behind the rail.
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (main === null) return;
    const saved = scrollPositionsRef.current.get(scopedDestinationKey) ?? 0;
    main.scrollTop = saved;
    rememberViewScroll(scrollPositionsRef.current, scopedDestinationKey, saved);
  }, [scopedDestinationKey]);

  return (
    <main
      ref={mainRef}
      onScroll={(event) => {
        rememberViewScroll(
          scrollPositionsRef.current,
          scopedDestinationKey,
          event.currentTarget.scrollTop,
        );
      }}
      className="min-w-0 flex-1 overflow-auto bg-surface-base"
    >
      <ErrorBoundary resetKey={scopedDestinationKey} fallback={errorFallback}>
        <Suspense fallback={loadingFallback}>
          <Fragment key={contentIdentity}>{children}</Fragment>
        </Suspense>
      </ErrorBoundary>
    </main>
  );
}

/** P2 #7 — whether the Team destination is offered, matching the Sidebar gate:
 *  a team MEMBER (teamCount>0) OR a team-capable tier (so an owner can manage
 *  their team before adding members). */
export function paletteShowTeam(tier: string | null, teamCount: number): boolean {
  const teamCapableTier =
    tier === 'team_manual' || tier === 'agency_manual' || tier === 'enterprise';
  return teamCount > 0 || teamCapableTier;
}

/** P2 #7 — build the ⌘K palette's action list. Extracted (pure, given the nav
 *  callback + the two sidebar gates) so the destination set is testable and stays
 *  in lockstep with the Sidebar rail (Session log / Mac mini fleet / Team were
 *  missing). `showFleet`/`showTeam` mirror the Sidebar's exact gates so the palette
 *  never routes to a destination the rail wouldn't show. */
export function buildPaletteActions(opts: {
  setView: (v: View) => void;
  onShowShortcuts: () => void;
  showFleet: boolean;
  showTeam: boolean;
}): PaletteAction[] {
  const { setView, onShowShortcuts, showFleet, showTeam } = opts;
  return [
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
      label: 'Go to Saved tasks',
      kind: 'view',
      glyph: '❡',
      keywords: ['nav', 'saved', 'tasks', 'recipes', 'automation', 'flows'],
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
      id: 'nav-sessions-history',
      label: 'Go to Session log',
      kind: 'view',
      glyph: '☰',
      keywords: ['nav', 'session log', 'history', 'past', 'closed', 'audit'],
      run: () => setView({ kind: 'sessions-history' }),
    },
    ...(showFleet
      ? [
          {
            id: 'nav-fleet',
            label: 'Go to Mac mini fleet',
            kind: 'view' as const,
            glyph: '▤',
            keywords: ['nav', 'fleet', 'mac', 'mini', 'cluster', 'nodes', 'workers'],
            run: () => setView({ kind: 'fleet' }),
          },
        ]
      : []),
    ...(showTeam
      ? [
          {
            id: 'nav-team',
            label: 'Go to Team',
            kind: 'view' as const,
            glyph: '◑',
            keywords: ['nav', 'team', 'members', 'workspace', 'rbac', 'invite'],
            run: () => setView({ kind: 'team' }),
          },
        ]
      : []),
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
      run: onShowShortcuts,
    },
  ];
}

export function App(): JSX.Element {
  return (
    <SettingsProvider>
      <RecordingsProvider>
        {/* ToastProvider lifted to wrap Shell so the app-boot deep-link
            listener (in Shell, above the view tree) can push a toast when
            "Open in desktop client" fails — previously its failure was
            swallowed to console.warn only. Transparent for the loading /
            first-run-wizard early returns. */}
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </RecordingsProvider>
    </SettingsProvider>
  );
}

function Shell(): JSX.Element {
  const { settings, activeWorkspace, accountMe, loading, authExpired, dismissAuthExpired } =
    useSettings();
  // P2 #11 — the real app version (Tauri runtime / build-time), not a hardcoded
  // literal that silently lies after a version bump.
  const appVersion = useAppVersion();
  // ⛔ V-1611 #18 — ONE subscription for the whole shell. `useNotifications()`
  // opens an SSE stream on mount, so each caller gets its own connection; the
  // toast stack and the bell are two readers of one feed, not two subscribers.
  //
  // ⛔ AND IT LIVES HERE, with the other unconditional hooks, because Shell has
  // early returns at the wizard and error paths. I first put it just above the
  // final `return` and every app-shell test broke with "Rendered more hooks
  // than during the previous render" — the same defect V-1611 fixed in
  // SettingsView this morning, and the one the comment further down this file
  // already warns about. A hook below an early return is a hook that sometimes
  // does not run.
  const notificationFeed = useNotifications();
  // Toast surface for the app-boot deep-link listener below: a dashboard
  // "Open in desktop client" that can't open the window must SHOW the reason,
  // not bury it in console.warn (the customer re-clicks with no idea why).
  const { push } = useToasts();
  // 2026-06-14 — Command Center ('home') is the default landing (5→10 G4):
  // it leads with Automate (Ask AI / recipes) + an account/session overview,
  // making automation the primary surface; Profiles/Sessions are one click away.
  const [view, setView, replaceViewForScope] = useViewNavigation({ kind: 'home' });
  // Workspace switches rebuild SettingsContext's SDK client. Derive the safe
  // view during render, before React creates the newly keyed child, then
  // reconcile stored navigation state in layout. No fresh-workspace render or
  // passive effect can therefore observe an old entity-bearing profile link.
  const scopedView = useWorkspaceScopedView(view, replaceViewForScope, activeWorkspace);
  const workspaceContentIdentity =
    activeWorkspace === null ? 'workspace:personal' : `workspace:team:${activeWorkspace}`;
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
  // P2 #7 — the palette must offer the same primary sidebar destinations as the rail.
  // Session log is always present; Mac mini fleet + Team are gated EXACTLY like the
  // Sidebar (fleet on a self-hosted deployment; Team for a member or a team-capable
  // tier) so the palette never routes to a destination the rail wouldn't show.
  const paletteActions: PaletteAction[] = buildPaletteActions({
    setView,
    onShowShortcuts: () => setCheatsheetOpen(true),
    showFleet: !isCloudBaseUrl(settings.baseUrl),
    // `accountMe?.teams.length` only guards a null accountMe — a non-null /me
    // with teams missing (partial/legacy server response) would throw "Cannot
    // read properties of undefined (reading 'length')" here, in the shell render
    // ABOVE the per-view ErrorBoundary, blanking the whole window. Guard teams too.
    showTeam: paletteShowTeam(accountMe?.tier ?? null, accountMe?.teams?.length ?? 0),
  });
  // V-244 — track wizard state. Customer with no apiKey on boot
  // sees the wizard; once apiKey is set (via wizard or any other
  // path) the regular shell takes over. `wizardDismissed` lets the
  // customer skip the wizard mid-flow without leaving them stuck on
  // it forever; once true, they get the normal shell + can still
  // configure via Settings.
  const [wizardDismissed, setWizardDismissed] = useState(false);
  // The wizard saves the API key BEFORE its final "First profile" step (the
  // ProfileStep needs the now-validated client from SettingsContext to call
  // profiles.create). If the gate keyed only on `settings.apiKey === null`,
  // that save would flip the gate the instant the key validated and unmount
  // the wizard MID-FLOW — the customer never reaches the First-profile step
  // the stepper advertises; they're dumped straight into the app shell. Track
  // an explicit "wizard owns the screen" flag that latches true while the
  // wizard is running and only clears on its onComplete (skip / created /
  // dismissed). It re-arms on sign-out (apiKey → null) via the effect below.
  const [wizardActive, setWizardActive] = useState(false);
  // Latch the wizard ON only on the no-key edge (boot-with-no-key once settings
  // have loaded, or sign-out clearing the key). Gated on `!loading` so the
  // transient DEFAULT_SETTINGS (apiKey=null) during boot doesn't arm it for a
  // user who actually has a saved key, and never auto-CLEARS — the wizard's own
  // mid-flow key save can't unmount it (only onComplete clears it).
  useEffect(() => {
    if (!loading && settings.apiKey === null && !wizardDismissed) setWizardActive(true);
  }, [loading, settings.apiKey, wizardDismissed]);

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
  // P-8 — keep the probe cache young enough that BULK launch can trust it.
  // Single launch re-probes at launch time; bulk deliberately does not, so the
  // cache is load-bearing exactly where nothing re-tests it. Same shape as the
  // update check below: best-effort, silent, never blocking.
  //
  // Interval, not on-mount-only: the app stays open for days. The first sweep
  // is deferred by one interval rather than fired at startup — launch is the
  // busiest moment for the machine and nothing is stale-urgent in the first
  // quarter hour.
  useEffect(() => {
    const deps = {
      loadCache: loadProbeCache,
      listProxies,
      testProxy: (px: ProxyConfig) =>
        testProxy({ host: px.host, port: px.port, username: px.username, password: px.password }),
      saveResult: saveProbeResult,
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    };
    const id = window.setInterval(() => {
      // runSweep is single-flight; a tick arriving while one runs is a no-op.
      void runSweep(deps).catch(() => undefined);
    }, SWEEP_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void checkForUpdate().then(async (u) => {
      setUpdate(u);
      // Auto-install when the customer has left it on AND nothing is running.
      // A failure here is deliberately silent: the banner below is still
      // rendered, so a failed auto-install degrades into the manual path
      // rather than into a dead end.
      if (u !== null && kbSettings.autoUpdate) {
        if (shouldAutoInstall({ autoUpdate: true, sessionRunning: await isSessionRunning() })) {
          try {
            await u.install();
            return;
          } catch {
            /* fall through to the banner */
          }
        }
      }
      // M16 — "Later" persists per-version so the banner doesn't re-nag on EVERY launch;
      // a genuinely newer version (different string) still surfaces (audit 2026-07-08).
      if (u !== null) {
        try {
          if (localStorage.getItem('ds_update_dismissed') === u.version) setUpdateDismissed(true);
        } catch {
          /* storage unavailable — fall back to session-only dismissal */
        }
      }
    });
  }, []);

  // Global always-on deep-link listener (the dashboard's "Open in desktop
  // client" emits `driftstack://session/open?session_id=…`). The browser-
  // sign-in hook registers its OWN short-lived onOpenUrl listener while a CLI
  // authorize flow is in flight, but that one drops every non-cli-authorize
  // payload — so a session-open deep-link arriving any other time went nowhere
  // (it pointed at the now-removed in-app session viewer). This app-boot
  // listener routes session-open to REOPEN the floating Simulator window for
  // that session via openSessionById. MUST stay above the early returns below
  // (hooks-order rule). Keep one native listener installation after settings
  // load, while a ref supplies the latest api key / base URL / workspace. That
  // makes getCurrent() a true one-shot cold-start consume rather than replaying
  // it whenever account state changes. Imports stay dynamic so a browser
  // preview (no Tauri bridge) just no-ops.
  const deepLinkContext = useRef({ settings, activeWorkspace, push });
  deepLinkContext.current = { settings, activeWorkspace, push };
  useEffect(() => {
    if (loading) return;

    let unlisten: (() => void) | undefined;
    const abort = new AbortController();
    void (async () => {
      try {
        const [deepLinkPlugin, tauriEvent] = await Promise.all([
          import('@tauri-apps/plugin-deep-link'),
          import('@tauri-apps/api/event'),
        ]);
        const stop = await installAppDeepLinkSources(
          {
            getCurrent:
              typeof deepLinkPlugin.getCurrent === 'function'
                ? () => deepLinkPlugin.getCurrent()
                : undefined,
            onOpenUrl:
              typeof deepLinkPlugin.onOpenUrl === 'function'
                ? (handler) => deepLinkPlugin.onOpenUrl(handler)
                : undefined,
            onForwardedUrl: (handler) =>
              tauriEvent.listen<unknown>('ds-deep-link', (event) => handler(event.payload)),
          },
          (urls) => {
            const current = deepLinkContext.current;
            const client = buildClient(
              current.settings.apiKey,
              current.settings.baseUrl,
              current.activeWorkspace,
            );
            for (const url of urls) {
              dispatchDeepLink(url, {
                onSessionOpen: (sessionId) => {
                  void openSessionById({
                    client,
                    baseUrl: current.settings.baseUrl,
                    apiKey: current.settings.apiKey,
                    sessionId,
                  }).then((res) => {
                    if (!res.opened) {
                      // Keep the console line for diagnostics…
                      console.warn(
                        '[app] session-open deep-link could not open the simulator:',
                        res.reason ?? 'unknown',
                      );
                      // …but ALSO surface it: the customer clicked "Open in
                      // desktop client" on the dashboard expecting the iPhone
                      // window — when it fails (signed out / session ended /
                      // Simulator app not installed) they must see why, not have
                      // nothing happen.
                      current.push({
                        tone: 'error',
                        title: 'Could not open the session',
                        body: friendlyDeepLinkReason(res.reason),
                      });
                    }
                  });
                },
              });
            }
          },
          { signal: abort.signal },
        );
        if (abort.signal.aborted) {
          stop();
          return;
        }
        unlisten = stop;
      } catch {
        // Plugin unavailable (browser preview / Tauri version mismatch) →
        // no deep-link handling; not an error worth surfacing.
      }
    })();
    return () => {
      abort.abort();
      if (unlisten !== undefined) unlisten();
    };
  }, [loading]);

  // While settings load, show a calm spinner rather than a bare "Loading…" text
  // flash (matches the index.html boot splash so the boot→mount handoff is
  // seamless) — and never flash the wizard before we know the key state.
  if (loading) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-surface-base">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2 border-surface-divider border-t-ink-primary"
          role="status"
          aria-label="Loading"
        />
        <span className="section-label text-ink-muted">Loading…</span>
      </div>
    );
  }

  // V-244 — first-run gate. Show the wizard when there's no key (the direct
  // check renders it on the very first post-load frame, no flash of the empty
  // shell while the latching effect runs) OR while the wizard is mid-flow
  // (wizardActive latched true) — the latter keeps it mounted past its own key
  // save, which would otherwise null the `apiKey === null` check and unmount it
  // before the First-profile step the stepper advertises.
  if ((settings.apiKey === null || wizardActive) && !wizardDismissed) {
    return (
      <FirstRunWizard
        onComplete={() => {
          setWizardActive(false);
          setWizardDismissed(true);
        }}
      />
    );
  }

  const mode = deploymentLabel(settings.baseUrl);
  return (
    <>
      <div className="flex h-screen w-screen flex-col bg-surface-base">
        {/* 2026-05-20 — GUI panel notification overlay. Mounts at the
          shell level (above any view) so cost / incident / audit /
          session.errored toasts surface regardless of which view the
          customer is on. Subscribes via useNotifications() — auto-
          closes on sign-out (apiKey flips null). */}
        <NotificationToastStack {...notificationFeed} />
        <TitleBar
          subtitle={mode}
          right={
            <>
              <NotificationBell
                events={notificationFeed.events}
                notices={
                  update
                    ? [
                        {
                          id: `update-${update.version}`,
                          level: 'info' as const,
                          // ⛔ Stays in the bell even after the BANNER is
                          // dismissed. Dismissing a banner means "stop
                          // interrupting me", not "forget this happened" —
                          // losing it from history is the complaint #18 exists
                          // to fix.
                          title: `Update ${update.version} is ready to install`,
                          at: new Date().toISOString(),
                        },
                      ]
                    : []
                }
              />
              <ThemeSwitcher />
              <span className="text-surface-divider">|</span>
              <LiveConnectionPill
                baseUrl={settings.baseUrl}
                onClick={() => setView({ kind: 'settings' })}
              />
              <span className="section-label">v{appVersion}</span>
            </>
          }
        />
        {update && !updateDismissed ? (
          <UpdateBanner
            update={update}
            onDismiss={() => {
              setUpdateDismissed(true);
              try {
                localStorage.setItem('ds_update_dismissed', update.version);
              } catch {
                /* storage unavailable — dismissal stays session-only */
              }
            }}
          />
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
        {/* Finish-setup nudge — a customer who chose "Skip for now" in the wizard
            lands here unconnected (apiKey null, wizard dismissed) with everything
            reading "Not connected" and previously only a vanishing link back
            (journey audit L2). Persistent (no dismiss) until they connect; the
            button re-arms the wizard, which is still gated on apiKey === null. */}
        {settings.apiKey === null ? (
          <div
            role="status"
            className="flex items-center justify-between gap-3 border-b border-accent/40 bg-accent/10 px-4 py-2 text-xs text-ink-primary"
          >
            <span>You’re not connected yet — finish setup to start launching iPhone sessions.</span>
            <button
              type="button"
              className="rounded border border-accent/40 px-2 py-0.5 font-medium text-accent hover:bg-accent/15"
              onClick={() => setWizardDismissed(false)}
            >
              Finish setup
            </button>
          </div>
        ) : null}
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            current={sidebarSectionFor(scopedView)}
            onNavigate={(kind) => setView({ kind })}
            onSignOut={() => void handleSignOut()}
            onOpenPalette={() => setPaletteOpen(true)}
          />
          {/* min-w-0 is load-bearing: without it a flex item keeps min-width:auto
              and refuses to shrink below its content's intrinsic width, so a wide
              table (Profiles list view) blows the whole layout past the viewport
              instead of letting its own overflow-x-auto scroll. (founder 2026-06-16) */}
          <StableViewPanel
            destinationKey={viewScrollKey(scopedView)}
            contentIdentity={workspaceContentIdentity}
            errorFallback={(retry) => (
              <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
                <div className="max-w-md space-y-2">
                  <h2 className="text-base font-semibold text-ink-primary">
                    This view ran into a problem
                  </h2>
                  <p className="text-sm text-ink-muted">
                    Something went wrong rendering this screen. The rest of the app is still running
                    — you can retry, or switch to another view in the sidebar.
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
            loadingFallback={
              <div
                role="status"
                aria-label="Loading view"
                className="flex h-full items-center justify-center gap-3 text-sm text-ink-muted"
              >
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-surface-divider border-t-ink-primary" />
                Loading…
              </div>
            }
          >
            {/* Scope a view render-crash to this panel — the sidebar/chrome
                stay alive and the customer gets a Retry, instead of an
                unexpected throw bubbling to RootErrorBoundary and blanking the
                whole window (no recover path there). The boundary stays mounted
                and resets by destination identity, avoiding a panel remount. */}
            <CurrentView view={scopedView} onNavigate={setView} />
          </StableViewPanel>
        </div>
        <CommandPalette
          open={paletteOpen}
          actions={paletteActions}
          onClose={() => setPaletteOpen(false)}
        />
        <ShortcutsCheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
      </div>
    </>
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
      return (
        <AgentChatView
          initialProfileId={view.profileId}
          onGoToSettings={() => onNavigate({ kind: 'settings' })}
        />
      );
    case 'recipes':
      return (
        <RecipesView
          onGoToAI={() => onNavigate({ kind: 'ai' })}
          onGoToSettings={() => onNavigate({ kind: 'settings' })}
        />
      );
    case 'sessions':
      return (
        <SessionsView
          onGoToSettings={() => onNavigate({ kind: 'settings' })}
          onGoToProxies={() => onNavigate({ kind: 'proxies' })}
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
        // key by recordingId so swapping to a DIFFERENT recording without an
        // intervening unmount forces a clean remount — otherwise cursorMs /
        // playing / the tick interval would persist across the swap (new
        // recording starts mid-scrub). Latent today (list→player→list remounts),
        // but any 'next recording' / deep-link affordance would hit it. (audit)
        <RecordingPlayerView
          key={view.recordingId}
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
          onAssist={(profileId) => onNavigate({ kind: 'ai', profileId })}
        />
      );
    case 'sessions-history':
      return <SessionsHistoryView />;
    case 'fleet':
      return <FleetView />;
    case 'team':
      return <TeamView onGoToSettings={() => onNavigate({ kind: 'settings' })} />;
    case 'billing':
      return <BillingMovedView />;
  }
}

// ─── chrome ───────────────────────────────────────────────────────

// Map the active view to the sidebar section that should read as "you are here".
// Most views are 1:1 with a sidebar item, but the DRILLED-IN sub-view
// ('recording-player') isn't a sidebar entry — without this it fell through the
// old `view.kind as SidebarViewKind` cast and matched nothing, so the nav lost
// its active highlight. Fold it onto its parent section so drilling in keeps the
// section lit.
export function sidebarSectionFor(view: View): SidebarViewKind {
  switch (view.kind) {
    case 'recording-player':
      return 'recordings';
    // The live-Sessions view ('sessions') has no sidebar item of its own (the
    // in-app session viewer was removed); fold it onto the Session-log item
    // ('sessions-history') so the nav keeps an active highlight instead of going
    // dark when that view is open.
    case 'sessions':
      return 'sessions-history';
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

/** Map an openSessionById failure `reason` to friendly, actionable toast copy.
 *  The known reasons come from open-simulator.ts: 'not signed in', the
 *  Simulator-app-not-installed message, the browser-preview guard, plus the
 *  raw error message from a livekitToken mint (a closed/expired session 403s/
 *  404s). Unknown support diagnostics cross the shared safe fallback rather
 *  than entering the toast. */
export function friendlyDeepLinkReason(reason: string | undefined): string {
  return friendlySimulatorOpenReason(reason);
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
