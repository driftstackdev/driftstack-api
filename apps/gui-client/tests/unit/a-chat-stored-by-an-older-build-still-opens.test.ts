// §7 (stage 3) — A CHAT STORED BY AN OLDER BUILD STILL OPENS, AND A CHAT
// STORED BY A NEWER ONE DOES TOO.
//
// Stage 3 adds two optional fields to a persisted turn: `plan` (the server's
// captions, the step kinds, the re-plan boundaries) and `timing` (the elapsed
// clock and the per-step durations). The transcript is persisted VERBATIM —
// `cleanChat` validates the chat's own fields and passes `turns` through as an
// array — so this round-trips with no decoder change at all.
//
// ⛔ Which is exactly why it needs a test. "No change was required" is a claim
// about a decoder nobody is watching, and the failure it hides is the worst
// kind: a customer reopens a week-old chat and it is GONE, because one strict
// read rejected a turn shaped slightly differently from today's.
//
// Two directions, and both must hold:
//   · BACKWARD — a chat written before §7 has no `plan` and no `timing`, and
//     must open with its turns intact and those fields simply absent (the view
//     then draws no clock and no durations; that half is proved in
//     a-turn-without-timing-renders-no-clock-and-no-zeros.test.tsx).
//   · FORWARD — a chat written by a build NEWER than this one carries keys this
//     build has never heard of. They must survive the round trip untouched, not
//     be stripped and not make the chat unreadable: the customer may still be
//     running that newer build on another machine, against the same file.
//
// ⚠️ `cleanChat` REBUILDS the chat field by field, so anything not named there
// is dropped — that is how `sessionId` was silently lost once (see its comment
// in chat-history.ts). The forward arm below is the standing guard that the
// same thing does not happen inside a TURN.

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

import { loadChats, upsertChat, summariseTurn, type StoredChat } from '../../src/lib/chat-history';
import type { ChatTurn } from '../../src/lib/use-agent-chat';

function seed(value: unknown): void {
  const m = stores.get('agent-chats.json') ?? new Map<string, unknown>();
  m.set('chats', value);
  stores.set('agent-chats.json', m);
}

const NAV = { kind: 'navigate', url: 'https://shop.example.com/' } as const;
const SHOT = { kind: 'capture', capture: 'screenshot' } as const;

/** Exactly what a build BEFORE §7 wrote: an agent turn with a response and
 *  nothing else. Typed as ChatTurn on purpose — this shape is still valid. */
const OLD_AGENT_TURN: ChatTurn = {
  id: 2,
  role: 'agent',
  response: {
    kind: 'plan-executed',
    session: {
      id: 'agt_old',
      account_id: 'acc_1',
      driftstack_session_id: null,
      status: 'closed',
      closed_reason: 'idle',
      stop_on_exit_ip_change: false,
      token_budget_total: 100_000,
      token_budget_remaining: 88_000,
      transcript_length: 2,
      closed_at: '2026-06-14T00:10:00Z',
      created_by_user_id: null,
      mode: 'ai',
      model: 'claude-sonnet-5',
      pair_mode_state: null,
      created_at: '2026-06-14T00:00:00Z',
      updated_at: '2026-06-14T00:10:00Z',
    },
    intents: [NAV, SHOT],
    results: [
      { kind: 'success', intent: NAV, summary: 'Opened the store' },
      { kind: 'success', intent: SHOT, summary: 'Took a screenshot' },
    ],
    ok: true,
  },
};

function storedChat(turns: ReadonlyArray<unknown>): Record<string, unknown> {
  return {
    id: 'c_old',
    title: 'find me trail running shoes',
    profileId: '',
    model: 'claude-sonnet-5',
    turns,
    createdAt: 1000,
    updatedAt: 2000,
  };
}

beforeEach(() => {
  stores.clear();
});

describe('a chat written before §7 opens unchanged', () => {
  it('⛔ decodes, keeps its turns, and simply has no plan and no timing on them', async () => {
    seed([
      storedChat([{ id: 1, role: 'user', text: 'find me trail running shoes' }, OLD_AGENT_TURN]),
    ]);
    const [chat] = await loadChats();

    expect(chat?.turns).toHaveLength(2);
    const agent = chat?.turns[1];
    expect(agent?.response?.kind).toBe('plan-executed');
    // The two new fields are ABSENT, not null and not empty objects — which is
    // what makes the view draw the turn the way the old build drew it.
    expect(agent?.plan).toBeUndefined();
    expect(agent?.timing).toBeUndefined();
  });

  it('and the history rail still summarises it, so it is readable before it is opened', () => {
    expect(summariseTurn(OLD_AGENT_TURN)).toEqual({
      role: 'agent',
      headline: '2 actions · navigate, capture',
      intentCount: 2,
      ok: true,
    });
  });
});

describe('a turn written by THIS build round-trips its new fields', () => {
  it('keeps the captions, the kinds, the re-plan boundaries and every duration', async () => {
    const rich: ChatTurn = {
      ...OLD_AGENT_TURN,
      plan: {
        labels: ['Open the store', 'Screenshot the product page'],
        kinds: ['navigate', 'capture'],
        replanAt: [1],
      },
      timing: { elapsedMs: 41_000, stepMs: [3100, null] },
    };
    const chat: StoredChat = {
      id: 'c_new',
      title: 'find me trail running shoes',
      profileId: '',
      model: 'claude-sonnet-5',
      turns: [{ id: 1, role: 'user', text: 'find me trail running shoes' }, rich],
      createdAt: 1000,
      updatedAt: 2000,
    };
    await upsertChat(chat, 3000);
    const [back] = await loadChats();

    expect(back?.turns[1]?.plan).toEqual({
      labels: ['Open the store', 'Screenshot the product page'],
      kinds: ['navigate', 'capture'],
      replanAt: [1],
    });
    // ⛔ The `null` in the middle survives as a null. A decoder that "cleaned"
    // it to 0 would put "0.0s" under a step nobody timed.
    expect(back?.turns[1]?.timing).toEqual({ elapsedMs: 41_000, stepMs: [3100, null] });
  });
});

describe('a chat written by a build NEWER than this one still opens', () => {
  it('⛔ keeps a turn field this build has never heard of, rather than dropping it', async () => {
    const future = {
      ...OLD_AGENT_TURN,
      timing: { elapsedMs: 41_000, stepMs: [3100, 1200], queuedMs: 800 },
      attribution: { decidedBy: 'a-thing-this-build-does-not-model' },
    };
    seed([storedChat([{ id: 1, role: 'user', text: 'hello' }, future])]);
    const [chat] = await loadChats();

    const back = chat?.turns[1] as unknown as Record<string, unknown>;
    expect(back['attribution']).toEqual({ decidedBy: 'a-thing-this-build-does-not-model' });
    expect(back['timing']).toEqual({ elapsedMs: 41_000, stepMs: [3100, 1200], queuedMs: 800 });
    // And the fields this build DOES model are still read correctly beside it.
    expect(chat?.turns[1]?.response?.kind).toBe('plan-executed');
  });

  it('⛔ and a turn whose new fields are the WRONG SHAPE does not take the chat down with it', async () => {
    // The transcript is our own data and validated structurally, so a turn can
    // carry nonsense. What must not happen is the whole chat — every other turn
    // in it — becoming unreachable because one field is a string.
    const broken = { ...OLD_AGENT_TURN, plan: 'not an object', timing: 42 };
    seed([storedChat([{ id: 1, role: 'user', text: 'hello' }, broken])]);
    const [chat] = await loadChats();

    expect(chat?.turns).toHaveLength(2);
    expect(chat?.turns[0]?.text).toBe('hello');
    expect(chat?.turns[1]?.response?.kind).toBe('plan-executed');
  });
});
