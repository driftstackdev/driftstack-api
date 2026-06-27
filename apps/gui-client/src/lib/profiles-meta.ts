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
import { makeWriteLock } from './store-write-lock';

export interface ProfileMeta {
  /** Folder name (single — the demo's model); empty string = unfiled. */
  folder: string;
  /** Free-form tags, deduped + trimmed on save. */
  tags: string[];
  /** Optional free-text note shown in the hub. */
  note: string;
  /** Optional chosen icon (a short emoji); empty string = use the monogram. */
  icon: string;
}

export type ProfilesMetaMap = Record<string, ProfileMeta>;

const STORE_FILE = 'profiles-meta.json';
const META_KEY = 'profiles';
const MAX_TAGS = 12;
// P2 #8 — these match the SERVER's binding caps (api-types ProfileFolderSchema
// max 32, ProfileTagSchema max 24), which are the source of truth for what a
// profile's folder/tag can actually be. The TAXONOMY stores (folders-store /
// tags-store) are reconciled DOWN to the same caps so a name a user creates in the
// rail can actually be applied to a profile — a longer name was truncated here +
// rejected server-side, so the profile's folder/tag stopped string-equalling the
// canonical name and vanished from its own filter.
const MAX_TAG_CHARS = 24;
const MAX_FOLDER_CHARS = 32;
const MAX_NOTE_CHARS = 280;
const MAX_ICON_CHARS = 8; // a single emoji (may be multi-codepoint)

let store: LazyStore | null = null;

// Serialize read-modify-write mutations (bulk folder/tag/icon ops can fire
// concurrently from the bulk bar) so they don't clobber each other.
const writeLock = makeWriteLock();

function getStore(): LazyStore {
  if (store === null) {
    store = new LazyStore(STORE_FILE);
  }
  return store;
}

/** Validate one persisted entry; anything malformed degrades to defaults. */
function cleanEntry(raw: unknown): ProfileMeta {
  const out: ProfileMeta = { folder: '', tags: [], note: '', icon: '' };
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
  if (typeof r.icon === 'string') out.icon = r.icon.slice(0, MAX_ICON_CHARS);
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

export function saveProfileMeta(
  profileId: string,
  meta: Partial<ProfileMeta>,
  /** When provided, entries for ids NOT in this list are pruned. */
  liveProfileIds?: string[],
): Promise<ProfilesMetaMap> {
  return writeLock(async () => {
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
  });
}

/** Bulk variant: apply the same partial to MANY profiles in one load/save
 *  round-trip (the bulk-select bar's move-to-folder / add-tag actions).
 *  `mode` controls tag semantics: 'merge' unions `meta.tags` into each
 *  profile's existing set; 'replace' overwrites fields verbatim (folder always
 *  overwrites — a profile lives in one folder); 'remove' SUBTRACTS `meta.tags`
 *  from each profile's existing set (the bulk "Remove tag" action) and leaves
 *  the non-tag fields of `meta` (e.g. folder) applied as a verbatim overwrite. */
export function saveProfilesMetaBulk(
  profileIds: string[],
  meta: Partial<ProfileMeta>,
  mode: 'merge' | 'replace' | 'remove' = 'merge',
  liveProfileIds?: string[],
): Promise<ProfilesMetaMap> {
  return writeLock(async () => {
    const all = await loadProfilesMeta();
    const removeSet =
      mode === 'remove' && meta.tags ? new Set(meta.tags.map((t) => t.trim())) : null;
    for (const id of profileIds) {
      if (id.length === 0) continue;
      const current = all[id] ?? { folder: '', tags: [], note: '', icon: '' };
      let nextTags: string[];
      if (mode === 'merge' && meta.tags) {
        nextTags = [...current.tags, ...meta.tags];
      } else if (removeSet !== null) {
        nextTags = current.tags.filter((t) => !removeSet.has(t.trim()));
      } else {
        nextTags = meta.tags ?? current.tags;
      }
      // In 'remove' mode `meta.tags` is the subtraction set, NOT a verbatim
      // overwrite — strip it from the spread so only the recomputed set lands.
      const { tags: _ignoredTags, ...metaRest } = meta;
      all[id] = cleanEntry({
        ...current,
        ...(removeSet !== null ? metaRest : meta),
        tags: nextTags,
      });
    }
    if (liveProfileIds) {
      const live = new Set(liveProfileIds);
      for (const id of Object.keys(all)) {
        if (!live.has(id)) delete all[id];
      }
    }
    await getStore().set(META_KEY, all);
    await getStore().save();
    return all;
  });
}

// ── Server sync (organization metadata Phase 2, 2026-06-12) ────────────────
// The backend now stores folder/tags on the profile row (migration 0076).
// Sync model v1, deliberately conservative:
//   • The LOCAL store stays what the hub UI reads (instant, offline-safe).
//   • Writes WRITE THROUGH to the API best-effort (ProfilesView does the
//     PATCH; a pre-0076 server strips the unknown fields harmlessly).
//   • Reads SEED DOWN: a profile with server-side organization but NO local
//     entry gets its local entry seeded from the server (covers "organized
//     on another device"). When BOTH exist and differ, local wins — the
//     next local edit write-through reconciles. `note` stays local-only
//     (no backend column; description is the server-side analogue).

/** The slice of a server Profile response this store cares about. The
 *  fields are typed required in api-types but a pre-0076 server omits
 *  them — hence the optional/undefined handling. */
export interface ServerProfileOrg {
  id: string;
  folder?: string | null;
  tags?: string[];
  /** UI metadata synced per-account (2026-06-16). */
  icon?: string | null;
  note?: string | null;
}

/**
 * Seed local entries from server organization for profiles that have no
 * local entry yet. Pure on the map (returns a new map + whether anything
 * changed); the caller persists via `persistProfilesMeta` only when
 * `changed` — avoids a store write on every refresh.
 */
export function seedMetaFromServer(
  local: ProfilesMetaMap,
  serverProfiles: ServerProfileOrg[],
): { map: ProfilesMetaMap; changed: boolean } {
  let changed = false;
  const map = { ...local };
  for (const p of serverProfiles) {
    if (p.id.length === 0 || map[p.id] !== undefined) continue;
    const folder = typeof p.folder === 'string' ? p.folder : '';
    const tags = Array.isArray(p.tags) ? p.tags : [];
    const icon = typeof p.icon === 'string' ? p.icon : '';
    const note = typeof p.note === 'string' ? p.note : '';
    if (folder.length === 0 && tags.length === 0 && icon.length === 0 && note.length === 0) {
      continue; // nothing to seed
    }
    map[p.id] = cleanEntry({ folder, tags, icon, note });
    changed = true;
  }
  return { map, changed };
}

/** Persist a full map (the seed path). Same prune-by-live-ids semantics
 *  as the save helpers. */
export function persistProfilesMeta(
  map: ProfilesMetaMap,
  liveProfileIds?: string[],
): Promise<void> {
  return writeLock(async () => {
    const all = { ...map };
    if (liveProfileIds) {
      const live = new Set(liveProfileIds);
      for (const id of Object.keys(all)) {
        if (!live.has(id)) delete all[id];
      }
    }
    await getStore().set(META_KEY, all);
    await getStore().save();
  });
}

/** Distinct folder names across the map, sorted, excluding unfiled. */
export function folderList(meta: ProfilesMetaMap): string[] {
  const set = new Set<string>();
  for (const m of Object.values(meta)) {
    if (m.folder.length > 0) set.add(m.folder);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Distinct tags across the map with per-tag counts, ordered by count desc
 *  then name. Powers the tag filter rail (G3). Empty tags are skipped. */
export function aggregateTags(meta: ProfilesMetaMap): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const m of Object.values(meta)) {
    for (const t of m.tags) {
      if (t.length === 0) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
