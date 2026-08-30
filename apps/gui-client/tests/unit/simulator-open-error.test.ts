import { describe, expect, it } from 'vitest';
import { friendlySimulatorOpenReason } from '../../src/lib/simulator-open-error';

describe('friendlySimulatorOpenReason', () => {
  it.each([
    ['not signed in', 'Sign in to the desktop app first, then open the session again.'],
    [
      'app not installed',
      'The Simulator app is missing and could not be installed automatically. Reinstall Driftstack from your download, then try again.',
    ],
    [
      'not running under Tauri (browser preview)',
      'Open sessions from the desktop app; a browser preview cannot launch the Simulator.',
    ],
    [
      'Cannot mint LiveKit token for closed session',
      'That session has ended. Launch the profile again to start a new one.',
    ],
    [
      'incomplete session token from server',
      'The server did not return live-view connection details. Try again.',
    ],
  ])('maps %s to actionable copy', (reason, expected) => {
    expect(friendlySimulatorOpenReason(reason)).toBe(expected);
  });

  it('never renders an unknown native launch reason', () => {
    const raw = 'spawn failed /Users/customer/Applications token=secret private-simulator.internal';
    const copy = friendlySimulatorOpenReason(raw);

    expect(copy).toBe(
      'The Simulator window could not open. Try again; if it keeps happening, restart the desktop app.',
    );
    expect(copy).not.toMatch(/\/Users|token=secret|private-simulator/i);
  });

  it('uses the same safe fallback when no reason is available', () => {
    expect(friendlySimulatorOpenReason(undefined)).toBe(
      'The Simulator window could not open. Try again; if it keeps happening, restart the desktop app.',
    );
  });
});
