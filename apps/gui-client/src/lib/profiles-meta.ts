// Profiles meta — client-side organization for the profiles hub
// (Fleet demo-concepts arc, 2026-06-12: folders + tags + notes, UI-first).
//
// DESIGN: a separate store file (`profiles-meta.json`) rather than
// settings.json — (a) settings.ts is heavily drift-pinned and owns the
// key/keychain lifecycle; org metadata has no business in that blast
// radius, (b) when the backend grows folders/tags columns this file
// becomes the one-shot migration source and then retires.
//
// Shape: a map keyed by profile id. Unknown ids are tolerated (a profile
// deleted server-side just leaves an orphan entry; `prune` clears them on
// the next save with a live id list). All reads are validated — a hand-
// edited or corrupt file degrades to empty meta, never a crash.

import { LazyStore } from '@tauri-apps/plugin-store';

export interface ProfileMeta {
  /** Folder name (single — the demo's model); empty string = unfiled. */
  folder: string;
  /** Free-form tags, deduped + trimmed on save. */
  tags: string[];
  /** Optional free-text note shown in the hub. */
  note: string;
}

export type ProfilesMetaMap = Record<string, ProfileMeta>;

const STORE_FILE = 'profiles-meta.json';
const META_KEY = 'profiles';
const MAX_TAGS = 12;
const MAX_TAG_CHARS = 24;
const MAX_FOLDER_CHARS = 32;
const MAX_NOTE_CHARS = 280;

let store: LazyStore | null = null;

function getStore(): LazyStore {
  if (store === null) {
    store = new LazyStore(STORE_FILE);
  }
  return store;
}

/** Validate one persisted entry; anything malformed degrades to defaults. */
function cleanEntry(raw: unknown): ProfileMeta {
  const out: ProfileMeta = { folder: '', tags: [], note: '' };
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.folder === 'string') out.folder = r.folder.slice(0, MAX_FOLDER_CHARS);
  if (Array.isArray(r.tags)) {
    const seen = new Set<string>();
    for (const t of r.tags) {
      if (typeof t !== 'string') continue;
      const tag = t.trim().slice(0, MAX_TAG_CHARS);
      if (tag.length === 0 || seen.has(tag)) continue;
      seen.add(tag);
      if (seen.size >= MAX_TAGS) break;
    }
    out.tags = [...seen];
  }
  if (typeof r.note === 'string') out.note = r.note.slice(0, MAX_NOTE_CHARS);
  return out;
}

export async function loadProfilesMeta(): Promise<ProfilesMetaMap> {
  try {
    const raw = await getStore().get<Record<string, unknown>>(META_KEY);
    if (typeof raw !== 'object' || raw === null) return {};
    const out: ProfilesMetaMap = {};
    for (const [id, entry] of Object.entries(raw)) {
      if (typeof id === 'string' && id.length > 0) out[id] = cleanEntry(entry);
    }
    return out;
  } catch {
    // Corrupt store / IO failure — organization is a convenience layer;
    // degrade to "no meta" rather than blocking the hub.
    return {};
  }
}

export async function saveProfileMeta(
  profileId: string,
  meta: Partial<ProfileMeta>,
  /** When provided, entries for ids NOT in this list are pruned. */
  liveProfileIds?: string[],
): Promise<ProfilesMetaMap> {
  const all = await loadProfilesMeta();
  const merged = cleanEntry({ ...all[profileId], ...meta });
  all[profileId] = merged;
  if (liveProfileIds) {
    const live = new Set(liveProfileIds);
    for (const id of Object.keys(all)) {
      if (!live.has(id)) delete all[id];
    }
  }
  await getStore().set(META_KEY, all);
  await getStore().save();
  return all;
}

/** Distinct folder names across the map, sorted, excluding unfiled. */
export function folderList(meta: ProfilesMetaMap): string[] {
  const set = new Set<string>();
  for (const m of Object.values(meta)) {
    if (m.folder.length > 0) set.add(m.folder);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
