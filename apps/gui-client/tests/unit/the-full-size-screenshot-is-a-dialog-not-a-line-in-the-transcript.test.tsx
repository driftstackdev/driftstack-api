// The screenshot a turn captured opens FULL SIZE, and where it opens matters
// more than how it looks.
//
// ⛔ THE DEFECT THIS FILE PINS SHUT. Until now the full-size view rendered
// exactly where it sits in the React tree — inside the log's
// `<ol aria-live="polite" aria-relevant="additions">`. Opening it therefore
// inserted a `role="dialog"` and its whole subtree into a POLITE LIVE REGION as
// an addition, and a screen reader read the modal out as though the AI had just
// said it. Five stages of review carried the finding forward ("one-line portal
// fix", rounds B and C) without anything being able to fail when it regressed.
//
// Two more things travelled with that placement, and both are measured here or
// in the browser rather than asserted from the diff:
//
//   • LAYERING. `.ai-deck-body` is `position: relative; z-index: 0` — an
//     explicit stacking CONTEXT, so the stage's room light and HUD chips cannot
//     paint over the bar. A `fixed inset-0 z-50` backdrop INSIDE that context is
//     sealed in at 0, under the rail (3, and 41 while its narrow-tier overlay is
//     open) and under the bar (3). Measured in a real browser at 960x600 with
//     the rail overlay open: a probe element with exactly the old placement and
//     z-index reports `ASIDE.ai-rail` as the topmost element over the rail's own
//     column, and the portalled dialog reports itself. jsdom lays nothing out,
//     so what this file can pin is the stacking context's declaration; the
//     covering is a browser fact and lives in the stage report.
//   • THE CONTAINER-QUERY TRAP. `container-type` makes an element a containing
//     block for `position: fixed` descendants, which is why the view's tiers are
//     measured rather than queried (`the-ai-view-puts-the-stage-in-reading-
//     order`). This modal was one of the two `fixed inset-0` descendants keeping
//     that door shut. The save-as-task dialog is still the other one.
//
// ⛔ THE ACCESSIBLE NAMES TESTS PIN ARE UNTOUCHED. The thumbnail is still the
// button named "Open the screenshot the agent captured on this step" in the same
// place in the card, and the image inside is still `CaptureThumbnail` with the
// alt text `capture-thumbnail.test.tsx` pins. Only the layer the full-size copy
// opens on is new.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AgentMessageResponse, AgentSession } from '@driftstack/sdk';
import type * as UseAgentChatModule from '../../src/lib/use-agent-chat';
import type { ChatTurn, UseAgentChatResult } from '../../src/lib/use-agent-chat';

const CSS_SOURCE = readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8');
/** The stylesheet with its comments stripped — the CSS sibling of the repo's
 *  `codeOnly` rule. The comment ABOVE `.ai-deck-body` explains the z-index at
 *  length, so a scan that read comments would pass on the prose alone. */
const CSS = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');

const h = vi.hoisted(() => ({
  livekitToken: vi.fn<(id: string) => Promise<{ ws_url: string; room: string; token: string }>>(),
  getSession: vi.fn<(id: string) => Promise<unknown>>(),
}));

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        iterate: function* iterate(): Generator<{ id: string; name: string }, void, void> {
          /* no profiles */
        },
      },
      agentSessions: { livekitToken: h.livekitToken, get: h.getSession },
    },
    settings: { apiKey: 'sk-test', baseUrl: 'https://api.example.com' },
  };
  return { useSettings: () => stable };
});
vi.mock('../../src/lib/toasts', () => ({ useToasts: () => ({ push: vi.fn() }) }));
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
}));
vi.mock('../../src/lib/chat-history', () => ({
  loadChats: () => Promise.resolve([]),
  upsertChat: () => Promise.resolve([]),
  deleteChat: () => Promise.resolve([]),
  deriveChatTitle: () => 'Chat',
}));

const SESSION: AgentSession = {
  id: 'agt_shot',
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
  stop_on_exit_ip_change: false,
  pair_mode_state: null,
  created_at: '2026-06-15T06:00:00.000Z',
  updated_at: '2026-06-15T06:40:00.000Z',
};

/** The gallery seam: an image every `CaptureThumbnail` shows instead of
 *  fetching. Nothing here talks to a capture route. */
const SHOT_SRC = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';

const NAV = { kind: 'navigate', url: 'https://shop.example.com' } as const;
const SHOT = { kind: 'capture', capture: 'screenshot' } as const;

/**
 * A settled turn with an answer and a screenshot. THREE results, with the
 * capture in the MIDDLE: the step the dialog names is 2, which is neither the
 * number of results (3) nor the last one — so a name built from the wrong
 * number cannot pass by coincidence.
 */
function shotTurn(): ChatTurn {
  const response = {
    kind: 'plan-executed',
    session: SESSION,
    intents: [NAV, SHOT, NAV],
    results: [
      { kind: 'success', intent: NAV, summary: 'Opened the store' },
      { kind: 'success', intent: SHOT, summary: 'Captured the product page', captureId: 'cap_1' },
      { kind: 'success', intent: NAV, summary: 'Opened the basket' },
    ],
    ok: true,
    answer: 'The Ridgeline Trail 2 is $104.00 and US size 10 is in stock.',
  } as AgentMessageResponse;
  return { id: 2, role: 'agent', response };
}

let chatState: UseAgentChatResult;
vi.mock('../../src/lib/use-agent-chat', async (importOriginal) => {
  const actual = await importOriginal<typeof UseAgentChatModule>();
  return { ...actual, useAgentChat: () => chatState };
});

const { AgentChatView } = await import('../../src/views/AgentChatView');
const { AgentChatProvider } = await import('../../src/lib/AgentChatProvider');

function baseChat(over: Partial<UseAgentChatResult> = {}): UseAgentChatResult {
  return {
    turns: [],
    session: SESSION,
    sending: false,
    liveSteps: [],
    livePhase: null,
    livePlan: null,
    liveStepIndex: null,
    liveAnswer: null,
    error: null,
    pendingConfirmation: null,
    deniedTurnIds: new Set<number>(),
    approvedTurnIds: new Set<number>(),
    restoredHistoryCount: 0,
    restoredSessionId: null,
    adopting: false,
    adoptError: null,
    stopping: false,
    stoppedTurnStillRunning: false,
    send: vi.fn(() => Promise.resolve(true)),
    lastSendKeptMessage: vi.fn(() => false),
    approve: vi.fn(() => Promise.resolve()),
    deny: vi.fn(),
    reset: vi.fn(),
    restore: vi.fn(),
    adopt: vi.fn(),
    cancel: vi.fn(),
    ...over,
  };
}

const USER_TURN: ChatTurn = {
  id: 1,
  role: 'user',
  text: 'Find the best-rated trail shoe under $120 and screenshot it',
};

function Wrapper({ children }: { children: ReactNode }): JSX.Element {
  return <AgentChatProvider value={{ captureSrc: SHOT_SRC }}>{children}</AgentChatProvider>;
}

/** The log's live region. Asserting the dialog is not inside "any aria-live"
 *  is vacuous if there is no live region at all, so every arm that uses it
 *  takes it through here, which throws when the region is gone. */
function liveRegion(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[aria-live="polite"][aria-relevant="additions"]');
  if (el === null) throw new Error('the log has no polite live region');
  return el;
}

/** Every text node under `el`, joined. `textContent` alone would miss a node
 *  ADDED as a sibling of identical text; this is what "announced as an
 *  addition" actually means to a screen reader. */
function textNodes(el: Element): string[] {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  while (walk.nextNode()) out.push(walk.currentNode.textContent ?? '');
  return out;
}

/** The thumbnail that opens the full-size view. Held as an element because
 *  opening the dialog hides the page behind it from the a11y tree, and a
 *  `getByRole` re-query would then stop finding it — correctly. */
function thumbnail(): HTMLElement {
  return screen.getByRole('button', {
    name: 'Open the screenshot the agent captured on this step',
  });
}

/** The open dialog, found by DOM rather than by role.
 *
 *  ⛔ DELIBERATELY NOT `getByRole`. A dialog rendered back inside the view
 *  would sit under the `aria-hidden` this component puts on the page behind
 *  it, and `getByRole` would then fail with "no accessible roles" — a true
 *  failure that names the wrong defect. Queried this way, the arm below fails
 *  on the sentence it is about: the dialog is inside a live region. The
 *  accessible name and the a11y-tree reachability get their own arm. */
function openDialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  if (el === null) throw new Error('the full-size screenshot did not open');
  return el;
}

function closedDialog(): Element | null {
  return document.querySelector('[role="dialog"]');
}

function openShot(): { thumb: HTMLElement; dialog: HTMLElement } {
  const thumb = thumbnail();
  // A real pointer click focuses the button it lands on; jsdom's `click` does
  // not, and the restore this file checks is about where the keyboard was.
  thumb.focus();
  fireEvent.click(thumb);
  return { thumb, dialog: openDialog() };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.livekitToken.mockResolvedValue({ ws_url: 'ws://x', room: 'r', token: 't' });
  h.getSession.mockResolvedValue(SESSION);
  chatState = baseChat({ turns: [USER_TURN, shotTurn()] });
});
afterEach(cleanup);

describe('the full-size screenshot opens outside the transcript', () => {
  it('⛔ is not a descendant of any aria-live element — it is portalled to the document body', () => {
    render(<AgentChatView />, { wrapper: Wrapper });
    // CONTROL: the live region exists, and the thumbnail really is inside it,
    // so "the dialog is not in a live region" is a fact about placement and not
    // about a region that is missing.
    const region = liveRegion();
    expect(region.contains(thumbnail())).toBe(true);

    const { dialog } = openShot();
    for (const live of Array.from(document.querySelectorAll('[aria-live]'))) {
      expect(live.contains(dialog), `announced by ${live.tagName}[aria-live]`).toBe(false);
    }
    expect(region.contains(dialog)).toBe(false);
    // It is not merely outside the log — it is outside the VIEW, at the end of
    // the body, which is what puts its z-index back in the root stacking
    // context (see the header).
    expect(document.querySelector('.ai-view')?.contains(dialog)).toBe(false);
    expect(document.querySelector('.ai-deck-body')?.contains(dialog)).toBe(false);
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it('⛔ adds no text inside the live region, so the transcript is not re-announced', () => {
    render(<AgentChatView />, { wrapper: Wrapper });
    const region = liveRegion();
    const before = textNodes(region);
    // CONTROL: the region HAS text. Two empty lists are equal, and that
    // comparison would pass on a log that rendered nothing at all.
    expect(before.length).toBeGreaterThan(5);

    openShot();
    expect(textNodes(region)).toEqual(before);
    expect(region.querySelector('[role="dialog"]')).toBeNull();
  });

  it('moves focus into the dialog on open, and back to the thumbnail on close', () => {
    render(<AgentChatView />, { wrapper: Wrapper });
    const { thumb, dialog } = openShot();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(closedDialog()).toBeNull();
    expect(document.activeElement).toBe(thumb);
  });

  it('closes on Escape, and the keyboard still goes back to the thumbnail', () => {
    render(<AgentChatView />, { wrapper: Wrapper });
    const { thumb } = openShot();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closedDialog()).toBeNull();
    expect(document.activeElement).toBe(thumb);
  });

  it('closes on a click on the backdrop, and NOT on a click inside the picture', () => {
    render(<AgentChatView />, { wrapper: Wrapper });
    const { dialog } = openShot();
    const backdrop = dialog.parentElement;
    if (backdrop === null) throw new Error('the dialog has no backdrop');

    // The negative first: a click that lands on the dialog must not dismiss it.
    fireEvent.click(dialog);
    expect(closedDialog()).not.toBeNull();

    fireEvent.click(backdrop);
    expect(closedDialog()).toBeNull();
  });

  it('traps Tab inside the dialog', () => {
    render(<AgentChatView />, { wrapper: Wrapper });
    const { dialog } = openShot();
    // Tab is intercepted and wrapped — `fireEvent` returns false when the
    // handler called preventDefault.
    expect(fireEvent.keyDown(window, { key: 'Tab' })).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    // CONTROL: the trap intercepts Tab, not every key — an unconditional
    // preventDefault would satisfy both lines above.
    expect(fireEvent.keyDown(window, { key: 'ArrowDown' })).toBe(true);
  });

  it('⛔ makes the page behind it inert and silent, and gives it back on close', () => {
    const { container } = render(<AgentChatView />, { wrapper: Wrapper });
    // CONTROL: nothing is hidden before it opens.
    expect(container.getAttribute('aria-hidden')).toBeNull();
    expect(container.getAttribute('inert')).toBeNull();

    const { thumb } = openShot();
    expect(container.getAttribute('aria-hidden')).toBe('true');
    expect(container.getAttribute('inert')).toBe('');
    // …and the dialog's own layer is NOT hidden with it.
    const dialog = openDialog();
    expect(dialog.closest('[aria-hidden="true"]')).toBeNull();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.getAttribute('aria-hidden')).toBeNull();
    expect(container.getAttribute('inert')).toBeNull();
    expect(document.activeElement).toBe(thumb);
  });

  it('is named for the step its screenshot came from, in words the eye can read too', () => {
    render(<AgentChatView />, { wrapper: Wrapper });
    const { dialog } = openShot();
    // The name is not an aria-label only a screen reader reaches: it is the
    // caption the dialog draws, referenced by id.
    // Computed by the accessibility tree, not read off the attribute I wrote —
    // and this query can only find it because the dialog's own layer is the one
    // thing NOT hidden behind `aria-hidden` while it is open.
    expect(screen.getByRole('dialog', { name: 'Screenshot from step 2' })).toBe(dialog);
    const id = dialog.getAttribute('aria-labelledby');
    expect(id).not.toBeNull();
    const caption = id === null ? null : document.getElementById(id);
    expect(caption?.textContent).toBe('Screenshot from step 2');
    expect(dialog.contains(caption)).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The capture is the SECOND of three results, so a name built from the
    // result COUNT would say 3 and a name built from "the last step" would too.
    expect(caption?.textContent).not.toContain('3');
  });

  it('⛔ keeps the thumbnail exactly where it was, with the name and the alt text tests pin', () => {
    render(<AgentChatView />, { wrapper: Wrapper });
    const thumb = thumbnail();
    expect(liveRegion().contains(thumb)).toBe(true);
    expect(thumb.className).toContain('ai-shot');
    expect(within(thumb).getByAltText('Screenshot the agent captured on this step')).toBeTruthy();
    // The full-size copy is the same component, same alt — a customer must not
    // be shown two different pictures.
    const { dialog } = openShot();
    expect(within(dialog).getByAltText('Screenshot the agent captured on this step')).toBeTruthy();
  });
  it('opens with the shared modal motion, which the global reduced-motion clamp stills', () => {
    render(<AgentChatView />, { wrapper: Wrapper });
    const { dialog } = openShot();
    // The two shared classes, so the dialog inherits the app's one modal
    // gesture rather than declaring a second one — and both keyframes animate
    // `opacity` / `transform` only.
    expect(dialog.className).toContain('animate-modal-panel-in');
    expect(dialog.parentElement?.className).toContain('animate-modal-backdrop-in');
    for (const name of ['ds-modal-panel-in', 'ds-modal-backdrop-in']) {
      const frames = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(CSS)?.[1] ?? '';
      expect(frames, `${name} must be declared`).not.toBe('');
      expect(
        frames.replace(/transform:|opacity:/g, ''),
        `${name} animates transform/opacity only`,
      ).not.toMatch(/^\s*[a-z-]+\s*:/m);
    }
    // The STILL is the global clamp, not a second set of rules to keep in step:
    // both animations are one-shot with `both`, so a duration of 0.01ms lands
    // them on their last frame — the dialog simply appears.
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(CSS)?.[1];
    expect(reduced).toMatch(/\*,\s*\*::before,\s*\*::after/);
    expect(reduced).toContain('animation-duration: 0.01ms !important');
  });
});

describe('the layer the dialog left', () => {
  it('⛔ `.ai-deck-body` is an explicit stacking context, which is what sealed the old z-50 in', () => {
    // This is the OTHER half of the defect and the reason the portal is not a
    // stylistic preference: `z-index: auto` here would have let the old inline
    // `z-50` compete in the root context and paint correctly, and an explicit
    // `0` — which the view needs, so the stage's own layers cannot cover the
    // bar — seals it under the rail instead. Both facts are true at once, and
    // only moving the dialog out satisfies both.
    const body = /(^|\n)\.ai-deck-body \{([^}]*)\}/.exec(CSS)?.[2] ?? '';
    expect(body).toContain('position: relative');
    expect(body).toMatch(/z-index:\s*0\b/);
    // CONTROL: the reader really is reading this rule and not an empty string.
    expect(body).toContain('flex: 1');
  });

  it('the rail and its overlay still sit UNDER a root-context modal', () => {
    // The rail is raised to 41 while its narrow-tier overlay is open, and the
    // comment beside it promises that 41 "stays under the save-as-task dialog
    // and the screenshot lightbox, which are both z-50". That promise was only
    // true for a modal in the ROOT context — which, from today, this one is.
    const open = /\[data-ai-narrow\] \.ai-rail\[data-open\] \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(open).toMatch(/z-index:\s*41\b/);
    const panel = /\[data-ai-narrow\] \.ai-rail\[data-open\] \.ai-rail-panel \{([^}]*)\}/.exec(
      CSS,
    )?.[1];
    expect(panel).toContain('z-index: 40');
  });

  it('⛔ the picture leaves room for the caption row under it, at the smallest window too', () => {
    // A `vh` cap sizes the picture as if it were the dialog's only child. It is
    // not: picture + 12px gap + the 36px caption row, inside a backdrop padded
    // 32px top and bottom. Measured in a browser at the Tauri MINIMUM height of
    // 600: with `82vh` alone the panel overflowed its own `max-h-full` box and
    // the caption row survived only on the backdrop's bottom padding, by 2px.
    // With the second term the panel fits at 800, 640, 600, 560, 520 and 480,
    // and the picture at 800 is exactly the size it was (656px).
    //
    // jsdom loads no stylesheet, so there is no computed height to read here —
    // the stylesheet's own text is the only place this fact exists to check.
    const img = /(^|\n)\.ai-lightbox-img \{([^}]*)\}/.exec(CSS)?.[2] ?? '';
    expect(img).toMatch(/max-height:\s*min\(82vh,\s*calc\(100vh - 120px\)\)/);
    // CONTROL: the rule was found and really is the full-size image's.
    expect(img).toContain('max-width: 100%');
  });
});
