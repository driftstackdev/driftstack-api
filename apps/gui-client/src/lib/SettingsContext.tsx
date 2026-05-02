// Settings context — single source of truth for the API key + base
// URL across the React tree. Wraps the load/save persistence in
// settings.ts and exposes a memoised SDK client.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { buildClient, type DriftstackClient } from './client';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type DriftstackSettings } from './settings';

interface SettingsContextValue {
  settings: DriftstackSettings;
  loading: boolean;
  client: DriftstackClient | null;
  /** Update settings + persist. Returns once the on-disk write resolves. */
  update: (next: Partial<DriftstackSettings>) => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

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

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, loading, client, update }),
    [settings, loading, client, update],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>');
  return ctx;
}
