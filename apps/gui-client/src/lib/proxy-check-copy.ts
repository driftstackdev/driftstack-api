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
/** Phase B (2026-09-11) — the profile card's exit line is ONE fixed 18px row at
 *  a 144px content width, so it shows the SHORT half and carries the long
 *  sentence (`VPN_NO_EXIT_YET_TITLE`) as its title. The long string is derived
 *  from the short one so the grid's full sentence and the card's clause can
 *  never disagree about the state they name. */
export const VPN_NO_EXIT_YET_SHORT = 'no exit measured yet';
export const VPN_NO_EXIT_YET = `${VPN_NO_EXIT_YET_SHORT} — run ${CHECK_VPN_ACTION}`;
export const VPN_NO_EXIT_YET_TITLE = `No exit measured yet. Run ${CHECK_VPN_ACTION} to bring the tunnel up on the test Mac, or launch a session — a live session reports its own exit.`;

/** (n) N-M1 / Phase B — V-857's THIRD exit state ("the probe did not complete"),
 *  hoisted from the card so the Proxies grid (ProxiesView) and the profile card
 *  read one constant: the whole finding was that the two surfaces described the
 *  same cache state in different words. The card renders the SHORT clause with
 *  the full sentence as its title; the grid renders the full sentence. Derived,
 *  never retyped — `EXIT_GEO_UNAVAILABLE` stays byte-identical to the literal
 *  the grid shipped. */
export const EXIT_GEO_UNAVAILABLE_SHORT = 'exit geo unavailable';
export const EXIT_GEO_UNAVAILABLE = `${EXIT_GEO_UNAVAILABLE_SHORT} — the probe did not complete`;
export const EXIT_GEO_UNAVAILABLE_TITLE =
  'The proxy connected and authenticated, but no traffic completed a round trip through it.';

/** #3 — the card's latency slot for a VPN row with no fleet number: nothing
 *  was ever measured, so "stale" (a number that aged) is the wrong word. */
export const VPN_LATENCY_NOT_MEASURED = 'not measured';
/** (o) — the hover text of that pill when the row ALREADY SHOWS an exit (a live
 *  session reported it, or the list adopted it) but no latency was ever
 *  measured through the tunnel. `VPN_NO_EXIT_YET_TITLE` was used here and
 *  asserted "No exit measured yet" two rows above the exit it contradicted;
 *  this sentence names only what is missing. */
export const VPN_NO_LATENCY_YET_TITLE = `No latency measured through this tunnel yet. Run ${CHECK_VPN_ACTION} to bring the tunnel up on the test Mac and measure it.`;

/** (o) — the Proxies grid's "tunnel up · no latency" pill ((i) I4: the test Mac
 *  brought the tunnel up and observed the exit but reported no number). The
 *  profile card reads the SAME cache entry and used to call it "not measured"
 *  with a "no exit yet" title beside the exit that reply put on the row; both
 *  surfaces now carry this one sentence. */
export const VPN_TUNNEL_UP_NO_LATENCY_TITLE =
  'The test Mac brought this tunnel up and measured through it, but reported no latency.';

/** (o) — the pre-flight of a VPN/HTTP row is a DNS resolve of its endpoint. When
 *  it does NOT resolve, nothing downstream ran: no tunnel, no latency, no exit.
 *  The grid's pill has said "unresolved" (with the resolver's message) since
 *  T-20; the profile card said "not measured" + "no exit measured yet — run
 *  Check VPN", promising a check that cannot bring the tunnel up. This is the
 *  card's word for the exit line; the pill carries the resolver's message. */
export const ENDPOINT_UNRESOLVED = 'unresolved';
export const ENDPOINT_UNRESOLVED_EXIT_TITLE = `The endpoint did not resolve, so no exit could be measured. Fix the address, then ${RECHECK_ACTION}.`;

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

/** (p) D1 — the ONE word for re-running a SOCKS5 test once a row holds a
 *  result, on the Proxies grid's row button AND the profile card's repair row
 *  (the comp said 'Retest'; the grid rendered a literal, the card a constant
 *  pinned against it — now both read this). */
export const RETEST_ACTION = 'Re-test';

/** (p) D1 — the grid's EndpointHealthPill word + title for a VPN/HTTP row whose
 *  endpoint resolved and whose tunnel was never brought up. The card's health
 *  pill reads the same cache entry (it once said 'not measured' for it), so
 *  both surfaces read these two strings. */
export const ENDPOINT_OK_PILL = 'endpoint ok';
export const ENDPOINT_OK_TITLE =
  'The endpoint resolved. The tunnel itself is measured by the test Mac when the proxy is stored on your account, and verified at launch.';
