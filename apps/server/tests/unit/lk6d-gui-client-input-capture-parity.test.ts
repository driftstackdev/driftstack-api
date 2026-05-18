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

  it('imports sendInputEvent + InputEvent + Room from the wrapper (no duplicates)', () => {
    expect(body).toMatch(
      /import \{ sendInputEvent, type InputEvent, type Room \} from '\.\/livekit'/,
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

  it('emits all 6 outgoing InputEvent variants (mouseMove/Down/Up + wheel + keyDown/Up)', () => {
    expect(body).toMatch(/type: 'mouseMove'/);
    expect(body).toMatch(/type: 'mouseDown'/);
    expect(body).toMatch(/type: 'mouseUp'/);
    expect(body).toMatch(/type: 'wheel'/);
    expect(body).toMatch(/type: 'keyDown'/);
    expect(body).toMatch(/type: 'keyUp'/);
  });

  it('mouseMove is sent lossy (reliable=false) — cursor jitter > congestion', () => {
    expect(body).toMatch(/send\(\{ type: 'mouseMove'[^}]+\}, false\)/);
  });

  it('mouseDown / mouseUp / wheel / keyDown / keyUp are reliable (must arrive in order)', () => {
    // Three inline forms (mouseDown / mouseUp / wheel) + two multi-
    // line forms (keyDown / keyUp). Sum should be ≥5 reliable sends.
    const inline = (body.match(/,\s*true\)/g) ?? []).length;
    const multiline = (body.match(/\btrue,\n\s+\)/g) ?? []).length;
    expect(inline + multiline).toBeGreaterThanOrEqual(5);
  });

  it('coordinate translation converts browser px → video.videoWidth/Height logical px', () => {
    expect(body).toMatch(/event\.clientX - rect\.left/);
    expect(body).toMatch(/video\.videoWidth \|\| rect\.width/);
    expect(body).toMatch(/video\.videoHeight \|\| rect\.height/);
  });

  it('mouseButton() restricts to 0|1|2 (left/middle/right) matching Quartz', () => {
    expect(body).toMatch(/raw === 0 \|\| raw === 1 \|\| raw === 2/);
  });

  it('modifiersFromEvent collects Shift / Control / Alt / Meta from KeyboardEvent flags', () => {
    expect(body).toMatch(/event\.shiftKey/);
    expect(body).toMatch(/event\.ctrlKey/);
    expect(body).toMatch(/event\.altKey/);
    expect(body).toMatch(/event\.metaKey/);
    expect(body).toMatch(/'Shift'/);
    expect(body).toMatch(/'Control'/);
    expect(body).toMatch(/'Alt'/);
    expect(body).toMatch(/'Meta'/);
  });

  it('keyboard events bind to window (capture works without video focus)', () => {
    expect(body).toMatch(/window\.addEventListener\('keydown'/);
    expect(body).toMatch(/window\.addEventListener\('keyup'/);
  });

  it('mouseDown attempts pointer-capture so subsequent move/up land outside the element', () => {
    expect(body).toMatch(/setPointerCapture/);
  });

  it('cleanup removes every listener it installed (no leaks on unmount)', () => {
    expect(body).toMatch(/video\.removeEventListener\('mousemove'/);
    expect(body).toMatch(/video\.removeEventListener\('mousedown'/);
    expect(body).toMatch(/video\.removeEventListener\('mouseup'/);
    expect(body).toMatch(/video\.removeEventListener\('wheel'/);
    expect(body).toMatch(/window\.removeEventListener\('keydown'/);
    expect(body).toMatch(/window\.removeEventListener\('keyup'/);
  });

  it('hook short-circuits when enabled=false OR room===null (no listeners installed)', () => {
    expect(body).toMatch(/if \(!enabled \|\| room === null\) return/);
  });

  it('sendInputEvent rejections are swallowed (best-effort — handlers must never throw)', () => {
    expect(body).toMatch(/sendInputEvent\([\s\S]+?\.catch\(\(\) => undefined\)/);
  });
});
