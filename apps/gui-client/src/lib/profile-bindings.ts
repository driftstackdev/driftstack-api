// 2026-05-20 — local-only mapping of profile → most-recent-session +
// default-proxy. The server's profiles + sessions schemas are
// decoupled (sessions don't carry a profile_id column at the control
// plane); the antidetect-browser UX paradigm needs a per-profile
// "launch / stop / status" so this lib supplies the GUI-side glue.

import { LazyStore } from '@tauri-apps/plugin-store';
import { makeWriteLock } from './store-write-lock';

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

// Serialize the read-modify-write mutations (adversarial review w410wv3eq #6 —
// every other shared store already locks). Without this, two concurrent mutations
// (e.g. markLaunched racing setDefaultProxy) both read the old list and the second
// save clobbers the first's change. The PUBLIC mutations take the lock around their
// full get→upsert; the private upsertBinding stays lock-free (only called inside a
// locked section — a nested lock would deadlock). Reads (list/getBinding) are
// lock-free.
const writeLock = makeWriteLock();

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
  return writeLock(async () => {
    const existing = await getBinding(profileId);
    await upsertBinding({
      profileId,
      defaultProxyId: proxyId,
      currentSessionId: existing?.currentSessionId ?? null,
      lastLaunchedAt: existing?.lastLaunchedAt ?? null,
    });
  });
}

export async function markLaunched(profileId: string, sessionId: string): Promise<void> {
  return writeLock(async () => {
    const existing = await getBinding(profileId);
    await upsertBinding({
      profileId,
      defaultProxyId: existing?.defaultProxyId ?? null,
      currentSessionId: sessionId,
      lastLaunchedAt: new Date().toISOString(),
    });
  });
}

export async function clearSession(profileId: string): Promise<void> {
  return writeLock(async () => {
    const existing = await getBinding(profileId);
    if (existing === null) return;
    await upsertBinding({
      profileId,
      defaultProxyId: existing.defaultProxyId,
      currentSessionId: null,
      lastLaunchedAt: existing.lastLaunchedAt,
    });
  });
}

export async function deleteBinding(profileId: string): Promise<void> {
  return writeLock(async () => {
    const all = await listBindings();
    await getStore().set(
      KEY,
      all.filter((b) => b.profileId !== profileId),
    );
    await getStore().save();
  });
}

/**
 * The profiles whose DEFAULT proxy is `proxyId`. A READ — it writes nothing,
 * and the proxy-delete path depends on that.
 *
 * ⛔ 2026-09-12 (owner, P1) — READ THIS BEFORE "CLEANING UP" A DANGLING BINDING.
 * This was `clearBindingsForProxy`, which set `defaultProxyId = null` on every
 * binding naming the deleted proxy. A null default is NOT "no proxy": every
 * resolver reads it as "this profile never chose one" and falls back to the
 * FIRST saved proxy —
 *   • `ProfilesView.pickProxy`            → `return proxies[0] ?? null`
 *   • `AgentChatView.pickProxyFor`        → `return proxies[0] ?? null`
 *   • `session-h3-observation.attributeSessionProxy` → `proxies[0]?.id ?? null`
 * So deleting proxy B re-pointed B's profiles at proxy A, and the next session
 * left from a country the customer never chose. Reported verbatim: "when a proxy
 * is removed, and it still has existing profiles on that proxy, currently it
 * switches to another proxy which is available, i think it would be better, if
 * proxy was simply removed".
 *
 * So the binding KEEPS naming the deleted proxy, and that IS the app's
 * "no proxy configured" state for a profile that once had one: all three
 * resolvers already treat an EXPLICIT default whose proxy is gone as nothing
 * (never `proxies[0]`), the profile card renders its no-proxy state
 * (`hasProxy={px !== null}`), and the launch path refuses with "This profile's
 * configured proxy was deleted" rather than rerouting the egress. Nulling these
 * bindings re-opens the privacy hazard; pointing them at another proxy is the
 * defect itself. If a future cleanup really needs the dangling id gone, it must
 * first give the resolvers a way to tell "detached" from "never chose".
 */
export async function profilesUsingProxy(proxyId: string): Promise<string[]> {
  const all = await listBindings();
  return all.filter((b) => b.defaultProxyId === proxyId).map((b) => b.profileId);
}
