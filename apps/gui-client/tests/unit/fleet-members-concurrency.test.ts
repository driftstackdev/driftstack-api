// Fleet registry persistence is one array-valued read-modify-write key. These
// tests hold the mocked store between the read and durable write to prove that
// every public read/mutation shares one FIFO and cannot lose, resurrect, or
// observe a half-settled member snapshot.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetMember, FleetMemberDraft } from '../../src/lib/fleet-members';

const STORE_FILE = 'settings.json';
const FLEET_KEY = 'fleetMembers';
const stores = new Map<string, Map<string, unknown>>();

interface SetCall {
  key: string;
  value: unknown;
}

let getCalls = 0;
let setCalls: SetCall[] = [];
let beforeSet: ((call: SetCall, index: number) => void | Promise<void>) | null = null;

function clone<T>(value: T): T {
  return structuredClone(value);
}

vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private readonly file: string;

    constructor(file: string) {
      this.file = file;
      if (!stores.has(file)) stores.set(file, new Map());
    }

    private map(): Map<string, unknown> {
      let current = stores.get(this.file);
      if (current === undefined) {
        current = new Map();
        stores.set(this.file, current);
      }
      return current;
    }

    get(key: string): Promise<unknown> {
      getCalls++;
      const value = this.map().get(key);
      // Snapshot at invocation time. Without the module FIFO, two callers can
      // therefore both read the same old array before either writes.
      return Promise.resolve(value === undefined ? undefined : clone(value));
    }

    async set(key: string, value: unknown): Promise<void> {
      const call: SetCall = { key, value: clone(value) };
      const index = setCalls.length;
      setCalls.push(call);
      await beforeSet?.(call, index);
      this.map().set(key, clone(value));
    }

    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import {
  addFleetMember,
  listFleetMembers,
  removeFleetMember,
  updateFleetMember,
} from '../../src/lib/fleet-members';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function member(id: string, label: string): FleetMember {
  return {
    id,
    label,
    baseUrl: `https://${id}.example.test`,
    notes: null,
    createdAt: '2026-07-17T12:00:00.000Z',
  };
}

function draft(label: string): FleetMemberDraft {
  return {
    label,
    baseUrl: `https://${label.toLowerCase()}.example.test/`,
    notes: null,
  };
}

function seed(...members: FleetMember[]): void {
  stores.set(STORE_FILE, new Map([[FLEET_KEY, clone(members)]]));
}

beforeEach(() => {
  stores.clear();
  getCalls = 0;
  setCalls = [];
  beforeSet = null;
});

describe('fleet-members — serialized registry ownership', () => {
  it('queues a second add behind a held first add and preserves both members', async () => {
    const firstWrite = deferred<void>();
    beforeSet = (_call, index) => (index === 0 ? firstWrite.promise : undefined);

    const first = addFleetMember(draft('Alpha'));
    const second = addFleetMember(draft('Beta'));

    await vi.waitFor(() => expect(setCalls).toHaveLength(1));
    expect(getCalls).toBe(1);

    firstWrite.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect(setCalls).toHaveLength(2);
    expect((await listFleetMembers()).map((entry) => entry.label)).toEqual(['Alpha', 'Beta']);
  });

  it('queues public reads behind a held mutation so they observe its committed snapshot', async () => {
    seed(member('fleet_existing', 'Existing'));
    const firstWrite = deferred<void>();
    beforeSet = (_call, index) => (index === 0 ? firstWrite.promise : undefined);

    const adding = addFleetMember(draft('Added'));
    await vi.waitFor(() => expect(setCalls).toHaveLength(1));
    const reading = listFleetMembers();
    let readSettled = false;
    void reading.then(() => {
      readSettled = true;
    });
    await Promise.resolve();

    expect(getCalls).toBe(1);
    expect(readSettled).toBe(false);

    firstWrite.resolve(undefined);
    await adding;
    await expect(reading).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'fleet_existing', label: 'Existing' }),
        expect.objectContaining({ label: 'Added' }),
      ]),
    );
  });

  it('applies update then remove in call order without losing an unrelated row', async () => {
    seed(member('fleet_target', 'Target'), member('fleet_other', 'Other'));
    const firstWrite = deferred<void>();
    beforeSet = (_call, index) => (index === 0 ? firstWrite.promise : undefined);

    const updating = updateFleetMember('fleet_target', draft('Renamed'));
    await vi.waitFor(() => expect(setCalls).toHaveLength(1));
    const removing = removeFleetMember('fleet_target');
    expect(getCalls).toBe(1);

    firstWrite.resolve(undefined);
    await expect(updating).resolves.toEqual(
      expect.objectContaining({ id: 'fleet_target', label: 'Renamed' }),
    );
    await removing;

    expect(setCalls).toHaveLength(2);
    expect(await listFleetMembers()).toEqual([member('fleet_other', 'Other')]);
  });

  it('applies remove then update in call order; the update returns null and cannot resurrect', async () => {
    seed(member('fleet_target', 'Target'), member('fleet_other', 'Other'));
    const firstWrite = deferred<void>();
    beforeSet = (_call, index) => (index === 0 ? firstWrite.promise : undefined);

    const removing = removeFleetMember('fleet_target');
    await vi.waitFor(() => expect(setCalls).toHaveLength(1));
    const updating = updateFleetMember('fleet_target', draft('Resurrected'));
    expect(getCalls).toBe(1);

    firstWrite.resolve(undefined);
    await removing;
    await expect(updating).resolves.toBeNull();

    // Missing updates do not issue a second persistence write.
    expect(setCalls).toHaveLength(1);
    expect(await listFleetMembers()).toEqual([member('fleet_other', 'Other')]);
  });

  it('returns null without writing when the requested member is already missing', async () => {
    seed(member('fleet_other', 'Other'));

    await expect(updateFleetMember('fleet_missing', draft('Missing'))).resolves.toBeNull();

    expect(setCalls).toHaveLength(0);
    expect(await listFleetMembers()).toEqual([member('fleet_other', 'Other')]);
  });

  it('recovers the FIFO after a failed first write and runs the queued successor', async () => {
    beforeSet = (_call, index) => {
      if (index === 0) throw new Error('store write failed');
    };

    const failed = addFleetMember(draft('Failed'));
    const successor = addFleetMember(draft('Successor'));

    await expect(failed).rejects.toThrow('store write failed');
    await expect(successor).resolves.toEqual(expect.objectContaining({ label: 'Successor' }));
    expect(setCalls).toHaveLength(2);
    expect((await listFleetMembers()).map((entry) => entry.label)).toEqual(['Successor']);
  });
});
