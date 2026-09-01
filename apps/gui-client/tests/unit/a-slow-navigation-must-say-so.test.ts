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
 * ⚠️ This was deferred twice as "an owner/A1 call to arm a harness flag". That
 * was wrong: arming a watchdog would tell US what happened, and the owner asked
 * to be told something. The two are different deliverables and only one of them
 * was ever blocked.
 *
 * ⭐ It deliberately does NOT cancel or time out the navigation — a page that
 * lands at 90s still lands, and the notice disappears when it does. Making the
 * wait legible is the fix; making it shorter is not in this lane.
 */

const SRC = resolve(__dirname, '../../src/views/SimulatorWindow.tsx');
const body = readFileSync(SRC, 'utf8');

describe('a slow navigation must say so', () => {
  it('has two thresholds — unusual, and probably-not-coming', () => {
    const slow = /const NAV_SLOW_MS = ([0-9_]+);/.exec(body)?.[1]?.replace(/_/g, '');
    const stalled = /const NAV_STALLED_MS = ([0-9_]+);/.exec(body)?.[1]?.replace(/_/g, '');
    expect(slow, 'NAV_SLOW_MS must be declared').toBeDefined();
    expect(stalled, 'NAV_STALLED_MS must be declared').toBeDefined();
    expect(Number(slow)).toBeGreaterThanOrEqual(5_000);
    expect(Number(stalled)).toBeGreaterThan(Number(slow));
  });

  it('drives the state from elapsed load time, not from a guess', () => {
    expect(body).toMatch(/setNavAge\(/);
    expect(body).toMatch(
      /elapsed >= NAV_STALLED_MS \? 'stalled' : elapsed >= NAV_SLOW_MS \? 'slow' : 'normal'/,
    );
  });

  it('renders a notice the customer can actually read', () => {
    expect(body).toContain('data-component="simulator-slow-nav"');
    expect(body).toContain('taking longer than usual');
    expect(body).toContain('It may not arrive on its own.');
  });

  it('offers the reload the customer would otherwise reach for blindly', () => {
    expect(body).toContain('data-action="retry-slow-nav"');
    // Reuses the existing reload path rather than inventing a second one, so a
    // mid-edit reload keeps the same "never silently navigate away" guarantee.
    expect(body).toMatch(/data-action="retry-slow-nav"[\s\S]{0,200}onClick=\{reload\}/);
  });

  it('⛔ resets on completion, so a fast load never shows it', () => {
    // The notice is gated on barVisible AND a non-normal age; completion clears
    // both. A sticky notice after a successful load would be its own defect.
    expect(body).toMatch(/barVisible && navAge !== 'normal' &&/);
    expect(body).toMatch(/loadingActiveRef\.current = false;\s*\n\s*setNavAge\('normal'\);/);
  });

  it('never cancels the navigation', () => {
    // Making the wait legible is the fix; timing it out would turn a page that
    // was going to arrive into one that never does.
    expect(body).not.toMatch(/NAV_STALLED_MS[\s\S]{0,200}(abort|cancel|stopLoading)/i);
  });
});
