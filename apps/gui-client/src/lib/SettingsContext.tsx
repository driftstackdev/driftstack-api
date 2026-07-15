// Settings context — single source of truth for the API key + base
// URL across the React tree. Wraps the load/save persistence in
// settings.ts and exposes a memoised SDK client.
//
// V-239: also fetches + exposes the AccountSelfProfile (V-237 endpoint)
// so views can render "X / Y concurrent sessions" + "P / Q profiles"
// gates without each view re-fetching independently. `accountMe` is
// null while loading or when no apiKey is set; `refreshAccountMe()`
// is exposed so views (Sessions, Profiles) can refresh after a
// create/destroy that mutates the count.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { AccountSelfProfile } from '@driftstack/sdk';
import { buildClient, type DriftstackClient } from './client';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type DriftstackSettings } from './settings';
import { initTelemetry } from './telemetry';

interface SettingsContextValue {
  settings: DriftstackSettings;
  loading: boolean;
  client: DriftstackClient | null;
  /** Workspace half-2: active team workspace (owner account id) or null =
   *  personal. Switching rebuilds the client with the SDK's
   *  effectiveAccount option; persisted per-install in localStorage. */
  activeWorkspace: string | null;
  setActiveWorkspace: (ownerAccountId: string | null) => void;
  /** V-239 — current account's tier + caps + usage. Null while loading or unauthenticated. */
  accountMe: AccountSelfProfile | null;
  /** V-239 — manually trigger a re-fetch (e.g. after a create/destroy). */
  refreshAccountMe: () => Promise<void>;
  /** True when an API call returned 401 with a key set (key expired / revoked
   *  mid-session) — surfaced once centrally as a re-auth prompt. */
  authExpired: boolean;
  /** Dismiss the central re-auth prompt. */
  dismissAuthExpired: () => void;
  /** Update settings + persist. Background callers remain best-effort; explicit
   * save flows can request a rejection so they can report that persistence did
   * not complete and leave the prior in-memory value available for retry. */
  update: (
    next: Partial<DriftstackSettings>,
    options?: { reportPersistenceFailure?: boolean },
  ) => Promise<void>;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [settings, setSettings] = useState<DriftstackSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void loadSettings()
      .then((s) => {
        if (!cancelled) {
          setSettings(s);
          setLoading(false);
        }
      })
      .catch((err) => {
        // A keychain/store read failure must NOT blank the app via the global
        // handler — degrade to defaults so the GUI boots (the user can re-enter
        // their key in Settings).
        console.warn('[settings] load failed; using defaults:', err);
        if (!cancelled) {
          setSettings(DEFAULT_SETTINGS);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fleet theme axes (2026-06-12 rework) — apply mode + accent to the
  // document root so the token layer (styles/index.css) flips the whole
  // GUI. Runs on load and on every settings change; cheap + idempotent.
  useEffect(() => {
    document.documentElement.dataset.mode = settings.themeMode;
    document.documentElement.dataset.accent = settings.themeAccent;
  }, [settings.themeMode, settings.themeAccent]);

  // V-242 — re-init telemetry whenever baseUrl or telemetryOptIn changes.
  // initTelemetry is idempotent + reconfigure-safe; it close()s the
  // existing client when the customer opts out mid-session.
  useEffect(() => {
    initTelemetry({ baseUrl: settings.baseUrl, optIn: settings.telemetryOptIn });
  }, [settings.baseUrl, settings.telemetryOptIn]);

  const update = useCallback(
    async (next: Partial<DriftstackSettings>, options?: { reportPersistenceFailure?: boolean }) => {
      const merged: DriftstackSettings = { ...settings, ...next };
      const reportPersistenceFailure = options?.reportPersistenceFailure === true;
      const credentialUnchanged =
        merged.apiKey === settings.apiKey && merged.baseUrl === settings.baseUrl;
      // Background appearance/preferences changes keep the historical
      // best-effort behavior. An explicit Save commits in-memory state only
      // after persistence succeeds, so a reported failure stays retryable.
      if (!reportPersistenceFailure) setSettings(merged);
      // Persistence stays best-effort for default callers: a keychain/store
      // failure must not turn a void theme update into a global rejection. The
      // explicit path is awaited by customer-facing save flows and rejects so
      // they can render a bounded, actionable failure. (#9)
      try {
        await saveSettings(merged, { credentialUnchanged });
        if (reportPersistenceFailure) setSettings(merged);
      } catch (e) {
        console.warn('[settings] persist failed:', e);
        if (reportPersistenceFailure) throw e;
      }
    },
    [settings],
  );

  const [activeWorkspace, setActiveWorkspaceState] = useState<string | null>(() => {
    try {
      return localStorage.getItem('ds_active_workspace');
    } catch {
      return null;
    }
  });
  const setActiveWorkspace = useCallback((ownerAccountId: string | null): void => {
    setActiveWorkspaceState(ownerAccountId);
    try {
      if (ownerAccountId === null) localStorage.removeItem('ds_active_workspace');
      else localStorage.setItem('ds_active_workspace', ownerAccountId);
    } catch {
      /* session-only persistence */
    }
  }, []);

  // Cross-account scope safety — a persisted team workspace must NOT leak into
  // a different session/account. Reset the active workspace to personal scope
  // when the key or deployment changes underneath it:
  //   • sign-out (apiKey → null): drop the workspace so the next sign-in starts
  //     personal, not scoped to the previous account's team owner id.
  //   • baseUrl change: a cloud workspace id is meaningless against a different
  //     deployment (self-hosted), so don't send a stale X-Driftstack-Account.
  // Both are gated on `!loading`: while settings load, `settings` are the
  // DEFAULTS (apiKey=null, default baseUrl) — that transient state is NOT a real
  // sign-out / deployment switch and must not wipe a freshly restored workspace.
  // (The "workspace isn't in the new account's teams" reconciliation lives in
  // refreshAccountMe below, where accountMe.teams is known.)
  useEffect(() => {
    if (!loading && settings.apiKey === null && activeWorkspace !== null) {
      setActiveWorkspace(null);
    }
  }, [loading, settings.apiKey, activeWorkspace, setActiveWorkspace]);

  // Reset on deployment change. Keyed only on baseUrl (not activeWorkspace) so a
  // legitimate same-deployment workspace switch isn't clobbered. The previous
  // baseUrl is seeded only once settings have loaded, so the DEFAULT→loaded
  // baseUrl transition during boot doesn't count as a deployment change and
  // doesn't wipe the restored workspace.
  const prevBaseUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    if (prevBaseUrlRef.current !== null && prevBaseUrlRef.current !== settings.baseUrl) {
      setActiveWorkspace(null);
    }
    prevBaseUrlRef.current = settings.baseUrl;
  }, [loading, settings.baseUrl, setActiveWorkspace]);
  // Central 401 handling — an expired/revoked key makes every call 401; the
  // client's fetch observer flips this once so App shows ONE re-auth banner
  // instead of each view rendering its own 401 copy.
  const [authExpired, setAuthExpired] = useState(false);
  const handleUnauthorized = useCallback(() => setAuthExpired(true), []);
  const dismissAuthExpired = useCallback(() => setAuthExpired(false), []);
  const client = useMemo(
    () => buildClient(settings.apiKey, settings.baseUrl, activeWorkspace, handleUnauthorized),
    [settings.apiKey, settings.baseUrl, activeWorkspace, handleUnauthorized],
  );
  // A changed key / base / workspace clears any prior expired state.
  useEffect(() => {
    setAuthExpired(false);
  }, [settings.apiKey, settings.baseUrl, activeWorkspace]);

  // V-239 — fetch the AccountSelfProfile whenever the client (apiKey/
  // baseUrl combo) changes. Failures (e.g. invalid key, server down)
  // leave accountMe null; views fall back to ungated UI in that case
  // rather than blocking the customer entirely.
  const [accountMe, setAccountMe] = useState<AccountSelfProfile | null>(null);

  // P2 #4 — clear accountMe the instant the account/deployment IDENTITY changes
  // (apiKey or baseUrl), BEFORE the new fetch resolves. Without this the Sidebar
  // showed the PREVIOUS account's email/tier/caps until (and if) the new fetch
  // landed — and the fail-closed catch in refreshAccountMe (audit wja3dfl5t) KEEPS
  // the last-known accountMe, so a failed new fetch (e.g. a bad key on the switched
  // deployment) pinned the old account's data indefinitely. Clearing on the identity
  // tuple makes it show "—"/ungated until the NEW account's fetch lands, while the
  // fail-closed catch still protects against a TRANSIENT blip for the SAME account
  // (this effect only fires when the tuple actually changes). Skips the initial
  // settings-load transition (prev ref null) so boot doesn't null a just-fetched me.
  const prevIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    const identity = `${settings.apiKey ?? ''} ${settings.baseUrl}`;
    if (prevIdentityRef.current !== null && prevIdentityRef.current !== identity) {
      setAccountMe(null);
    }
    prevIdentityRef.current = identity;
  }, [loading, settings.apiKey, settings.baseUrl]);

  // Track the latest client so a slow in-flight /account/me from a PREVIOUS
  // identity (apiKey/baseUrl switch A→B) can't resolve after B's and pin
  // account A's email/tier/caps in the shell — the same stale-render race the
  // clear-on-identity-change guard above defends against, but on the async
  // resolution side. (Siblings useConnectionStats/useLatencyPing guard with a
  // cancelled flag; this is the manual-call-safe equivalent.)
  const latestClientRef = useRef(client);
  useEffect(() => {
    latestClientRef.current = client;
  }, [client]);

  const refreshAccountMe = useCallback(async (): Promise<void> => {
    if (!client) {
      setAccountMe(null);
      return;
    }
    try {
      const raw = await client.account.me();
      if (client !== latestClientRef.current) return; // superseded by a newer identity
      // Normalize at the SOURCE: the SDK's account.me() does NO shape validation
      // (it casts the JSON), so a partial/legacy/malformed /v1/account/me that
      // omits `teams` would leave every consumer (Sidebar, App shell, the
      // reconciliation just below) to throw "Cannot read properties of undefined
      // (reading 'length'/'some')". Guarantee `teams` is always an array here so
      // one bad payload can't blank the whole window via a render outside the
      // per-view ErrorBoundary.
      const me = raw.teams === undefined ? { ...raw, teams: [] } : raw;
      setAccountMe(me);
      // Reconcile a persisted/active team workspace against the CURRENT account's
      // teams. If the active workspace owner id isn't one of this key's teams
      // (stale localStorage value, account swap, membership removed), drop to
      // personal scope so we don't keep sending a workspace header the account
      // can't satisfy (403 / empty results) instead of degrading cleanly.
      if (
        activeWorkspace !== null &&
        !me.teams.some((t) => t.owner_account_id === activeWorkspace)
      ) {
        setActiveWorkspace(null);
      }
    } catch {
      // Soft-fail, but FAIL CLOSED: KEEP the last-known accountMe rather than
      // nulling it. Views treat null as "cap unknown; don't gate", so nulling on a
      // transient blip (network/5xx/429 — e.g. right after a successful create's
      // refresh) silently evaporated the at-cap New-session gate and the customer
      // hit the raw 402 the gate exists to prevent (audit wja3dfl5t). The cap stays
      // enforced on the last-known figures; a real key change replaces it on the
      // next successful fetch (and a missing client nulls it above). The underlying
      // error still surfaces when the user takes an action the server rejects.
    }
  }, [client, activeWorkspace, setActiveWorkspace]);

  useEffect(() => {
    void refreshAccountMe();
  }, [refreshAccountMe]);

  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      loading,
      client,
      activeWorkspace,
      setActiveWorkspace,
      accountMe,
      refreshAccountMe,
      authExpired,
      dismissAuthExpired,
      update,
    }),
    [
      settings,
      loading,
      client,
      activeWorkspace,
      setActiveWorkspace,
      accountMe,
      refreshAccountMe,
      authExpired,
      dismissAuthExpired,
      update,
    ],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>');
  return ctx;
}
