// The layout re-cut: rail → bar → stage → mission, in that order, in the DOM.
//
// Stage 4 of the AI-view rebuild (spec §1). DOM order = visual order = focus
// order is not a slogan here, it is the fix: the live pane used to be the LAST
// child of the deck, which put a slide-over's close button after the composer
// in the tab order, and below the `lg` viewport breakpoint it was hidden
// outright at exactly the window size a customer on a laptop has.
//
// Three things this file pins that no screenshot can show:
//
//   1. THE ORDER, because a keyboard user reads the view in it.
//   2. ⛔ THE CONTAINER-QUERY TRAP. Spec §1 writes the reflow as
//      `@container aiview (…)`. `container-type` makes an element a containing
//      block for `position: fixed` DESCENDANTS, and the view root still holds
//      one: the save-as-task dialog's `fixed inset-0` backdrop. Declaring the
//      container on the view would silently shrink it to the view it sits in.
//      ⛔ THE COUNT IS ONE, NOT THREE, AND BOTH CORRECTIONS ARE MEASURED. The
//      screenshot lightbox was the second and is now portalled to
//      `document.body` — see `the-full-size-screenshot-is-a-dialog-not-a-line-
//      in-the-transcript`. The rail's narrow-tier overlay was never the third:
//      `[data-ai-narrow] .ai-rail[data-open] .ai-rail-panel` is `position:
//      absolute`, so no container declared on the view can change where it
//      lands. The tiers are MEASURED anyway (`use-view-width.ts`), the path the two
//      WebViews with no `cq` units at all take; the one container query left is
//      `.ai-fit`, which has no fixed descendant and needs `100cqh`.
//   3. THE STAGE IS A DARK ROOM IN BOTH THEMES (spec D2). `AgentSessionPanel`'s
//      overlays are `ink-primary` on black with no scope of their own, so in the
//      light theme they resolved to near-black on black — a defect the
//      constraints map recorded and nothing could measure, because no fixture
//      reached those overlays. The pinned `data-mode="dark"` on the section is
//      what fixes it, for the panel and for everything else drawn in the screen.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentSession } from '@driftstack/sdk';
import type { UseAgentChatResult } from '../../src/lib/use-agent-chat';

const CSS_SOURCE = readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8');
/** The stylesheet with its comments removed — the CSS sibling of the repo's
 *  `codeOnly` rule. This file's own prose says `container-type` several times,
 *  and so does the stylesheet's; a scan that read them would be a scan that can
 *  never go green. */
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
    settings: { apiKey: 'sk-test', baseUrl: 'https://api.example.test' },
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
  id: 'agt_layout',
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
    send: () => Promise.resolve(false),
    lastSendKeptMessage: () => false,
    approve: () => Promise.resolve(),
    deny: () => undefined,
    reset: () => undefined,
    cancel: () => undefined,
    stopping: false,
    stoppedTurnStillRunning: false,
    restore: () => undefined,
    adopt: () => undefined,
    adopting: false,
    adoptError: null,
    restoredHistoryCount: 0,
    restoredSessionId: null,
    ...over,
  };
}

let chatState: UseAgentChatResult = baseChat();
vi.mock('../../src/lib/use-agent-chat', () => ({ useAgentChat: () => chatState }));

const { AgentChatView } = await import('../../src/views/AgentChatView');
const { AgentChatProvider } = await import('../../src/lib/AgentChatProvider');

/** The body of a top-level CSS rule, by selector (comments already stripped). */
function rule(selector: string): string {
  // `(` and `)` are in here for `:not(:focus)` — without them the parentheses
  // would go into the pattern as a capture group and the rule would never be
  // found, which a `.toThrow()` arm would happily read as "the rule is gone".
  const escaped = selector.replace(/[.[\]*'()]/g, (c) => `\\${c}`);
  const m = new RegExp(`(^|\\n)${escaped} \\{([^}]*)\\}`).exec(CSS);
  if (m === null) throw new Error(`no CSS rule for ${selector}`);
  return m[2] ?? '';
}

/** Does `a` come before `b` in the document? */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function el(selector: string): Element {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`no element for ${selector}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.livekitToken.mockResolvedValue({ ws_url: 'ws://x', room: 'r', token: 't' });
  h.getSession.mockResolvedValue(SESSION);
  chatState = baseChat();
});
afterEach(cleanup);

describe('the view reads rail → bar → stage → mission', () => {
  it('puts the four in that order in the DOM, which is the focus order', () => {
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const rail = el('[aria-label="Chats"]');
    const bar = el('.ai-bar');
    const stage = el('[data-component="ai-automation-live-pane"]');
    const mission = el('[data-component="ai-automation-chat-column"]');
    expect(precedes(rail, bar)).toBe(true);
    expect(precedes(bar, stage)).toBe(true);
    // ⛔ THE HALF THAT MOVED. The live pane used to come AFTER the composer.
    expect(precedes(stage, mission)).toBe(true);
  });

  it('⛔ and nothing re-orders them in CSS — DOM order IS visual order', () => {
    // The arm above is a DOM fact. `order` on a flex child would let the two
    // come apart silently: the picture would read rail → stage → mission and
    // the Tab key would read rail → mission → stage, which is the defect the
    // re-cut exists to remove.
    for (const selector of ['.ai-stage', '.ai-mission', '.ai-rail', '.ai-deck']) {
      expect(rule(selector), `${selector} must not re-order itself`).not.toMatch(
        /(^|\s|;)order\s*:/,
      );
    }
    // CONTROL: the reader really is reading these rules.
    expect(rule('.ai-stage')).toContain('flex: none');
  });

  it('the stage is a landmark named `Live view`, and the column keeps its hook', () => {
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const stage = el('[data-component="ai-automation-live-pane"]');
    expect(stage.tagName).toBe('SECTION');
    expect(stage.getAttribute('aria-label')).toBe('Live view');
    expect(el('[data-component="ai-automation-chat-column"]').className).toContain('ai-mission');
  });

  it('⛔ the stage is a DARK ROOM whatever the app theme is', () => {
    // The panel's overlays are ink-primary on black and carry no scope of their
    // own. Without this attribute they resolve to LIGHT-theme ink on black in
    // the light theme — unreadable, and unmeasured, because no fixture reaches
    // them. The SimulatorWindow precedent, and spec D2.
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(el('[data-component="ai-automation-live-pane"]').getAttribute('data-mode')).toBe('dark');
  });

  it('⛔ the room says nothing twice: no live region, no second role=status', () => {
    // Every word on the stage is already in the log, and the log is the live
    // region. A second one announces each step twice, which is what makes a run
    // unusable without sight. And `agent-chat-save-recipe` does
    // `getByRole('status')` with no name in the idle no-key state.
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const stage = el('[data-component="ai-automation-live-pane"]');
    expect(stage.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(stage.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(stage.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });
});

describe('the reflow is measured, so the modals still cover the window', () => {
  it('⛔ no ancestor of a fixed modal declares `container-type`', () => {
    // `container-type` (either kind) applies layout containment, which makes the
    // element a containing block for `position: fixed` descendants. These five
    // are the boxes a modal can sit inside.
    for (const selector of ['.ai-view', '.ai-deck', '.ai-deck-body', '.ai-mission', '.ai-log']) {
      expect(rule(selector), `${selector} must not be a query container`).not.toContain(
        'container-type',
      );
    }
    // POSITIVE CONTROL — the reader really can see a `container-type` when one
    // is there. `.ai-fit` is the one query container in the view: it sizes the
    // phone with `100cqw` / `100cqh` and has no fixed descendant.
    expect(rule('.ai-fit')).toContain('container-type: size');
  });

  it('the save-as-task dialog is a `fixed` descendant of the view — that is the trap', () => {
    chatState = baseChat({
      turns: [
        {
          id: 1,
          role: 'agent',
          response: { kind: 'plan-executed', session: SESSION, intents: [], results: [], ok: true },
        },
      ],
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    fireEvent.click(screen.getByRole('button', { name: 'Save as task' }));
    const dialog = screen.getByRole('dialog', { name: 'Save chat as task' });
    const backdrop = dialog.parentElement;
    expect(backdrop?.className).toContain('fixed');
    expect(backdrop?.className).toContain('inset-0');
    // It really is INSIDE the view root, which is why the point above matters.
    expect(el('.ai-view').contains(dialog)).toBe(true);
  });

  it('⛔ the view root carries no padding and no border, so the two reads agree', () => {
    // `use-view-width` takes its first measurement from `getBoundingClientRect`
    // (the BORDER box) and every later one from `contentRect` (the CONTENT
    // box). They are the same number only while the root has neither, and if
    // they disagree the tier can flip once on mount.
    const view = rule('.ai-view');
    expect(view).not.toMatch(/(^|\s|;)padding/);
    expect(view).not.toMatch(/(^|\s|;)border(?!-)/);
    // CONTROL: the rule was found and really is the view's.
    expect(view).toContain('display: flex');
  });

  it('a collapsed stage hands the conversation a readable measure, not the whole deck', () => {
    // At 1600x1000 with the stage gone the mission column is 1168px wide; a
    // 1168px line is not a line anyone reads.
    const collapsed = CSS.match(/\.ai-stage\[hidden\] \+ \.ai-mission[^{]*\{([^}]*)\}/);
    expect(collapsed?.[1]).toContain('max-width: 760px');
  });

  it('⛔ the narrow tier hides the live-view toggle only while the stage is SHOWING', () => {
    // THE WAY BACK. Collapsing is sticky state and the tier is measured off the
    // window, so the two compose: collapse the stage at 1280x800, resize to the
    // 960x600 Tauri minimum, and an unqualified
    // `[data-ai-narrow] .ai-bar-btn-icon { display: none }` takes away the only
    // control that can bring the stage back — while the visibility gate keeps
    // the stream torn down. That is this stage's own defect returning through
    // another door: the headline feature hidden at a narrow width with no
    // affordance, which is exactly what the re-cut was for.
    //
    // Hiding a control that only REMOVES what is already on screen is fine;
    // hiding the one that says "show me the thing you took away" never is.
    expect(rule("[data-ai-narrow] .ai-bar-btn-icon[aria-pressed='true']:not(:focus)")).toContain(
      'display: none',
    );
    // And there is no unqualified rule beside it doing the same thing.
    expect(() => rule('[data-ai-narrow] .ai-bar-btn-icon')).toThrow();
  });

  it('⛔ …and it never takes the button away while the keyboard is standing on it', () => {
    // REVIEW REPAIR. The arm above keeps the way back; this one keeps the
    // FOCUS. The two compose into the bug: collapsed at 960x600 the button is
    // reachable (`aria-pressed="false"`), so a keyboard user Tabs to it and
    // presses Enter — the stage returns, `aria-pressed` flips to true, the rule
    // above fires, and the control they were standing on becomes
    // `display: none` mid-activation. Measured in a browser: activeElement
    // falls back to `<body>` at 960x600 and stays on the button at 1280x800.
    //
    // `:not(:focus)` is the whole fix. It is asserted on the SELECTOR rather
    // than in jsdom because jsdom loads no stylesheet — there is no computed
    // `display` here to read, so the stylesheet's own text is the only place
    // this fact exists to be checked.
    const selectors = CSS.match(/\[data-ai-narrow\][^{}]*\.ai-bar-btn-icon[^{}]*\{/g) ?? [];
    // CONTROL: the scan really found the rule it is about to judge.
    expect(selectors).toHaveLength(1);
    expect(selectors[0]).toContain(':not(:focus)');
  });
});
