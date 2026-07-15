// User-created tag names (2026-06-16, founder: "tags should be under [the
// folder rail] to create tags as well").
//
// Tags were previously DERIVED from profile metadata (a tag existed only if
// some profile carried it — see profiles-meta.ts `aggregateTags`). That meant
// you couldn't create a tag up front to organize toward. This persists
// user-created tag names independently so the tag rail can show tags the
// customer made before any profile uses them. The effective tag list the UI
// shows is the UNION of these names + the names derived from profiles.
//
// Mirrors folders-store.ts (names-only — tags don't carry icons). Same
// store-isolation rationale: its own store file, out of settings.json's
// drift-pinned blast radius.

import { LazyStore } from '@tauri-apps/plugin-store';
import { makeWriteLock } from './store-write-lock';

const STORE_FILE = 'tags.json';
const KEY = 'names';
const SCOPED_KEY_PREFIX = 'account-scope:';
// P2 #8 — match the server/per-profile binding cap (api-types ProfileTagSchema
// max 24, profiles-meta MAX_TAG_CHARS 24). Was 40: a 25–40-char rail tag could
// never be applied to a profile (server rejects + per-profile meta truncated it),
// so a profile with that tag vanished from its own filter.
const MAX_TAG_CHARS = 24;
const MAX_TAGS = 300;

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (store === null) store = new LazyStore(STORE_FILE);
  return store;
}

const writeLock = makeWriteLock();

export interface TagTaxonomyCache {
  /** False means this identity has never owned a cache entry on this Mac. */
  exists: boolean;
  names: string[];
}

function scopedKey(scope: string): string {
  return `${SCOPED_KEY_PREFIX}${encodeURIComponent(scope)}:${KEY}`;
}

function cleanTagNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const name = normalizeTagName(v);
    if (name !== null && !out.includes(name)) out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** Normalize a raw tag name: trim, strip a leading '#', cap length. Returns
 *  null when empty after trimming (not a real tag). */
export function normalizeTagName(raw: string): string | null {
  const trimmed = raw.trim().replace(/^#+/, '').trim().slice(0, MAX_TAG_CHARS).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function loadTags(scope: string): Promise<string[]> {
  try {
    return cleanTagNames(await getStore().get<unknown>(scopedKey(scope)));
  } catch {
    return [];
  }
}

/** Load one identity-bound offline snapshot without ever falling back to the
 * legacy global key. See the folder-store sibling for the seed rationale. */
export async function loadTagTaxonomyCache(scope: string): Promise<TagTaxonomyCache> {
  try {
    const raw = await getStore().get<unknown>(scopedKey(scope));
    return { exists: raw !== undefined, names: cleanTagNames(raw) };
  } catch {
    return { exists: false, names: [] };
  }
}

/** Add a tag name (idempotent, deduped). Returns the updated sorted list. A
 *  no-op when blank or already present. */
export function addTag(rawName: string, scope: string): Promise<string[]> {
  return writeLock(async () => {
    const name = normalizeTagName(rawName);
    const current = await loadTags(scope);
    if (name === null || current.includes(name) || current.length >= MAX_TAGS) {
      return current;
    }
    const next = [...current, name].sort((a, b) => a.localeCompare(b));
    await getStore().set(scopedKey(scope), next);
    await getStore().save();
    return next;
  });
}

/** org-sync (2026-06-16) — bulk-replace the local tag cache from the server's
 *  authoritative taxonomy. Server wins on a successful load. */
export function replaceAllTags(names: string[], scope: string): Promise<void> {
  return writeLock(async () => {
    const clean: string[] = [];
    for (const n of names) {
      const name = normalizeTagName(n);
      if (name !== null && !clean.includes(name) && clean.length < MAX_TAGS) clean.push(name);
    }
    await getStore().set(
      scopedKey(scope),
      clean.sort((a, b) => a.localeCompare(b)),
    );
    await getStore().save();
  });
}

/** Remove a user-created tag name. Profiles still carrying it keep deriving it
 *  (so it only disappears from the rail once removed here AND unused). */
export function removeTag(name: string, scope: string): Promise<string[]> {
  return writeLock(async () => {
    const current = await loadTags(scope);
    if (!current.includes(name)) return current;
    const next = current.filter((t) => t !== name);
    await getStore().set(scopedKey(scope), next);
    await getStore().save();
    return next;
  });
}

/** Rename a user-created tag name in the persisted set. Returns the updated
 *  sorted list. A no-op when old/new normalize equal, the old name isn't
 *  present, or the new name is blank. Re-tagging the profiles that carry the
 *  old tag is the caller's job (this list is the empty-tag taxonomy). */
export function renameTag(rawOld: string, rawNew: string, scope: string): Promise<string[]> {
  return writeLock(async () => {
    const oldName = normalizeTagName(rawOld);
    const newName = normalizeTagName(rawNew);
    const current = await loadTags(scope);
    if (oldName === null || newName === null || oldName === newName) return current;
    if (!current.includes(oldName)) return current;
    const withoutOld = current.filter((t) => t !== oldName);
    const next = (withoutOld.includes(newName) ? withoutOld : [...withoutOld, newName]).sort(
      (a, b) => a.localeCompare(b),
    );
    await getStore().set(scopedKey(scope), next);
    await getStore().save();
    return next;
  });
}
