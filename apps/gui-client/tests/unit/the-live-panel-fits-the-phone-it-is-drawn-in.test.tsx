// The live panel's OWN overlays, in the box stage 4 gave them.
//
// Stage 7 of the AI-view rebuild (spec §9 stage 7). `AgentSessionPanel` was
// written for two wide surfaces — the standalone simulator window and the AI
// view's old 300px column. Stage 4 mounts the same component INSIDE the drawn
// iPhone, which at the 960x600 minimum window measures 209px (dark) / 205px
// (light). Two things were wrong there and this file holds both:
//
//   1. THE OVERLAY TOLD THE WRONG CUSTOMER WHAT TO DO. "Close this window, then
//      relaunch the profile from the main Driftstack window" is true in the
//      standalone simulator and false in the chat, which has no window to close
//      and no profile to relaunch — its session belongs to the chat. The
//      slow-start notice had ALREADY learned this (its close/relaunch clause is
//      gated on `onClose`); the terminal overlay had not, so the one sentence
//      telling an ended chat what to do next named a route that surface cannot
//      offer. It is now gated the same way.
//
//   2. THE RECAP DID NOT FIT. Measured in the real stage at 209px with the
//      container query disabled: the two-column recap gives each card 51px of
//      text, which put "Session length" on two lines, "Less than a minute" on
//      three, and left the outcome span with scrollWidth 78 inside clientWidth
//      51 — a word drawn outside the card it belongs to. One column at 171px
//      puts every label on one line and nothing outside its box.
//
// ⛔ WHY SOME OF THIS IS ASSERTED ON THE STYLESHEET'S TEXT. jsdom loads no
// stylesheet, so `getComputedStyle` here reports the initial value for every
// one of these properties and an arm written against it would pass whatever the
// CSS said. The DOM half (the classes are on the elements) and the CSS half
// (the rules exist and key off those classes) are both needed: either alone is
// a rule bound to nothing, or a class bound to no rule. The geometry itself is
// measured in a browser, in the stage, and the numbers are in the stage-7
// report — a jsdom test cannot measure a layout.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import type { LiveKitInfo } from '@driftstack/sdk';
// `vi.mock` below is hoisted above this import, so the component's module graph
// resolves ../lib/livekit to the mock — the same order agent-session-panel.test
// relies on.
import { AgentSessionPanel } from '../../src/components/AgentSessionPanel';

const CSS_SOURCE = readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8');
/** The stylesheet with its comments stripped — the CSS sibling of the repo's
 *  `codeOnly` rule. The block this file reads explains itself at length and
 *  says `container-type: size` inside a sentence about why it is NOT that; a
 *  scan that read comments could never go green. */
const CSS = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of `@container asp (max-width: N)`, or null when there is no such
 *  block. Brace-counted rather than regex-matched: the block contains nested
 *  rules, so `[^}]*` would stop at the first inner `}` and report a body that
 *  is missing everything after it — which every "contains" arm below would
 *  then read as a missing rule rather than as a broken reader. */
function containerBlock(name: string): { query: string; body: string } | null {
  const open = new RegExp(`@container\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{`).exec(CSS);
  if (open === null) return null;
  let depth = 1;
  let i = open.index + open[0].length;
  const start = i;
  while (i < CSS.length && depth > 0) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') depth -= 1;
    i += 1;
  }
  if (depth !== 0) return null;
  return { query: open[1] ?? '', body: CSS.slice(start, i - 1) };
}

/** Every `data-overlay` element in the panel's source, mapped to the className
 *  that element itself carries.
 *
 *  The opening tag is sliced out — from the `<` that opens it to the first `>`
 *  that is not the tail of an `=>` — rather than matched with a
 *  `data-overlay=…className=` window. A window reads whatever className comes
 *  NEXT in the file, so an attribute order that put `className` first, or an
 *  overlay whose own class string is long, silently hands back a CHILD's
 *  classes and the arm reports on an element nobody asked about. */
function overlayTags(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(/data-overlay="([^"]+)"/g)) {
    const at = m.index;
    const open = source.lastIndexOf('<', at);
    let end = at;
    for (;;) {
      end = source.indexOf('>', end + 1);
      if (end === -1 || source[end - 1] !== '=') break;
    }
    const tag = source.slice(open, end === -1 ? at : end);
    out.set(m[1] ?? '', /className="([^"]*)"/.exec(tag)?.[1] ?? '');
  }
  return out;
}

/** The overlays that are deliberately NOT reflowed by the container query, each
 *  with the reason it does not need to be. Anything not named here has to be in
 *  the query — the default is in, so a new sheet cannot be forgotten. */
const EXEMPT_FROM_COMPACT: ReadonlyMap<string, string> = new Map([
  [
    'publisher-reconnecting',
    'the calm pill over the last good frame, measured 131x33 inside a 209px box — a label, not a sheet, with nothing to reflow',
  ],
  [
    'tab-switching',
    'a single centred 11px label on a plain cover: no recap, no button row, no paragraph, so the compact rules have nothing to act on',
  ],
]);

const connectMock = vi.fn<(room: unknown, info: LiveKitInfo) => Promise<unknown>>();
const createRoomMock = vi.fn<() => { on: () => void; disconnect: () => void }>(() => ({
  on: () => undefined,
  disconnect: () => undefined,
}));

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => createRoomMock(),
  connectToAgentSession: (room: unknown, info: LiveKitInfo) => connectMock(room, info),
  sendInputEvent: () => Promise.resolve(),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    ParticipantDisconnected: 'participantDisconnected',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    DCBufferStatusChanged: 'dcBufferStatusChanged',
  },
}));

function liveKitInfo(): LiveKitInfo {
  return {
    ws_url: 'wss://live.example.com',
    room: 'room-stage7',
    token: 'tok',
    participant_identity: 'watcher',
    expires_at: '2026-08-25T13:00:00.000Z',
  };
}

const INFO = liveKitInfo();
const ENDED = { reason: 'renderer_crashed', summary: null, lastPhase: null } as const;

/** Renders the panel over a terminally-ended session and settles the connect
 *  promise, which is the only await the terminal overlay needs. */
async function renderEnded(onClose?: () => void): Promise<HTMLElement> {
  const { container } = render(
    <AgentSessionPanel info={INFO} interactive={false} sessionEnded={ENDED} onClose={onClose} />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  const overlay = container.querySelector<HTMLElement>('[data-overlay="session-ended"]');
  if (overlay === null) throw new Error('the session-ended overlay did not render');
  return overlay;
}

beforeEach(() => {
  vi.clearAllMocks();
  connectMock.mockResolvedValue(undefined);
  createRoomMock.mockReturnValue({ on: () => undefined, disconnect: () => undefined });
});

describe('the ended overlay only names a route the surface it is on can offer', () => {
  it('names close-and-relaunch where there IS a window to close, and offers the Close button with it', async () => {
    const onClose = vi.fn<() => void>();
    const overlay = await renderEnded(onClose);
    expect(overlay.textContent).toMatch(/Close this window, then relaunch the profile/);
    expect(overlay.querySelector('[data-action="close-ended-session"]')).not.toBeNull();
  });

  it('says nothing about closing a window in the chat, which has none — and still says what happened and what to do', async () => {
    const overlay = await renderEnded(undefined);
    // The route the embedded panel cannot offer is gone…
    expect(overlay.textContent).not.toMatch(/Close this window/);
    expect(overlay.textContent).not.toMatch(/relaunch the profile/);
    expect(overlay.querySelector('[data-action="close-ended-session"]')).toBeNull();
    // ⛔ …and the overlay is not left mute, which is the failure mode a fix that
    // simply deleted the sentence would have. WHAT HAPPENED and WHAT TO DO both
    // still render, from the reason's own mapped copy. Without this control the
    // arm above passes just as well on an empty overlay.
    expect(overlay.textContent).toMatch(/Session ended/);
    expect(overlay.textContent).toMatch(/The page stopped unexpectedly/);
    expect(overlay.textContent).toMatch(/Starting a new session is the quickest way back/);
  });

  it('gates it the SAME way the slow-start notice already did, so the two branches cannot drift apart', () => {
    const source = readFileSync(
      resolve(__dirname, '../../src/components/AgentSessionPanel.tsx'),
      'utf8',
    );
    // Both clauses, both gated on the same prop. Pinned on the source rather
    // than on a render because the point is that ONE rule is spelled twice: a
    // future branch that names the close/relaunch route has to join them.
    const gated = source.match(/onClose !== undefined &&\s*'? ?You can also close this window/);
    expect(gated, 'the slow-start clause is still gated').not.toBeNull();
    expect(
      source.match(
        /onClose !== undefined &&\s*'Close this window, then relaunch the profile from the main Driftstack window/,
      ),
      'the terminal clause is gated the same way',
    ).not.toBeNull();
  });
});

describe('the panel asks how wide its own box is, and gets compact when the answer is a phone', () => {
  it('declares itself a container on its own root, so no caller has to remember a prop', async () => {
    const overlay = await renderEnded(undefined);
    const root = overlay.closest('[data-component="agent-session-panel"]');
    expect(root).not.toBeNull();
    expect(root?.className).toMatch(/\basp-box\b/);
    const block = /\.asp-box \{([^}]*)\}/.exec(CSS);
    expect(block, 'the .asp-box rule exists').not.toBeNull();
    expect(block?.[1]).toMatch(/container-type:\s*inline-size/);
    expect(block?.[1]).toMatch(/container-name:\s*asp/);
    // ⛔ NEVER `size`. The panel's box takes its WIDTH from its height and the
    // device aspect ratio; containing the block axis would collapse it to
    // nothing, in the simulator window as well as in the stage.
    expect(block?.[1]).not.toMatch(/container-type:\s*size/);
  });

  it('puts the compact rules behind a container query, not a viewport breakpoint — the box is the phone, not the window', () => {
    const block = containerBlock('asp');
    expect(block, 'the @container asp block exists').not.toBeNull();
    expect(block?.query).toMatch(/max-width:\s*320px/);
    for (const selector of ['.asp-overlay', '.asp-recap', '.asp-actions']) {
      expect(block?.body, `${selector} is styled inside the container query`).toContain(selector);
    }
    // The recap goes to ONE column — the measured fix for a 51px card holding
    // 78px of word.
    //
    // ⛔ THE `;` IS THE WHOLE ARM. Written without it (`…1fr` unterminated) this
    // passed against `grid-template-columns: 1fr 1fr`, because `1fr 1fr` starts
    // with `1fr`: the negative control put the recap back to two columns and the
    // guard reported green. A track-list prefix is not a track list.
    expect(block?.body).toMatch(/\.asp-recap \{[^}]*grid-template-columns:\s*1fr;/);
    // Nothing is cut and unreachable: when the copy IS taller than the phone's
    // screen it scrolls, and `safe center` keeps the first line reachable
    // instead of pushing it past the scroll origin.
    expect(block?.body).toMatch(/overflow-y:\s*auto/);
    expect(block?.body).toMatch(/justify-content:\s*safe center/);
    // …with the plain keyword kept ahead of it as the fallback, so an engine
    // that drops `safe` still gets a centred overlay rather than none.
    expect(block?.body).toMatch(/justify-content:\s*center;[\s\S]*justify-content:\s*safe center/);
  });

  it('carries the classes the query needs on every overlay the panel has — derived from the source, so a new one is inside the query by default', async () => {
    // Terminal overlay: rendered here.
    const ended = await renderEnded(undefined);
    expect(ended.className).toMatch(/\basp-overlay\b/);
    expect(ended.className).toMatch(/\babsolute\b/);
    expect(ended.className).not.toMatch(/\bfixed\b/);
    const recap = ended.querySelector('[data-component="session-end-recap"]');
    expect(recap?.className).toMatch(/\basp-recap\b/);

    // The other overlays are driven by the connection state machine, which this
    // file deliberately does not re-drive (agent-session-panel.test.tsx owns
    // that). Their class strings are read off the source instead.
    //
    // ⛔ DERIVED, NOT LISTED (review repair 2026-09-20). The first version named
    // the two it knew about, which is the shape that lets the FIFTH overlay —
    // the one written next year by someone who never read this stage — sit
    // outside the container query with nothing to say so. Every `data-overlay`
    // in the panel is walked, the default is "must be in the query", and the
    // only way out is an entry in EXEMPT below with a reason.
    const source = readFileSync(
      resolve(__dirname, '../../src/components/AgentSessionPanel.tsx'),
      'utf8',
    );
    const tags = overlayTags(source);
    // Refused when it derives nothing: an attribute rename that hid every
    // overlay from this reader would otherwise pass as a clean run.
    expect(tags.size, 'no data-overlay elements were found to check').toBeGreaterThanOrEqual(4);
    expect([...tags.keys()]).toContain('session-ended');
    for (const [name, cls] of tags) {
      const exemptBecause = EXEMPT_FROM_COMPACT.get(name);
      if (exemptBecause !== undefined) {
        // An exemption is a claim about the element, so it is checked too: a
        // sheet that later grew the class would be in the query AND recorded as
        // outside it, and the reason here would be quietly false.
        expect(cls, `${name} is exempt (${exemptBecause}) and must not also claim it`).not.toMatch(
          /\basp-overlay\b/,
        );
        continue;
      }
      expect(cls, `${name} is inside the container query`).toMatch(/\basp-overlay\b/);
      // ⛔ `container-type` makes an element the containing block for a `fixed`
      // DESCENDANT. Every overlay here is `absolute inset-0` and must stay that
      // way: a `fixed` one would start resolving against this 205px box.
      expect(cls, `${name} is absolute, not fixed`).toMatch(/\babsolute inset-0\b/);
    }
    // Both button rows too — three side-by-side buttons do not fit a phone.
    expect(source.match(/className="asp-actions flex flex-wrap/g)).toHaveLength(2);
  });
});
