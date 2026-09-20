// The mission bar, stage 6 (spec §3.3).
//
// The bar it replaces wrapped: `flex-wrap` on a dense control cluster, put there
// in 2026 because the rightmost buttons were running off the panel edge. It
// took two rows at the 1280px default and THREE at the 960px minimum — a title
// row, a control row, and a row holding nothing but a second "New chat" — which
// is 122px of a 564px-tall view spent before the customer's first template.
//
// This stage removes the PRESSURE rather than the wrap: the duplicate New chat
// is gone, the subtitle is gone, the two pickers stop being form fields once the
// chat has settled what they say, and the bar was lifted out of the chat column
// into the deck so it is laid out in 872px at 1280 instead of 572.
//
// ⛔ WHAT MUST NOT CHANGE, and is pinned here because five other suites reach
// the bar through it: ONE `<select aria-label="Profile">` and ONE
// `<select aria-label="Model">`, native, with the same option text, the same
// `(needs your own key)` suffix, the same disabled options and the same lock
// titles; `Save as task` under exactly that name; `data-component=
// "agent-status-pill"`; and NOT `role="status"` — the no-key idle state must
// contain exactly one of those and it is the API-key gate card in the column.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { AgentSession } from '@driftstack/sdk';
import { NEEDS_OWN_KEY_SUFFIX } from '../../src/lib/chat-models';
import type { SessionStateDescriptor } from '../../src/lib/session-liveness';
import type { ChatModel } from '../../src/lib/use-agent-chat';
import { MissionBar } from '../../src/views/agent-chat/MissionBar';
import type { MissionStatusChat } from '../../src/views/agent-chat/mission-status';

const CSS = readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8');

/** A complete AgentSession, so this fixture adds nothing to the type backlog. */
function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'agt_bar',
    account_id: 'acc_1',
    driftstack_session_id: null,
    status: 'active',
    closed_reason: null,
    closed_at: null,
    token_budget_total: 100_000,
    token_budget_remaining: 82_000,
    transcript_length: 2,
    created_by_user_id: null,
    mode: 'ai',
    model: 'claude-sonnet-5',
    pair_mode_state: null,
    stop_on_exit_ip_change: false,
    created_at: '2026-06-15T06:00:00.000Z',
    updated_at: '2026-06-15T06:40:00.000Z',
    ...over,
  };
}

const READY: SessionStateDescriptor = {
  label: 'AI ready',
  tone: 'ready',
  title: 'Connected — the assistant is ready.',
};

interface BarOver {
  chat?: MissionStatusChat;
  sessionState?: SessionStateDescriptor;
  session?: AgentSession | null;
  hasOwnKey?: boolean | null;
  started?: boolean;
  sending?: boolean;
  canSaveRecipe?: boolean;
  stageShown?: boolean;
}

function renderBar(over: BarOver = {}): void {
  render(
    <MissionBar
      chat={over.chat ?? {}}
      sessionState={over.sessionState ?? READY}
      session={over.session ?? null}
      stageShown={over.stageShown ?? true}
      onToggleLiveView={() => undefined}
      profileId=""
      profiles={[{ id: 'prof_1', name: 'Retail research · DE' }]}
      onProfileChange={() => undefined}
      model="claude-sonnet-5"
      onModelChange={(_m: ChatModel) => undefined}
      hasOwnKey={over.hasOwnKey ?? true}
      started={over.started ?? false}
      sending={over.sending ?? false}
      canSaveRecipe={over.canSaveRecipe ?? false}
      onSaveAsTask={() => undefined}
    />,
  );
}

function pill(): HTMLElement {
  const el = document.querySelector('[data-component="agent-status-pill"]');
  if (el === null) throw new Error('no status pill');
  return el as HTMLElement;
}

/** The body of a top-level CSS rule, by selector. */
function rule(selector: string): string {
  const m = new RegExp(`(^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(CSS);
  // (a bare `[data-…]` selector is passed pre-escaped)
  if (m === null) throw new Error(`no CSS rule for ${selector}`);
  return m[2] ?? '';
}

afterEach(cleanup);

describe('the mission bar is one row', () => {
  it('⛔ has no wrap left to fall back on, and a cluster that shrinks instead', () => {
    // jsdom does not lay out, so this is a SOURCE pin and says so. The measured
    // half lives in the gallery: at 1280x800 and at 960x600 the bar is 52px and
    // 44px tall respectively — one row of each — which is one screenshot away
    // from any reader of this file.
    const bar = rule('.ai-bar');
    expect(bar).toContain('display: flex');
    expect(bar).not.toContain('wrap');
    // ONE height, read from a custom property the rail's overlay also hangs
    // from — so the two tiers cannot drift apart in two places.
    expect(bar).toContain('height: var(--ai-bar-h)');
    expect(rule('\\[data-ai-phase\\]')).toContain('--ai-bar-h: 52px');
    expect(rule('\\[data-ai-narrow\\]')).toContain('--ai-bar-h: 44px');
    // The cluster may shrink (the pickers ellipsize); it may not push its
    // rightmost button off the edge, which is the failure the wrap existed to
    // prevent and the reason this is not simply `flex-wrap: nowrap`.
    expect(rule('.ai-bar-r')).toContain('min-width: 0');
    // CONTROL: the reader really is finding rule bodies, not empty strings.
    expect(rule('.ai-bar-title')).toContain('white-space: nowrap');
  });

  it('⛔ carries no second New chat button — the rail owns that command', () => {
    renderBar({ started: true });
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ New chat' })).toBeNull();
  });

  it('drops the subtitle that said nothing the first screen does not', () => {
    renderBar();
    expect(screen.getByText('AI Browser Automation')).toBeTruthy();
    expect(screen.queryByText('natural-language automation')).toBeNull();
  });
});

describe('the status pill', () => {
  it('keeps the hook five suites find it by, and is NOT a live region', () => {
    renderBar();
    expect(pill().textContent).toBe('AI ready');
    expect(pill().getAttribute('title')).toBe(READY.title);
    // ⛔ `agent-chat-save-recipe` does `getByRole('status')` with no name in the
    // idle no-key state and expects the API-key gate card. A second one here
    // breaks it.
    expect(pill().getAttribute('role')).toBeNull();
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it('beats its pip only while something is actually running', () => {
    renderBar({ sessionState: { label: 'Running', tone: 'running', title: 'running' } });
    expect(pill().querySelector('.ai-pip')?.className).toContain('ai-beat-slow');
    cleanup();
    // ⛔ the pill that used to be unreadable grey text on grey: quiet ink now,
    // and a still pip.
    renderBar({ sessionState: { label: 'Stopping', tone: 'stopping', title: 'stopping' } });
    expect(pill().className).toContain('text-ink-secondary');
    expect(pill().className).not.toContain('text-status-idle');
    expect(pill().querySelector('.ai-pip')?.className).not.toContain('ai-beat');
  });

  it('says a decision is waiting, whatever the session thinks it is doing', () => {
    renderBar({
      chat: { pendingConfirmation: { category: 'purchase', matchedText: 'Place order · $104.00' } },
      sessionState: { label: 'Running', tone: 'running', title: 'running' },
    });
    expect(pill().textContent).toBe('Needs your approval');
    // …and it does not leak what the AI is about to buy into the bar.
    expect(pill().textContent).not.toContain('104');
  });
});

describe('the pickers lock into quiet context once the chat has settled them', () => {
  it('is still ONE native select each, with the same options and titles', () => {
    renderBar();
    const profile = screen.getByRole('combobox', { name: 'Profile' });
    const model = screen.getByRole('combobox', { name: 'Model' });
    expect(profile.tagName).toBe('SELECT');
    expect(model.tagName).toBe('SELECT');
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    expect(within_(profile, 'option')[0]?.textContent).toBe('Temporary profile (saves nothing)');
    expect(profile.getAttribute('title')).toMatch(/Which profile the agent works on/);
    expect((profile as HTMLSelectElement).disabled).toBe(false);
    expect(document.querySelectorAll('.ai-field[data-locked]')).toHaveLength(0);
  });

  it('⛔ locks on `started` OR a first send in flight, with the pinned titles', () => {
    for (const [what, over] of [
      ['started', { started: true }],
      ['first send', { sending: true }],
    ] as ReadonlyArray<[string, BarOver]>) {
      cleanup();
      renderBar(over);
      const profile: HTMLSelectElement = screen.getByRole('combobox', { name: 'Profile' });
      const model: HTMLSelectElement = screen.getByRole('combobox', { name: 'Model' });
      expect(profile.disabled, what).toBe(true);
      expect(model.disabled, what).toBe(true);
      expect(profile.getAttribute('title')).toBe(
        'Profile is locked for this chat — start a new chat to change it',
      );
      expect(model.getAttribute('title')).toBe(
        'Model is locked for the current chat — start a new chat to change it',
      );
      // drawn as settled context: both fields flagged, one lock glyph
      expect(document.querySelectorAll('.ai-field[data-locked]'), what).toHaveLength(2);
      expect(document.querySelectorAll('.ai-field-lock'), what).toHaveLength(1);
    }
  });

  it('marks own-key-only models only when the account is KNOWN to have no key', () => {
    renderBar({ hasOwnKey: false });
    const model = screen.getByRole('combobox', { name: 'Model' });
    const marked = within_(model, 'option').filter((o) =>
      o.textContent?.includes(NEEDS_OWN_KEY_SUFFIX),
    );
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((o) => (o as HTMLOptionElement).disabled)).toBe(true);
    // CONTROL — unknown (null) marks nothing, which is the rule that keeps a
    // slow /account/me from disabling half the picker.
    cleanup();
    renderBar({ hasOwnKey: null });
    expect(
      within_(screen.getByRole('combobox', { name: 'Model' }), 'option').filter((o) =>
        o.textContent?.includes(NEEDS_OWN_KEY_SUFFIX),
      ),
    ).toHaveLength(0);
  });
});

describe('Save as task', () => {
  it('is always labelled, and its icon is a drawing rather than a second word', () => {
    renderBar({ canSaveRecipe: true });
    const btn = screen.getByRole('button', { name: 'Save as task' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(btn.querySelector('[aria-hidden="true"] svg')).toBeTruthy();
  });

  it('says what would make it available, instead of just going grey', () => {
    renderBar({ canSaveRecipe: false });
    const btn = screen.getByRole('button', { name: 'Save as task' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute('title')).toBe('Available once a task has finished in this chat');
  });
});

describe('the AI budget', () => {
  it('is absent until there is a session to spend', () => {
    renderBar();
    expect(document.querySelector('.ai-budget')).toBeNull();
  });

  it('reads as one thing, and names what it is a budget OF', () => {
    renderBar({ session: session() });
    const budget = document.querySelector('.ai-budget');
    expect(budget?.textContent).toContain('82%');
    expect(budget?.textContent).toContain('left');
    // A percentage with no subject read as meaningless to a screen reader; the
    // three elements say one sentence.
    expect(budget?.getAttribute('aria-label')).toBe(
      "AI budget: 82% of this session's budget is left",
    );
    expect(budget?.getAttribute('title')).toBe(budget?.getAttribute('aria-label'));
    expect(budget?.hasAttribute('data-low')).toBe(false);
  });

  it('⛔ flags itself low, VALUELESSLY, so the narrow tier can keep it', () => {
    renderBar({ session: session({ token_budget_remaining: 9_000 }) });
    const budget = document.querySelector('.ai-budget');
    // `data-low={false}` would render as the string "false" and match
    // `[data-low]` — the whole bar would think every budget was low.
    expect(budget?.getAttribute('data-low')).toBe('');
    expect(budget?.textContent).toContain('9%');
    // CONTROL: one percent above the line and the flag is gone.
    cleanup();
    renderBar({ session: session({ token_budget_remaining: 20_000 }) });
    expect(document.querySelector('.ai-budget')?.hasAttribute('data-low')).toBe(false);
  });
});

describe('the live-view toggle says what it will do, and is named for what it is', () => {
  // ⛔ PIN MOVED IN STAGE 4, DELIBERATELY. This button used to carry the visible
  // words "Live view" / "Hide live" and to exist only below the `lg` VIEWPORT
  // breakpoint, where the live pane was hidden outright and this was the only
  // way to reach it. The stage is INLINE at every supported width now, so the
  // button has one job left — give the phone's room back to the conversation —
  // and it is an icon button whose `aria-pressed` says whether the stage is
  // showing. The ACCESSIBLE NAME is the half that did not move.
  it('keeps the accessible name `Toggle live view` exactly, at both states', () => {
    renderBar();
    expect(screen.getByRole('button', { name: 'Toggle live view' })).toBeTruthy();
    cleanup();
    renderBar({ stageShown: false });
    expect(screen.getByRole('button', { name: 'Toggle live view' })).toBeTruthy();
  });

  it('says whether the stage is showing, in `aria-pressed` and in the title', () => {
    renderBar({ stageShown: true });
    const shown = screen.getByRole('button', { name: 'Toggle live view' });
    expect(shown.getAttribute('aria-pressed')).toBe('true');
    expect(shown.getAttribute('title')).toBe('Hide the live view');
    cleanup();
    renderBar({ stageShown: false });
    const hidden = screen.getByRole('button', { name: 'Toggle live view' });
    expect(hidden.getAttribute('aria-pressed')).toBe('false');
    expect(hidden.getAttribute('title')).toBe('Show the live view');
  });

  it('⛔ carries no visible word of its own — the icon inside is aria-hidden', () => {
    // The name is `aria-label`; an icon that added a word would make the
    // button's accessible name something else and break the pinned lookup.
    renderBar();
    const btn = screen.getByRole('button', { name: 'Toggle live view' });
    expect(btn.textContent).toBe('');
    expect(btn.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });
});

/** Element children matching a selector, as an array. */
function within_(root: Element, selector: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)];
}
