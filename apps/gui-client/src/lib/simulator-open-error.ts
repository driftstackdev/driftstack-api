/**
 * Convert the launcher's support-facing reason into customer-safe action copy.
 * The launcher deliberately retains its raw reason for console diagnostics;
 * every DOM/toast caller must cross this boundary before rendering it.
 */
export function friendlySimulatorOpenReason(reason: string | undefined): string {
  const normalized = (reason ?? '').trim().toLowerCase();

  if (normalized.includes('not signed in')) {
    return 'Sign in to the desktop app first, then open the session again.';
  }
  if (normalized.includes('not installed')) {
    // ⛔ This sentence used to read "Install the Driftstack Simulator app, then
    // try again" — an instruction the customer cannot follow, because the macOS
    // DMG ships Driftstack.app alone and the Simulator is not distributed on its
    // own (V-2147). Reaching this text now also means the automatic install was
    // tried and could not find a copy to install, so the honest next step is
    // reinstalling the app that carries it — not hunting for a separate download.
    return 'The Simulator app is missing and could not be installed automatically. Reinstall Driftstack from your download, then try again.';
  }
  if (normalized.includes('browser preview') || normalized.includes('not running under tauri')) {
    return 'Open sessions from the desktop app; a browser preview cannot launch the Simulator.';
  }
  if (
    normalized.includes('403') ||
    normalized.includes('404') ||
    normalized.includes('not found') ||
    normalized.includes('expired') ||
    normalized.includes('closed') ||
    normalized.includes('cannot mint')
  ) {
    return 'That session has ended. Launch the profile again to start a new one.';
  }
  if (normalized.includes('incomplete session token')) {
    return 'The server did not return live-view connection details. Try again.';
  }
  return 'The Simulator window could not open. Try again; if it keeps happening, restart the desktop app.';
}
