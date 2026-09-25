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
export const CHECK_VPN_TITLE = `${CHECK_VPN_ACTION} — checks the address, connects the VPN and measures its latency and exit.`;

/** #2 — what an HTTP row's check does: the address, nothing more. */
export const CHECK_ENDPOINT_TITLE =
  'Check that this address can be found — the proxy itself is verified when a session launches.';

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
export const VPN_NO_EXIT_YET_TITLE = `No exit measured yet. Run ${CHECK_VPN_ACTION}, or launch a session — a live session reports its own exit.`;

/** (n) N-M1 / Phase B — V-857's THIRD exit state ("the probe did not complete"),
 *  hoisted from the card so the Proxies grid (ProxiesView) and the profile card
 *  read one constant: the whole finding was that the two surfaces described the
 *  same cache state in different words. The card renders the SHORT clause with
 *  the full sentence as its title; the grid renders the full sentence. Derived,
 *  never retyped — `EXIT_GEO_UNAVAILABLE` stays byte-identical to the literal
 *  the grid shipped. */
export const EXIT_GEO_UNAVAILABLE_SHORT = 'exit location unknown';
export const EXIT_GEO_UNAVAILABLE = `${EXIT_GEO_UNAVAILABLE_SHORT} — the check did not complete`;
export const EXIT_GEO_UNAVAILABLE_TITLE =
  'The proxy accepted the connection and login, but no traffic made it through. Try the test again.';

/** #3 — the card's latency slot for a VPN row with no fleet number: nothing
 *  was ever measured, so "stale" (a number that aged) is the wrong word. */
export const VPN_LATENCY_NOT_MEASURED = 'not measured';
/** (o) — the hover text of that pill when the row ALREADY SHOWS an exit (a live
 *  session reported it, or the list adopted it) but no latency was ever
 *  measured through the tunnel. `VPN_NO_EXIT_YET_TITLE` was used here and
 *  asserted "No exit measured yet" two rows above the exit it contradicted;
 *  this sentence names only what is missing. */
export const VPN_NO_LATENCY_YET_TITLE = `No latency measured through this VPN yet. Run ${CHECK_VPN_ACTION} to measure it.`;

/** (o) — the Proxies grid's "tunnel up · no latency" pill ((i) I4: the test Mac
 *  brought the tunnel up and observed the exit but reported no number). The
 *  profile card reads the SAME cache entry and used to call it "not measured"
 *  with a "no exit yet" title beside the exit that reply put on the row; both
 *  surfaces now carry this one sentence. */
export const VPN_TUNNEL_UP_NO_LATENCY_TITLE =
  'The VPN connected and was measured, but no latency was reported.';

/** (o) — the pre-flight of a VPN/HTTP row is a DNS resolve of its endpoint. When
 *  it does NOT resolve, nothing downstream ran: no tunnel, no latency, no exit.
 *  The grid's pill has said "unresolved" (with the resolver's message) since
 *  T-20; the profile card said "not measured" + "no exit measured yet — run
 *  Check VPN", promising a check that cannot bring the tunnel up. This is the
 *  card's word for the exit line; the pill carries the resolver's message. */
export const ENDPOINT_UNRESOLVED = 'address unknown';
export const ENDPOINT_UNRESOLVED_EXIT_TITLE = `The address could not be found, so no exit could be measured. Fix the address, then ${RECHECK_ACTION}.`;

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
 *  The next step must be a control the GUI has, and wherever two gates meet the
 *  KEY is checked first — a customer with no key cannot store anything, so the
 *  key is the blocker to name.
 *
 *  ⛔ REWRITTEN 2026-09-17, because the sentence had become false. It read
 *  "Launch a session through this VPN once to save it to your account; then
 *  Check VPN can test it", which was true while nothing on the Proxies tab could
 *  store a row — and it sent the customer to run the one thing that was failing,
 *  through a proxy nobody had checked. The tab's own check now STORES the row
 *  (ProxiesView.handleCheckEndpoint), exactly as the profile card's already did,
 *  so "launch a session once" names a step nobody needs to take.
 *
 *  What still reaches this notice is the fail-safe: the local row was DELETED
 *  while a check was in flight (a VPN check runs up to ~90 s), so
 *  `ensureAccountProxyRow` undid its own create and answered "nothing to test".
 *  A refusal by the account has its own sentences below. */
export const VPN_NOT_STORED_CHECK_NOTICE = `Address found. This VPN is not saved to your account, so it was not tested. Run ${CHECK_VPN_ACTION} again.`;
/** The Test-all tally's short form of the same reason (one clause per row). */
export const VPN_NOT_STORED_TALLY_REASON = 'not saved to your account';
export const VPN_NO_API_KEY_CHECK_NOTICE = `Address found. ${MISSING_API_KEY_NEXT_STEP}.`;

/**
 * (V2 2026-09-12, owner: "openvpn … not showing info measurements of proxy
 * check like a socks5 does after adding") — the two notices a VPN check leaves
 * when it STORES the row itself and the store is refused.
 *
 * ⛔ The sentence above (`VPN_NOT_STORED_CHECK_NOTICE`) described the OLD
 * behaviour and was the whole defect: a VPN row's check returned at
 * `serverId === undefined` and told the customer to launch a session — while
 * the launch they were told to run is the thing that was failing, so the one
 * measurement that would have explained it could never be taken. The check
 * stores the row now, exactly as the SOCKS5 Test has since (q) 12-memory (A),
 * and these say why when that store cannot happen. The old sentence stays as
 * the fallback for a store that returned no id at all.
 *
 * The PLAN case gets its own sentence rather than the server's: the control
 * plane's 403 detail names an internal feature flag (`The "vpnEgress" feature
 * is not available on the "free" tier.`), which is not a sentence to show a
 * customer — and it is the one refusal a retry can never fix.
 */
export const VPN_PLAN_EXCLUDED_CHECK_NOTICE =
  'Address found. Your plan does not include VPN proxies, so this VPN could not be tested and sessions cannot use it. Upgrade to use OpenVPN or WireGuard.';
/** The Test-all tally's clause for the same refusal. */
export const VPN_PLAN_EXCLUDED_TALLY_REASON = 'not included in your plan';
/** The Test-all tally's clause when the store failed for any other reason. */
export const VPN_STORE_FAILED_TALLY_REASON = 'could not be stored on your account';

/**
 * (V4 follow-up 2026-09-12) — the row IS stored, and the PUT that re-pushes the
 * config this Mac holds FAILED, so the tunnel the test Mac brought up is the one
 * some EARLIER save stored.
 *
 * ⛔ That failure used to be swallowed whole: the check's catch only spoke when
 * `serverId` was undefined, so for a stored row a refused re-sync said nothing
 * and the customer was shown a measurement of a DIFFERENT configuration than the
 * one in front of them, with no way to know. The comment above the catch
 * justified the silence with "an unedited row already matches" — which is false
 * for exactly the population this whole item serves: `accountProxyInputFor`
 * heals a legacy OpenVPN blob and `persistHealedOpenvpn` writes the healed copy
 * LOCALLY before the wire, so a healed row provably does not match the stored
 * one. The result still stands (it is a real measurement of a real config); the
 * sentence says which config it describes.
 */
export const VPN_STALE_CONFIG_CHECK_NOTICE =
  'Address found. Your latest VPN settings could not be sent to your account, so this result is for the settings saved earlier. Try the check again.';

/**
 * (2026-09-17) — what a VPN row shows WHILE its check runs.
 *
 * ⛔ The check is not a local one and it is not quick: the address is resolved
 * here, the row is stored on the account, and then Driftstack brings the tunnel
 * up and measures through it — up to about 90 seconds on a busy minute. A bare
 * "Checking…" beside a row that then sits still for a minute and a half reads as
 * a hang, and the one thing a customer can usefully do about it is wait, which
 * they will only do if told how long. Says WHAT and HOW LONG; never where it runs.
 */
export const VPN_CHECK_IN_PROGRESS = 'Testing through Driftstack — up to 90 s';

/** (j) J4 — the free-desktop credential cannot reach the test route: the row
 *  is "not tested".
 *
 *  GUI audit #11 — and the reason is the PLAN. The route policy that refuses it
 *  applies only to a Free account's desktop sign-in key; the full check is a
 *  paid-plan feature. This used to read "needs an API key — Connect your API key
 *  in Settings to test it", which is a dead end: the customer IS signed in, and
 *  a pasted key is refused for Free accounts as well. The tally clause and the
 *  sentence (`DESKTOP_CREDENTIAL_FLEET_TEST_REASON`) now say what is true. */
export const FREE_PLAN_FLEET_TEST_SENTENCE =
  "The full check through Driftstack isn't included on the Free plan. Upgrade your plan to run it.";
export const DESKTOP_CREDENTIAL_TALLY_REASON = 'not included on the Free plan';
/** Follow-up A (2026-09-24) — the WORD a SOCKS5 row's missing Driftstack side
 *  shows when the plan is why it is missing (it sits where the number would, so
 *  it is short; the hover is the plan sentence). It replaced "not tested", which
 *  promised a measurement the plan will never take. */
export const FLEET_TEST_NOT_ON_PLAN_WORD = 'not on plan'; // = NOT_ON_THIS_PLAN_LABEL

/** (p) D1 — the ONE word for re-running a SOCKS5 test once a row holds a
 *  result, on the Proxies grid's row button AND the profile card's repair row
 *  (the comp said 'Retest'; the grid rendered a literal, the card a constant
 *  pinned against it — now both read this). */
export const RETEST_ACTION = 'Re-test';

/** (p) D1 — the grid's EndpointHealthPill word + title for a VPN/HTTP row whose
 *  endpoint resolved and whose tunnel was never brought up. The card's health
 *  pill reads the same cache entry (it once said 'not measured' for it), so
 *  both surfaces read these two strings. */
export const ENDPOINT_OK_PILL = 'address ok';
export const ENDPOINT_OK_TITLE =
  'The address was found. The connection itself is tested once the proxy is saved to your account, and verified when a session launches.';

/**
 * (V6 2026-09-16) ITEM 3 — a VPN row's UDP state, in THREE states, defined once
 * for the three surfaces that show it (the Proxies grid, the profile card, the
 * profiles list). They described the same cache state in their own words before,
 * which is the same defect this module was created for.
 *
 * ⛔ THE NOT-MEASURED SENTENCE LEADS WITH THE STATE, AND SAYS THE WORD.
 * It read "UDP travels inside the VPN. WebRTC and QUIC use it; run Check VPN to
 * measure QUIC through this VPN." — three true clauses, not one of which says
 * nobody looked. That is a flat capability claim about the customer's tunnel,
 * hedged by nothing, in the state that exists PRECISELY BECAUSE the control plane
 * refused to forward the node's asserted `udp_associate: true` as a reading. A
 * customer reading it concluded UDP had been checked and worked: the item's
 * failure mode was not removed, only moved off the wire and into the copy.
 *
 * The repo's own honest twin is `NO_TEST_MAC_QUIC_HINT` in ProxiesView, which
 * opens "Not measured yet — …" and renders in the cell 29 lines away. Same shape
 * here: the absence first, then what is true of a tunnel.
 *
 * ⛔ AND IT STILL MUST NOT NAME A BUTTON THAT CANNOT PRODUCE THE VALUE. Today's
 * fleet node does not probe UDP on the VPN path at all — it ASSERTS
 * `udp_associate: true` about the tunnel's nature — so there is nothing a customer
 * can press to fill this in. Check VPN is named only for QUIC, which that check
 * really does measure. When the node's contracted three-state UDP arrives, the
 * reading replaces this sentence with one of the two below.
 *
 * ⛔ AND NOT-MEASURED IS NEVER RENDERED AS A NEGATIVE. "No UDP" is reserved for
 * `VPN_UDP_MEASURED_NONE_TITLE`, which only a probed `false` can reach: a
 * customer must never be told their tunnel lacks UDP because nobody looked.
 */
export const VPN_UDP_NOT_MEASURED_TITLE = `UDP through this tunnel has not been measured yet. UDP travels inside the VPN. ${CHECK_VPN_ACTION} measures QUIC through the tunnel.`;
export const VPN_UDP_MEASURED_OK_TITLE =
  'UDP relays through this tunnel — measured from Driftstack’s network. WebRTC and QUIC can use it.';
export const VPN_UDP_MEASURED_NONE_TITLE =
  'No UDP through this tunnel — measured from Driftstack’s network. WebRTC falls back to a slower, more detectable path and QUIC falls back to HTTP/2.';

// ─── The VPN row's QUIC reading ──────────────────────────────────────────────
//
// ⛔ (2026-09-17) IT MOVED HERE, and the header's "constants only" is now "copy,
// and the one function that CHOOSES between these strings". The reason is the
// module's own reason: the profile LIST said nothing about QUIC for a VPN row —
// its `quic` state was hard-wired to "not tested" because a tunnel has no SOCKS5
// capabilities to derive one from — while the Proxies grid and the profile card
// showed a measured green for the same proxy from the same cache. One proxy, two
// answers, on two screens a customer reads side by side.
//
// Copying the four-branch choice into the list would have been a third answer
// waiting to happen, so the choice lives beside the words it chooses. It is
// imported, not re-implemented; the only value it pulls in is `agedReadingHint`,
// from the import-free os-fingerprint-verdict, and the types are erased.

import { agedReadingHint } from './os-fingerprint-verdict';
import type { MeasuredQuic } from './account-proxies';
import type { AgedReading } from './proxy-probe-cache';

/** Not measured, and the reason is Driftstack rather than the customer's tunnel —
 *  so the hint must not name the tunnel as the thing that failed. */
export const NO_TEST_MAC_QUIC_HINT = `Not measured yet — Driftstack was busy. QUIC is measured from Driftstack’s network; try ${CHECK_VPN_ACTION} again in a few minutes.`;

/**
 * (2026-09-17) — the chip LABEL for a reading the account's plan will never
 * produce, and the sentence behind it.
 *
 * ⛔ "untested" is the wrong word here, and it is wrong in a way that costs the
 * customer time: it says a check has not happened YET, so they press the button
 * that cannot work, read "not measured yet" again, and conclude the app is
 * broken. VPN proxies are a paid-plan feature — on a Free account there is no
 * check to run and no amount of pressing produces one. The label says what is
 * true of the reading and the hint says what would change it.
 */
//
// ⛔ 2026-09-24 (owner item 9) — SHORTENED to the word every surface can fit.
// The Proxies tab printed "UDP — not included on this plan"; the profile card's
// 144px caps row has no room for that and printed "⇢ UDP" (NOT MEASURED) for the
// same tunnel instead — one state, two claims. The card, the list and the grid
// now print the same "UDP — not on plan"; the whole sentence is the hover.
export const NOT_ON_THIS_PLAN_LABEL = 'not on plan';
/** The UDP chip's text for a reading the plan will never produce — grid, card
 *  and list. */
export const UDP_NOT_ON_PLAN_CHIP = `UDP — ${NOT_ON_THIS_PLAN_LABEL}`;
export const VPN_QUIC_NOT_ON_PLAN_HINT =
  'VPN proxies are on paid plans, so this tunnel is not tested and QUIC through it is not measured. Upgrade to use OpenVPN or WireGuard.';
export const VPN_UDP_NOT_ON_PLAN_HINT =
  'VPN proxies are on paid plans, so this tunnel is not tested and UDP through it is not measured. Upgrade to use OpenVPN or WireGuard.';

/**
 * The QUIC reading of a VPN row — `ok` (null = not measured), the sentence that
 * says so, and the aged reading when that is what is being shown.
 *
 * STRONGEST EVIDENCE FIRST: a live session's HTTP/3 verdict outranks the relay
 * leg, because it is what a browser actually did; a measured negative of either
 * kind is a verdict and not an absence; and only when nothing CURRENT exists does
 * a dated past reading stand in, in the past tense. `noFleetMac` separates the two
 * causes of a plain absence — nobody has looked yet, or Driftstack was busy —
 * because "run Check VPN" is useless advice for the second.
 */
export function vpnQuicReading(
  quicMeasured: MeasuredQuic | undefined,
  quicProbe: boolean | undefined,
  noFleetMac: boolean,
  /** The row's aged QUIC reading, consulted ONLY when nothing current exists. */
  past: { aged: AgedReading<boolean> | undefined; nowMs: number; autoRecheck: boolean } = {
    aged: undefined,
    nowMs: Date.now(),
    autoRecheck: false,
  },
  /** The account's plan has no VPN egress, so no check of this row can ever run.
   *  ⛔ Consulted AFTER every real reading below: a row measured while the account
   *  was on a paid plan still has a verdict, and a downgrade does not un-measure
   *  it. It only replaces the "not measured yet" that would otherwise send the
   *  customer to press a button that cannot work. */
  planExcluded = false,
): { ok: boolean | null; hint: string; aged?: AgedReading<boolean>; planExcluded?: true } {
  if (quicMeasured === 'h3')
    return { ok: true, hint: 'HTTP/3 verified in a live session through this tunnel.' };
  if (quicMeasured === 'h2-only')
    return {
      ok: false,
      hint: 'No HTTP/3 — a live session fell back to HTTP/2 through this tunnel.',
    };
  if (quicProbe === true)
    return { ok: true, hint: 'QUIC works through this tunnel — sites can use HTTP/3.' };
  if (quicProbe === false)
    return {
      ok: false,
      hint: 'QUIC does not work through this tunnel — HTTP/3 falls back to HTTP/2.',
    };
  if (past.aged !== undefined)
    return {
      ok: null,
      aged: past.aged,
      hint: `${agedReadingHint(past.aged.atMs, past.nowMs, past.autoRecheck, CHECK_VPN_ACTION)} ${
        past.aged.value
          ? 'QUIC worked through this VPN then.'
          : 'QUIC did not work through this VPN then — HTTP/3 fell back to HTTP/2.'
      }`,
    };
  if (planExcluded) return { ok: null, planExcluded: true, hint: VPN_QUIC_NOT_ON_PLAN_HINT };
  return {
    ok: null,
    hint: noFleetMac
      ? NO_TEST_MAC_QUIC_HINT
      : `Not measured yet — run ${CHECK_VPN_ACTION} to test QUIC through this tunnel.`,
  };
}
