// (l) SOCKS5/VPN check copy — the customer-facing words both proxy surfaces
// (the Proxies grid and the profile card) use for the SAME action and the SAME
// next step, defined once so the two cannot drift again.
//
// Audit findings #1, #2, #9 and #10 were all one action wearing four names
// ("Check endpoint" / "run Check for the exit" / "Check VPN" / "run Check") and
// one missing credential given three next steps ("sign in to test it", "from
// the dashboard", "in Settings"). A first-time customer cannot tell that the
// card's "Check VPN" is the grid's "Check endpoint", and "the dashboard" is
// never named anywhere in the GUI as a place they can go from here.
//
// Kept out of lib/account-proxies and lib/proxy-server-test on purpose: both
// are hand-mocked by many suites, and a new export there is `undefined` in
// every hand-listed factory. This module is constants only.

/** #10 — the ONE name of a VPN row's check, on every surface: the grid button,
 *  the card menu, the exit-cell prompt, the QUIC chip hint. */
export const CHECK_VPN_ACTION = 'Check VPN';

/** #2 — an HTTP row's check is the DNS pre-flight ALONE (no tunnel to test, no
 *  exit to measure), so its button must not promise either. */
export const CHECK_ENDPOINT_ACTION = 'Check endpoint';

/** Both buttons once the row holds a pre-flight verdict. */
export const RECHECK_ACTION = 'Re-check';

/** #10 / #11 — what the VPN check does, in the customer's words (the grid
 *  button title and the card menu label share it). */
export const CHECK_VPN_TITLE = `${CHECK_VPN_ACTION} — resolves the endpoint, then the test Mac brings the tunnel up and measures its latency and exit.`;

/** #2 — what an HTTP row's check does: the address, nothing more. */
export const CHECK_ENDPOINT_TITLE =
  'Check that this address resolves — the proxy itself is verified when a session launches.';

/** #2 — an HTTP row's exit cell: no exit prompt, because no check here measures one. */
export const HTTP_VERIFIED_AT_LAUNCH = 'verified at launch';

/** #3 — a VPN row with no exit MEASURED yet (checked, but the tunnel was never
 *  brought up: a refused test, no test Mac free, not stored, no API key, or a
 *  list-adopted entry). Says WHY there is no exit and what fills it, on the
 *  grid and the card alike; "no exit IP" was a dead end. */
export const VPN_NO_EXIT_YET = `no exit measured yet — run ${CHECK_VPN_ACTION}`;
export const VPN_NO_EXIT_YET_TITLE = `No exit measured yet. Run ${CHECK_VPN_ACTION} to bring the tunnel up on the test Mac, or launch a session — a live session reports its own exit.`;

/** #3 — the card's latency slot for a VPN row with no fleet number: nothing
 *  was ever measured, so "stale" (a number that aged) is the wrong word. */
export const VPN_LATENCY_NOT_MEASURED = 'not measured';

/** #9 — the ONE next step for a missing API key, everywhere a proxy check
 *  needs one. Settings is the place the customer can go from here; "the
 *  dashboard" and "sign in" are not. */
export const CONNECT_API_KEY_IN_SETTINGS = 'Connect your API key in Settings';
export const MISSING_API_KEY_NEXT_STEP = `${CONNECT_API_KEY_IN_SETTINGS} to test it`;

/** #1 — a single-row Check on a VPN row whose tunnel the test Mac could not
 *  be asked to bring up. The row used to return to "endpoint ok" + "run Check
 *  for the exit" with nothing saying why, sending the customer round the same
 *  loop; these notices name the reason and the next step — on the grid AND on
 *  the profile card (the card's Check VPN runs the same gate).
 *
 *  The next step must be a control the GUI has. Nothing on the Proxies tab
 *  stores a proxy on the account: `ensureServerProxy` (ProfilesView) and the
 *  chat's launch do it as a side effect of the FIRST session through the proxy,
 *  and only with an API key. So "store this proxy on your account" named a
 *  step with no button; and wherever the two gates meet, the KEY is checked
 *  first — a customer with no key cannot store anything, so the key is the
 *  blocker to name. */
export const VPN_NOT_STORED_CHECK_NOTICE = `Endpoint resolves. Launch a session through this proxy once to store it on your account; then ${CHECK_VPN_ACTION} can test the tunnel.`;
/** The Test-all tally's short form of the same reason (one clause per row). */
export const VPN_NOT_STORED_TALLY_REASON =
  'not stored on your account yet — launch a session through it once';
export const VPN_NO_API_KEY_CHECK_NOTICE = `Endpoint resolves. ${MISSING_API_KEY_NEXT_STEP}.`;

/** (j) J4 / #9 — the free-desktop credential cannot reach the test route: the
 *  row is "not tested", with the same next step a row with no key gets. */
export const DESKTOP_CREDENTIAL_NEXT_STEP = `needs an API key — ${MISSING_API_KEY_NEXT_STEP}`;
