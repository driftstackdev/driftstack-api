// User-created folder names (2026-06-15, founder: "missing functionality to
// create new folders").
//
// Folders were previously DERIVED from profile metadata (a folder existed only
// if some profile lived in it — see profiles-meta.ts `folderList`). That meant
// you couldn't create an EMPTY folder up front and then move profiles into it.
// This persists user-created folder names independently so the folder rail can
// show empty folders the customer made. The effective folder list the UI shows
// is the UNION of these names + the names derived from profiles.
//
// Same store-isolation rationale as profiles-meta.ts / proxy-probe-cache.ts:
// its own store file, out of settings.json's drift-pinned blast radius.

import { LazyStore } from '@tauri-apps/plugin-store';
import { makeWriteLock } from './store-write-lock';

const STORE_FILE = 'folders.json';
const KEY = 'names';
const SCOPED_KEY_PREFIX = 'account-scope:';
// 2026-06-16 (founder: "attach an icon to a folder") — a SEPARATE map keyed by
// folder name → emoji, so the `names` array shape stays unchanged (old
// folders.json still loads) and an icon can attach to ANY folder name (custom
// or one derived from profiles).
const ICONS_KEY = 'icons';
// P2 #8 — match the server/per-profile binding cap (api-types ProfileFolderSchema
// max 32, profiles-meta MAX_FOLDER_CHARS 32). Was 60: a 33–60-char rail folder
// could never be assigned to a profile (server rejects + per-profile meta truncated
// it), so a profile under that folder vanished from its own filter. The whole stack
// (rail input, taxonomy store, per-profile meta, server) is now one cap.
const MAX_FOLDER_CHARS = 32;
const MAX_FOLDERS = 200;
const MAX_ICON_CHARS = 8;

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (store === null) store = new LazyStore(STORE_FILE);
  return store;
}

const writeLock = makeWriteLock();

export interface FolderTaxonomyCache {
  /** False means this identity has never owned a cache entry on this Mac. */
  exists: boolean;
  names: string[];
  icons: Record<string, string>;
}

function scopedKey(key: typeof KEY | typeof ICONS_KEY, scope: string): string {
  return `${SCOPED_KEY_PREFIX}${encodeURIComponent(scope)}:${key}`;
}

function cleanFolderNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const name = normalizeFolderName(v);
    if (name !== null && !out.includes(name)) out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function cleanFolderIcons(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = normalizeFolderName(k);
    if (name !== null && typeof v === 'string' && v.length > 0) {
      out[name] = v.slice(0, MAX_ICON_CHARS);
    }
  }
  return out;
}

/** Normalize a raw folder name: trim, collapse the unfiled sentinel, cap length.
 *  Returns null when the name is empty after trimming (not a real folder). */
export function normalizeFolderName(raw: string): string | null {
  const trimmed = raw.trim().slice(0, MAX_FOLDER_CHARS).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function loadFolders(scope: string): Promise<string[]> {
  try {
    return cleanFolderNames(await getStore().get<unknown>(scopedKey(KEY, scope)));
  } catch {
    return [];
  }
}

/** Folder-name → icon (emoji) map. Absent / unknown names just have no icon
 *  (the rail falls back to the deterministic folderGlyph). */
export async function loadFolderIcons(scope: string): Promise<Record<string, string>> {
  try {
    return cleanFolderIcons(await getStore().get<unknown>(scopedKey(ICONS_KEY, scope)));
  } catch {
    return {};
  }
}

/** Load one identity-bound offline snapshot without ever falling back to the
 * legacy global keys. `exists` lets the caller distinguish an intentionally
 * empty cache from unrelated/legacy data that must never seed this account. */
export async function loadFolderTaxonomyCache(scope: string): Promise<FolderTaxonomyCache> {
  try {
    const [rawNames, rawIcons] = await Promise.all([
      getStore().get<unknown>(scopedKey(KEY, scope)),
      getStore().get<unknown>(scopedKey(ICONS_KEY, scope)),
    ]);
    return {
      exists: rawNames !== undefined || rawIcons !== undefined,
      names: cleanFolderNames(rawNames),
      icons: cleanFolderIcons(rawIcons),
    };
  } catch {
    return { exists: false, names: [], icons: {} };
  }
}

/** Set (or clear, with '') the icon for a folder name. Returns the updated map. */
export function setFolderIcon(
  rawName: string,
  icon: string,
  scope: string,
): Promise<Record<string, string>> {
  return writeLock(async () => {
    const name = normalizeFolderName(rawName);
    if (name === null) return loadFolderIcons(scope);
    const icons = await loadFolderIcons(scope);
    const trimmed = icon.trim().slice(0, MAX_ICON_CHARS);
    if (trimmed.length === 0) delete icons[name];
    else icons[name] = trimmed;
    await getStore().set(scopedKey(ICONS_KEY, scope), icons);
    await getStore().save();
    return icons;
  });
}

/** Add a folder name (idempotent, deduped case-sensitively against the stored
 *  set), optionally with an icon. Returns the updated sorted list. A no-op for
 *  the names list when blank/already present, but still sets the icon if given. */
export function addFolder(rawName: string, scope: string, icon?: string): Promise<string[]> {
  return writeLock(async () => {
    const name = normalizeFolderName(rawName);
    if (name === null) return loadFolders(scope);
    const current = await loadFolders(scope);
    const alreadyPresent = current.includes(name);
    const atCap = current.length >= MAX_FOLDERS;
    // Only persist the icon if the folder will actually exist (already present, or about to be
    // added) — otherwise an at-cap add stores an orphan icon for a name that's never in the list.
    if (icon !== undefined && icon.trim().length > 0 && (alreadyPresent || !atCap)) {
      const icons = await loadFolderIcons(scope);
      icons[name] = icon.trim().slice(0, MAX_ICON_CHARS);
      await getStore().set(scopedKey(ICONS_KEY, scope), icons);
    }
    if (alreadyPresent || atCap) {
      await getStore().save();
      return current;
    }
    const next = [...current, name].sort((a, b) => a.localeCompare(b));
    await getStore().set(scopedKey(KEY, scope), next);
    await getStore().save();
    return next;
  });
}

/** org-sync (2026-06-16) — bulk-replace the local cache (names + icons) from
 *  the server's authoritative taxonomy. Server wins on a successful load; this
 *  keeps the offline cache aligned. */
export function replaceAllFolders(
  names: string[],
  icons: Record<string, string>,
  scope: string,
): Promise<void> {
  return writeLock(async () => {
    const cleanNames: string[] = [];
    for (const n of names) {
      const name = normalizeFolderName(n);
      if (name !== null && !cleanNames.includes(name) && cleanNames.length < MAX_FOLDERS) {
        cleanNames.push(name);
      }
    }
    const cleanIcons: Record<string, string> = {};
    for (const [k, v] of Object.entries(icons)) {
      const name = normalizeFolderName(k);
      if (name !== null && typeof v === 'string' && v.length > 0) {
        cleanIcons[name] = v.slice(0, MAX_ICON_CHARS);
      }
    }
    await getStore().set(
      scopedKey(KEY, scope),
      cleanNames.sort((a, b) => a.localeCompare(b)),
    );
    await getStore().set(scopedKey(ICONS_KEY, scope), cleanIcons);
    await getStore().save();
  });
}

/** Remove a user-created folder name from the persisted set. Profiles still
 *  carrying that folder keep deriving it (so it only disappears from the rail
 *  once it's both removed here AND empty of profiles). Also drops any icon
 *  attached to that name so a stale icon can't reattach if the name comes back. */
export function removeFolder(name: string, scope: string): Promise<string[]> {
  return writeLock(async () => {
    const current = await loadFolders(scope);
    const icons = await loadFolderIcons(scope);
    const hadName = current.includes(name);
    const hadIcon = icons[name] !== undefined;
    if (!hadName && !hadIcon) return current;
    if (hadIcon) {
      delete icons[name];
      await getStore().set(scopedKey(ICONS_KEY, scope), icons);
    }
    if (!hadName) {
      await getStore().save();
      return current;
    }
    const next = current.filter((f) => f !== name);
    await getStore().set(scopedKey(KEY, scope), next);
    await getStore().save();
    return next;
  });
}

/** Rename a user-created folder name in BOTH the names list and the icon map
 *  (re-keying any attached icon onto the new name). Returns the updated sorted
 *  list. A no-op when old/new normalize equal, the old name isn't present, or
 *  the new name is blank. Re-assigning the profiles that carry the old folder
 *  is the caller's job (the names list here is the empty-folder taxonomy). */
export function renameFolder(rawOld: string, rawNew: string, scope: string): Promise<string[]> {
  return writeLock(async () => {
    const oldName = normalizeFolderName(rawOld);
    const newName = normalizeFolderName(rawNew);
    const current = await loadFolders(scope);
    if (oldName === null || newName === null || oldName === newName) return current;
    // Re-key the icon if the old name carried one (only when not already taken).
    const icons = await loadFolderIcons(scope);
    if (icons[oldName] !== undefined) {
      if (icons[newName] === undefined) icons[newName] = icons[oldName];
      delete icons[oldName];
      await getStore().set(scopedKey(ICONS_KEY, scope), icons);
    }
    if (!current.includes(oldName)) {
      // Old name was profile-derived only (not in the persisted set). The icon
      // re-key above still applies; nothing to rename in the names list.
      await getStore().save();
      return current;
    }
    const withoutOld = current.filter((f) => f !== oldName);
    const next = (withoutOld.includes(newName) ? withoutOld : [...withoutOld, newName]).sort(
      (a, b) => a.localeCompare(b),
    );
    await getStore().set(scopedKey(KEY, scope), next);
    await getStore().save();
    return next;
  });
}
