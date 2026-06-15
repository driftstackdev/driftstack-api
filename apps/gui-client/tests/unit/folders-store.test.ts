// folders-store — user-created folder names (founder 2026-06-15: "missing
// functionality to create new folders"). Round-trip, dedupe/normalize, remove.
// Store mocked with the same plugin-store pattern as proxy-probe-cache.

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

import {
  loadFolders,
  addFolder,
  removeFolder,
  normalizeFolderName,
} from '../../src/lib/folders-store';

beforeEach(() => {
  stores.clear();
});

describe('folders-store', () => {
  it('normalizeFolderName trims + drops blanks', () => {
    expect(normalizeFolderName('  Shopping  ')).toBe('Shopping');
    expect(normalizeFolderName('   ')).toBeNull();
    expect(normalizeFolderName('')).toBeNull();
  });

  it('addFolder persists, sorts, and round-trips through load', async () => {
    await addFolder('Shopping');
    const list = await addFolder('Aged');
    expect(list).toEqual(['Aged', 'Shopping']); // sorted
    expect(await loadFolders()).toEqual(['Aged', 'Shopping']);
  });

  it('addFolder is idempotent + trims (no dupes from whitespace variants)', async () => {
    await addFolder('Shopping');
    const list = await addFolder('  Shopping  ');
    expect(list).toEqual(['Shopping']);
  });

  it('addFolder ignores a blank name', async () => {
    const list = await addFolder('   ');
    expect(list).toEqual([]);
  });

  it('removeFolder drops a name; missing name is a no-op', async () => {
    await addFolder('Shopping');
    await addFolder('Aged');
    expect(await removeFolder('Shopping')).toEqual(['Aged']);
    expect(await removeFolder('Nope')).toEqual(['Aged']);
  });

  it('loadFolders degrades to [] on a corrupt (non-array) value', async () => {
    stores.set('folders.json', new Map([['names', 'not-an-array']]));
    expect(await loadFolders()).toEqual([]);
  });
});
