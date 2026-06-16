// tags-store — user-created tag names (founder 2026-06-16: "tags should be
// under [the folder rail] to create tags as well"). Mirrors folders-store.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = new Map<string, Map<string, unknown>>();

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

import { loadTags, addTag, removeTag, normalizeTagName } from '../../src/lib/tags-store';

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

  it('addTag persists, sorts, and round-trips through load', async () => {
    await addTag('shopping');
    const list = await addTag('aged');
    expect(list).toEqual(['aged', 'shopping']); // sorted
    expect(await loadTags()).toEqual(['aged', 'shopping']);
  });

  it('addTag is idempotent + strips # (no dupes from #-prefixed variants)', async () => {
    await addTag('aged');
    const list = await addTag('#aged');
    expect(list).toEqual(['aged']);
  });

  it('addTag ignores a blank name', async () => {
    expect(await addTag('   ')).toEqual([]);
  });

  it('removeTag drops a name; missing name is a no-op', async () => {
    await addTag('aged');
    await addTag('vip');
    expect(await removeTag('aged')).toEqual(['vip']);
    expect(await removeTag('nope')).toEqual(['vip']);
  });

  it('loadTags degrades to [] on a corrupt (non-array) value', async () => {
    stores.set('tags.json', new Map([['names', 'not-an-array']]));
    expect(await loadTags()).toEqual([]);
  });
});
