// profiles-meta — validation, dedup/caps, pruning, corrupt-store degrade.
// The store is mocked (same plugin-store mock pattern as settings tests).

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
      // get-or-create on every access: beforeEach clears the registry but
      // the module under test caches its LazyStore instance across tests.
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

import { folderList, loadProfilesMeta, saveProfileMeta } from '../../src/lib/profiles-meta';

function seed(value: unknown): void {
  const m = stores.get('profiles-meta.json') ?? new Map<string, unknown>();
  m.set('profiles', value);
  stores.set('profiles-meta.json', m);
}

beforeEach(() => {
  stores.clear();
});

describe('profiles-meta store', () => {
  it('empty store loads as empty map', async () => {
    expect(await loadProfilesMeta()).toEqual({});
  });

  it('save merges partials and round-trips', async () => {
    await saveProfileMeta('prof-1', { folder: 'E-commerce', tags: ['checkout'] });
    await saveProfileMeta('prof-1', { note: 'priority account' });
    const all = await loadProfilesMeta();
    expect(all['prof-1']).toEqual({
      folder: 'E-commerce',
      tags: ['checkout'],
      note: 'priority account',
    });
  });

  it('tags are trimmed, deduped, and capped; folder + note length-capped', async () => {
    await saveProfileMeta('prof-1', {
      folder: 'F'.repeat(99),
      note: 'n'.repeat(999),
      tags: [' a ', 'a', '', 'b', ...Array.from({ length: 30 }, (_, i) => `t${String(i)}`)],
    });
    const m = (await loadProfilesMeta())['prof-1']!;
    expect(m.folder).toHaveLength(32);
    expect(m.note).toHaveLength(280);
    expect(m.tags[0]).toBe('a'); // trimmed + deduped
    expect(m.tags.length).toBeLessThanOrEqual(12);
  });

  it('prunes entries for ids not in the live list when provided', async () => {
    await saveProfileMeta('alive', { folder: 'Keep' });
    await saveProfileMeta('dead', { folder: 'Gone' });
    await saveProfileMeta('alive', { note: 'x' }, ['alive']);
    const all = await loadProfilesMeta();
    expect(Object.keys(all)).toEqual(['alive']);
  });

  it('corrupt entries degrade to defaults; corrupt root degrades to empty', async () => {
    seed({ ok: { folder: 'F', tags: ['t'], note: 'n' }, bad: 42, worse: null });
    const all = await loadProfilesMeta();
    expect(all['ok']).toEqual({ folder: 'F', tags: ['t'], note: 'n' });
    expect(all['bad']).toEqual({ folder: '', tags: [], note: '' });
    seed('not-an-object');
    expect(await loadProfilesMeta()).toEqual({});
  });

  it('bulk: merge unions tags + folder overwrites; replace overwrites tags', async () => {
    const { saveProfilesMetaBulk } = await import('../../src/lib/profiles-meta');
    await saveProfileMeta('a', { tags: ['x'], folder: 'Old' });
    await saveProfilesMetaBulk(['a', 'b'], { folder: 'New', tags: ['y'] }, 'merge');
    let all = await loadProfilesMeta();
    expect(all['a']).toEqual({ folder: 'New', tags: ['x', 'y'], note: '' });
    expect(all['b']).toEqual({ folder: 'New', tags: ['y'], note: '' });
    await saveProfilesMetaBulk(['a'], { tags: ['z'] }, 'replace');
    all = await loadProfilesMeta();
    expect(all['a']!.tags).toEqual(['z']);
    expect(all['a']!.folder).toBe('New');
  });

  it('folderList: distinct, sorted, unfiled excluded', () => {
    expect(
      folderList({
        a: { folder: 'Zeta', tags: [], note: '' },
        b: { folder: 'Alpha', tags: [], note: '' },
        c: { folder: 'Alpha', tags: [], note: '' },
        d: { folder: '', tags: [], note: '' },
      }),
    ).toEqual(['Alpha', 'Zeta']);
  });
});
