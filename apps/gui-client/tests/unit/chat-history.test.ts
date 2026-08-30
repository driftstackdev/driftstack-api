// chat-history — title derivation, upsert/sort/prune, delete, corrupt-degrade.
// Store mocked (same plugin-store pattern as profiles-meta / proxy-probe-cache).

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
  loadChats,
  upsertChat,
  deleteChat,
  deriveChatTitle,
  type StoredChat,
} from '../../src/lib/chat-history';

function seed(value: unknown): void {
  const m = stores.get('agent-chats.json') ?? new Map<string, unknown>();
  m.set('chats', value);
  stores.set('agent-chats.json', m);
}

function chat(over: Partial<StoredChat> = {}): StoredChat {
  return {
    id: 'c1',
    title: 'Test chat',
    profileId: '',
    model: 'claude-opus-4-7',
    turns: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

beforeEach(() => {
  stores.clear();
});

describe('deriveChatTitle', () => {
  it('uses the first user message, trimmed + collapsed', () => {
    expect(
      deriveChatTitle([
        { id: 1, role: 'user', text: '  warm up   this   profile  ' },
        { id: 2, role: 'agent' },
      ]),
    ).toBe('warm up this profile');
  });
  it('truncates long titles with an ellipsis', () => {
    const long = 'a'.repeat(80);
    expect(deriveChatTitle([{ id: 1, role: 'user', text: long }]).endsWith('…')).toBe(true);
    expect(deriveChatTitle([{ id: 1, role: 'user', text: long }]).length).toBeLessThanOrEqual(60);
  });
  it('falls back to "New chat" when there is no user message', () => {
    expect(deriveChatTitle([])).toBe('New chat');
    expect(deriveChatTitle([{ id: 1, role: 'agent' }])).toBe('New chat');
  });
});

describe('chat-history store', () => {
  it('upsert inserts, updates by id, and sorts most-recent-first', async () => {
    await upsertChat(chat({ id: 'a', title: 'A' }), 100);
    await upsertChat(chat({ id: 'b', title: 'B' }), 200);
    let all = await loadChats();
    expect(all.map((c) => c.id)).toEqual(['b', 'a']); // newest first
    // update 'a' with a later timestamp → it floats to the top
    await upsertChat(chat({ id: 'a', title: 'A2' }), 300);
    all = await loadChats();
    expect(all.map((c) => c.id)).toEqual(['a', 'b']);
    expect(all[0]?.title).toBe('A2');
  });

  it('delete removes by id and is idempotent', async () => {
    await upsertChat(chat({ id: 'a' }), 100);
    await upsertChat(chat({ id: 'b' }), 200);
    const afterDel = await deleteChat('a');
    expect(afterDel.map((c) => c.id)).toEqual(['b']);
    // deleting a missing id is a no-op
    const again = await deleteChat('a');
    expect(again.map((c) => c.id)).toEqual(['b']);
  });

  it('serializes writes: a concurrent upsert does not resurrect a deleted chat', async () => {
    await upsertChat(chat({ id: 'x', title: 'X' }), 100);
    await upsertChat(chat({ id: 'y', title: 'Y' }), 200);
    // Fire delete(x) and upsert(y) WITHOUT awaiting between them — the write
    // lock must run them sequentially so delete(x) isn't clobbered.
    const pDel = deleteChat('x');
    const pUp = upsertChat(chat({ id: 'y', title: 'Y2' }), 300);
    await Promise.all([pDel, pUp]);
    const all = await loadChats();
    expect(all.map((c) => c.id)).toEqual(['y']); // x stays deleted, not resurrected
    expect(all[0]?.title).toBe('Y2');
  });

  it('corrupt root degrades to empty; corrupt entries are dropped', async () => {
    seed('not-an-array');
    expect(await loadChats()).toEqual([]);
    seed([chat({ id: 'ok' }), 42, null, { id: '' }]);
    const all = await loadChats();
    expect(all.map((c) => c.id)).toEqual(['ok']);
  });
});

// V-2167 — `cleanChat` rebuilds a stored chat FIELD BY FIELD, so any key it
// does not name is silently dropped on load. `sessionId` was such a key: the
// type marks it optional, so its disappearance was invisible to the compiler,
// and every arm above builds a `StoredChat` in memory rather than round-tripping
// one through the store — so nothing could see it. The consequence was that
// V-2162's "reattach to the session this chat was using" never fired for a chat
// read from disk, which is every chat after an app restart.
//
// ⛔ The arm below is keyed on the SHAPE, not on `sessionId`. A guard that names
// one member of a growing record goes blind the moment a second optional field
// is added — which is exactly how this one got through.
describe('chat-history round trip', () => {
  it('preserves every field of a stored chat, not only the required ones', async () => {
    const full: StoredChat = chat({
      id: 'round-trip',
      title: 'Warm up this profile',
      profileId: 'p-42',
      sessionId: 'agsess_abc123',
      turns: [{ role: 'user', text: 'hello' } as StoredChat['turns'][number]],
      createdAt: 1,
      updatedAt: 2,
    });

    // `at` becomes updatedAt, so pass the record's own value and the round
    // trip compares like for like.
    await upsertChat(full, full.updatedAt);
    const [loaded] = await loadChats();
    expect(loaded, 'the chat did not survive the store round trip at all').toBeDefined();

    // Enumerate the source record rather than asserting a hand-written list:
    // a field added to StoredChat later joins this check for free.
    for (const key of Object.keys(full) as (keyof StoredChat)[]) {
      expect({ key, value: loaded[key] }, `cleanChat dropped "${key}" on load`).toEqual({
        key,
        value: full[key],
      });
    }
    expect(Object.keys(loaded).sort()).toEqual(Object.keys(full).sort());
  });

  it('drops a sessionId that is not a usable string', async () => {
    // The store is on disk and hand-editable, and a blank id would send the
    // reattach path off to `GET /v1/agent-sessions/` — so the field is admitted
    // only when it can actually name a session.
    seed([{ ...chat({ id: 'bad' }), sessionId: '' }]);
    const [loaded] = await loadChats();
    expect(loaded.id).toBe('bad');
    expect(loaded.sessionId).toBeUndefined();
  });
});
