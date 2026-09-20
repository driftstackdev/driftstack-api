// The history rail, stage 6 (spec §3.2).
//
// What it has to get right, and what each of those is protecting:
//
//   • THE DOT IS NEVER THE ONLY SIGNAL. Colour is the second reading of
//     something already readable. Every state the dot can show, the meta line
//     says in words — so these arms assert the WORDS and treat the class as the
//     decoration it is.
//   • ⛔ IT MUST NOT ASK `lib/chat-history` FOR A COLOUR. Four view tests mock
//     that module with saved chats and no `summariseTurn`, including both that
//     pin the own-key model picker. The spy arms below fail the moment a row
//     reaches for the prose summariser to decide its dot, which is the mistake
//     that would take four unrelated suites down.
//   • ⛔ EXACTLY ONE BUTTON IS NAMED `+ New chat`, at every width. It used to be
//     two (the bar's `New chat` and this one) and the exact-string pin resolved
//     only because of the plus; now the bar has none, and the 44px strip renders
//     its `+` INSTEAD of this button rather than beside it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type {
  AgentIntent,
  AgentIntentResult,
  AgentMessageResponse,
  AgentSession,
} from '@driftstack/sdk';
import type { StoredChat } from '../../src/lib/chat-history';
import type { ChatTurn } from '../../src/lib/use-agent-chat';
import type * as ChatHistoryModule from '../../src/lib/chat-history';
import type { LiveChatStatus } from '../../src/views/agent-chat/mission-status';

const h = vi.hoisted(() => ({
  chatTurnCount: vi.fn((c: { turns: ReadonlyArray<unknown> }) => c.turns.length),
  summariseTurn: vi.fn((t: ChatTurn) => ({
    role: t.role,
    headline: 'a line the rail only needs when a row is expanded',
  })),
}));

// The REAL module, with the two functions the rail may call wrapped in spies —
// so "did a row ask for this?" is a measurement, not a reading of the source.
vi.mock('../../src/lib/chat-history', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatHistoryModule>();
  return { ...actual, chatTurnCount: h.chatTurnCount, summariseTurn: h.summariseTurn };
});

const { ChatRail, railGroup } = await import('../../src/views/agent-chat/ChatRail');

/** The frozen clock every fixture below is measured against. */
const NOW = Date.parse('2026-06-15T09:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The union's every arm carries a session; a complete fixture is what keeps
 *  this file out of the pinned type backlog. */
const SESSION: AgentSession = {
  id: 'agt_rail',
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  closed_at: null,
  token_budget_total: 100_000,
  token_budget_remaining: 90_000,
  transcript_length: 2,
  created_by_user_id: null,
  mode: 'ai',
  model: 'claude-sonnet-5',
  pair_mode_state: null,
  stop_on_exit_ip_change: false,
  created_at: '2026-06-15T06:00:00.000Z',
  updated_at: '2026-06-15T06:40:00.000Z',
};

const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#buy' };
function ok(summary: string): AgentIntentResult {
  return { kind: 'success', intent: TAP, summary };
}
const PLAN_OK: AgentMessageResponse = {
  kind: 'plan-executed',
  session: SESSION,
  ok: true,
  intents: [TAP],
  results: [ok('Opened the store')],
  answer: 'Done.',
};

function chat(over: Partial<StoredChat> & Pick<StoredChat, 'id' | 'title'>): StoredChat {
  return {
    profileId: '',
    model: 'claude-sonnet-5',
    turns: [{ id: 1, role: 'user', text: 'Go to the store.' }],
    createdAt: NOW - DAY,
    updatedAt: NOW - HOUR,
    ...over,
  };
}

const TODAY_FINISHED = chat({
  id: 'c_today',
  title: 'Compare prices for a jacket',
  turns: [
    { id: 1, role: 'user', text: 'Compare the prices.' },
    { id: 2, role: 'agent', response: PLAN_OK },
  ],
  updatedAt: NOW - HOUR,
});
const YESTERDAY_IDLE = chat({
  id: 'c_yesterday',
  title: 'Sign up for the newsletter',
  updatedAt: NOW - DAY,
});
const EARLIER_STOPPED = chat({
  id: 'c_earlier',
  title: 'Add three items to the cart and stop',
  turns: [
    { id: 1, role: 'user', text: 'Add three items.' },
    {
      id: 2,
      role: 'agent',
      interrupted: { reason: 'Stopped after step 2 of 5, as you asked.', steps: [ok('Opened')] },
    },
  ],
  updatedAt: NOW - 4 * DAY,
});

const CHATS = [TODAY_FINISHED, YESTERDAY_IDLE, EARLIER_STOPPED];

function renderRail(
  over: {
    chats?: ReadonlyArray<StoredChat>;
    activeId?: string;
    busy?: boolean;
    narrow?: boolean;
    liveStatus?: LiveChatStatus | null;
  } = {},
): void {
  render(
    <ChatRail
      chats={over.chats ?? CHATS}
      activeId={over.activeId ?? ''}
      busy={over.busy ?? false}
      narrow={over.narrow ?? false}
      liveStatus={over.liveStatus ?? null}
      onNew={() => undefined}
      onSelect={() => undefined}
      onDelete={() => undefined}
    />,
  );
}

/** The row for the saved chat with this exact title. Found through the pinned
 *  title span rather than by accessible name: the expander and the delete
 *  button are named after the chat too, so a name query matches three. */
function row(title: string): HTMLElement {
  const el = document.querySelector(`.ai-rail-open [title="${title}"]`)?.closest('.ai-rail-row');
  if (el === null || el === undefined) throw new Error(`no row for "${title}"`);
  return el as HTMLElement;
}

beforeEach(() => {
  vi.setSystemTime(NOW);
  h.chatTurnCount.mockClear();
  h.summariseTurn.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the history rail groups chats by day', () => {
  it('heads each group once, newest first', () => {
    renderRail();
    const groups = document.querySelectorAll('.ai-rail-group');
    expect([...groups].map((g) => g.textContent)).toEqual(['Today', 'Yesterday', 'Earlier']);
  });

  it('groups by CALENDAR day, not by elapsed hours', () => {
    // ⚠️ LOCAL time, deliberately: "yesterday" is a thing the customer's own
    // calendar decides, so the fixtures are built the way a customer's clock
    // would read them and the arm holds in any timezone the runner is in.
    const justAfterMidnight = new Date(2026, 5, 15, 0, 10).getTime();
    const lateLastNight = new Date(2026, 5, 14, 23, 50).getTime();
    const lateTonight = new Date(2026, 5, 15, 23, 50).getTime();
    // twenty minutes old, and already Yesterday
    expect(railGroup(lateLastNight, justAfterMidnight)).toBe('Yesterday');
    // …and twenty-three hours old, and still Today
    expect(railGroup(justAfterMidnight, lateTonight)).toBe('Today');
    expect(railGroup(new Date(2026, 5, 12, 12, 0).getTime(), justAfterMidnight)).toBe('Earlier');
  });

  it('does not repeat a heading for two chats from the same day', () => {
    renderRail({ chats: [TODAY_FINISHED, chat({ id: 'c2', title: 'Another', updatedAt: NOW })] });
    expect([...document.querySelectorAll('.ai-rail-group')].map((g) => g.textContent)).toEqual([
      'Today',
    ]);
  });
});

describe('the history rail says how each chat ended', () => {
  it('says a chat that did not finish in WORDS, and dresses it red', () => {
    renderRail();
    const stopped = row('Add three items to the cart and stop');
    expect(stopped.textContent).toContain('Didn’t finish');
    expect(stopped.querySelector('.ai-rail-dot')?.className).toContain('ai-rail-dot-bad');
    // CONTROL: the finished chat says neither, so the arm measures the outcome
    // and not the presence of a meta line.
    const finished = row('Compare prices for a jacket');
    expect(finished.textContent).not.toContain('Didn’t finish');
    expect(finished.querySelector('.ai-rail-dot')?.className).toContain('ai-rail-dot-ok');
  });

  it('keeps the turn count and the time for a chat that has nothing to report', () => {
    renderRail();
    const quiet = row('Sign up for the newsletter');
    expect(quiet.textContent).toContain('1 turn · yesterday');
    expect(quiet.querySelector('.ai-rail-dot')?.className).toContain('ai-rail-dot-idle');
  });

  it('a clipped meta line carries its full text, as a clipped title does', () => {
    renderRail();
    const meta = row('Sign up for the newsletter').querySelector('.ai-rail-meta');
    expect(meta?.getAttribute('title')).toMatch(/^1 turn · updated /);
    // the pinned title span is untouched by the re-cut
    const title = row('Sign up for the newsletter').querySelector('.truncate');
    expect(title?.getAttribute('title')).toBe('Sign up for the newsletter');
  });
});

describe('the history rail says what the chat it is working on is doing', () => {
  it('replaces the timestamp with the step, and beats the dot', () => {
    renderRail({
      activeId: TODAY_FINISHED.id,
      liveStatus: { meta: 'Running · step 4 of 6', dot: 'running' },
    });
    const active = row('Compare prices for a jacket');
    expect(active.textContent).toContain('Running · step 4 of 6');
    expect(active.textContent).not.toContain('1 turn ·');
    const dot = active.querySelector('.ai-rail-dot');
    expect(dot?.className).toContain('ai-rail-dot-run');
    // ONE rhythm across the view — the same class the bar's Running pip wears.
    expect(dot?.className).toContain('ai-beat-slow');
  });

  it('says an approval is waiting, and holds the dot still', () => {
    renderRail({
      activeId: TODAY_FINISHED.id,
      liveStatus: { meta: 'Needs your approval', dot: 'approval' },
    });
    const active = row('Compare prices for a jacket');
    expect(active.textContent).toContain('Needs your approval');
    const dot = active.querySelector('.ai-rail-dot');
    expect(dot?.className).toContain('ai-rail-dot-wait');
    expect(dot?.className).not.toContain('ai-beat');
  });

  it('only the ACTIVE row is described that way', () => {
    renderRail({
      activeId: TODAY_FINISHED.id,
      liveStatus: { meta: 'Running · step 4 of 6', dot: 'running' },
    });
    expect(row('Sign up for the newsletter').textContent).not.toContain('Running');
    expect(document.querySelectorAll('.ai-rail-dot-run')).toHaveLength(1);
  });
});

describe('the history rail asks chat-history for a count, never for a colour', () => {
  it('⛔ decides every dot without touching summariseTurn', () => {
    renderRail();
    // Three rows, three outcomes, and the prose summariser was never called —
    // which is what lets four view tests mock this module without it.
    expect(document.querySelectorAll('.ai-rail-dot')).toHaveLength(3);
    expect(h.summariseTurn).not.toHaveBeenCalled();
  });

  it('CONTROL — expanding a row DOES call it, so the spy is wired to something', () => {
    renderRail();
    fireEvent.click(
      screen.getByRole('button', { name: 'Show what happened in Compare prices for a jacket' }),
    );
    expect(h.summariseTurn).toHaveBeenCalled();
  });

  it('⛔ an empty rail counts nothing', () => {
    renderRail({ chats: [] });
    expect(screen.getByText(/Your chats are saved here/)).toBeTruthy();
    expect(h.chatTurnCount).not.toHaveBeenCalled();
    // CONTROL: a rail with rows does count, so the arm is not measuring a spy
    // nobody ever calls.
    cleanup();
    renderRail();
    expect(h.chatTurnCount).toHaveBeenCalled();
  });
});

describe('the rail has exactly one New chat button, at every width', () => {
  it('is named "+ New chat" on the full rail', () => {
    renderRail();
    expect(screen.getAllByRole('button', { name: '+ New chat' })).toHaveLength(1);
    // ⛔ and NOT "New chat" — the exact string the bar's second button used to
    // answer to. Two buttons made `getByRole` ambiguous; one wrong name makes
    // the pin resolve to the wrong button.
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
  });

  it('is named "+ New chat" in the 44px strip too — and is still only one', () => {
    renderRail({ narrow: true });
    expect(screen.getAllByRole('button', { name: '+ New chat' })).toHaveLength(1);
    // the full rail's copy is not rendered at all, so it cannot be found by a
    // query that does not know about CSS
    expect(document.querySelectorAll('.ai-rail-new')).toHaveLength(0);
  });

  it('is disabled while a reply is in flight, at both widths, with the reason', () => {
    for (const narrow of [false, true]) {
      cleanup();
      renderRail({ narrow, busy: true });
      const btn = screen.getByRole('button', { name: '+ New chat' });
      expect((btn as HTMLButtonElement).disabled, `narrow=${String(narrow)}`).toBe(true);
      expect(btn.getAttribute('title')).toBe('Finish or stop the current reply first');
    }
  });
});

describe('the 44px strip opens the list as an overlay', () => {
  it('offers the chats behind a named, expandable button with a count', () => {
    renderRail({ narrow: true });
    const show = screen.getByRole('button', { name: 'Show chats' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    expect(within(show).getByText('3')).toBeTruthy();
    expect(document.querySelector('.ai-rail')?.hasAttribute('data-open')).toBe(false);
  });

  it('opens on click and closes on Escape', () => {
    renderRail({ narrow: true });
    const show = screen.getByRole('button', { name: 'Show chats' });
    fireEvent.click(show);
    expect(show.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.ai-rail')?.hasAttribute('data-open')).toBe(true);
    // the panel it names is the one that opened
    expect(show.getAttribute('aria-controls')).toBe('ai-rail-panel');
    expect(document.getElementById('ai-rail-panel')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.ai-rail')?.hasAttribute('data-open')).toBe(false);
  });

  it('⛔ never claims to be open at a width where the list is simply on screen', () => {
    // A rail left "open" by a resize would keep a focus trap around a panel
    // that is part of the page.
    const { rerender } = render(
      <ChatRail
        chats={CHATS}
        activeId=""
        busy={false}
        narrow
        liveStatus={null}
        onNew={() => undefined}
        onSelect={() => undefined}
        onDelete={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    expect(document.querySelector('.ai-rail')?.hasAttribute('data-open')).toBe(true);
    rerender(
      <ChatRail
        chats={CHATS}
        activeId=""
        busy={false}
        narrow={false}
        liveStatus={null}
        onNew={() => undefined}
        onSelect={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(document.querySelector('.ai-rail')?.hasAttribute('data-open')).toBe(false);
  });

  it('⛔ answering the list closes it — a chat picked, or a new one started', () => {
    // ⛔ REVIEW REPAIR (2026-09-20). Measured in a browser at 960x600 before it:
    // picking a chat left the overlay open over 232px of a 692px mission
    // column, so the chat the customer had just asked for was hidden behind the
    // panel they asked with — at the one width this stage exists to buy room
    // at. Closing is also what keeps the keyboard honest: the focused row is
    // inside a panel that becomes `display: none`, and `useFocusTrap`'s cleanup
    // puts focus back on `Show chats`.
    const picked: string[] = [];
    let started = 0;
    const deleted: string[] = [];
    const renderRailWithSpies = (narrow: boolean): void => {
      render(
        <ChatRail
          chats={CHATS}
          activeId=""
          busy={false}
          narrow={narrow}
          liveStatus={null}
          onNew={() => {
            started += 1;
          }}
          onSelect={(c) => {
            picked.push(c.id);
          }}
          onDelete={(id) => {
            deleted.push(id);
          }}
        />,
      );
    };
    const isOpen = (): boolean =>
      document.querySelector('.ai-rail')?.hasAttribute('data-open') ?? false;
    const show = (): HTMLElement => screen.getByRole('button', { name: 'Show chats' });
    const openRow = (title: string): HTMLElement => {
      const el = row(title).querySelector('.ai-rail-open');
      if (el === null) throw new Error(`no open-button for "${title}"`);
      return el as HTMLElement;
    };

    renderRailWithSpies(true);
    fireEvent.click(show());
    expect(isOpen()).toBe(true);
    fireEvent.click(openRow(TODAY_FINISHED.title));
    expect(picked, 'the chat still reaches the view').toEqual([TODAY_FINISHED.id]);
    expect(isOpen(), 'the list is still covering the chat it just opened').toBe(false);
    expect(show().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(show());
    expect(isOpen()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '+ New chat' }));
    expect(started).toBe(1);
    expect(isOpen()).toBe(false);

    // CONTROL ONE: deleting is list housekeeping, not an answer — the list
    // stays open so the next one can go too. Without this arm, "close on
    // everything" would pass the two above just as well.
    fireEvent.click(show());
    expect(isOpen()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: `Delete chat ${EARLIER_STOPPED.title}` }));
    expect(deleted).toEqual([EARLIER_STOPPED.id]);
    expect(isOpen(), 'a delete must not dismiss the list').toBe(true);

    // CONTROL TWO: the full rail is untouched — no strip, no overlay to close,
    // and the chat still reaches the view. (`setOpen(false)` on an already
    // closed overlay is the no-op this depends on.)
    cleanup();
    picked.length = 0;
    renderRailWithSpies(false);
    fireEvent.click(openRow(YESTERDAY_IDLE.title));
    expect(picked).toEqual([YESTERDAY_IDLE.id]);
    expect(document.querySelector('.ai-rail-mini')).toBeNull();
  });

  it('carries the live state on the strip, so a collapsed rail still reports it', () => {
    renderRail({ narrow: true, liveStatus: { meta: 'Needs your approval', dot: 'approval' } });
    expect(document.querySelector('.ai-rail-mini-dot')?.className).toContain('ai-rail-dot-wait');
    // CONTROL: with nothing running there is no dot at all.
    cleanup();
    renderRail({ narrow: true });
    expect(document.querySelector('.ai-rail-mini-dot')).toBeNull();
  });
});

describe('the rail keeps the names the rest of the app reaches it by', () => {
  it('expander and delete are unchanged', () => {
    renderRail();
    const expander = screen.getByRole('button', {
      name: 'Show what happened in Compare prices for a jacket',
    });
    expect(expander.getAttribute('aria-expanded')).toBe('false');
    expect(expander.getAttribute('aria-controls')).toBe('chat-turns-c_today');
    fireEvent.click(expander);
    expect(
      screen.getByRole('button', { name: 'Hide what happened in Compare prices for a jacket' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Delete chat Compare prices for a jacket' }),
    ).toBeTruthy();
  });
});
