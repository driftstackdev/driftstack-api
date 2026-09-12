// profile-bindings — the local profile→default-proxy/session map.
//
// Focus on `profilesUsingProxy`, the proxy-DELETE step, and on the property the
// delete path now depends on: it is a READ. Deleting a proxy must leave the
// profiles that used it with NO proxy, and the mechanism is that their binding
// keeps naming the deleted id — every resolver already treats an explicit
// default whose proxy is gone as nothing, while a NULL default means "never
// chose one" and falls back to `proxies[0]`.
//
// ⛔ This file replaces the `clearBindingsForProxy` arms, which pinned the
// opposite (`defaultProxyId` nulled). That null was the owner's 2026-09-12
// defect: "when a proxy is removed, and it still has existing profiles on that
// proxy, currently it switches to another proxy which is available, i think it
// would be better, if proxy was simply removed". The re-point is asserted here
// through the REAL resolver rule (`attributeSessionProxy`, the exported mirror
// of ProfilesView.pickProxy) so restoring the null goes red on the consequence,
// not merely on a shape.
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
  markLaunched,
  profilesUsingProxy,
} from '../../src/lib/profile-bindings';
import { attributeSessionProxy } from '../../src/lib/session-h3-observation';

beforeEach(() => {
  stores.clear();
});

describe('profile-bindings — profilesUsingProxy', () => {
  it('names every profile whose default is that proxy, and no others', async () => {
    await setDefaultProxy('prof_a', 'px_eu');
    await setDefaultProxy('prof_b', 'px_eu');
    await setDefaultProxy('prof_c', 'px_us'); // unrelated — must not be named

    expect((await profilesUsingProxy('px_eu')).sort()).toEqual(['prof_a', 'prof_b']);
    expect(await profilesUsingProxy('px_us')).toEqual(['prof_c']);
  });

  it('returns [] for a proxy nothing is bound to, and against an empty store', async () => {
    await setDefaultProxy('prof_a', 'px_eu');
    expect(await profilesUsingProxy('px_never_bound')).toEqual([]);
    stores.clear();
    expect(await profilesUsingProxy('px_x')).toEqual([]);
    expect(await listBindings()).toEqual([]);
  });

  it('does not name a profile whose binding was deleted', async () => {
    await setDefaultProxy('prof_a', 'px_eu');
    await deleteBinding('prof_a');
    expect(await profilesUsingProxy('px_eu')).toEqual([]);
    expect(await getBinding('prof_a')).toBeNull();
  });

  it('CRITICAL (P1) — it WRITES NOTHING: the binding still names the deleted proxy afterwards', async () => {
    await setDefaultProxy('prof_a', 'px_eu');
    await setDefaultProxy('prof_c', 'px_us');

    await profilesUsingProxy('px_eu');

    // Not nulled, not re-pointed, and the unrelated row is untouched. Nulling
    // here is exactly what handed prof_a to px_us (see the next arm).
    expect((await getBinding('prof_a'))?.defaultProxyId).toBe('px_eu');
    expect((await getBinding('prof_c'))?.defaultProxyId).toBe('px_us');
    // The binding row itself survives, so launch history persists.
    expect((await listBindings()).some((b) => b.profileId === 'prof_a')).toBe(true);
  });
});

describe('profile-bindings — deleting a proxy leaves its profiles with NO proxy', () => {
  // The two proxies the customer saved; px_eu is the one being deleted, so the
  // registry AFTER the delete holds px_us alone — the proxy a re-point would
  // silently move prof_a onto.
  const REGISTRY_AFTER_DELETE = [{ id: 'px_us' }];

  it('CRITICAL the resolver gives the affected profile NOTHING, not the surviving proxy', async () => {
    await setDefaultProxy('prof_a', 'px_eu');
    await markLaunched('prof_a', 'sess_a');

    // The whole of what the proxy-delete path does to the bindings: read them.
    expect(await profilesUsingProxy('px_eu')).toEqual(['prof_a']);

    const bindings = await listBindings();
    expect(attributeSessionProxy('sess_a', bindings, REGISTRY_AFTER_DELETE)).toBeNull();
  });

  it('POSITIVE CONTROL — the same resolver DOES hand a null default to the first saved proxy', async () => {
    // Why the delete path must not null: this is the re-point, in the resolver's
    // own words. If `profilesUsingProxy` ever writes `defaultProxyId: null`
    // again, the arm above becomes this one and reds.
    await setDefaultProxy('prof_a', null);
    await markLaunched('prof_a', 'sess_a');

    const bindings = await listBindings();
    expect(attributeSessionProxy('sess_a', bindings, REGISTRY_AFTER_DELETE)).toBe('px_us');
  });

  it('a profile bound to a SURVIVING proxy still resolves to it (the delete is not a blanket detach)', async () => {
    await setDefaultProxy('prof_c', 'px_us');
    await markLaunched('prof_c', 'sess_c');

    await profilesUsingProxy('px_eu');

    const bindings = await listBindings();
    expect(attributeSessionProxy('sess_c', bindings, REGISTRY_AFTER_DELETE)).toBe('px_us');
  });
});
