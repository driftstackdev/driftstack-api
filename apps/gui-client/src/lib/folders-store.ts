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
// 2026-06-16 (founder: "attach an icon to a folder") — a SEPARATE map keyed by
// folder name → emoji, so the `names` array shape stays unchanged (old
// folders.json still loads) and an icon can attach to ANY folder name (custom
// or one derived from profiles).
const ICONS_KEY = 'icons';
const MAX_FOLDER_CHARS = 60;
const MAX_FOLDERS = 200;
const MAX_ICON_CHARS = 8;

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (store === null) store = new LazyStore(STORE_FILE);
  return store;
}

const writeLock = makeWriteLock();

/** Normalize a raw folder name: trim, collapse the unfiled sentinel, cap length.
 *  Returns null when the name is empty after trimming (not a real folder). */
export function normalizeFolderName(raw: string): string | null {
  const trimmed = raw.trim().slice(0, MAX_FOLDER_CHARS).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function loadFolders(): Promise<string[]> {
  try {
    const raw = await getStore().get<unknown>(KEY);
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const v of raw) {
      if (typeof v !== 'string') continue;
      const name = normalizeFolderName(v);
      if (name !== null && !out.includes(name)) out.push(name);
    }
    return out.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Folder-name → icon (emoji) map. Absent / unknown names just have no icon
 *  (the rail falls back to the deterministic folderGlyph). */
export async function loadFolderIcons(): Promise<Record<string, string>> {
  try {
    const raw = await getStore().get<unknown>(ICONS_KEY);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const name = normalizeFolderName(k);
      if (name !== null && typeof v === 'string' && v.length > 0) {
        out[name] = v.slice(0, MAX_ICON_CHARS);
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Set (or clear, with '') the icon for a folder name. Returns the updated map. */
export function setFolderIcon(rawName: string, icon: string): Promise<Record<string, string>> {
  return writeLock(async () => {
    const name = normalizeFolderName(rawName);
    if (name === null) return loadFolderIcons();
    const icons = await loadFolderIcons();
    const trimmed = icon.trim().slice(0, MAX_ICON_CHARS);
    if (trimmed.length === 0) delete icons[name];
    else icons[name] = trimmed;
    await getStore().set(ICONS_KEY, icons);
    await getStore().save();
    return icons;
  });
}

/** Add a folder name (idempotent, deduped case-sensitively against the stored
 *  set), optionally with an icon. Returns the updated sorted list. A no-op for
 *  the names list when blank/already present, but still sets the icon if given. */
export function addFolder(rawName: string, icon?: string): Promise<string[]> {
  return writeLock(async () => {
    const name = normalizeFolderName(rawName);
    if (name === null) return loadFolders();
    if (icon !== undefined && icon.trim().length > 0) {
      const icons = await loadFolderIcons();
      icons[name] = icon.trim().slice(0, MAX_ICON_CHARS);
      await getStore().set(ICONS_KEY, icons);
    }
    const current = await loadFolders();
    if (current.includes(name) || current.length >= MAX_FOLDERS) {
      await getStore().save();
      return current;
    }
    const next = [...current, name].sort((a, b) => a.localeCompare(b));
    await getStore().set(KEY, next);
    await getStore().save();
    return next;
  });
}

/** org-sync (2026-06-16) — bulk-replace the local cache (names + icons) from
 *  the server's authoritative taxonomy. Server wins on a successful load; this
 *  keeps the offline cache aligned. */
export function replaceAllFolders(names: string[], icons: Record<string, string>): Promise<void> {
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
      KEY,
      cleanNames.sort((a, b) => a.localeCompare(b)),
    );
    await getStore().set(ICONS_KEY, cleanIcons);
    await getStore().save();
  });
}

/** Remove a user-created folder name from the persisted set. Profiles still
 *  carrying that folder keep deriving it (so it only disappears from the rail
 *  once it's both removed here AND empty of profiles). */
export function removeFolder(name: string): Promise<string[]> {
  return writeLock(async () => {
    const current = await loadFolders();
    if (!current.includes(name)) return current;
    const next = current.filter((f) => f !== name);
    await getStore().set(KEY, next);
    await getStore().save();
    return next;
  });
}
