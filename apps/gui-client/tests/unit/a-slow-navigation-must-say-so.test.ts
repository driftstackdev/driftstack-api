import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Owner, reported TWICE (2026-08-31 and again 2026-09-01):
 *
 *   "I load a new url sometimes, it loads, the loading bar, and just suddenly
 *    stops. No error code nothing, it just stays on the old page. Wait after
 *    like 1/2 minutes it jumped to this url. But we still need better handle
 *    this, its inconvenient user experience like that."
 *
 * ⛔ The second sentence is the request, and it is a CLIENT UX request — not a
 * device-side diagnosis. The load bar trickles toward 90% and DECELERATES, so
 * it asymptotically never finishes and nothing else on screen changes. A slow
 * load and a dead one render IDENTICALLY. The customer cannot tell "still
 * working" from "gave up" because the UI does not distinguish them.
 *
 * T-15 (owner #1, 2026-09-07): the first answer to that report was a pill under
 * the address field with its own 8s/25s clock — while the page-load advisory
 * over the video already ran a 9s/45s clock of its own. On a slow proxy BOTH
 * showed: "1 should be enough". The pill is gone; its 25s escalation now lives
 * in the advisory's ladder (9s → 25s → 45s), driven by ONE target-owned clock.
 * This file pins the SHAPE of that ladder at source level; the rendered
 * "exactly one element" guard is in simulator-window-navigate.test.tsx.
 *
 * ⭐ It deliberately does NOT cancel or time out the navigation — a page that
 * lands at 90s still lands, and the notice disappears when it does. Making the
 * wait legible is the fix; making it shorter is not in this lane.
 */

const SRC = resolve(__dirname, '../../src/views/SimulatorWindow.tsx');
const body = readFileSync(SRC, 'utf8');

const SLOW_COPY = 'Still loading — this proxy is slow. The page is on its way.';
const STALLED_COPY = 'Still loading. It may not arrive on its own.';
const FALLBACK_COPY = 'This page is taking longer than usual to load.';

function rung(src: string, name: string): number | undefined {
  const raw = new RegExp(`const ${name} = ([0-9_]+);`).exec(src)?.[1];
  return raw === undefined ? undefined : Number(raw.replace(/_/g, ''));
}

/**
 * Every "Still loading" literal must be raised through the advisory's own
 * setter — i.e. belong to the ONE ladder — rather than sit in a second piece of
 * markup. Returns the literals that are NOT.
 */
function strayStillLoadingLiterals(src: string): string[] {
  const stray: string[] = [];
  const re = /'Still loading[^']*'/g;
  for (const m of src.matchAll(re)) {
    const before = src.slice(Math.max(0, (m.index ?? 0) - 400), m.index);
    if (!before.includes('setPageLoadStalled(')) stray.push(m[0]);
  }
  return stray;
}

describe('a slow navigation must say so', () => {
  it('has three rungs — unusual, probably-not-coming, and the give-up fallback — in that order', () => {
    const slow = rung(body, 'PAGE_LOAD_SLOW_HINT_MS');
    const stalled = rung(body, 'PAGE_LOAD_STALLED_HINT_MS');
    const fallback = rung(body, 'PAGE_LOAD_FALLBACK_MS');
    expect(slow, 'PAGE_LOAD_SLOW_HINT_MS must be declared').toBeDefined();
    expect(stalled, 'PAGE_LOAD_STALLED_HINT_MS must be declared').toBeDefined();
    expect(fallback, 'PAGE_LOAD_FALLBACK_MS must be declared').toBeDefined();
    expect(slow).toBeGreaterThanOrEqual(5_000);
    expect(stalled).toBeGreaterThan(slow as number);
    expect(fallback).toBeGreaterThan(stalled as number);
  });

  it('drives each rung from elapsed load time on the target-owned watchdog, not from a guess', () => {
    expect(body).toMatch(/\}, PAGE_LOAD_SLOW_HINT_MS\);\s*slowHintRef\.current = hint;/);
    expect(body).toMatch(/\}, PAGE_LOAD_STALLED_HINT_MS\);\s*stalledHintRef\.current = escalate;/);
    // Both rungs bail when the cycle's target has moved on (a redirect / a new
    // navigate owns a fresh ladder).
    const ladder = body.slice(
      body.indexOf('const hint = window.setTimeout('),
      body.indexOf('}, PAGE_LOAD_STALLED_HINT_MS);'),
    );
    expect(
      ladder.match(/if \(loadWatchdogRef\.current\.target !== target\) return;/g),
    ).toHaveLength(2);
  });

  it('renders copy the customer can actually read, escalating in plain words', () => {
    expect(body).toContain(SLOW_COPY);
    expect(body).toContain(STALLED_COPY);
    expect(body).toContain(FALLBACK_COPY);
  });

  it('T-15 — says it from ONE element: the address-bar pill is gone and every rung goes through the advisory', () => {
    expect(body).not.toContain('data-component="simulator-slow-nav"');
    expect(body).not.toMatch(/\bnavAge\b/);
    expect(strayStillLoadingLiterals(body)).toEqual([]);
    // VACUITY CONTROL — derived, not hand-labelled: put the old pill back into this
    // very body and the same detector must go red, or "no stray literal" would be
    // a statement about the regex rather than about the file.
    const withPillBack = `${body}\n<div data-component="simulator-slow-nav">{'Still loading — this page is taking longer than usual.'}</div>\n`;
    expect(strayStillLoadingLiterals(withPillBack)).toHaveLength(1);
    expect(withPillBack).toContain('data-component="simulator-slow-nav"');
  });

  it('offers the retry the customer would otherwise reach for blindly, on the SAME banner', () => {
    // The advisory's Retry re-issues the navigation through onNavigate (never a
    // second reload path), and it renders on the one advisory element.
    expect(body).toMatch(
      /data-component="page-load-stalled-banner"[\s\S]{0,1200}data-action="retry-stalled-navigate"[\s\S]{0,200}onNavigate\(/,
    );
  });

  it('⛔ retires on completion, so a fast load never shows it and a landed page never keeps it', () => {
    // A page that arrives clears the watchdog, and the watchdog clears the ladder.
    expect(body).toMatch(/const clearLoadWatchdog = \(\): void => \{\s*cancelLoadWatchdog\(\);/);
    expect(body).toMatch(
      /const cancelLoadWatchdog = \(\): void => \{[\s\S]{0,900}setPageLoadStalled\(\(prev\) => \(prev\?\.local === true \? null : prev\)\);/,
    );
  });

  it('never cancels the navigation', () => {
    // Making the wait legible is the fix; timing it out would turn a page that
    // was going to arrive into one that never does. The 25s rung only sets copy.
    const escalate = body.slice(
      body.indexOf('const escalate = window.setTimeout('),
      body.indexOf('}, PAGE_LOAD_STALLED_HINT_MS);'),
    );
    expect(escalate.length).toBeGreaterThan(0);
    expect(escalate).not.toMatch(/abort|cancel|stopLoading|setPageLoading\(false\)/i);
  });
});
