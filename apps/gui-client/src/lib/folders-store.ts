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
const MAX_FOLDER_CHARS = 60;
const MAX_FOLDERS = 200;

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

/** Add a folder name (idempotent, deduped case-sensitively against the stored
 *  set). Returns the updated sorted list. A no-op (returns current) when the
 *  name is blank or already present. */
export function addFolder(rawName: string): Promise<string[]> {
  return writeLock(async () => {
    const name = normalizeFolderName(rawName);
    const current = await loadFolders();
    if (name === null || current.includes(name) || current.length >= MAX_FOLDERS) {
      return current;
    }
    const next = [...current, name].sort((a, b) => a.localeCompare(b));
    await getStore().set(KEY, next);
    await getStore().save();
    return next;
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
