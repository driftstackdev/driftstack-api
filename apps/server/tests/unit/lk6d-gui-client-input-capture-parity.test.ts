// LK.6.d — drift guard for the useInputCapture hook. Pins the
// browser-event → InputEvent translation contract so a regression
// can't silently break the Mac-side Quartz dispatch.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const HOOK = resolve(REPO_ROOT, 'apps/gui-client/src/lib/livekit-input-capture.ts');

describe('LK.6.d — useInputCapture hook', () => {
  it('hook file exists', () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  const body = readFileSync(HOOK, 'utf8');

  it('exports useInputCapture + UseInputCaptureOpts', () => {
    expect(body).toMatch(/export function useInputCapture/);
    expect(body).toMatch(/export interface UseInputCaptureOpts/);
  });

  it('imports sendInputEvent + RoomEvent + InputEvent + Room from the wrapper (no duplicates)', () => {
    // RoomEvent (a value, not a type) is used to subscribe to DCBufferStatusChanged for
    // the reliable-channel backpressure shed (see livekit-input-capture-backpressure.test).
    expect(body).toMatch(
      /import \{ sendInputEvent, RoomEvent, type InputEvent, type Room \} from '\.\/livekit'/,
    );
  });

  it('wires all 6 browser event sources (mousemove/down/up + wheel + keydown/up)', () => {
    expect(body).toMatch(/addEventListener\('mousemove'/);
    expect(body).toMatch(/addEventListener\('mousedown'/);
    expect(body).toMatch(/addEventListener\('mouseup'/);
    expect(body).toMatch(/addEventListener\('wheel'/);
    expect(body).toMatch(/addEventListener\('keydown'/);
    expect(body).toMatch(/addEventListener\('keyup'/);
  });

  it('emits iPhone-COHERENT TOUCH variants (touchStart/Move/End + keyDown/Up); wheel scroll is a touchStream drag (per-move scroll, no momentum), NOT a swipe; NEVER mouse* (W198/W1249 — mouse events are a detectable iPhone tell the harness drops)', () => {
    expect(body).toMatch(/type: 'touchStart'/);
    expect(body).toMatch(/type: 'touchMove'/);
    expect(body).toMatch(/type: 'touchEnd'/);
    expect(body).toMatch(/type: 'keyDown'/);
    expect(body).toMatch(/type: 'keyUp'/);
    // Wheel/trackpad scroll now drives a touchStream drag (A3 W2736: the fork adds
    // its OWN momentum to every `swipe`, so ~100 wheel events/sec stacked into jumpy
    // overshoot / "randomly scrolls back up") → the GUI no longer emits `swipe`.
    expect(body).not.toMatch(/type: 'swipe'/);
    // The browser EVENT SOURCES stay mouse (the user drives with a mouse), but
    // no mouse* InputEvent is ever emitted on the wire (W198/W1249 coherence).
    expect(body).not.toMatch(/type: 'mouseMove'/);
    expect(body).not.toMatch(/type: 'mouseDown'/);
    expect(body).not.toMatch(/type: 'mouseUp'/);
  });

  it('touchMove is sent lossy (reliable=false) — a dropped move jitters then recovers > congestion', () => {
    expect(body).toMatch(/send\(\{ type: 'touchMove'[^}]+\}, false\)/);
  });

  it('mouseDown / mouseUp / wheel / keyDown / keyUp are reliable (must arrive in order)', () => {
    // Three inline forms (mouseDown / mouseUp / wheel) + two multi-
    // line forms (keyDown / keyUp). Sum should be ≥5 reliable sends.
    const inline = (body.match(/,\s*true\)/g) ?? []).length;
    const multiline = (body.match(/\btrue,\n\s+\)/g) ?? []).length;
    expect(inline + multiline).toBeGreaterThanOrEqual(5);
  });

  it('coordinate translation maps browser px → the per-archetype captured-frame logical device frame (threaded `logical`, default 402×874), NOT the SFU-downscaled track px (founder tap-offset fix / A3 W2811 + per-archetype content-only fork A3 84de32ad4d)', () => {
    // The element-offset math stays.
    expect(body).toMatch(/event\.clientX - rect\.left/);
    // Scale against the per-archetype captured-frame logical device frame (the live
    // `logical` dims = videoW/dpr × videoH/dpr; 402×874 only as the pre-stream
    // fallback), NEVER video.videoWidth/Height: the SFU REMB-downscales the published
    // track under bandwidth pressure, which (pre-fix) halved every coord on a throttle
    // so a tap landed high-and-left ("above where I tap"), snapping back on recovery.
    // The content-only fork (84de32ad4d) makes the captured frame the web content
    // edge-to-edge, sized per archetype, so the touch space is per-device now.
    expect(body).toMatch(/const DEVICE_LOGICAL_WIDTH = 402/);
    expect(body).toMatch(/const DEVICE_LOGICAL_HEIGHT = 874/);
    expect(body).toMatch(/const nw = logical\.width/);
    expect(body).toMatch(/const nh = logical\.height/);
    // The per-archetype live dims are an opt on the hook + a param on pointerToViewport,
    // threaded from the <video>'s first full-res natural size ÷ dpr (parent-side).
    expect(body).toMatch(/logical\?: \{ width: number; height: number \}/);
    // `ownsAuthority` joined the dependency list when input was fenced to the
    // control-authority holder: losing authority must re-run the effect and
    // detach the listeners, not keep sending input from a demoted viewer.
    expect(body).toMatch(/\}, \[room, video, enabled, logicalW, logicalH, ownsAuthority\]\);/);
  });

  it('mouseButton() restricts to 0|1|2 (left/middle/right) matching Quartz', () => {
    expect(body).toMatch(/raw === 0 \|\| raw === 1 \|\| raw === 2/);
  });

  it('2026-05-20 — modifiersFromEvent collects cmd/ctrl/shift/option (Mac-native labels, 1:1 with Quartz CGEventFlagMask) from KeyboardEvent meta/ctrl/shift/alt flags', () => {
    expect(body).toMatch(/event\.shiftKey/);
    expect(body).toMatch(/event\.ctrlKey/);
    expect(body).toMatch(/event\.altKey/);
    expect(body).toMatch(/event\.metaKey/);
    expect(body).toMatch(/'cmd'/);
    expect(body).toMatch(/'ctrl'/);
    expect(body).toMatch(/'shift'/);
    expect(body).toMatch(/'option'/);
  });

  it('keyboard events bind to window (capture works without video focus)', () => {
    expect(body).toMatch(/window\.addEventListener\('keydown'/);
    expect(body).toMatch(/window\.addEventListener\('keyup'/);
  });

  it('mouseDown attempts pointer-capture so subsequent move/up land outside the element', () => {
    expect(body).toMatch(/setPointerCapture/);
  });

  it('cleanup removes every listener it installed (no leaks on unmount)', () => {
    // mousedown + wheel stay on the video; move + release are on WINDOW so an
    // off-element drag keeps scrolling (S1) and pointerup wins the release race so
    // the inertial fling actually runs (B1, audit w5q5vvdca).
    expect(body).toMatch(/video\.removeEventListener\('mousedown'/);
    expect(body).toMatch(/video\.removeEventListener\('wheel'/);
    expect(body).toMatch(/window\.removeEventListener\('mousemove'/);
    expect(body).toMatch(/window\.removeEventListener\('mouseup'/);
    expect(body).toMatch(/window\.removeEventListener\('pointerup'/);
    expect(body).toMatch(/window\.removeEventListener\('keydown'/);
    expect(body).toMatch(/window\.removeEventListener\('keyup'/);
  });

  it('hook short-circuits when enabled=false OR room===null OR video===null (no listeners installed) — the guard now also bails before the <video> element mounts (added video===null) so the window-level mouseup/pointerup fallback + editingLocally key guards are all installed AFTER the short-circuit', () => {
    // Effect reads PRIMITIVES off opts (room / videoElement→video / enabled) so it
    // re-runs on the real values, then short-circuits before installing any listener.
    expect(body).toMatch(/const \{ room, videoElement: video, enabled \} = opts;/);
    expect(body).toMatch(
      /if \(!enabled \|\| room === null \|\| video === null \|\| !ownsAuthority\(room\)\) return;/,
    );
  });

  it('sendInputEvent rejections are swallowed per-event BUT the first failure is surfaced (best-effort — handlers never throw; a silently-dead control channel read as view-only, founder-hit 2026-06-12)', () => {
    expect(body).toMatch(/sendInputEvent\([\s\S]+?\.catch\(\(err: unknown\) =>/);
    expect(body).toMatch(/warnedPublishFailure = true;/);
    expect(body).toMatch(/input publish failed — control will not reach the device/);
    expect(body).toMatch(/return undefined;/);
  });
});
