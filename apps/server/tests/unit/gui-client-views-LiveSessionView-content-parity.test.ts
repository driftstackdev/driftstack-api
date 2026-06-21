// W485.B — drift guard for apps/gui-client/src/views/LiveSessionView.tsx.
// Live session viewport: 500ms polling capture + L-001 two-plane
// input forwarding. Drift here either drops the L-001 plane split
// (intent-only via interact / coordinate via gui-control + scope
// check) or breaks the 500ms cadence + 600ms tap-marker (input
// → visible-effect feedback degrades).
//
//   • Framing pinned: 'Live session viewport — polling-based, with
//     input forwarding.' + 'Polls client.sessions.capture({kind:
//     'screenshot'}) at ~500ms per frame and renders the base64
//     PNG in an <img>.' + L-001 two-plane framing.
//   • FRAME_INTERVAL_MS = 500 module constant.
//   • PRESS_KEYS 13-key non-printable set (Enter / Escape /
//     Backspace / Tab / Arrow* / Home / End / PageUp / PageDown /
//     Delete).
//   • Coord translation: round((clientX-rect.left)/rect.width *
//     naturalWidth) — pinned so tap_at coords stay in viewport-px,
//     not display-px.
//   • L-001 plane split: scroll/press via client.sessions.interact;
//     tap_at/type_focused via sendGUIInput.
//   • Esc cascade: !manualControl + Escape → onBack; manualControl
//     + Escape → turn control off.
//   • TapMarker 600ms decay + img[alt^=…] reverse-projection.
//   • friendlyError 4-branch: GUIInputError 403 scope-message,
//     GUIInputError generic, DriftstackError, Error, fallback
//     'unknown error'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/LiveSessionView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W485.B apps/gui-client/src/views/LiveSessionView.tsx content parity', () => {
  const body = read(LIB);

  it("Framing pinned: 'Live session viewport — polling-based, with input forwarding.' + 'Polls client.sessions.capture({kind:'screenshot'}) at ~500ms per frame and renders the base64 PNG in an <img>.' + 'When manual control is on, clicks/scrolls/keystrokes on the viewport translate to client.sessions.interact() calls so the founder can drive a real session through the GUI without the WebKit-fork dev tools.'", () => {
    expect(body).toMatch(/\/\/ Live session viewport — polling-based, with input forwarding\./);
    expect(body).toMatch(
      /\/\/ Polls `client\.sessions\.capture\(\{kind:'screenshot'\}\)` at ~500ms per\s*\n?\s*\/\/ frame and renders the base64 PNG in an <img>\./,
    );
    expect(body).toMatch(
      /When manual control\s*\n?\s*\/\/ is on, clicks\/scrolls\/keystrokes on the viewport translate to\s*\n?\s*\/\/ `client\.sessions\.interact\(\)` calls so the founder can drive a real\s*\n?\s*\/\/ session through the GUI without the WebKit-fork dev tools\./,
    );
  });

  it("GUI4 input mapping framing pinned: 'click on img → { kind: 'tap_at', x, y } in viewport px' + 'wheel on img → { kind: 'scroll', delta_x, delta_y }' + 'non-printable keys → { kind: 'press', key }' + 'printable chars → { kind: 'type_focused', text }' — pinned so the 4-event vocabulary stays documented inline at the source", () => {
    expect(body).toMatch(
      /\/\/ GUI4 input mapping:\s*\n?\s*\/\/ {3}- click on img\s+→ \{ kind: 'tap_at', x, y \} in viewport px\s*\n?\s*\/\/ {3}- wheel on img\s+→ \{ kind: 'scroll', delta_x, delta_y \}\s*\n?\s*\/\/ {3}- non-printable keys\s+→ \{ kind: 'press', key \}\s*\n?\s*\/\/ {3}- printable chars\s+→ \{ kind: 'type_focused', text \}/,
    );
  });

  it("Trade-offs framing pinned: '~50-200 KB per frame on the wire (base64 over HTTP).' + 'Latency floor of ~500ms request RTT + capture compute, which means input → visible-effect lag is ~1s end-to-end. Bearable for debugging, painful for real interactive control. WebRTC (or a binary stream over WebSocket) closes that gap when GUI3+ justifies the server work.' — pinned so the upgrade-path framing (WebRTC/WebSocket → 2 fps polling) survives", () => {
    expect(body).toMatch(/\/\/ {3}- ~50-200 KB per frame on the wire \(base64 over HTTP\)\./);
    expect(body).toMatch(
      /\/\/ {3}- Latency floor of ~500ms request RTT \+ capture compute, which\s*\n?\s*\/\/ {5}means input → visible-effect lag is ~1s end-to-end\. Bearable for\s*\n?\s*\/\/ {5}debugging, painful for real interactive control\. WebRTC \(or a\s*\n?\s*\/\/ {5}binary stream over WebSocket\) closes that gap when GUI3\+\s*\n?\s*\/\/ {5}justifies the server work\./,
    );
    expect(body).toMatch(
      /\/\/ {3}- Polling pauses when the view unmounts AND when the user clicks\s*\n?\s*\/\/ {5}"Pause", so an idle window never burns rate-limit\./,
    );
  });

  it("FRAME_INTERVAL_MS = 500 module constant pinned — pinned so the 2-fps cadence doesn't silently halve to 4 fps (which doubles wire traffic) or double to 1 fps (which makes manual control feel unusable)", () => {
    expect(body).toMatch(/const FRAME_INTERVAL_MS = 500;/);
  });

  it("PRESS_KEYS 13-key set: Enter / Escape / Backspace / Tab / ArrowUp / ArrowDown / ArrowLeft / ArrowRight / Home / End / PageUp / PageDown / Delete — pinned so the press vs type_focused split mirrors InteractActionSchema in @driftstack/api-types and printable chars don't accidentally route through the press plane", () => {
    expect(body).toMatch(
      /const PRESS_KEYS = new Set\(\[\s*\n?\s*'Enter',\s*\n?\s*'Escape',\s*\n?\s*'Backspace',\s*\n?\s*'Tab',\s*\n?\s*'ArrowUp',\s*\n?\s*'ArrowDown',\s*\n?\s*'ArrowLeft',\s*\n?\s*'ArrowRight',\s*\n?\s*'Home',\s*\n?\s*'End',\s*\n?\s*'PageUp',\s*\n?\s*'PageDown',\s*\n?\s*'Delete',\s*\n?\s*\]\);/,
    );
  });

  it("L-001 two-plane framing pinned: 'intent-only (scroll, press) → customer SDK interact' + 'coordinate (tap_at, type_focused) → gui-control endpoint via sendGUIInput. The user's API key needs the gui_control scope for this to succeed; otherwise the server responds 403 and we surface that in the inline error banner.' — pinned so the plane split + scope requirement stays documented at the call site", () => {
    expect(body).toMatch(
      /\/\/ Two planes per L-001 \(docs\/locked-decisions\.md\):\s*\n?\s*\/\/ {3}- intent-only \(scroll, press\) → customer SDK `interact`\s*\n?\s*\/\/ {3}- coordinate \(tap_at, type_focused\) → gui-control endpoint via\s*\n?\s*\/\/ {5}sendGUIInput\. The user's API key needs the `gui_control` scope\s*\n?\s*\/\/ {5}for this to succeed; otherwise the server responds 403 and\s*\n?\s*\/\/ {5}we surface that in the inline error banner\./,
    );
  });

  it('Coordinate translation: round(((clientX - rect.left) / rect.width) * naturalWidth) — pinned so the display-px → natural-px math stays correct (object-contain rendering means rect IS the rendered image area, so the linear projection is exact)', () => {
    expect(body).toMatch(
      /const x = Math\.round\(\(\(e\.clientX - rect\.left\) \/ rect\.width\) \* naturalW\);\s*\n?\s*const y = Math\.round\(\(\(e\.clientY - rect\.top\) \/ rect\.height\) \* naturalH\);/,
    );
    expect(body).toMatch(/void guiInput\(\{ kind: 'tap_at', x, y \}\);/);
    expect(body).toMatch(/void interact\(\{ kind: 'scroll', delta_x: dx, delta_y: dy \}\);/);
  });

  it('Esc cascade: !manualControl + Escape → onBack (back to sessions); manualControl + Escape → turn manualControl off (less destructive than navigating away) — pinned so the Esc semantics differ by mode (back vs disengage)', () => {
    expect(body).toMatch(
      /\/\/ Esc always backs out of the live view, even when manual control is on\.\s*\n?\s*if \(!manualControlRef\.current && e\.key === 'Escape'\) \{\s*\n?\s*e\.preventDefault\(\);\s*\n?\s*onBack\(\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ Esc inside manual control turns control off \(less destructive than navigating away\)\.\s*\n?\s*if \(e\.key === 'Escape'\) \{\s*\n?\s*e\.preventDefault\(\);\s*\n?\s*manualControlRef\.current = false;\s*\n?\s*setState\(\(s\) => \(\{ \.\.\.s, manualControl: false \}\)\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it("Modifier gates: ignore Shift/Control/Alt/Meta modifier-only events + don't hijack metaKey/ctrlKey shortcuts (so copy/paste/devtools stay native) + printable char (e.key.length === 1) → guiInput type_focused — pinned so OS shortcuts pass through and single chars route to the gui-control plane (not the press plane)", () => {
    expect(body).toMatch(
      /if \(e\.key === 'Shift' \|\| e\.key === 'Control' \|\| e\.key === 'Alt' \|\| e\.key === 'Meta'\) return;/,
    );
    expect(body).toMatch(/if \(e\.metaKey \|\| e\.ctrlKey\) return;/);
    expect(body).toMatch(
      /if \(e\.key\.length === 1\) \{\s*\n?\s*e\.preventDefault\(\);\s*\n?\s*void guiInput\(\{ kind: 'type_focused', text: e\.key \}\);\s*\n?\s*\}/,
    );
  });

  it("TapMarker: 600ms decay (Date.now() - lastTap.at < 600) + img[alt^='session viewport at'] querySelector for reverse-projection from natural-px back to display-px — pinned so the marker tracks resizes between renders + decays before stale-tap confusion", () => {
    expect(body).toMatch(/const showTapMarker = lastTap !== null && tapAgeMs < 600;/);
    expect(body).toMatch(
      /const img = document\.querySelector<HTMLImageElement>\('img\[alt\^="session viewport at"\]'\);/,
    );
    expect(body).toMatch(
      /left: rect\.left - parent\.left \+ \(x \/ img\.naturalWidth\) \* rect\.width,\s*\n?\s*top: rect\.top - parent\.top \+ \(y \/ img\.naturalHeight\) \* rect\.height,/,
    );
  });

  it("friendlyError 4-branch: GUIInputError 403 → 'API key lacks gui_control scope — manual control is unavailable on this key.' / GUIInputError generic → .message / DriftstackError → .message / Error → .message / fallback 'unknown error' — pinned so the 403 scope-error gets a specific founder-facing message instead of raw HTTP status; 2026-05-20 — signature widened to accept optional baseUrl for 'Couldn't reach <url>' hint", () => {
    // Pin signature with optional baseUrl param + the 403-gate branch +
    // each fallback. Use granular pins instead of one giant regex so a
    // future refactor of the order can't silently drop a branch.
    expect(body).toMatch(/function friendlyError\(err: unknown, baseUrl\?: string\): string/);
    expect(body).toMatch(/if \(err instanceof GUIInputError\) \{/);
    expect(body).toMatch(
      /return 'API key lacks gui_control scope — manual control is unavailable on this key\.';/,
    );
    expect(body).toMatch(/if \(err instanceof DriftstackError\)/);
    expect(body).toMatch(/return 'unknown error';/);
  });

  it("Recording integration: recordingIdRef.current === null gate before addFrame (so frames don't double-buffer when not recording); useRecordings hook from '../lib/recordings' — pinned so the polled frame stream feeds the recording buffer iff a recording is active for this session", () => {
    expect(body).toMatch(
      /const recId = recordingIdRef\.current;\s*\n?\s*if \(recId !== null\) \{\s*\n?\s*addFrame\(recId, \{ at: now, dataUrl, bytes: cap\.byte_size \}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/from '\.\.\/lib\/recordings';/);
  });

  it('FPS moving average over last 4 timestamps: window slides via shift() when length > 4; computeFps returns ((n-1)*1000)/elapsedMs — pinned so the displayed fps is a moving average (not instantaneous) and stays stable even when one frame stalls', () => {
    expect(body).toMatch(
      /\/\/ Keep the last 4 timestamps for the fps moving average\.\s*\n?\s*while \(frameTimestampsRef\.current\.length > 4\) frameTimestampsRef\.current\.shift\(\);/,
    );
    expect(body).toMatch(
      /function computeFps\(timestamps: number\[\]\): number \{\s*\n?\s*if \(timestamps\.length < 2\) return 0;/,
    );
    expect(body).toMatch(/return \(\(timestamps\.length - 1\) \* 1000\) \/ elapsedMs;/);
  });

  it('Overlap guard: the fixed-interval poll skips a capture while one is in flight (fetchInFlightRef) + releases it in finally — pinned so a screenshot slower than FRAME_INTERVAL_MS cannot stack concurrent captures (server load + out-of-order frames)', () => {
    expect(body).toMatch(/const fetchInFlightRef = useRef\(false\);/);
    expect(body).toMatch(
      /if \(fetchInFlightRef\.current\) return;\s*\n?\s*fetchInFlightRef\.current = true;/,
    );
    expect(body).toMatch(/\} finally \{\s*\n?\s*fetchInFlightRef\.current = false;\s*\n?\s*\}/);
  });

  it('W607 browser chrome: navigateTo drives client.sessions.navigate via the omnibox resolver (URL or search), wired to an editable URL bar (Enter) + Reload (re-navigate currentUrl)', () => {
    expect(body).toMatch(/const navigateTo = useCallback\(/);
    expect(body).toMatch(/await client\.sessions\.navigate\(sessionId, \{ url: target \}\)/);
    // Omnibox: a URL navigates, anything else becomes a web search (shared
    // address-bar resolver) — replaced the old bare-host `'https://' + url`.
    expect(body).toMatch(/resolveAddressBarInput\(/);
    expect(body).toMatch(/props\.onNavigate\(draftUrl\)/);
    // Reload navigates the live URL VERBATIM (normalizeNavigateUrl guard), never via
    // the omnibox — so the initial about:blank can't be re-classified as a search.
    expect(body).toMatch(/normalizeNavigateUrl\(state\.currentUrl/);
    // The draft URL isn't clobbered by the poll mid-type (synced only when
    // currentUrl actually changes underneath).
    expect(body).toMatch(/const \[draftUrl, setDraftUrl\] = useState/);
    expect(body).toMatch(/aria-label="Address bar"/);
  });

  it("W608 device frame: toggleable iOS bezel (rounded-[2.25rem] + 10px border + dynamic-island notch), persisted to localStorage 'ds_gui_device_frame', img + TapMarker stay direct children (tap-projection math unchanged), nothing hardcoded to one archetype (img object-contain scales to the frame's natural dimensions)", () => {
    expect(body).toMatch(/const \[deviceFrame, setDeviceFrame\] = useState\(/);
    expect(body).toMatch(/localStorage\.getItem\('ds_gui_device_frame'\) !== 'off'/);
    expect(body).toMatch(/localStorage\.setItem\('ds_gui_device_frame', on \? 'off' : 'on'\)/);
    expect(body).toMatch(/data-device-frame=\{deviceFrame \? 'on' : 'off'\}/);
    expect(body).toMatch(/rounded-\[2\.25rem\] border-\[10px\] shadow-2xl/);
    // Notch overlay never intercepts taps; bezel renders only when toggled on.
    expect(body).toMatch(
      /\{deviceFrame && \(\s*\n?\s*<div\s*\n?\s*aria-hidden="true"\s*\n?\s*className="pointer-events-none absolute/,
    );
    // Escape hatch for pixel-peeping a capture.
    expect(body).toMatch(/aria-label=\{deviceFrame \? 'Hide device frame' : 'Show device frame'\}/);
    // Cosmetic-only contract: container stays the positioned parent the
    // TapMarker reverse-projects against.
    expect(body).toMatch(
      /tap-projection math \(img\.parentElement\s*\n?\s*\/\/ rect\) is unchanged/,
    );
  });

  it('W609 tab strip mounted: <SessionTabStrip activeSessionId onSwitch onNewTab> renders above the Header; LiveSessionViewProps gained onSwitchSession + onNewTab — pinned so the browser-tabs surface stays wired (App.tsx keys the view by sessionId for clean remounts, covered by its own parity file)', () => {
    expect(body).toMatch(/import \{ SessionTabStrip \} from '\.\.\/components\/SessionTabStrip';/);
    expect(body).toMatch(
      /<SessionTabStrip\s*\n?\s*activeSessionId=\{sessionId\}\s*\n?\s*onSwitch=\{onSwitchSession\}\s*\n?\s*onNewTab=\{onNewTab\}\s*\n?\s*\/>/,
    );
    expect(body).toMatch(/onSwitchSession: \(sessionId: string\) => void;/);
    expect(body).toMatch(/onNewTab: \(\) => void;/);
  });

  it("W613 phone-aspect bezel: aspectRatio driven by the frame's naturalWidth/naturalHeight via img onLoad (placeholder '9 / 19.5' until first frame) — pinned so the bezel hugs the phone shape instead of the pane (the founder-reported iPad look) without hardcoding any archetype", () => {
    expect(body).toMatch(
      /const \[frameAspect, setFrameAspect\] = useState<string \| null>\(null\);/,
    );
    expect(body).toMatch(
      /style=\{deviceFrame \? \{ aspectRatio: frameAspect \?\? '9 \/ 19\.5' \} : undefined\}/,
    );
    expect(body).toMatch(/const next = `\$\{el\.naturalWidth\} \/ \$\{el\.naturalHeight\}`;/);
  });

  it('W616 page-state rendering: meta refresh every 10th interval tick (~5s, skipped while paused — getState records a state_capture usage event, so a 2/s meta poll would spam the usage meter); loading bar overlay (local navigating OR page_state loading); error overlay with pageErrorCopy kind→action copy + Try again re-navigate', () => {
    expect(body).toMatch(/const frameCounterRef = useRef\(0\);/);
    expect(body).toMatch(
      /if \(!pausedRef\.current && frameCounterRef\.current % 10 === 0\) \{\s*\n?\s*void fetchSessionMeta\(\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /pageState: \(st as \{ page_state\?: PageStateInfo \| null \}\)\.page_state \?\? null,/,
    );
    expect(body).toMatch(/\{\(loading \|\| pageState\?\.state === 'loading'\) && \(/);
    expect(body).toMatch(/data-overlay="page-loading"/);
    expect(body).toMatch(
      /\{pageState\?\.state === 'errored' && pageState\.error !== undefined && \(/,
    );
    expect(body).toMatch(/data-overlay="page-error"/);
    // kind→copy map stays total over the 5 error kinds.
    expect(body).toMatch(
      /function pageErrorCopy\(err: NonNullable<PageStateInfo\['error'\]>\): string \{/,
    );
    for (const kind of ['dns', 'tls', 'http', 'timeout', 'net']) {
      expect(body, `pageErrorCopy must handle '${kind}'`).toMatch(new RegExp(`case '${kind}':`));
    }
  });

  it('W623 GUI-side back/forward history: navigateTo records AFTER successful navigate (failed navigations excluded), new navigation truncates forward entries, back/forward commit the index only on a SUCCESSFUL navigate (no desync on failure), the opening page is seeded into history, buttons disabled at the stack edges — pinned because the driver has no history route (the stack is the only history)', () => {
    expect(body).toMatch(/const historyRef = useRef<string\[\]>\(\[\]\);/);
    expect(body).toMatch(/const historyIndexRef = useRef\(-1\);/);
    expect(body).toMatch(
      /const h = historyRef\.current\.slice\(0, historyIndexRef\.current \+ 1\);/,
    );
    expect(body).toMatch(/if \(opts\.recordHistory !== false\) \{/);
    // Back/forward commit the index only after the navigate resolves true.
    expect(body).toMatch(/void navigateTo\(url, \{ recordHistory: false \}\)\.then\(\(ok\) => \{/);
    // The opening page is seeded into history so Back can return to it.
    expect(body).toMatch(/historyRef\.current = \[st\.url\];/);
    expect(body).toMatch(/disabled=\{!props\.canBack\}/);
    expect(body).toMatch(/disabled=\{!props\.canForward\}/);
    expect(body).toMatch(/aria-label="Back"/);
    expect(body).toMatch(/aria-label="Forward"/);
  });

  it('W2746 session-viewer robustness (audit fixes): the address draft is not clobbered while the input is focused, wheel deltas are scaled into device px (deltaMode-normalized) like the tap path, and navigate clears loading explicitly so navigate-while-paused does not spin forever', () => {
    // #2 — focus guard on the draft resync.
    expect(body).toMatch(/const inputFocusedRef = useRef\(false\);/);
    expect(body).toMatch(/if \(!inputFocusedRef\.current\) setDraftUrl/);
    // #3 — wheel deltas normalized + scaled to device px (not raw display px).
    expect(body).toMatch(/e\.deltaMode === 1 \? 16 : e\.deltaMode === 2/);
    expect(body).toMatch(/\(\(e\.deltaY \* unit\) \/ rect\.height\) \* naturalH/);
  });

  it('stops polling on a gone session (410/404): isSessionGone gates a clearInterval + ended terminal panel, instead of hammering capture/state — founder 2026-06-18 logs flooded with "410 Gone" for minutes after a session was destroyed', () => {
    expect(body).toContain('function isSessionGone(err: unknown): boolean {');
    expect(body).toContain(
      'err instanceof DriftstackError && (err.status === 410 || err.status === 404)',
    );
    // The capture catch stops the poll on a gone session.
    expect(body).toContain('if (isSessionGone(err)) {');
    expect(body).toContain('window.clearInterval(intervalIdRef.current);');
    expect(body).toContain('ended: true');
    // A terminal panel replaces the polling viewport.
    expect(body).toContain('if (state.ended) {');
    expect(body).toContain('Session ended');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
