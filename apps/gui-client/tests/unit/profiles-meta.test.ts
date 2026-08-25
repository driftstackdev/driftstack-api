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
      icon: '',
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
    seed({ ok: { folder: 'F', tags: ['t'], note: 'n', icon: '' }, bad: 42, worse: null });
    const all = await loadProfilesMeta();
    expect(all['ok']).toEqual({ folder: 'F', tags: ['t'], note: 'n', icon: '' });
    expect(all['bad']).toEqual({ folder: '', tags: [], note: '', icon: '' });
    seed('not-an-object');
    expect(await loadProfilesMeta()).toEqual({});
  });

  it('geolocation override: a valid in-range pair round-trips (+ optional accuracy)', async () => {
    await saveProfileMeta('prof-1', {
      geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 20 },
    });
    let m = (await loadProfilesMeta())['prof-1']!;
    expect(m.geolocation).toEqual({ latitude: 48.8566, longitude: 2.3522, accuracy: 20 });
    // accuracy omitted → stored without it (device applies its default)
    await saveProfileMeta('prof-2', { geolocation: { latitude: -33.8688, longitude: 151.2093 } });
    m = (await loadProfilesMeta())['prof-2']!;
    expect(m.geolocation).toEqual({ latitude: -33.8688, longitude: 151.2093 });
  });

  it('geolocation override: out-of-range / partial / non-numeric degrades to no override', async () => {
    seed({
      badLat: { geolocation: { latitude: 91, longitude: 0 } },
      badLon: { geolocation: { latitude: 0, longitude: 181 } },
      partial: { geolocation: { latitude: 10 } },
      nonNumeric: { geolocation: { latitude: 'x', longitude: 'y' } },
      badAcc: { geolocation: { latitude: 1, longitude: 2, accuracy: -5 } },
    });
    const all = await loadProfilesMeta();
    expect(all['badLat']!.geolocation).toBeUndefined();
    expect(all['badLon']!.geolocation).toBeUndefined();
    expect(all['partial']!.geolocation).toBeUndefined();
    expect(all['nonNumeric']!.geolocation).toBeUndefined();
    // lat/lon valid but accuracy invalid → keep the coords, drop only accuracy
    expect(all['badAcc']!.geolocation).toEqual({ latitude: 1, longitude: 2 });
  });

  it('geolocation override: a later save can CLEAR it (undefined → back to auto-derive)', async () => {
    await saveProfileMeta('prof-1', { geolocation: { latitude: 40, longitude: -74 } });
    expect((await loadProfilesMeta())['prof-1']!.geolocation).toEqual({
      latitude: 40,
      longitude: -74,
    });
    await saveProfileMeta('prof-1', { geolocation: undefined });
    expect((await loadProfilesMeta())['prof-1']!.geolocation).toBeUndefined();
  });

  it('bulk: merge unions tags + folder overwrites; replace overwrites tags', async () => {
    const { saveProfilesMetaBulk } = await import('../../src/lib/profiles-meta');
    await saveProfileMeta('a', { tags: ['x'], folder: 'Old' });
    await saveProfilesMetaBulk(['a', 'b'], { folder: 'New', tags: ['y'] }, 'merge');
    let all = await loadProfilesMeta();
    expect(all['a']).toEqual({ folder: 'New', tags: ['x', 'y'], note: '', icon: '' });
    expect(all['b']).toEqual({ folder: 'New', tags: ['y'], note: '', icon: '' });
    await saveProfilesMetaBulk(['a'], { tags: ['z'] }, 'replace');
    all = await loadProfilesMeta();
    expect(all['a']!.tags).toEqual(['z']);
    expect(all['a']!.folder).toBe('New');
  });

  it("bulk 'remove' mode SUBTRACTS the given tags from each profile (other tags + folder untouched)", async () => {
    const { saveProfilesMetaBulk } = await import('../../src/lib/profiles-meta');
    await saveProfileMeta('a', { folder: 'Keep', tags: ['x', 'y', 'z'] });
    await saveProfileMeta('b', { tags: ['x'] });
    await saveProfileMeta('c', { tags: ['q'] }); // doesn't carry the tag
    await saveProfilesMetaBulk(['a', 'b', 'c'], { tags: ['x', 'y'] }, 'remove');
    const all = await loadProfilesMeta();
    expect(all['a']).toEqual({ folder: 'Keep', tags: ['z'], note: '', icon: '' });
    expect(all['b']!.tags).toEqual([]); // last remaining tag removed
    expect(all['c']!.tags).toEqual(['q']); // unaffected — tag not present
  });

  it("bulk 'remove' mode is NOT a verbatim tag overwrite (meta.tags is the subtraction set, never assigned)", async () => {
    const { saveProfilesMetaBulk } = await import('../../src/lib/profiles-meta');
    await saveProfileMeta('a', { tags: ['keep'] });
    // 'gone' isn't on the profile; removing it must NOT add it.
    await saveProfilesMetaBulk(['a'], { tags: ['gone'] }, 'remove');
    expect((await loadProfilesMeta())['a']!.tags).toEqual(['keep']);
  });

  it('seedMetaFromServer: seeds only no-local-entry profiles with server organization; local wins conflicts; empty server org skipped', async () => {
    const { seedMetaFromServer } = await import('../../src/lib/profiles-meta');
    const local = { kept: { folder: 'Local', tags: ['mine'], note: 'n', icon: '' } };
    const { map, changed } = seedMetaFromServer(local, [
      // Local entry exists — server value must NOT overwrite (local wins).
      { id: 'kept', folder: 'Server', tags: ['theirs'] },
      // No local entry + server organization → seeded.
      { id: 'new', folder: 'Synced', tags: ['remote'] },
      // No local entry + nothing server-side → no entry minted.
      { id: 'plain', folder: null, tags: [] },
      // Pre-0076 server: fields absent entirely → no entry minted.
      { id: 'old-server' },
    ]);
    expect(changed).toBe(true);
    expect(map['kept']).toEqual({ folder: 'Local', tags: ['mine'], note: 'n', icon: '' });
    expect(map['new']).toEqual({ folder: 'Synced', tags: ['remote'], note: '', icon: '' });
    expect(map['plain']).toBeUndefined();
    expect(map['old-server']).toBeUndefined();
    // Nothing to seed → changed=false and the SAME map reference (caller
    // skips the store write).
    const again = seedMetaFromServer(map, [{ id: 'kept', folder: 'Server', tags: [] }]);
    expect(again.changed).toBe(false);
  });

  it('seedMetaFromServer entries pass through cleanEntry caps (oversized server values clamped)', async () => {
    const { seedMetaFromServer } = await import('../../src/lib/profiles-meta');
    const { map } = seedMetaFromServer({}, [
      {
        id: 'big',
        folder: 'x'.repeat(99),
        tags: Array.from({ length: 20 }, (_, i) => `t${String(i)}`),
      },
    ]);
    expect(map['big']!.folder).toHaveLength(32);
    expect(map['big']!.tags).toHaveLength(12);
  });

  it('persistProfilesMeta: writes the map and prunes ids not in the live list', async () => {
    const { persistProfilesMeta } = await import('../../src/lib/profiles-meta');
    await persistProfilesMeta(
      {
        live: { folder: 'A', tags: [], note: '', icon: '' },
        gone: { folder: 'B', tags: [], note: '', icon: '' },
      },
      ['live'],
    );
    const all = await loadProfilesMeta();
    expect(all['live']).toEqual({ folder: 'A', tags: [], note: '', icon: '' });
    expect(all['gone']).toBeUndefined();
  });

  it('folderList: distinct, sorted, unfiled excluded', () => {
    expect(
      folderList({
        a: { folder: 'Zeta', tags: [], note: '', icon: '' },
        b: { folder: 'Alpha', tags: [], note: '', icon: '' },
        c: { folder: 'Alpha', tags: [], note: '', icon: '' },
        d: { folder: '', tags: [], note: '', icon: '' },
      }),
    ).toEqual(['Alpha', 'Zeta']);
  });

  it('aggregateTags: per-tag counts, ordered by count desc then name', async () => {
    const { aggregateTags } = await import('../../src/lib/profiles-meta');
    expect(
      aggregateTags({
        a: { folder: '', tags: ['shop', 'eu'], note: '', icon: '' },
        b: { folder: '', tags: ['shop', 'us'], note: '', icon: '' },
        c: { folder: '', tags: ['shop'], note: '', icon: '' },
        d: { folder: '', tags: ['eu', ''], note: '', icon: '' }, // empty tag skipped
        e: { folder: '', tags: [], note: '', icon: '' },
      }),
    ).toEqual([
      { tag: 'shop', count: 3 },
      { tag: 'eu', count: 2 },
      { tag: 'us', count: 1 },
    ]);
  });

  it('aggregateTags: empty map → empty list', async () => {
    const { aggregateTags } = await import('../../src/lib/profiles-meta');
    expect(aggregateTags({})).toEqual([]);
  });
});
