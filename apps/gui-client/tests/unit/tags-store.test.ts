// tags-store — user-created tag names (founder 2026-06-16: "tags should be
// under [the folder rail] to create tags as well"). Mirrors folders-store.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = new Map<string, Map<string, unknown>>();
const TEST_SCOPE = 'https://api.example.test|account:acc_test';

vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private file: string;
    constructor(file: string) {
      this.file = file;
      if (!stores.has(file)) stores.set(file, new Map());
    }
    private map(): Map<string, unknown> {
      let m = stores.get(this.file);
      if (!m) {
        m = new Map();
        stores.set(this.file, m);
      }
      return m;
    }
    get(key: string): Promise<unknown> {
      return Promise.resolve(this.map().get(key));
    }
    set(key: string, value: unknown): Promise<void> {
      this.map().set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import {
  loadTags,
  addTag,
  removeTag,
  renameTag,
  normalizeTagName,
  loadTagTaxonomyCache,
  replaceAllTags,
} from '../../src/lib/tags-store';

beforeEach(() => {
  stores.clear();
});

describe('tags-store', () => {
  it('normalizeTagName trims, strips a leading #, drops blanks', () => {
    expect(normalizeTagName('  #aged  ')).toBe('aged');
    expect(normalizeTagName('vip')).toBe('vip');
    expect(normalizeTagName('  #  ')).toBeNull();
    expect(normalizeTagName('')).toBeNull();
  });

  // P2 #8 — the tag-name cap must match the server/per-profile binding cap (24).
  // A longer rail tag could never be applied to a profile (server rejects + the
  // per-profile meta truncated it), so the profile vanished from its own tag filter.
  it('caps a tag name at 24 chars (matches the server/per-profile binding cap)', () => {
    expect(normalizeTagName('a'.repeat(24))).toBe('a'.repeat(24));
    expect(normalizeTagName('a'.repeat(40))).toBe('a'.repeat(24));
    expect(normalizeTagName('a'.repeat(25))?.length).toBe(24);
  });

  it('addTag persists, sorts, and round-trips through load', async () => {
    await addTag('shopping', TEST_SCOPE);
    const list = await addTag('aged', TEST_SCOPE);
    expect(list).toEqual(['aged', 'shopping']); // sorted
    expect(await loadTags(TEST_SCOPE)).toEqual(['aged', 'shopping']);
  });

  it('addTag is idempotent + strips # (no dupes from #-prefixed variants)', async () => {
    await addTag('aged', TEST_SCOPE);
    const list = await addTag('#aged', TEST_SCOPE);
    expect(list).toEqual(['aged']);
  });

  it('addTag ignores a blank name', async () => {
    expect(await addTag('   ', TEST_SCOPE)).toEqual([]);
  });

  it('removeTag drops a name; missing name is a no-op', async () => {
    await addTag('aged', TEST_SCOPE);
    await addTag('vip', TEST_SCOPE);
    expect(await removeTag('aged', TEST_SCOPE)).toEqual(['vip']);
    expect(await removeTag('nope', TEST_SCOPE)).toEqual(['vip']);
  });

  it('renameTag re-keys the name; sorts; no-ops on blank/equal/missing', async () => {
    await addTag('aged', TEST_SCOPE);
    await addTag('vip', TEST_SCOPE);
    expect(await renameTag('aged', 'warmup', TEST_SCOPE)).toEqual(['vip', 'warmup']);
    // No-ops: equal-after-normalize (# stripped), blank new, missing old.
    expect(await renameTag('warmup', '#warmup', TEST_SCOPE)).toEqual(['vip', 'warmup']);
    expect(await renameTag('warmup', '   ', TEST_SCOPE)).toEqual(['vip', 'warmup']);
    expect(await renameTag('ghost', 'x', TEST_SCOPE)).toEqual(['vip', 'warmup']);
  });

  it('loadTags degrades to [] on a corrupt (non-array) value', async () => {
    stores.set(
      'tags.json',
      new Map([[`account-scope:${encodeURIComponent(TEST_SCOPE)}:names`, 'not-an-array']]),
    );
    expect(await loadTags(TEST_SCOPE)).toEqual([]);
  });

  it('isolates names by non-secret effective-account scope', async () => {
    const personal = 'https://api.driftstack.dev|account:acc_personal';
    const team = 'https://api.driftstack.dev|account:acc_team';
    await addTag('personal', personal);
    await addTag('team', team);

    expect(await loadTags(personal)).toEqual(['personal']);
    expect(await loadTags(team)).toEqual(['team']);
  });

  it('never claims a legacy global tag list for a scoped account cache', async () => {
    stores.set('tags.json', new Map([['names', ['legacy']]]));
    const team = 'https://api.driftstack.dev|account:acc_team';

    expect(await loadTagTaxonomyCache(team)).toEqual({ exists: false, names: [] });
    expect(await loadTags(team)).toEqual([]);

    await replaceAllTags([], team);
    expect(await loadTagTaxonomyCache(team)).toEqual({ exists: true, names: [] });
    expect(stores.get('tags.json')?.get('names')).toEqual(['legacy']);
  });
});
