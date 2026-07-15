// folders-store — user-created folder names (founder 2026-06-15: "missing
// functionality to create new folders"). Round-trip, dedupe/normalize, remove.
// Store mocked with the same plugin-store pattern as proxy-probe-cache.

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
  loadFolders,
  addFolder,
  removeFolder,
  renameFolder,
  normalizeFolderName,
  loadFolderIcons,
  loadFolderTaxonomyCache,
  replaceAllFolders,
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
    await addFolder('Shopping', TEST_SCOPE);
    const list = await addFolder('Aged', TEST_SCOPE);
    expect(list).toEqual(['Aged', 'Shopping']); // sorted
    expect(await loadFolders(TEST_SCOPE)).toEqual(['Aged', 'Shopping']);
  });

  it('addFolder with an icon stores it; loadFolderIcons round-trips; names list unaffected', async () => {
    await addFolder('Shopping', TEST_SCOPE, '🛒');
    expect(await loadFolders(TEST_SCOPE)).toEqual(['Shopping']);
    expect(await loadFolderIcons(TEST_SCOPE)).toEqual({ Shopping: '🛒' });
  });

  it('setFolderIcon sets + clears an icon (works for any folder name, even derived)', async () => {
    expect(await setFolderIcon('Work', '💼', TEST_SCOPE)).toEqual({ Work: '💼' });
    expect(await loadFolderIcons(TEST_SCOPE)).toEqual({ Work: '💼' });
    expect(await setFolderIcon('Work', '', TEST_SCOPE)).toEqual({}); // empty clears
  });

  it('loadFolderIcons degrades to {} on a corrupt (non-object) value', async () => {
    stores.set(
      'folders.json',
      new Map([[`account-scope:${encodeURIComponent(TEST_SCOPE)}:icons`, ['not', 'an', 'object']]]),
    );
    expect(await loadFolderIcons(TEST_SCOPE)).toEqual({});
  });

  it('addFolder is idempotent + trims (no dupes from whitespace variants)', async () => {
    await addFolder('Shopping', TEST_SCOPE);
    const list = await addFolder('  Shopping  ', TEST_SCOPE);
    expect(list).toEqual(['Shopping']);
  });

  it('addFolder ignores a blank name', async () => {
    const list = await addFolder('   ', TEST_SCOPE);
    expect(list).toEqual([]);
  });

  it('removeFolder drops a name; missing name is a no-op', async () => {
    await addFolder('Shopping', TEST_SCOPE);
    await addFolder('Aged', TEST_SCOPE);
    expect(await removeFolder('Shopping', TEST_SCOPE)).toEqual(['Aged']);
    expect(await removeFolder('Nope', TEST_SCOPE)).toEqual(['Aged']);
  });

  it('removeFolder also drops the attached icon', async () => {
    await addFolder('Shopping', TEST_SCOPE, '🛒');
    expect(await loadFolderIcons(TEST_SCOPE)).toEqual({ Shopping: '🛒' });
    await removeFolder('Shopping', TEST_SCOPE);
    expect(await loadFolders(TEST_SCOPE)).toEqual([]);
    expect(await loadFolderIcons(TEST_SCOPE)).toEqual({});
  });

  it('renameFolder re-keys the name + its icon; sorts; no-ops on blank/equal/missing', async () => {
    await addFolder('Shopping', TEST_SCOPE, '🛒');
    await addFolder('Aged', TEST_SCOPE);
    // Rename moves the name AND re-keys the icon under the new name.
    expect(await renameFolder('Shopping', 'Retail', TEST_SCOPE)).toEqual(['Aged', 'Retail']);
    expect(await loadFolderIcons(TEST_SCOPE)).toEqual({ Retail: '🛒' });
    // No-ops: equal-after-normalize, blank new, missing old.
    expect(await renameFolder('Retail', 'Retail', TEST_SCOPE)).toEqual(['Aged', 'Retail']);
    expect(await renameFolder('Retail', '   ', TEST_SCOPE)).toEqual(['Aged', 'Retail']);
    expect(await renameFolder('Ghost', 'X', TEST_SCOPE)).toEqual(['Aged', 'Retail']);
  });

  it('loadFolders degrades to [] on a corrupt (non-array) value', async () => {
    stores.set(
      'folders.json',
      new Map([[`account-scope:${encodeURIComponent(TEST_SCOPE)}:names`, 'not-an-array']]),
    );
    expect(await loadFolders(TEST_SCOPE)).toEqual([]);
  });

  it('isolates names and icons by non-secret effective-account scope', async () => {
    const personal = 'https://api.driftstack.dev|account:acc_personal';
    const team = 'https://api.driftstack.dev|account:acc_team';
    await addFolder('Personal work', personal, '👤');
    await addFolder('Team work', team, '👥');

    expect(await loadFolders(personal)).toEqual(['Personal work']);
    expect(await loadFolderIcons(personal)).toEqual({ 'Personal work': '👤' });
    expect(await loadFolders(team)).toEqual(['Team work']);
    expect(await loadFolderIcons(team)).toEqual({ 'Team work': '👥' });
  });

  it('never claims legacy global taxonomy for a scoped account cache', async () => {
    stores.set(
      'folders.json',
      new Map<string, unknown>([
        ['names', ['Legacy personal']],
        ['icons', { 'Legacy personal': '👤' }],
      ]),
    );
    const team = 'https://api.driftstack.dev|account:acc_team';

    expect(await loadFolderTaxonomyCache(team)).toEqual({ exists: false, names: [], icons: {} });
    expect(await loadFolders(team)).toEqual([]);
    expect(await loadFolderIcons(team)).toEqual({});

    await replaceAllFolders([], {}, team);
    expect(await loadFolderTaxonomyCache(team)).toEqual({ exists: true, names: [], icons: {} });
    expect(stores.get('folders.json')?.get('names')).toEqual(['Legacy personal']);
  });

  // P2 #8 — the folder-name cap must match the server/per-profile binding cap (32).
  // A longer rail name could never be assigned to a profile (server rejects + the
  // per-profile meta truncated it), so the profile vanished from its own folder
  // filter. The taxonomy store now caps at the SAME 32 chars.
  it('caps a folder name at 32 chars (matches the server/per-profile binding cap)', () => {
    expect(normalizeFolderName('a'.repeat(32))).toBe('a'.repeat(32));
    expect(normalizeFolderName('a'.repeat(40))).toBe('a'.repeat(32));
    expect(normalizeFolderName('a'.repeat(33))?.length).toBe(32);
  });
});
