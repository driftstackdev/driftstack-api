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
  /** V-239 — current account's tier + caps + usage. Null while loading or unauthenticated. */
  accountMe: AccountSelfProfile | null;
  /** V-239 — manually trigger a re-fetch (e.g. after a create/destroy). */
  refreshAccountMe: () => Promise<void>;
  /** Update settings + persist. Returns once the on-disk write resolves. */
  update: (next: Partial<DriftstackSettings>) => Promise<void>;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [settings, setSettings] = useState<DriftstackSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((s) => {
      if (!cancelled) {
        setSettings(s);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const client = useMemo(
    () => buildClient(settings.apiKey, settings.baseUrl),
    [settings.apiKey, settings.baseUrl],
  );

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
    () => ({ settings, loading, client, accountMe, refreshAccountMe, update }),
    [settings, loading, client, accountMe, refreshAccountMe, update],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>');
  return ctx;
}
