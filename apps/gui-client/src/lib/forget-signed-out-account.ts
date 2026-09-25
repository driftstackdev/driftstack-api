// GUI audit #5 — sign-out leaves nothing of the account for the next person.
//
// The app keeps several local stores that are NOT keyed by account: the AI
// chat history, the saved proxies (with their credentials and the vault key),
// the cached proxy readings, the profile bindings and the local profile notes.
// Sign-out used to remove the account key and nothing else, so on a shared
// computer the next person to sign in saw the previous account's transcripts
// and proxies — and a Simulator window could still be driving its live session.
//
// Every sign-out path calls this AFTER the key is removed (so no mounted view is
// still writing as the old account). Each step is independent and best-effort:
// one store that fails to clear must not keep the others, and sign-out itself
// must never fail on it.

import { forgetAllChats } from './chat-history';
import { closeAllSimulatorWindows } from './open-simulator';
import { forgetAllBindings } from './profile-bindings';
import { forgetProfilesMeta } from './profiles-meta';
import { forgetAllProxies } from './proxies';
import { forgetProbeCache } from './proxy-probe-cache';

// Each step is called through a wrapper, never referenced at module load: the
// stores are read only when someone actually signs out.
const STEPS: ReadonlyArray<readonly [string, () => Promise<void>]> = [
  ['Simulator windows', () => closeAllSimulatorWindows()],
  ['AI chat history', () => forgetAllChats()],
  ['saved proxies', () => forgetAllProxies()],
  ['proxy readings', () => forgetProbeCache()],
  ['profile bindings', () => forgetAllBindings()],
  ['profile notes', () => forgetProfilesMeta()],
];

/**
 * What every sign-out path asks before it does any of the above — the sidebar
 * button, ⌘⇧L and Settings all show THIS text, so what the customer is told is
 * removed cannot drift from STEPS (a test holds each step to a phrase here).
 * It says what is removed from this computer, what stays, and that nothing
 * changes on the account itself.
 */
export const SIGN_OUT_CONFIRM_MESSAGE = [
  'Sign out on this computer?',
  '',
  'This removes from this computer: your API key, your AI chat history, your saved proxies with their passwords, proxy check results, which proxy each profile uses, and the notes, folders and tags you gave your profiles. Any open iPhone window closes.',
  '',
  'Your recordings stay on this computer. Nothing changes on your Driftstack account: your profiles and sessions stay, and your API key keeps working until you revoke it in the web dashboard.',
].join('\n');

export async function forgetSignedOutAccount(): Promise<void> {
  // Sequential: several of these share settings.json, and the order keeps the
  // windows (the only step with a live session behind it) first.
  for (const [what, step] of STEPS) {
    try {
      await step();
    } catch (err) {
      console.warn(`[sign-out] could not clear ${what}:`, err);
    }
  }
}
