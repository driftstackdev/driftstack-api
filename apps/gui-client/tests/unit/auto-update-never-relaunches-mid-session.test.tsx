// Auto-update is on by default, and installing ends in relaunch().
//
// Those two facts together are the hazard: this is a browser-automation tool,
// and relaunching while a session is live destroys browser state the customer
// cannot get back. Being one version behind is recoverable; losing a running
// session is not. So the preference is necessary and NOT sufficient — a running
// session falls back to the existing non-blocking banner, which is the
// "customer picks the moment" path that already existed.
//
// The policy is the part worth pinning, so it lives in a pure function and the
// arms below are the truth table plus the two defaults that decide real
// behaviour on a fresh install.

import { describe, expect, it } from 'vitest';
import { shouldAutoInstall } from '../../src/lib/updater';
import { DEFAULT_SETTINGS } from '../../src/lib/settings';

describe('auto-update never relaunches mid-session', () => {
  it('CRITICAL a running session blocks the install even with auto-update ON — relaunching would destroy live browser state', () => {
    expect(shouldAutoInstall({ autoUpdate: true, sessionRunning: true })).toBe(false);
  });

  it('installs unattended when auto-update is on and nothing is running', () => {
    expect(shouldAutoInstall({ autoUpdate: true, sessionRunning: false })).toBe(true);
  });

  it('never installs unattended when the customer turned it off, session or not', () => {
    // The preference is a veto, not merely one input among several.
    expect(shouldAutoInstall({ autoUpdate: false, sessionRunning: false })).toBe(false);
    expect(shouldAutoInstall({ autoUpdate: false, sessionRunning: true })).toBe(false);
  });

  it('ships ON by default (T-14) — OFF left the owner four releases behind, because a banner nobody acts on is the same as no update', () => {
    // It shipped OFF from 2026-08-23 on the argument that the updater should
    // not decide when to restart. Measured 2026-09-07: the owner's Mac was on
    // 0.1.15 with 0.1.19 served, "Later" persisting per version. The running
    // session veto above is what protects the restart moment; the default is
    // to install. The three loader cases (absent → on, stored false stays off,
    // stored true stays on) live in
    // auto-update-is-on-unless-the-customer-turned-it-off.test.ts.
    expect(DEFAULT_SETTINGS.autoUpdate).toBe(true);
  });
});
