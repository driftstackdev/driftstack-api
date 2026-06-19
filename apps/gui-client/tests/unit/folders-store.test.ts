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
  renameFolder,
  normalizeFolderName,
  loadFolderIcons,
  setFolderIcon,
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

  it('addFolder with an icon stores it; loadFolderIcons round-trips; names list unaffected', async () => {
    await addFolder('Shopping', '🛒');
    expect(await loadFolders()).toEqual(['Shopping']);
    expect(await loadFolderIcons()).toEqual({ Shopping: '🛒' });
  });

  it('setFolderIcon sets + clears an icon (works for any folder name, even derived)', async () => {
    expect(await setFolderIcon('Work', '💼')).toEqual({ Work: '💼' });
    expect(await loadFolderIcons()).toEqual({ Work: '💼' });
    expect(await setFolderIcon('Work', '')).toEqual({}); // empty clears
  });

  it('loadFolderIcons degrades to {} on a corrupt (non-object) value', async () => {
    stores.set('folders.json', new Map([['icons', ['not', 'an', 'object']]]));
    expect(await loadFolderIcons()).toEqual({});
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

  it('removeFolder also drops the attached icon', async () => {
    await addFolder('Shopping', '🛒');
    expect(await loadFolderIcons()).toEqual({ Shopping: '🛒' });
    await removeFolder('Shopping');
    expect(await loadFolders()).toEqual([]);
    expect(await loadFolderIcons()).toEqual({});
  });

  it('renameFolder re-keys the name + its icon; sorts; no-ops on blank/equal/missing', async () => {
    await addFolder('Shopping', '🛒');
    await addFolder('Aged');
    // Rename moves the name AND re-keys the icon under the new name.
    expect(await renameFolder('Shopping', 'Retail')).toEqual(['Aged', 'Retail']);
    expect(await loadFolderIcons()).toEqual({ Retail: '🛒' });
    // No-ops: equal-after-normalize, blank new, missing old.
    expect(await renameFolder('Retail', 'Retail')).toEqual(['Aged', 'Retail']);
    expect(await renameFolder('Retail', '   ')).toEqual(['Aged', 'Retail']);
    expect(await renameFolder('Ghost', 'X')).toEqual(['Aged', 'Retail']);
  });

  it('loadFolders degrades to [] on a corrupt (non-array) value', async () => {
    stores.set('folders.json', new Map([['names', 'not-an-array']]));
    expect(await loadFolders()).toEqual([]);
  });
});
