// "Bringing The Stage everywhere" stage 1, coordinator round 2, item 1 — the
// fixture must not contradict itself. The owner's report: in
// audit-simulator-live the drawer chip said LIVE while the tab strip, the
// address bar, the status line and the Session pane all still said
// "connecting…" — five surfaces deriving from the SAME live session,
// disagreeing about it. `SimulatorWindow.tsx`'s `galleryFixture` (and, for
// the toolbar/address-bar wait pill, `galleryManualInputWait`) now threads
// one fixture object through every one of those surfaces; this file renders
// the REAL scenes the visual gate captures (`AuditScene`, the same component
// marketing-scenes.test.tsx renders) and proves, per surface, that the state
// word each one shows AGREES with `data-sim-state` — not by reading source
// text (a claim about the code), but by reading what a customer would see.
//
// Word-boundary regexes throughout: "reconnecting" contains "connecting" as a
// substring, so a plain `.not.toContain('connecting')` would also fail on the
// correct `degraded` text. `\bconnecting\b` does not match inside
// "reconnecting" (no boundary between "re" and "connecting").

import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AuditScene, auditLoadedMarkers } from '../../src/visual-harness/audit-scenes';
import type { AuditSceneName } from '../../src/visual-harness/gallery';

// `\b` alone is not enough: `textContent` glues adjacent flex children with
// no whitespace between them (e.g. the device name "17" runs straight into
// "connecting…" with no text node between), and a DIGIT is a `\w` character
// too — `\b` finds no boundary between "7" and "c", so `\bconnecting\b`
// false-negatives on real, correctly-connecting text. A letter-only
// lookaround still keeps the one boundary that matters here: "reconnecting"
// is excluded because "connecting" is preceded by the LETTER "e".
const CONNECTING_WORD = /(?<![a-z])connecting(?![a-z])/i;
const RECONNECTING_WORD = /reconnecting/i;
const LIVE_WORD = /(?<![a-z])live(?![a-z])/i;
const ENDED_WORD = /(?<![a-z])ended(?![a-z])/i;

/** Every string a viewer would actually see in this subtree: text nodes,
 *  PLUS `value`/`placeholder`/`title` — the address bar is a real
 *  `<input value={…}>` (SimulatorWindow.tsx BrowserBar), so `.textContent`
 *  alone misses its resting URL entirely (mirrors marketing-scenes.test.tsx's
 *  own `visibleStrings`, scoped to one element instead of a whole stage). */
function text(el: Element | null): string {
  if (el === null) return '';
  const parts: string[] = [el.textContent ?? ''];
  for (const node of Array.from(el.querySelectorAll('*'))) {
    for (const attr of ['title', 'placeholder', 'value']) {
      const v = node.getAttribute(attr);
      if (v !== null) parts.push(v);
    }
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      parts.push(node.value);
    }
  }
  return parts.join(' ');
}

interface SceneCase {
  name: AuditSceneName;
  state: 'connecting' | 'live' | 'degraded' | 'ended';
}

const CASES: readonly SceneCase[] = [
  { name: 'audit-simulator-connecting', state: 'connecting' },
  { name: 'audit-simulator-live', state: 'live' },
  { name: 'audit-simulator-degraded', state: 'degraded' },
  { name: 'audit-simulator-ended', state: 'ended' },
];

describe('the four simulator gallery scenes — every surface agrees with data-sim-state', () => {
  for (const { name, state } of CASES) {
    it(`${name}: data-sim-state="${state}" and the toolbar/tab/address-bar/drawer/Session-pane text all say ${state}, never a different state's word`, async () => {
      const { container } = render(<AuditScene name={name} />);
      const stage = container.querySelector<HTMLElement>(`[data-scene="${name}"]`);
      expect(stage).not.toBeNull();
      if (stage === null) return;

      const markers = auditLoadedMarkers(name);
      const last = markers[markers.length - 1] ?? '';
      await waitFor(() => expect(text(stage)).toContain(last), { timeout: 5_000 });

      const shell = stage.querySelector('[data-component="simulator-shell"]');
      expect(shell, 'simulator-shell not found').not.toBeNull();
      expect(shell?.getAttribute('data-sim-state')).toBe(state);

      const toolbar = stage.querySelector('[data-component="simulator-toolbar"]');
      const tabStrip = stage.querySelector('[data-component="simulator-tab-strip"]');
      const addressBar = stage.querySelector('[data-component="simulator-address-bar"]');
      const drawerStatus = stage.querySelector('[data-component="sim-drawer-status"]');
      const sessionPane = stage.querySelector('[data-component="simulator-control-section"]');
      for (const [label, el] of [
        ['simulator-toolbar', toolbar],
        ['simulator-tab-strip', tabStrip],
        ['simulator-address-bar', addressBar],
        ['sim-drawer-status', drawerStatus],
        ['simulator-control-section', sessionPane],
      ] as const) {
        expect(el, `${label} not found in ${name}`).not.toBeNull();
      }

      const toolbarText = text(toolbar);
      const tabText = text(tabStrip);
      const addressText = text(addressBar);
      const drawerText = text(drawerStatus);
      const sessionText = text(sessionPane);

      switch (state) {
        case 'connecting': {
          expect(toolbarText).toMatch(CONNECTING_WORD);
          expect(toolbarText).not.toMatch(LIVE_WORD);
          expect(toolbarText).not.toMatch(RECONNECTING_WORD);
          // The tab shows no page yet — never the live page's own title.
          expect(tabText).not.toContain('trail running shoes');
          expect(addressText).toMatch(CONNECTING_WORD);
          expect(addressText).not.toMatch(RECONNECTING_WORD);
          expect(addressText).not.toMatch(ENDED_WORD);
          expect(drawerText).toContain('CONNECTING');
          expect(drawerText).not.toContain('LIVE');
          expect(drawerText).not.toContain('RECONNECTING');
          expect(drawerText).not.toContain('ENDED');
          // The "link" word (mode · LINK · transport) — the bug this scene
          // caught: it read `info` (only ever true once ws/token are set,
          // which is unconditional inside this render branch) and said
          // "connected" in every fixture phase, one word before this same
          // line's own "connecting…".
          expect(drawerText).toContain('not connected');
          expect(sessionText).toContain('Connecting…');
          break;
        }
        case 'live': {
          expect(toolbarText).toMatch(LIVE_WORD);
          expect(toolbarText).not.toMatch(CONNECTING_WORD);
          expect(toolbarText).not.toMatch(RECONNECTING_WORD);
          // The tab shows the page's own title, not a placeholder.
          expect(tabText).toContain('trail running shoes');
          // The address bar shows the page's own host, unlocked — never the
          // "connecting… — the address bar unlocks once the device is live"
          // placeholder the owner's report quoted verbatim.
          expect(addressText).toContain('shop.example.com');
          expect(addressText).not.toMatch(CONNECTING_WORD);
          expect(addressText).not.toMatch(RECONNECTING_WORD);
          expect(drawerText).toContain('LIVE');
          expect(drawerText).toContain('direct');
          expect(drawerText).not.toContain('RECONNECTING');
          expect(drawerText).not.toContain('ENDED');
          expect(drawerText).not.toContain('not connected');
          expect(drawerText).toContain('connected');
          expect(sessionText).not.toContain('Connecting…');
          break;
        }
        case 'degraded': {
          // The toolbar's own pill now reads the reconnecting group too (the
          // fix this test file was added to prove) — it must not still show
          // the bare "connecting" word the first-connect state uses.
          expect(toolbarText).toMatch(RECONNECTING_WORD);
          expect(toolbarText).not.toMatch(CONNECTING_WORD);
          expect(toolbarText).not.toMatch(LIVE_WORD);
          expect(tabText).toContain('trail running shoes');
          expect(addressText).toMatch(RECONNECTING_WORD);
          expect(addressText).not.toMatch(CONNECTING_WORD);
          expect(addressText).not.toMatch(ENDED_WORD);
          expect(drawerText).toContain('RECONNECTING');
          expect(drawerText).toContain('reconnecting');
          expect(drawerText).not.toContain('LIVE');
          expect(drawerText).not.toContain('ENDED');
          // The session's link is still up — only its media dropped — so
          // "link" reads "connected" beside "reconnecting…", not "not
          // connected" beside it (which would itself read as contradictory:
          // not connected, but reconnecting).
          expect(drawerText).not.toContain('not connected');
          expect(drawerText).toContain('connected');
          // The full-screen "Connection dropped — reconnecting…" overlay
          // (AgentSessionPanel's own gallery state) must agree too.
          expect(text(stage)).toMatch(/Connection dropped.*reconnecting/i);
          break;
        }
        case 'ended': {
          expect(toolbarText).not.toMatch(LIVE_WORD);
          expect(toolbarText).not.toMatch(CONNECTING_WORD);
          expect(toolbarText).not.toMatch(RECONNECTING_WORD);
          expect(tabText).not.toContain('trail running shoes');
          expect(addressText).toMatch(ENDED_WORD);
          expect(addressText).not.toMatch(CONNECTING_WORD);
          expect(addressText).not.toMatch(RECONNECTING_WORD);
          expect(drawerText).toContain('ENDED');
          expect(drawerText).not.toContain('LIVE');
          expect(drawerText).not.toContain('RECONNECTING');
          expect(drawerText).toContain('not connected');
          expect(sessionText).toMatch(/this session has ended/i);
          break;
        }
      }
    });
  }

  it('VACUITY CONTROL — the word-boundary regex does not treat "reconnecting" as "connecting" (the substring trap this file exists to avoid)', () => {
    expect('reconnecting…').not.toMatch(CONNECTING_WORD);
    expect('reconnecting…').toMatch(RECONNECTING_WORD);
    expect('connecting…').toMatch(CONNECTING_WORD);
  });
});
