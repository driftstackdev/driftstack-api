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

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
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
  /** Update settings + persist. Returns once the on-disk write resolves. */
  update: (next: Partial<DriftstackSettings>) => Promise<void>;
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
    async (next: Partial<DriftstackSettings>) => {
      const merged: DriftstackSettings = { ...settings, ...next };
      setSettings(merged);
      await saveSettings(merged);
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

  const refreshAccountMe = useCallback(async (): Promise<void> => {
    if (!client) {
      setAccountMe(null);
      return;
    }
    try {
      const me = await client.account.me();
      setAccountMe(me);
    } catch {
      // Soft-fail: leave accountMe null + don't surface the error here.
      // Views consuming accountMe should treat null as "cap unknown;
      // don't gate". The actual failure surfaces when the user attempts
      // an action that hits the cap (server returns 402).
      setAccountMe(null);
    }
  }, [client]);

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
