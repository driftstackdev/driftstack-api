// Settings persistence backed by tauri-plugin-store.
//
// The store writes to the OS-appropriate config dir (e.g.
// ~/Library/Application Support/dev.driftstack.gui/settings.json on
// macOS), so the API key isn't sitting in browser localStorage where
// any user with devtools access could pluck it. This is the right
// posture for a self-hosted desktop app; the `keyring` upgrade for
// genuinely secure key storage is queued for GUI8 polish or beyond.

import { LazyStore } from '@tauri-apps/plugin-store';

export interface DriftstackSettings {
  apiKey: string | null;
  baseUrl: string;
}

export const DEFAULT_SETTINGS: DriftstackSettings = {
  apiKey: null,
  baseUrl: 'http://localhost:7780',
};

const STORE_FILE = 'settings.json';
const SETTINGS_KEY = 'driftstack';

let store: LazyStore | null = null;

function getStore(): LazyStore {
  if (store === null) {
    store = new LazyStore(STORE_FILE);
  }
  return store;
}

export async function loadSettings(): Promise<DriftstackSettings> {
  const value = await getStore().get<DriftstackSettings>(SETTINGS_KEY);
  if (!value) return DEFAULT_SETTINGS;
  return {
    apiKey: typeof value.apiKey === 'string' && value.apiKey.length > 0 ? value.apiKey : null,
    baseUrl:
      typeof value.baseUrl === 'string' && value.baseUrl.length > 0
        ? value.baseUrl
        : DEFAULT_SETTINGS.baseUrl,
  };
}

export async function saveSettings(s: DriftstackSettings): Promise<void> {
  await getStore().set(SETTINGS_KEY, s);
  await getStore().save();
}
