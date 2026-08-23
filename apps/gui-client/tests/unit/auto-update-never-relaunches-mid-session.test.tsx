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

  it('ships OFF by default, so the default experience is being ASKED before a restart', () => {
    // Installing ends in relaunch(). Deciding on the customer's behalf that now
    // is a good moment to restart a browser-automation tool is the one thing an
    // updater should not do unprompted, so the banner — new version, current
    // version, Install & restart or Later — is what happens by default.
    expect(DEFAULT_SETTINGS.autoUpdate).toBe(false);
  });
});
