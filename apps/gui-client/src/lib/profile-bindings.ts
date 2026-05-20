// 2026-05-20 — local-only mapping of profile → most-recent-session +
// default-proxy. The server's profiles + sessions schemas are
// decoupled (sessions don't carry a profile_id column at the control
// plane); the antidetect-browser UX paradigm needs a per-profile
// "launch / stop / status" so this lib supplies the GUI-side glue.

import { LazyStore } from '@tauri-apps/plugin-store';

export interface ProfileBinding {
  /** Driftstack profile UUID. */
  profileId: string;
  /** Default SOCKS5 proxy id (from lib/proxies) to use on Launch. */
  defaultProxyId: string | null;
  /** Most-recent session id minted by Launch. null = never launched. */
  currentSessionId: string | null;
  /** ISO8601 timestamp of the most-recent Launch. null = never. */
  lastLaunchedAt: string | null;
}

const STORE_FILE = 'settings.json';
const KEY = 'profile_bindings';

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (store === null) store = new LazyStore(STORE_FILE);
  return store;
}

function isBinding(value: unknown): value is ProfileBinding {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.profileId === 'string' &&
    (v.defaultProxyId === null || typeof v.defaultProxyId === 'string') &&
    (v.currentSessionId === null || typeof v.currentSessionId === 'string') &&
    (v.lastLaunchedAt === null || typeof v.lastLaunchedAt === 'string')
  );
}

export async function listBindings(): Promise<ProfileBinding[]> {
  const raw = await getStore().get<unknown>(KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isBinding);
}

export async function getBinding(profileId: string): Promise<ProfileBinding | null> {
  const all = await listBindings();
  return all.find((b) => b.profileId === profileId) ?? null;
}

async function upsertBinding(b: ProfileBinding): Promise<void> {
  const all = await listBindings();
  const idx = all.findIndex((x) => x.profileId === b.profileId);
  const next = idx >= 0 ? all.map((x, i) => (i === idx ? b : x)) : [...all, b];
  await getStore().set(KEY, next);
  await getStore().save();
}

export async function setDefaultProxy(profileId: string, proxyId: string | null): Promise<void> {
  const existing = await getBinding(profileId);
  await upsertBinding({
    profileId,
    defaultProxyId: proxyId,
    currentSessionId: existing?.currentSessionId ?? null,
    lastLaunchedAt: existing?.lastLaunchedAt ?? null,
  });
}

export async function markLaunched(profileId: string, sessionId: string): Promise<void> {
  const existing = await getBinding(profileId);
  await upsertBinding({
    profileId,
    defaultProxyId: existing?.defaultProxyId ?? null,
    currentSessionId: sessionId,
    lastLaunchedAt: new Date().toISOString(),
  });
}

export async function clearSession(profileId: string): Promise<void> {
  const existing = await getBinding(profileId);
  if (existing === null) return;
  await upsertBinding({
    profileId,
    defaultProxyId: existing.defaultProxyId,
    currentSessionId: null,
    lastLaunchedAt: existing.lastLaunchedAt,
  });
}

export async function deleteBinding(profileId: string): Promise<void> {
  const all = await listBindings();
  await getStore().set(
    KEY,
    all.filter((b) => b.profileId !== profileId),
  );
  await getStore().save();
}
