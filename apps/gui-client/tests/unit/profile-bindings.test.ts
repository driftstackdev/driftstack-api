// profile-bindings — the local profile→default-proxy/session map. Focus on
// clearBindingsForProxy, the proxy-delete cleanup that prevents a DANGLING
// defaultProxyId from silently rerouting a profile's egress to a different
// proxy once the bound one is deleted (an anti-detect privacy hazard). Also
// re-confirms setDefaultProxy/deleteBinding round-trips around it.
//
// LazyStore mocked with the same in-memory pattern as folders-store.test.ts.

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
  setDefaultProxy,
  getBinding,
  listBindings,
  deleteBinding,
  clearBindingsForProxy,
} from '../../src/lib/profile-bindings';

beforeEach(() => {
  stores.clear();
});

describe('profile-bindings — clearBindingsForProxy', () => {
  it('nulls every binding pointing at the deleted proxy and returns their profile ids', async () => {
    await setDefaultProxy('prof_a', 'px_eu');
    await setDefaultProxy('prof_b', 'px_eu');
    await setDefaultProxy('prof_c', 'px_us'); // unrelated — must be untouched

    const affected = await clearBindingsForProxy('px_eu');

    expect(affected.sort()).toEqual(['prof_a', 'prof_b']);
    expect((await getBinding('prof_a'))?.defaultProxyId).toBeNull();
    expect((await getBinding('prof_b'))?.defaultProxyId).toBeNull();
    // The unrelated binding keeps its proxy.
    expect((await getBinding('prof_c'))?.defaultProxyId).toBe('px_us');
  });

  it('preserves session/launch history on the unbound bindings (only the proxy is cleared)', async () => {
    await setDefaultProxy('prof_a', 'px_eu');
    // Simulate a launch having populated session history.
    const before = await getBinding('prof_a');
    expect(before).not.toBeNull();

    await clearBindingsForProxy('px_eu');

    const after = await getBinding('prof_a');
    expect(after).not.toBeNull();
    expect(after?.defaultProxyId).toBeNull();
    // The binding row itself survives (not deleted) so launch history persists.
    expect((await listBindings()).some((b) => b.profileId === 'prof_a')).toBe(true);
  });

  it('returns [] and mutates nothing when no binding references the proxy', async () => {
    await setDefaultProxy('prof_a', 'px_eu');
    const affected = await clearBindingsForProxy('px_never_bound');
    expect(affected).toEqual([]);
    expect((await getBinding('prof_a'))?.defaultProxyId).toBe('px_eu');
  });

  it('is a no-op against an empty store', async () => {
    expect(await clearBindingsForProxy('px_x')).toEqual([]);
    expect(await listBindings()).toEqual([]);
  });

  it('does not resurrect a deleted binding', async () => {
    await setDefaultProxy('prof_a', 'px_eu');
    await deleteBinding('prof_a');
    const affected = await clearBindingsForProxy('px_eu');
    expect(affected).toEqual([]);
    expect(await getBinding('prof_a')).toBeNull();
  });
});
