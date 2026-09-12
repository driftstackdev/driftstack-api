// Proxy management — protected local registry plus encrypted account sync.
//
// Credentials stay in protected local storage while the GUI is idle. When a
// proxy is selected for a session, the launch path creates or refreshes an
// owner-scoped account_proxies record whose secret fields are encrypted under
// the account key hierarchy.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmptyState } from '../components/EmptyState';
import { RelativeTime } from '../components/RelativeTime';
import { Skeleton, SkeletonRegion } from '../components/Skeleton';
import { ProxyCapabilityChips, ProxyOsChip } from '../components/ProxyCapabilities';
import { OS_FINGERPRINT_MEASURING, VPN_TUNNEL_OS_FINGERPRINT } from '../lib/os-fingerprint-verdict';
import {
  isProxyUsable,
  addProxy,
  listProxies,
  removeProxy,
  resolveEndpoint,
  testProxy,
  updateProxy,
  validateDraft,
  type DraftValidation,
  type EndpointResolveResult,
  type ProxyConfig,
  type ProxyDraft,
  type ProxyTestResult,
} from '../lib/proxies';
import { ProxyHostWarning } from '../components/ProxyHostWarning';
import {
  invalidateProbe,
  loadProbeCache,
  subscribeProbeCache,
  clearExitResult,
  saveExitResult,
  saveProbeResult,
  saveEndpointResult,
  type CachedOsFingerprint,
  type ProbeCacheMap,
} from '../lib/proxy-probe-cache';
import { probeProxyExit, type ProxyExitProbeResult } from '../lib/proxies';
import { parseProxyString } from '../lib/parse-proxy';
import { parseWireGuardConfigDetailed } from '../lib/parse-wireguard';
import { validateOpenVpnConfig } from '../lib/parse-openvpn';
import { openvpnRefusal, openvpnAutoStrip, type OpenvpnRefusal } from '../lib/openvpn-refusal';
import { wireguardRefusal, type WireguardRefusal } from '../lib/wireguard-refusal';
import {
  findUnsupportedOpenvpnLines,
  findUnresolvableOpenvpnFileReferences,
  stripUnsupportedOpenvpnLines,
} from '@driftstack/api-types';
import {
  buildWireGuardProxyInput,
  buildOpenVpnProxyInput,
  deleteProxy as deleteAccountProxy,
  updateProxy as updateAccountProxy,
  type AccountProxyScheme,
  type AccountProxyTestNotRun,
  type MeasuredQuic,
} from '../lib/account-proxies';
import { profilesUsingProxy } from '../lib/profile-bindings';
import { isSocks5Probeable, isVpnScheme } from '../lib/proxy-scheme';
import { withProxyProbe } from '../lib/proxy-probe-sweeper';
import {
  accountProxyInputFor,
  deriveProbeViewWithEndpointRows,
  ensureAccountProxyRow,
  fleetFailureReasons,
  persistHealedOpenvpn,
  persistServerProbe,
  serverProbeStamps,
  SOCKS5_TEST_NO_API_KEY_NOTICE,
  socks5FleetTestNotStoredNotice,
  syncListExitObserved,
  testProxyOnServer,
  unansweredCheckNotice,
  type ServerProbeOutcome,
} from '../lib/proxy-server-test';
import { useSettings } from '../lib/SettingsContext';
import { useConfirm } from '../components/ConfirmProvider';
import { humanizeError } from '../lib/humanize-error';
import { vantageLabel, type ServerVantage } from '../lib/proxy-vantage';
import {
  CHECK_ENDPOINT_ACTION,
  CHECK_ENDPOINT_TITLE,
  CHECK_VPN_ACTION,
  CHECK_VPN_TITLE,
  DESKTOP_CREDENTIAL_NEXT_STEP,
  EXIT_GEO_UNAVAILABLE,
  ENDPOINT_OK_PILL,
  ENDPOINT_OK_TITLE,
  EXIT_GEO_UNAVAILABLE_TITLE,
  HTTP_VERIFIED_AT_LAUNCH,
  MISSING_API_KEY_NEXT_STEP,
  RECHECK_ACTION,
  RETEST_ACTION,
  VPN_NO_API_KEY_CHECK_NOTICE,
  VPN_NO_EXIT_YET,
  VPN_NO_EXIT_YET_TITLE,
  VPN_NOT_STORED_CHECK_NOTICE,
  VPN_NOT_STORED_TALLY_REASON,
  VPN_TUNNEL_UP_NO_LATENCY_TITLE,
} from '../lib/proxy-check-copy';

interface ListState {
  proxies: ProxyConfig[];
  loading: boolean;
  error: string | null;
  /** Transient confirmation, e.g. "2 profiles were using this proxy". (P1)
   *  Nothing is "unbound": the binding is KEPT naming the deleted proxy, which
   *  is the state every resolver reads as no-proxy. */
  notice: string | null;
}

interface TestAllSummary {
  runId: number;
  text: string;
}

/** Per-scheme display label + icon for a saved-proxy card (P2 #3 — the card used to
 *  hardcode "🔒 SOCKS5" so a VPN/HTTP proxy was MISLABELED). `undefined` scheme is the
 *  legacy SOCKS5 default. */
function schemeLabel(scheme: AccountProxyScheme | undefined): { icon: string; text: string } {
  switch (scheme) {
    case 'openvpn':
      return { icon: '🛡️', text: 'OpenVPN' };
    case 'wireguard':
      return { icon: '🛡️', text: 'WireGuard' };
    case 'http':
      return { icon: '🌐', text: 'HTTP' };
    case 'socks5':
    default:
      return { icon: '🔒', text: 'SOCKS5' };
  }
}

// T-20 — `isSocks5Probeable` used to be defined here (and re-spelled in the
// sweeper and the profile hub's inline form); the pre-launch gate had no copy at
// all. One definition now, in lib/proxy-scheme.

/** VPN exit parity (b) — which proxies a sweep (Test all / Test selected) covers:
 *  a SOCKS5 row through the native probe, a VPN row through its endpoint check
 *  + the fleet test. An HTTP row has neither and is still verified at launch. */
function isSweepable(scheme: AccountProxyScheme | undefined): boolean {
  return isSocks5Probeable(scheme) || isVpnScheme(scheme);
}

/**
 * (n) N3 — whether an edit changed the material a VPN row AUTHENTICATES with.
 *
 * The edit path's `connChanged` compared scheme/host/port/username/password
 * only. For a VPN row host and port are DERIVED from the conf's endpoint line
 * and username/password are null, so a provider key rotation — a new conf, same
 * server — changed none of them: the cached probe was kept, no re-test ran, and
 * the row's "tunnel up", latency, exit IP and timezone went on describing a
 * tunnel built from the PREVIOUS keys. Compared field-wise (not by identity or
 * JSON, which would also fire on key ORDER) so the answer is about the material
 * and nothing else. A row that is not on a VPN scheme has no material here and
 * answers false — its own fields are compared above.
 */
function vpnMaterialChanged(prev: ProxyConfig, draft: ProxyDraft): boolean {
  const scheme = draft.scheme;
  if (scheme === 'wireguard') {
    const a = prev.wireguard;
    const b = draft.wireguard;
    if (a === undefined || b === undefined) return a !== b;
    return (
      a.private_key !== b.private_key ||
      a.peer_public_key !== b.peer_public_key ||
      a.preshared_key !== b.preshared_key ||
      a.endpoint !== b.endpoint ||
      a.address !== b.address ||
      a.allowed_ips !== b.allowed_ips ||
      a.dns !== b.dns
    );
  }
  if (scheme === 'openvpn') {
    const a = prev.openvpn;
    const b = draft.openvpn;
    if (a === undefined || b === undefined) return a !== b;
    return (
      a.config_blob !== b.config_blob || a.username !== b.username || a.password !== b.password
    );
  }
  return false;
}

/** The VPN half of a sweep's tally: rows whose tunnel got a verdict, how many
 *  of those the fleet brought up, (d) rows whose test was NOT RUN — refused
 *  while a live session holds the tunnel, or the measuring Mac was busy — and
 *  (h) rows whose endpoint resolved but whose tunnel was NOT TESTED: no API
 *  key, not stored on the account, no fleet Mac free, a control-plane fallback
 *  (which cannot measure a tunnel), or a fleet answer with no measurement. A
 *  skipped or untested row is neither up nor down and is never counted as
 *  either. (h) A check that could not RUN (the resolver threw) is its own
 *  bucket too: not a DNS verdict, not a tunnel verdict. */
interface VpnSweepTally {
  checked: number;
  tunnelOk: number;
  /** (i) I4 — of `tunnelOk`, the rows a fleet Mac brought up WITHOUT a timing:
   *  the tunnel is up (the exit and QUIC verdict the reply carried are the
   *  row's), and the sentence says the number is missing rather than filing
   *  the row under "not tested" while the row wears that reply's fields. */
  tunnelOkNoLatency: number;
  skipped: number;
  /** (d)/(h) — WHY each skipped row was not run, one phrase per row. */
  skippedWhy: string[];
  notTested: number;
  /** (h) — WHY each resolved row's tunnel went untested, one phrase per row. */
  notTestedWhy: string[];
  checkFailed: number;
}

function emptyVpnTally(): VpnSweepTally {
  return {
    checked: 0,
    tunnelOk: 0,
    tunnelOkNoLatency: 0,
    skipped: 0,
    skippedWhy: [],
    notTested: 0,
    notTestedWhy: [],
    checkFailed: 0,
  };
}

/** (h) — the phrase a sweep gives for a not_run reason. Names the ACTUAL
 *  reason the server sent (the discriminator, never its prose) and the next
 *  step in the same breath, so "skipped" is never read as "failed" or as
 *  "forgotten", and a busy Mac is never described as a live session. */
function notRunPhrase(why: AccountProxyTestNotRun): string {
  switch (why) {
    case 'live_session':
      return 'in use by a live session; end it to test the tunnel';
    case 'node_busy':
      return 'the test Mac was busy; try again in a minute';
    case 'node_error':
      return 'the test Mac could not complete the test; try again shortly';
    case 'no_node':
      return 'no test Mac free';
    case 'plan_excluded':
      return 'not included in your plan';
    case 'desktop_credential':
      // (j) J4 — the free-desktop route policy refused the CREDENTIAL, not the
      // plan: the row is "not tested", like a row with no API key at all.
      // (l) #9 — the same next step that row gets (Settings, never "the
      // dashboard", which the GUI names nowhere as a place to go from here).
      return DESKTOP_CREDENTIAL_NEXT_STEP;
  }
}

/** (i) I4 — the "N VPN tunnel(s) up" clause, naming the rows whose tunnel a
 *  fleet Mac brought up without reporting a latency. */
function tunnelsUpClause(vpn: VpnSweepTally, prefix: string, nounCount: number): string {
  const up = `${prefix} VPN tunnel${nounCount === 1 ? '' : 's'} up`;
  if (vpn.tunnelOkNoLatency === 0) return up;
  return vpn.tunnelOkNoLatency === vpn.tunnelOk
    ? `${up} (no latency reported)`
    : `${up} (${String(vpn.tunnelOkNoLatency)} with no latency reported)`;
}

/** Distinct reasons, in first-seen order, joined for a parenthetical. */
function reasonList(why: ReadonlyArray<string>): string {
  return [...new Set(why)].join('; ');
}

/** (d) — the clause a sweep appends for tunnels it could not test. Says WHY in
 *  the same breath, so "skipped" is never read as "failed" or as "forgotten". */
function skippedClause(skipped: number, why: ReadonlyArray<string>): string {
  return `${String(skipped)} VPN tunnel${skipped === 1 ? '' : 's'} skipped (${reasonList(why)})`;
}

/** (h) — the clause for rows whose endpoint resolved but whose tunnel nothing
 *  measured. Distinct from "skipped" (a test the server refused to run) so a
 *  customer with no API key is not told a live session is in the way. */
function notTestedClause(
  notTested: number,
  why: ReadonlyArray<string>,
  /** Bare ("1 not tested") when a "VPN tunnel" clause already precedes it. */
  bare = false,
): string {
  const noun = bare ? '' : ` VPN tunnel${notTested === 1 ? '' : 's'}`;
  return `${String(notTested)}${noun} not tested (${reasonList(why)})`;
}

function checkFailedClause(n: number): string {
  return `${String(n)} VPN check${n === 1 ? '' : 's'} could not run (the address lookup failed; try again)`;
}

function formatTestAllSummary(
  results: ProxyTestResult[],
  vpn: VpnSweepTally = emptyVpnTally(),
): string {
  const vpnSwept = vpn.checked + vpn.notTested + vpn.checkFailed;
  if (results.length === 0 && vpnSwept === 0 && vpn.skipped === 0) {
    return 'No proxy results landed — run Test all again.';
  }
  // (d)/(h) — the sentence must never begin "Tested 0 — 0 VPN tunnels up",
  // which reads as every tunnel down, when nothing was actually measured.
  const untestedParts = (bare: boolean): string[] => {
    const parts: string[] = [];
    if (vpn.skipped > 0) parts.push(skippedClause(vpn.skipped, vpn.skippedWhy));
    if (vpn.notTested > 0) parts.push(notTestedClause(vpn.notTested, vpn.notTestedWhy, bare));
    if (vpn.checkFailed > 0) parts.push(checkFailedClause(vpn.checkFailed));
    return parts;
  };
  if (results.length === 0 && vpn.checked === 0) {
    return `${untestedParts(false).join(', ')} — nothing was tested`;
  }
  // VPN rows have no SOCKS5 buckets; they get their own clause so the sentence
  // never counts a tunnel as "healthy" on a handshake it never made. (h) A
  // tunnel the fleet could not bring up is said as "down" — a count of "up"
  // alone leaves the reader to subtract.
  const tunnelDown = vpn.checked - vpn.tunnelOk;
  if (results.length === 0) {
    const parts = [tunnelsUpClause(vpn, String(vpn.tunnelOk), vpn.tunnelOk)];
    if (tunnelDown > 0) parts.push(`${String(tunnelDown)} down`);
    parts.push(...untestedParts(true));
    return `Tested ${String(vpnSwept)} — ${parts.join(', ')}`;
  }
  const healthy = results.filter((result) => isProxyUsable(result)).length;
  const unreachable = results.filter((result) => !result.reachable).length;
  const authFailed = results.filter((result) => result.reachable && !result.auth_ok).length;
  // Authenticates but will not carry traffic. Counted separately because
  // "auth failed" sends someone to re-check a password that was accepted.
  const cannotRoute = results.filter(
    (result) => result.reachable && result.auth_ok && !result.can_route,
  ).length;
  const parts = [`${String(healthy)} healthy`];
  if (unreachable > 0) parts.push(`${String(unreachable)} unreachable`);
  if (cannotRoute > 0) parts.push(`${String(cannotRoute)} can't route`);
  if (authFailed > 0) {
    parts.push(`${String(authFailed)} auth failure${authFailed === 1 ? '' : 's'}`);
  }
  if (vpn.checked > 0) {
    parts.push(tunnelsUpClause(vpn, `${String(vpn.tunnelOk)}/${String(vpn.checked)}`, vpn.checked));
  }
  parts.push(...untestedParts(false));
  return `Tested ${String(results.length + vpnSwept)} — ${parts.join(', ')}`;
}

/**
 * Hover text on every positive verdict the native probe produces here. The probe
 * runs on this Mac; the profile runs on Driftstack's servers. A proxy on the
 * customer's own network, or one that admits their IP and nobody else's, tests
 * green here and is dead there — so a verdict that does not say where it was
 * measured reads as a promise about the profile's path. Kept local rather than
 * imported from lib/proxies: that module is hand-mocked by dozens of suites.
 */
const PROBE_ORIGIN_TITLE =
  'Measured from your computer, not from the server that runs your profile.';

/**
 * Hover text on a latency that came from the control plane's own test (T-1). The
 * native probe runs on this Mac and measures the customer's own path; the server
 * value is measured closer to the fleet that will run the profile, so it is the
 * honest number to lead with — labelled, so it is never mistaken for the laptop's.
 */
const SERVER_LATENCY_TITLE = 'Measured from Driftstack, not your computer.';

/**
 * (P2, owner 2026-09-12) — "PRoxy tests from proxies tab still show 'slow from
 * this mac', but it should also test from the mac worker where it will run".
 *
 * The row already measured BOTH: the native SOCKS5 handshake from this Mac
 * (`result.latency_ms`) and the test Mac's number (`serverLatencyMs`, asked for
 * as `?vantage=fleet`). They were merged with a `??` — one number under one
 * label — so a 180ms measured on the test Mac rendered "slow from this Mac"
 * under a "measured from your computer" hover. Two different facts, and only
 * the second one predicts a session.
 *
 * So the cell shows BOTH, each labelled, and NEITHER is shown unlabelled: when
 * one side has no number the row says which side is missing rather than
 * quietly presenting the other as the whole truth. The health pill leads with
 * the number that predicts the session (the test Mac's when there is one) and
 * NAMES that machine in its own words — it is the one place a customer reads a
 * verdict without hovering anything.
 *
 * ⚠️ A missing side reads as a SHORT state word plus the machine's short name,
 * never as a sentence. Two reasons, both MEASURED against this app's real CSS
 * in the running harness (scratchpad/measure-cell-v2.mjs, content width of the
 * cell inside the table's own text-[12px]):
 *
 *   pre-P2, native only ................  66.0px x 35.5px
 *   pre-P2, server number + chip ....... 172.2px x 35.5px   <- the old column max
 *   a sentence in the 8px chip ......... 169.4px x   57px   (27 chars @ 8px)
 *   SHIPPED, missing side + number ..... 150.7px x   57px
 *   SHIPPED, both numbers .............. 172.2px x   57px   <- the new column max
 *   SHIPPED, missing side suppressed ... 150.7px x 35.5px
 *
 * So the widest state is 172.2px — EXACTLY the width a server-measured row
 * already had before P2, i.e. the column maximum does not move, and a missing
 * side (150.7px) never drives it. The state word lands in the number's slot at
 * the table's 12px, above the project's own 9px floor for measured text
 * (scripts/gui-text-quality MIN_PX); only the machine-name chip is 8px, which
 * is what that chip was before P2. A 27-character sentence at 8px was both
 * below our own readability rule and the widest thing in the cell.
 * The words also deliberately avoid the exact strings "from the test Mac" /
 * "from this Mac", which mean "a number was measured there" on this grid and on
 * the profile card, and which several suites read as that claim.
 *
 * ⛔ And a missing side says WHY, from state this row ALREADY holds. One
 * sentence for every absence was false twice over: a fleet test that RAN and
 * FAILED, and a fleet `ok` that reported no timing, have both measured this
 * proxy — "has not measured this proxy yet" was a claim about our instrument
 * that the code contradicted, printed beside a green pill. `vpnFailure`,
 * `serverVantage` and `noFleetMac` separate the four states; a row whose own
 * notice already names the absent vantage (no API key, not storable) prints no
 * label at all rather than a second copy of a sentence already on screen.
 */
/** The machine names on a MISSING side — short, and deliberately not the
 *  phrases that mean "measured there". */
const TEST_MAC_CHIP_LABEL = 'test Mac';
const NATIVE_CHIP_LABEL = 'this Mac';
/** Why there is no number from the Mac that runs the profiles. FOUR states —
 *  only the last of them is "nothing has been measured". */
const SERVER_FAILED_WORD = 'no answer';
const SERVER_FAILED_TITLE_PREFIX = 'The Mac that runs your profiles could not use this proxy:';
const SERVER_NO_TIMING_WORD = 'no number';
const SERVER_NO_TIMING_TITLE =
  'The Mac that runs your profiles reached this proxy but reported no timing.';
const NO_TEST_MAC_WORD = 'none free';
const NO_TEST_MAC_LATENCY_TITLE =
  'Not measured yet — no test Mac was free, and the number that predicts a session is measured from the Mac that runs your profiles.';
const NO_SERVER_NUMBER_WORD = 'not tested';
const NO_SERVER_NUMBER_TITLE =
  'The Mac that runs your profiles has not measured this proxy yet — only its number predicts a session.';
/** …and why there is none from this computer. An unreachable handshake did not
 *  fail to measure: it measured that it could not connect, which is a different
 *  fact and is not "has not measured this proxy yet". */
const NATIVE_NO_CONNECT_WORD = 'no connect';
const NATIVE_NO_CONNECT_TITLE = 'Your computer could not connect to this proxy.';
const NATIVE_NO_TIMING_WORD = 'no number';
const NATIVE_NO_TIMING_TITLE = 'Your computer connected to this proxy but recorded no timing.';
const NO_NATIVE_NUMBER_WORD = 'not tested';
const NO_NATIVE_NUMBER_TITLE = 'Your computer has not measured this proxy yet.';
/** The label beside the native number, and the words the health pill borrows
 *  for it. One constant so the pill and the cell cannot disagree. */
const NATIVE_VANTAGE_LABEL = 'from this Mac';
/** (P2) — the pill when the Mac that RUNS the profile could not use this proxy,
 *  whatever the local handshake said. It outranks a green local verdict: the
 *  session runs there, not here. The reason renders beside the pill. */
const FLEET_FAILED_PILL = 'fails on the test Mac';
/** At or under this many ms a latency reads "healthy"; over it, "slow". One
 *  constant for the pill and for every per-side meter, so a bar cannot be green
 *  beside a number the pill calls slow. */
const LATENCY_GOOD_MS = 100;

/**
 * (P2) — every row's FLEET-measurement stamp, SOCKS5 rows included.
 *
 * `serverProbeStamps` (lib) deliberately keys endpoint rows only, because it
 * feeds the "Tested" column and a SOCKS5 row's column dates its NATIVE verdict
 * (its own doc says so). The per-side latency lines need the other date too: a
 * fleet number outlives a native re-test (`saveServerProbeResult` keeps the
 * prior `at` and writes only `serverProbeAt`), so without this the fleet line
 * wore the native line's date in the one cell that prints two measurements.
 */
function fleetProbeStamps(cache: ProbeCacheMap): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, c] of Object.entries(cache)) {
    if (typeof c.serverProbeAt === 'number') out[id] = c.serverProbeAt;
  }
  return out;
}

const EMPTY_DRAFT: ProxyDraft = {
  label: '',
  scheme: 'socks5',
  host: '',
  port: 1080,
  username: null,
  password: null,
};

export function ProxiesView(): JSX.Element {
  const { settings } = useSettings();
  const confirm = useConfirm();
  const [state, setState] = useState<ListState>({
    proxies: [],
    loading: true,
    error: null,
    notice: null,
  });
  const [editor, setEditor] = useState<
    { kind: 'idle' } | { kind: 'add' } | { kind: 'edit'; id: string }
  >({ kind: 'idle' });
  const [busyId, setBusyId] = useState<string | null>(null);
  // Saving a proxy can write the encrypted local vault and then refresh the
  // registry. A state-only guard lands one render too late for two same-turn
  // submit events, so the ref is the authoritative single-flight latch while
  // `saving` drives the visible/accessible busy state.
  const saveInFlightRef = useRef(false);
  const [saving, setSaving] = useState(false);
  // Native SOCKS5 probe per saved proxy — reachability + UDP-associate
  // support. Keyed by proxy id so each row keeps its own last result.
  const [testingId, setTestingId] = useState<string | null>(null);
  // Epoch token for in-flight probes: bumped when a proxy is edited (endpoint
  // changed) or removed, so a slow probe that started against the OLD endpoint
  // discards its result instead of re-advertising stale reachability/geo.
  const testEpochRef = useRef(0);
  // E-2 exit-geo: per-proxy echo result. A null entry means the probe ran and
  // returned nothing. Both dependencies this note once blamed shipped on
  // 2026-06-12 (V-857), so a null now means this proxy did not complete the
  // echo round-trip — a real fault on the customer's side, not pending work.
  const [exitResults, setExitResults] = useState<Record<string, ProxyExitProbeResult | null>>({});
  const [testResults, setTestResults] = useState<Record<string, ProxyTestResult>>({});
  // N4 — per-VPN-row DNS pre-flight verdicts (endpoint_resolve), keyed by proxy id.
  const [endpointResults, setEndpointResults] = useState<Record<string, EndpointResolveResult>>({});
  // Epoch-ms timestamp of each proxy's last probe (from the cache `at` field), so
  // the card can show "tested <relative>" — a green 'healthy' pill is meaningless
  // without knowing whether the test ran 30s or 30 days ago (audit).
  const [testedAt, setTestedAt] = useState<Record<string, number>>({});
  const [osFingerprints, setOsFingerprints] = useState<Record<string, CachedOsFingerprint>>({});
  // T-1 — server-measured latency per proxy (control plane /test), preferred for
  // the grid Latency column. T-6 — the QUIC verdict measured in a live session,
  // consumed by the capability chip so a measured 'h3' can go green.
  const [serverLatency, setServerLatency] = useState<Record<string, number>>({});
  // (P2) — WHEN that server number was measured. Separate from `testedAt`,
  // which on a SOCKS5 row dates the native verdict: the cell now prints both
  // numbers, so each one carries its own date in its own hover.
  const [serverProbeAt, setServerProbeAt] = useState<Record<string, number>>({});
  const [quicMeasured, setQuicMeasured] = useState<Record<string, MeasuredQuic>>({});
  // T-1 — WHERE the server latency was measured (a fleet Mac, named, or the
  // server itself when none was free) and the fleet Mac's separate QUIC-relay
  // verdict. Both label the row; neither is ever folded into quicMeasured.
  const [serverVantage, setServerVantage] = useState<Record<string, ServerVantage>>({});
  const [quicProbe, setQuicProbe] = useState<Record<string, boolean>>({});
  // VPN exit parity (b) — the fleet's failure sentence for a VPN row whose
  // endpoint resolved but whose tunnel the fleet Mac could not bring up.
  // (h) finding 3 — hydrated from the CACHE (`fleetFailureReasons`) on load
  // and on every emit, like every other server-measured value: kept in memory
  // only, a remount forgot a verdict the cache still stamped, and the profile
  // card had no representation of a check that ran here. Set here the moment
  // the fleet answers (the write is async) and cleared by the cache writers
  // that record a later verdict or exit — never by a check that measured
  // nothing.
  const [vpnFailures, setVpnFailures] = useState<Record<string, string>>({});
  // (d) — the server's sentence when a VPN row's test was NOT RUN (a live
  // session holds the tunnel; the measuring Mac was busy). A notice, never a
  // failure: it sits beside whatever verdict the row has, in muted ink, and is
  // cleared by the next check exactly like a failure is.
  const [vpnNotices, setVpnNotices] = useState<Record<string, string>>({});
  // (o) O5 — the rows whose LAST server test could not reach a fleet Mac at all
  // (`not_run: 'no_node'`: none free, the dispatch never landed, or the deployment
  // has no fleet). ⛔ This is the only honest signal for it, and it is NOT the
  // vantage: for a VPN row the control plane NEVER measures, so it never answers
  // `ok` — it answers `ok:false` + `not_run`, which writes no `serverVantage` at
  // all (`applyServerProbeOutcome` sets it inside the `ok` arm only, and the cache
  // surfaces a `measuredFrom` only beside a usable result). Keying the chip on
  // `vantage === 'control_plane'` therefore guarded a state a VPN row cannot be in.
  // In memory only, like `vpnNotices`: a remount has not seen the reply, and the
  // chip then says "not measured yet" — which is what is true of what it knows.
  const [noFleetMac, setNoFleetMac] = useState<Record<string, true>>({});
  const [testAllSummary, setTestAllSummary] = useState<TestAllSummary | null>(null);
  // A ref closes the one-render gap before `testingAll` disables the button. It
  // also owns the eventual summary, so an abandoned/stale sweep cannot announce
  // after a newer one has taken its place.
  const activeTestAllRunRef = useRef<number | null>(null);
  const nextTestAllRunRef = useRef(1);

  useEffect(() => {
    if (testAllSummary === null) return;
    const { runId } = testAllSummary;
    const id = window.setTimeout(() => {
      setTestAllSummary((current) => (current?.runId === runId ? null : current));
    }, 5000);
    return () => window.clearTimeout(id);
  }, [testAllSummary]);

  useEffect(
    () => () => {
      activeTestAllRunRef.current = null;
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const proxies = await listProxies();
      setState((s) => ({ ...s, proxies, loading: false, error: null }));
      // D2 — a VPN row's exit is whatever the server last OBSERVED through it
      // (a live session, or a fleet probe): adopt it from the account list into
      // the same cache the hydration below reads, so the row shows an exit
      // without a Test. Fire-and-forget; the cache subscription re-derives the
      // view when it lands, and a failure changes nothing the customer sees.
      void syncListExitObserved(settings.baseUrl, settings.apiKey, proxies).catch(() => undefined);
      // Hydrate the LAST persisted probe result per proxy so a tested proxy
      // keeps showing its reachability / UDP / exit-geo across visits instead
      // of reverting to "untested" + needing a re-test every time (the cache
      // was written by saveProbeResult/saveExitResult but never read back here).
      // P-8 — one shared derivation with the subscription path below, so the
      // two cannot drift. The exit-geo rule that used to live inline here is
      // documented on deriveProbeViewState.
      // VPN exit parity (b) — the endpoint-row overlay lives in the same shared
      // step as the fleet test, so a VPN row's fleet-measured latency and exit
      // hydrate here exactly as a SOCKS5 row's do.
      const cache = await loadProbeCache();
      const view = deriveProbeViewWithEndpointRows(cache);
      setTestResults(view.testResults);
      setEndpointResults(view.endpointResults);
      setExitResults(view.exitResults);
      // (h) — a VPN row's "Tested" dates the fleet number it shows, not the
      // DNS pre-flight that ran before a refused test.
      setTestedAt({ ...view.testedAt, ...serverProbeStamps(cache) });
      setServerProbeAt(fleetProbeStamps(cache));
      setVpnFailures(fleetFailureReasons(cache));
      setOsFingerprints(view.osFingerprints);
      setServerLatency(view.serverLatency);
      setQuicMeasured(view.quicMeasured);
      setServerVantage(view.serverVantage);
      setQuicProbe(view.quicProbe);
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: friendlyError(err, "Couldn't load proxies. Try again."),
      }));
    }
  }, [settings.apiKey, settings.baseUrl]);

  // P-8 — the background sweep rewrites verdicts while this grid is open. Without
  // this, a proxy re-tested and found DOWN would keep showing the healthy pill it
  // was rendered with, which is worse than not sweeping: the customer would be
  // reading a verdict we already know is superseded.
  useEffect(
    () =>
      subscribeProbeCache((cache) => {
        const view = deriveProbeViewWithEndpointRows(cache);
        setTestResults(view.testResults);
        setEndpointResults(view.endpointResults);
        setExitResults(view.exitResults);
        setTestedAt({ ...view.testedAt, ...serverProbeStamps(cache) });
        setServerProbeAt(fleetProbeStamps(cache));
        setVpnFailures(fleetFailureReasons(cache));
        setOsFingerprints(view.osFingerprints);
        setServerLatency(view.serverLatency);
        setQuicMeasured(view.quicMeasured);
        setServerVantage(view.serverVantage);
        setQuicProbe(view.quicProbe);
      }),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSave(draft: ProxyDraft): Promise<void> {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      // Which proxy, if any, to test once this save lands. The moment a customer
      // enters a proxy is the moment to find out it cannot route — not the moment
      // they launch a profile through it and watch the session fail.
      let testAfterSave: 'added' | 'edited' | null = null;
      if (editor.kind === 'add') {
        await addProxy(draft);
        testAfterSave = 'added';
      } else if (editor.kind === 'edit') {
        const editId = editor.id;
        const prev = state.proxies.find((p) => p.id === editId);
        await updateProxy(editId, draft);
        // If the connection target changed, the cached probe (capability +
        // exit-geo) no longer describes this proxy — drop it so cards fall
        // back to the honest "untested" state until the next Test, rather
        // than advertising the OLD endpoint's reachability/UDP/exit-geo.
        // A label-only rename keeps the probe (same endpoint).
        // (l) #16 — the SCHEME too: a vpn→socks5 edit with the same host/port
        // is a different KIND of check (the endpoint verdict, the fleet
        // failure sentence and its notice describe a tunnel the row no longer
        // is), so it invalidates and re-tests like a moved endpoint.
        // (n) N3 — and the VPN BLOCK. Host/port are derived from the conf's
        // Endpoint line and username/password are null on a VPN row, so a
        // re-pasted conf whose only change is the key material (a provider key
        // rotation on the same server) left every field above equal: no
        // invalidation, no re-test, and yesterday's "tunnel up" + latency + exit
        // + timezone stood as the verdict for keys the fleet had never used.
        // Changing a SOCKS5 password re-tests immediately — this is that rule
        // for the material a VPN row actually authenticates with.
        const connChanged =
          prev === undefined ||
          prev.scheme !== draft.scheme ||
          prev.host !== draft.host ||
          prev.port !== draft.port ||
          prev.username !== draft.username ||
          prev.password !== draft.password ||
          vpnMaterialChanged(prev, draft);
        if (connChanged) {
          testEpochRef.current++; // discard any in-flight probe against the old endpoint
          void invalidateProbe(editId).catch(() => undefined);
          setTestResults((r) => dropKey(r, editId));
          setExitResults((r) => dropKey(r, editId));
          setOsFingerprints((m) => dropKey(m, editId));
          setServerLatency((m) => dropKey(m, editId));
          setQuicMeasured((m) => dropKey(m, editId));
          setServerVantage((m) => dropKey(m, editId));
          setQuicProbe((m) => dropKey(m, editId));
          // Invalidating alone leaves the row with NO verdict, which reads as
          // "untested" rather than "the endpoint changed" — and the next launch
          // is where that gets discovered. Re-test instead.
          testAfterSave = 'edited';
        }
      }
      await refresh();
      // Keep the form mounted and locked through refresh so the customer never
      // sees an editable draft while the just-saved registry is still settling.
      const editedId = editor.kind === 'edit' ? editor.id : null;
      setEditor({ kind: 'idle' });
      if (testAfterSave !== null) {
        // Re-list rather than reading component state: setState from refresh has
        // not committed yet, so state.proxies here is still the PREVIOUS registry
        // and would not contain a row that was just added.
        const fresh = await listProxies().catch(() => null);
        const target =
          fresh === null
            ? undefined
            : testAfterSave === 'added'
              ? // addProxy does not return the created row, so match on the tuple
                // the customer just entered. Host+port+username is what identifies
                // an endpoint here; two rows differing only by password would be
                // the same endpoint anyway.
                fresh.find(
                  (p) =>
                    p.host === draft.host && p.port === draft.port && p.username === draft.username,
                )
              : fresh.find((p) => p.id === editedId);
        // Best-effort: a probe that cannot run must never make a successful save
        // look failed. This block IS inside the save's try — it has to be, so it
        // runs only on a save that actually landed — so the isolation comes from
        // the two catches above and below, not from the structure: `listProxies`
        // degrades to null and the probe is fire-and-forget. Drop either catch
        // and a proxy that saved fine reports "Couldn't save this proxy", which
        // is the one outcome this whole path exists to avoid.
        // handleTest owns its own epoch guard, so an edit or removal landing
        // mid-probe discards the result rather than writing it to the wrong row.
        // (l) #16 — by SCHEME: a row that ends on an OpenVPN/WireGuard/HTTP
        // scheme gets ITS check (the endpoint pre-flight, then the fleet for a
        // VPN row), never the native SOCKS5 handshake, which can only answer
        // "unreachable" to a UDP endpoint — the T-20 false negative this path
        // wrote into the cache for a moved or re-schemed VPN row (a red failed
        // row beside an "untested" endpoint pill, and a card that disagreed).
        if (target !== undefined) {
          void (
            isSocks5Probeable(target.scheme) ? handleTest(target) : handleCheckEndpoint(target)
          ).catch(() => undefined);
        }
      }
    } catch (err) {
      setState((s) => ({
        ...s,
        error: friendlyError(err, "Couldn't save this proxy. Check the details and try again."),
      }));
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  /**
   * Everything removing a proxy entails, WITHOUT the confirmation.
   *
   * Split out so a bulk remove can ask once for the whole selection instead of
   * once per proxy — N modals for one intent is not a confirmation, it is an
   * obstacle course, and the reflex it trains (click through the dialog) is
   * exactly the reflex a destructive action needs intact.
   *
   * ⛔ It does NOT touch the profile→proxy bindings. See `profilesUsingProxy`:
   * a profile bound to this proxy must be left with NO proxy, and the way to
   * leave it that way is to leave its binding naming the deleted id — nulling
   * it hands the profile to `proxies[0]` instead. The caller reads the affected
   * profiles BEFORE calling this (the confirm has to count them), which is also
   * why nothing is returned from here.
   */
  async function removeOne(id: string): Promise<void> {
    // Capture the server-side account_proxies id (set on first launch-sync)
    // BEFORE the local entry is wiped, so we can also delete the encrypted
    // server row. Without this the wrapped password / VPN secret orphans on
    // the server forever after a local delete — a credential-hygiene leak for
    // an anti-detect tool, and a CRUD desync (the proxy is "gone" locally but
    // still resolvable server-side by its id).
    const removed = state.proxies.find((p) => p.id === id);
    await removeProxy(id);
    // Best-effort server delete: the account row deletion must not block the
    // local remove (offline / unauth still leaves the operator with the proxy
    // gone locally). deleteAccountProxy treats a 404 as already-gone.
    if (removed?.serverId !== undefined && settings.apiKey !== null && settings.apiKey.length > 0) {
      void deleteAccountProxy(settings.baseUrl, settings.apiKey, removed.serverId).catch(
        (err: unknown) => {
          console.warn('[proxies] failed to delete server-side proxy row', err);
        },
      );
    }
    testEpochRef.current++; // discard any in-flight probe for the removed proxy
    // Drop the cached probe too, else its exit-IP/geo orphans in the
    // cache (and a future re-minted id could inherit stale geo).
    void invalidateProbe(id).catch(() => undefined);
    setTestResults((r) => dropKey(r, id));
    setExitResults((r) => dropKey(r, id));
    setOsFingerprints((m) => dropKey(m, id));
    setServerLatency((m) => dropKey(m, id));
    setServerProbeAt((m) => dropKey(m, id));
    setQuicMeasured((m) => dropKey(m, id));
    setServerVantage((m) => dropKey(m, id));
    setQuicProbe((m) => dropKey(m, id));
  }

  /**
   * The profiles a removal of these proxies leaves with no proxy, PER proxy id.
   *
   * `null` = the binding store could not be read. The confirm then HEDGES
   * instead of claiming a count it does not have: a failed read that degrades
   * to 0 would print "No profile is using it" over a destructive action, which
   * is the one sentence here that must never be a guess.
   *
   * ⛔ Per id, NOT one pre-unioned count, because a bulk remove can PARTIALLY
   * fail. The confirm speaks for everything the operator asked for; the notice
   * afterwards may only speak for the ids that actually went. Unioning at the
   * read is how the notice claimed the profiles of a proxy that is still there
   * and still bound to them.
   */
  async function profilesLeftWithoutProxy(ids: string[]): Promise<Record<string, string[]> | null> {
    const perId: Record<string, string[]> = {};
    for (const id of ids) {
      try {
        perId[id] = await profilesUsingProxy(id);
      } catch (err) {
        console.warn('[proxies] could not read profile bindings before a remove', err);
        return null;
      }
    }
    return perId;
  }

  /** How many DISTINCT profiles these ids leave without a proxy. A profile
   *  bound to two of the removed proxies is ONE profile left without one. */
  function affectedCount(perId: Record<string, string[]> | null, ids: string[]): number | null {
    if (perId === null) return null;
    const found = new Set<string>();
    for (const id of ids) for (const profileId of perId[id] ?? []) found.add(profileId);
    return found.size;
  }

  /**
   * The proxy an INHERITING profile would fall to once these ids are gone, or
   * null when this removal changes nothing for such a profile.
   *
   * ⛔ P1 detaches the profiles a binding NAMES. A profile that never chose one
   * inherits the first saved proxy (`ProfilesView.pickProxy` → `proxies[0]`,
   * and the same in `AgentChatView` and the H3 attribution), so removing the
   * current HEAD promotes the next survivor and silently changes the exit of
   * every such profile — the owner's hazard exactly, for profiles no binding
   * names. The dialog must therefore not print "Nothing is moved to a different
   * proxy" in this case: `removeProxy` filters the list and preserves its
   * order, so the next survivor here IS the proxy they will inherit.
   */
  function inheritedNextLabel(ids: string[]): string | null {
    const head = state.proxies[0];
    if (head === undefined || !ids.includes(head.id)) return null;
    return state.proxies.find((p) => !ids.includes(p.id))?.label ?? null;
  }

  /**
   * The sentence after "Remove …?": what happens to the profiles that used it.
   *
   * (P1) It states the count, and it states what does NOT happen — none of them
   * is moved to another proxy — because that is precisely what the app used to
   * do silently, and a customer who remembers the old behaviour needs to be
   * told the profile is being left empty on purpose.
   *
   * ⛔ That "nothing is moved" half is CONDITIONAL, and its condition is not
   * about the bound profiles at all: see `inheritedNextLabel`. Removing the
   * FIRST saved proxy re-points every profile that never chose one, so when
   * that is about to happen the sentence names the proxy they will inherit
   * instead of printing a promise that is false in exactly the case that
   * matters. `theirs`, not a fixed "its": the bulk dialog says "them".
   */
  function detachWarning(
    affected: number | null,
    many: boolean,
    inheritedNext: string | null,
  ): string {
    const them = many ? 'them' : 'it';
    const theirs = many ? 'their' : 'its';
    const moved =
      inheritedNext === null
        ? 'Nothing is moved to a different proxy.'
        : `Profiles that never chose a proxy will use "${inheritedNext}" instead.`;
    if (affected === null)
      return `Any profile using ${them} as ${theirs} default will be left with no proxy and must be given one before it launches. ${moved}`;
    if (affected === 0)
      return inheritedNext === null
        ? `No profile is using ${them} as ${theirs} default.`
        : `No profile is using ${them} as ${theirs} default, but profiles that never chose one will use "${inheritedNext}" instead.`;
    return `${String(affected)} profile${affected === 1 ? '' : 's'} using ${them} will be left with no proxy — ${
      affected === 1 ? 'it' : 'they'
    } will not launch until you choose one. ${moved}`;
  }

  /** Notice text for N profiles left with no proxy by a removal. The "was
   *  moved" clause is scoped to THOSE profiles ("none of them"), so it cannot
   *  be read as a promise about the profiles that merely inherited this one. */
  function detachedNotice(n: number, many: boolean): string {
    return `${String(n)} profile${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} using ${
      many ? 'one of these proxies' : 'this proxy'
    } — ${n === 1 ? 'it' : 'they'} now ${
      n === 1 ? 'has' : 'have'
    } no proxy. Choose one before launching; none of them was moved to a different proxy.`;
  }

  async function handleRemove(id: string): Promise<void> {
    // Read the bindings BEFORE the dialog, because the confirm has to state the
    // count in the question it asks — not because the count expires: P1 KEEPS
    // the bindings, so `profilesUsingProxy(id)` answers the same afterwards.
    // (That earlier comment claimed the opposite and was what hid the bulk
    // notice's over-claim below.)
    const perId = await profilesLeftWithoutProxy([id]);
    const affected = affectedCount(perId, [id]);
    if (
      !(await confirm(
        `Remove this proxy? ${detachWarning(affected, false, inheritedNextLabel([id]))}`,
        {
          confirmLabel: 'Remove',
          tone: 'danger',
        },
      ))
    )
      return;
    setBusyId(id);
    try {
      await removeOne(id);
      await refresh();
      if (affected !== null && affected > 0) {
        setState((s) => ({ ...s, notice: detachedNotice(affected, false) }));
      }
    } catch (err) {
      setState((s) => ({
        ...s,
        error: friendlyError(err, "Couldn't remove this proxy. Try again."),
      }));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Remove a whole selection behind ONE confirmation that names the count.
   *
   * Removals run in sequence rather than in parallel: each one bumps
   * testEpochRef and rewrites several pieces of local state, and overlapping
   * those is how a half-applied delete leaves one row's cached probe on
   * another row.
   */
  async function handleRemoveMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const n = ids.length;
    // Same read-before-the-dialog rule as handleRemove, unioned over the
    // selection: one profile bound to two of the removed proxies is one
    // profile left without a proxy, not two.
    const perId = await profilesLeftWithoutProxy(ids);
    const affected = affectedCount(perId, ids);
    if (
      !(await confirm(
        `Remove ${String(n)} ${n === 1 ? 'proxy' : 'proxies'}? ${detachWarning(
          affected,
          n !== 1,
          inheritedNextLabel(ids),
        )}`,
        { confirmLabel: `Remove ${String(n)}`, tone: 'danger' },
      ))
    )
      return;
    setBusyId(ids[0] ?? null);
    const failed: string[] = [];
    try {
      for (const id of ids) {
        try {
          await removeOne(id);
        } catch (err) {
          // One failure must not abandon the rest of the selection — the
          // operator asked for all of them, and a silent partial leaves them
          // guessing which survived.
          console.warn('[proxies] bulk remove failed for one proxy', err);
          failed.push(id);
        }
      }
      await refresh();
      if (failed.length > 0) {
        setState((s) => ({
          ...s,
          error:
            failed.length < n
              ? `${String(failed.length)} of ${String(n)} could not be removed. The rest were removed.`
              : 'None could be removed.',
        }));
      }
      // ⛔ Count ONLY the proxies that actually went. `affected` above is the
      // union over everything the operator ASKED for — the right number for the
      // question, the wrong one for the outcome: remove 3, one fails, and the
      // old `failed.length < n` gate printed that union, claiming the profiles
      // of the proxy that is still there and still bound to it.
      const removedIds = ids.filter((id) => !failed.includes(id));
      const detached = affectedCount(perId, removedIds);
      if (detached !== null && detached > 0) {
        setState((s) => ({ ...s, notice: detachedNotice(detached, removedIds.length !== 1) }));
      }
    } finally {
      setBusyId(null);
    }
  }

  /** What one VPN row's check contributed to a sweep's tally (h). `resolved`
   *  null = the resolver did not run (not a DNS verdict); `tunnelOk` null = no
   *  tunnel verdict, with `skipped` (the server refused to run it: why) or
   *  `notTested` (nothing could measure it: why) naming the reason. */
  type VpnCheckOutcome = {
    resolved: boolean | null;
    tunnelOk: boolean | null;
    skipped?: string;
    notTested?: string;
    checkFailed?: true;
    /** (i) I4 — beside `tunnelOk: true`: the fleet Mac brought the tunnel up
     *  but reported no latency. */
    noLatency?: true;
  };

  /**
   * (n) N2 — push THIS Mac's material onto the account row before the fleet
   * tests it.
   *
   * ⛔ MEASURED: nothing in this view ever called `updateAccountProxy`. The only
   * writers were the two launch paths (ProfilesView.ensureServerProxy,
   * AgentChatView), so between a Save and the next LAUNCH the account row still
   * held the previous private key / endpoint / blob — and the fleet leg below
   * brought THAT tunnel up. The row then showed the old tunnel's latency, exit
   * IP, country and timezone as the verdict for the config just pasted, and a
   * manual Check repeated it. A SOCKS5 row is unaffected: its Test is native and
   * reads the local credentials directly.
   *
   * Best-effort by design. The PUT is a REFRESH, not a precondition: the common
   * check is an unedited row where the account already holds this exact material,
   * and blocking those on a transient failure would trade a rare stale verdict for
   * a check that cannot run at all. A failure therefore falls through to the fleet
   * leg, which answers about whatever the account row holds — the status quo
   * before this existed. The same 404 a stale `serverId` produces is not
   * self-healed here (that needs a create + `setProxyServerId`, which the launch
   * path owns); the fleet test then reports its own `unavailable`.
   */
  async function pushLocalMaterialToAccount(p: ProxyConfig): Promise<void> {
    const apiKey = settings.apiKey;
    if (apiKey === null || apiKey.length === 0) return;
    if (p.serverId === undefined) return;
    // The SAME body ensureServerProxy builds at launch, so the account row after a
    // Check is byte-identical to the one a launch would have written.
    // (q) Items 2 / 13(a) — built by the shared step, so a STORED refusable
    // OpenVPN blob (`script-security 2` from a pre-strip build) is normalised
    // here exactly as at launch: this PUT used to carry the raw blob, 400, and
    // — being best-effort — swallow it, so Check never said why the row kept
    // failing. The healed blob is persisted to the local row once (and mirrored
    // into this grid's list), so the next Check or launch sends the same bytes.
    const { input, healedOpenvpn } = accountProxyInputFor(p);
    if (healedOpenvpn !== null) {
      await persistHealedOpenvpn(p, healedOpenvpn).catch(() => null);
      setState((s) => ({
        ...s,
        proxies: s.proxies.map((x) =>
          x.id === p.id && x.openvpn !== undefined
            ? { ...x, openvpn: { ...x.openvpn, config_blob: healedOpenvpn } }
            : x,
        ),
      }));
    }
    await updateAccountProxy(settings.baseUrl, apiKey, p.serverId, input);
  }

  // N4 (owner: "Proxy check OVPN also not working") — a saved VPN row's on-demand
  // check is a DNS pre-flight of its endpoint (endpoint_resolve), NOT a SOCKS5
  // handshake (which a VPN endpoint never speaks — it always read "unreachable").
  // Confirms the host resolves without claiming the tunnel works; the full tunnel
  // still verifies at launch. Persisted so the profile cards + a reload show it.
  //
  // VPN exit parity (b) — the DNS pre-flight stays the first leg. When it
  // resolves and the row is stored on the account, the SAME fleet test a SOCKS5
  // row gets runs next (lib/proxy-server-test): a fleet Mac brings the tunnel
  // up, measures latency and observes the exit, so a VPN row gets latency +
  // exit/geo like a SOCKS5 row instead of a bare "endpoint ✓". Returns the
  // pre-flight verdict and whether the tunnel came up, for the sweep's tally;
  // null when an edit/remove made the check stale.
  async function handleCheckEndpoint(p: ProxyConfig): Promise<VpnCheckOutcome | null> {
    const epoch = ++testEpochRef.current;
    const stale = (): boolean => testEpochRef.current !== epoch;
    setTestingId(p.id);
    // (h) — the previous failure/notice stays beside the row until THIS check
    // lands its own answer: clearing it at the start left a "tunnel down" row
    // reading "endpoint ok" for the whole 30-45 s fleet wait. Finding 3 — the
    // FAILURE is the cache's (`fleetFailureReasons`): a check that measured
    // nothing (not stored, no key, a refusal, no answer) leaves the last
    // fleet verdict standing, on this grid and on the profile card alike; only
    // a check that answers — a verdict, or an unresolved endpoint — moves it,
    // and it does so through the cache write, mirrored here so the row does
    // not wait for the emit.
    const settle = (): void => {
      setVpnNotices((m) => dropKey(m, p.id));
    };
    try {
      const r = await resolveEndpoint(p.host, p.port);
      if (stale()) return null;
      setEndpointResults((m) => ({ ...m, [p.id]: r }));
      // Awaited (best-effort) so the pre-flight's cache write — which drops every
      // server field from the previous check — lands BEFORE the fleet result is
      // persisted on top of it; the two writes are serialised by the cache's
      // write lock, but the order is what makes the second one survive.
      //
      // (j) J3 — that write carries the previous fleet verdict over ONLY when
      // the endpoint still resolves to the SAME address (`saveEndpointResult`);
      // a different address drops it. Read the prior from the cache the write
      // reads, so the `unavailable` notice below says what is true AFTER it.
      // (k) K2 — and read the whole prior entry, not just its address: the
      // `unavailable` notice must also know whether the row held a fleet
      // verdict at all (no entry, an unresolved pre-flight, a fleet that never
      // answered with one) — "the last verdict stands" is false when there is
      // none. One pick (`unansweredCheckNotice`) for the grid and the card.
      const prior = await loadProbeCache()
        .then((cache) => cache[p.id])
        .catch(() => undefined);
      const priorEndpoint = prior?.endpoint;
      const endpointMoved =
        r.resolved && priorEndpoint?.resolved === true && priorEndpoint.ip !== r.ip;
      await saveEndpointResult(
        p.id,
        { resolved: r.resolved, ip: r.ip, message: r.message },
        Date.now(),
      ).catch(() => undefined);
      if (!r.resolved) {
        settle();
        // An unresolved endpoint is this check's answer: the pre-flight write
        // above carried nothing over (the failure sentence included).
        setVpnFailures((m) => dropKey(m, p.id));
        dropServerState(p.id);
        return { resolved: false, tunnelOk: false };
      }
      // Only a VPN row has a tunnel to test; an HTTP row's check is the endpoint
      // pre-flight alone (the server's fallback for it is a bare TCP connect,
      // which must never read as "tunnel up"). A row the fleet cannot test — not
      // stored on the account, or no API key — is "not tested", not "down".
      if (!isVpnScheme(p.scheme)) {
        settle();
        return { resolved: true, tunnelOk: null };
      }
      // (l) #1 — a single-row Check on either row used to `settle()` and
      // return with the reason reaching ONLY the Test-all tally: the row went
      // back to "endpoint ok" + "run Check for the exit" + "QUIC untested — run
      // Check…", nothing saying why the tunnel was not tested, and the customer
      // was sent round the same loop. The reason is the row's own notice now,
      // in the slot a `not_run` uses, with the next step in the same sentence.
      // The KEY first: a proxy is stored on the account only by a launch
      // through it, and a launch stores nothing without a key — so with
      // neither, the key is the blocker, and "store it" would name a step the
      // customer cannot take. The card's runFleetTestForRow orders them the same.
      if (settings.apiKey === null || settings.apiKey.length === 0) {
        settle();
        setVpnNotices((m) => ({ ...m, [p.id]: VPN_NO_API_KEY_CHECK_NOTICE }));
        return { resolved: true, tunnelOk: null, notTested: MISSING_API_KEY_NEXT_STEP };
      }
      if (p.serverId === undefined) {
        settle();
        setVpnNotices((m) => ({ ...m, [p.id]: VPN_NOT_STORED_CHECK_NOTICE }));
        return { resolved: true, tunnelOk: null, notTested: VPN_NOT_STORED_TALLY_REASON };
      }
      // (n) N2 — the account row is refreshed FIRST, so the tunnel the fleet brings
      // up is the one this Mac holds and not the one the last launch stored.
      await pushLocalMaterialToAccount(p).catch(() => undefined);
      if (stale()) return null;
      const outcome = await testProxyOnServer(settings.baseUrl, settings.apiKey, p.serverId);
      if (stale()) return null;
      settle();
      applyServerProbeOutcome(p.id, outcome);
      if (outcome.kind === 'ok') {
        // A verdict replaces the last failure (the cache write below drops
        // its sentence; this is the same change without waiting for the emit).
        setVpnFailures((m) => dropKey(m, p.id));
      } else if (outcome.kind === 'failed') {
        setVpnFailures((m) => ({ ...m, [p.id]: outcome.reason }));
        // (h) — the fleet could not bring the tunnel up, so the exit it observed
        // LAST time is not this row's exit now, and neither is a QUIC verdict a
        // session measured through it. The shared drop keeps a SOCKS5 row's
        // natively-measured exit; a tunnel has no other exit to keep.
        setExitResults((m) => dropKey(m, p.id));
        setQuicMeasured((m) => dropKey(m, p.id));
      } else if (outcome.kind === 'not_run') {
        // (d) — NOTHING RAN. The sentence is a notice beside the row, never the
        // red "tunnel down": a live session holding the tunnel is the opposite
        // of a tunnel that is down, and a busy Mac says nothing about it.
        setVpnNotices((m) => ({ ...m, [p.id]: outcome.reason }));
      } else {
        // (i) I5 — `unavailable`: the server did not answer, so nothing was
        // learned. The standing verdict (a failure sentence, the measured
        // fields) is untouched — `settle()` above cleared only the previous
        // check's NOTICE — and this check leaves its own notice in its place,
        // transient like every other: the next check clears it.
        // (j) J3 — unless the pre-flight above moved the endpoint: then the
        // verdict is already gone and the notice must not claim it stands.
        // (k) K2 — nor when the row never held one (`unansweredCheckNotice`).
        setVpnNotices((m) => ({
          ...m,
          [p.id]: unansweredCheckNotice(prior, endpointMoved),
        }));
      }
      void persistServerProbe(p.id, outcome, { adoptExit: true });
      if (outcome.kind === 'not_run') {
        // (h) — `no_node` is "not tested" (no fleet Mac was free to bring the
        // tunnel up), not a refusal: the row was never in anyone's hands.
        // (j) J4 — `desktop_credential` too: the credential cannot reach the
        // route, the same "not tested" a row with no API key gets above.
        return outcome.why === 'no_node' || outcome.why === 'desktop_credential'
          ? { resolved: true, tunnelOk: null, notTested: notRunPhrase(outcome.why) }
          : { resolved: true, tunnelOk: null, skipped: notRunPhrase(outcome.why) };
      }
      if (outcome.kind === 'failed') return { resolved: true, tunnelOk: false };
      if (outcome.kind === 'unavailable') {
        return { resolved: true, tunnelOk: null, notTested: 'the server did not answer' };
      }
      // A verdict about the TUNNEL comes only from a fleet Mac that brought it
      // up AND measured it; a control-plane fallback measured the endpoint,
      // not the tunnel, and (h) a fleet `ok` with no timing measured nothing
      // the row can show — the pill reads "endpoint ok", and so must the tally.
      if (outcome.vantage?.measuredFrom !== 'fleet') {
        return {
          resolved: true,
          tunnelOk: null,
          notTested: 'measured from the server, not the test Mac',
        };
      }
      // (i) I4 — a fleet `ok` with no timing still brought the tunnel UP (the
      // row adopts the exit and QUIC verdict the reply carried), so it is
      // counted up, and the sentence says the number is missing. Filing it
      // under "not tested" contradicted the row wearing that reply's fields.
      if (outcome.latencyMs === null) return { resolved: true, tunnelOk: true, noLatency: true };
      return { resolved: true, tunnelOk: true };
    } catch {
      if (stale()) return null;
      // (h) — the resolver itself failed to RUN (the native command threw).
      // Not a DNS verdict: the name was never looked up, so no "unresolved"
      // pill; the row keeps what it holds and says the check did not run.
      settle();
      setVpnNotices((m) => ({
        ...m,
        [p.id]: 'The endpoint check could not run on this Mac. Try again.',
      }));
      return { resolved: null, tunnelOk: null, checkFailed: true };
    } finally {
      setTestingId((cur) => (cur === p.id ? null : cur));
    }
  }

  /** Drop every server-measured value held for a row (a failed or absent
   *  verdict must not leave a latency, a vantage, an exit or a fingerprint
   *  beside it, where they read as current). */
  function dropServerState(id: string): void {
    setExitResults((r) => dropKey(r, id));
    setOsFingerprints((m) => dropKey(m, id));
    setServerLatency((m) => dropKey(m, id));
    setServerProbeAt((m) => dropKey(m, id));
    setQuicMeasured((m) => dropKey(m, id));
    setServerVantage((m) => dropKey(m, id));
    setQuicProbe((m) => dropKey(m, id));
    // (o) O5 — and the "no Mac was free" state with them: it describes the last
    // server test, and this drop is taken where that test's answer no longer
    // stands (an endpoint that stopped resolving, an edit).
    setNoFleetMac((m) => dropKey(m, id));
  }

  /**
   * Apply the control plane's fleet-test outcome to the grid's own state. ONE
   * application for the SOCKS5 row's Test and the VPN row's Check endpoint
   * (b) — the two used to be one inline block and one nothing, which is how a
   * VPN row never showed a fleet number.
   */
  function applyServerProbeOutcome(id: string, outcome: ServerProbeOutcome): void {
    // (o) O5 — a test that DID reach a Mac (ok or a failed verdict) clears the
    // "no Mac was free" state; a `no_node` sets it. Written here rather than at
    // the call sites so the grid's Check and the sweep cannot drift.
    setNoFleetMac((m) =>
      outcome.kind === 'not_run'
        ? outcome.why === 'no_node'
          ? { ...m, [id]: true }
          : // A refusal the customer can act on (a live session, a busy node) is a
            // DIFFERENT cause, and the row's notice states it.
            dropKey(m, id)
        : outcome.kind === 'unavailable'
          ? // (i) I5 — the server did not answer, so nothing was learned and nothing
            // here moves: the standing state is still the last thing measured.
            m
          : dropKey(m, id),
    );
    if (outcome.kind === 'ok') {
      const fp = outcome.osFingerprint;
      if (fp !== undefined) {
        const rec: CachedOsFingerprint = { ...fp, at: outcome.at };
        setOsFingerprints((m) => ({ ...m, [id]: rec }));
      }
      // T-1 — a fleet result can be ok with NO timing. The old number must
      // then GO: left in place beside a fresh vantage label it reads as "the
      // Mac just measured this", which is the opposite of what happened.
      const measured = outcome.latencyMs;
      setServerLatency((m) => (measured !== null ? { ...m, [id]: measured } : dropKey(m, id)));
      // (P2) — the number's OWN date travels with it: `testedAt` dates the
      // native verdict on a SOCKS5 row, and the cell prints both numbers.
      setServerProbeAt((m) => (measured !== null ? { ...m, [id]: outcome.at } : dropKey(m, id)));
      // (P2) — an `ok` verdict retires the last fleet failure on ANY row, not
      // only a VPN one: the SOCKS5 pill, the sort and the hero read it now.
      setVpnFailures((m) => dropKey(m, id));
      const quic = outcome.quicMeasured;
      if (quic !== undefined) setQuicMeasured((m) => ({ ...m, [id]: quic }));
      // T-1 — where that number was measured travels WITH it: a fleet Mac
      // (named) or, when none was free, the server — replaced on every
      // result, so a fleet label never outlives its measurement and the
      // fallback is visible. The latency LABEL renders only beside a number
      // (the row gates it on `lat`), while (i) I4 the vantage itself is also
      // the VPN row's tunnel verdict — a fleet `ok` with no timing still
      // brought the tunnel up — so it is kept on every `ok`, exactly as the
      // cache derivation keeps `measuredFrom` beside a cleared number.
      const vantage = outcome.vantage;
      setServerVantage((m) => (vantage !== undefined ? { ...m, [id]: vantage } : dropKey(m, id)));
      // The fleet QUIC-relay verdict is its own chip; it never becomes a
      // quicMeasured value.
      // (q) Item 3 residual — a CONTROL-PLANE fallback measured nothing about
      // QUIC (only a fleet Mac runs the relay leg), so it keeps the relay
      // verdict the last fleet run left, exactly as the cache write does
      // (`saveServerProbeResult`); the vantage above still flips to "server",
      // so the fallback is visible. A FLEET answer without a relay verdict
      // still drops it — that Mac ran and produced none.
      const relay = outcome.quicProbe;
      const cpFallback = vantage?.measuredFrom === 'control_plane';
      setQuicProbe((m) =>
        relay !== undefined ? { ...m, [id]: relay } : cpFallback ? m : dropKey(m, id),
      );
      // VPN exit parity (b) — the exit the fleet Mac observed is the exit the
      // profile will have; it lands in the same row cell as the native probe's
      // exit, and for a VPN row it is the only exit there can be.
      const exit = outcome.exitObserved;
      if (exit !== undefined) {
        setExitResults((r) => ({
          ...r,
          [id]: {
            ip: exit.ip,
            country: exit.country,
            city: exit.city,
            region: exit.region,
            timezone: exit.timezone,
          },
        }));
      }
    } else if (outcome.kind === 'not_run') {
      // (d) — nothing was measured, so nothing here changes: the row keeps
      // whatever it holds. The one thing the reply CAN carry is the server's
      // STORED exit (what a session saw through the tunnel at `observed_at`).
      // ⛔ (h) finding 1 — it is NOT adopted here. It reaches the exit cell
      // through the cache write (`persistServerProbe` → the emit above), which
      // dates it by the observation and refuses one the fleet has since
      // contradicted; adopting it here at reply time put "tunnel down"'s
      // dropped exit straight back on the grid beside "No fleet Mac was free".
    } else if (outcome.kind === 'failed') {
      // ⛔ The server says this proxy is NOT usable, while the native probe
      // from this Mac said it was. That disagreement is real information —
      // the servers are what run the profile — so the server-measured values
      // must GO. Leaving them shows a latency, a vantage, a QUIC verdict and
      // a fingerprint from a test that has since failed, beside a card that
      // was just re-tested, which reads as "all of this is current".
      //
      // This path was unreachable while a fleet result could never be
      // `ok:false`. It cannot stay unhandled now that a proxy answering
      // nothing correctly reports one.
      setServerLatency((m) => dropKey(m, id));
      setServerProbeAt((m) => dropKey(m, id));
      setServerVantage((m) => dropKey(m, id));
      setQuicProbe((m) => dropKey(m, id));
      setOsFingerprints((m) => dropKey(m, id));
      // ⛔ (P2) — but the REASON is kept, on a SOCKS5 row too. This is the
      // machine that runs the profile saying the proxy does not work, and it
      // was the one thing the grid threw away: the row rendered a green
      // "healthy from this Mac" beside a latency cell claiming the test Mac
      // "has not measured this proxy yet", for the ordinary IP-allowlisted
      // proxy this product measures from two places precisely to catch.
      setVpnFailures((m) => ({ ...m, [id]: outcome.reason }));
    }
  }

  async function handleTest(p: ProxyConfig): Promise<ProxyTestResult | null> {
    // (l) #16 — the gate lives HERE too, not only at the callers: the native
    // SOCKS5 probe has no honest answer for a VPN/HTTP endpoint (T-20), so a
    // row of any other scheme is routed to its own check whoever asks.
    if (!isSocks5Probeable(p.scheme)) {
      await handleCheckEndpoint(p);
      return null;
    }
    const epoch = ++testEpochRef.current; // claim this probe; an edit/remove bumps it
    const stale = (): boolean => testEpochRef.current !== epoch;
    setTestingId(p.id);
    try {
      // (l) #15 — ONE handshake per proxy at a time: this Test queues behind a
      // background sweep already probing the same row (and the sweep skips a
      // row this Test holds), so the two never overlap and skew each other's
      // latency, and the verdict the customer asked for is the one that lands
      // last. The cache write rides inside the claim for the same reason.
      const probed = await withProxyProbe(p.id, async () => {
        const r = await testProxy({
          host: p.host,
          port: p.port,
          username: p.username,
          password: p.password,
        });
        if (stale()) return null; // proxy endpoint changed/removed mid-probe → discard
        const at = Date.now();
        // Night-arc B: persist so profile cards can render egress
        // capability (UDP badge) without re-probing. Best-effort.
        await saveProbeResult(p.id, r, at).catch(() => undefined);
        return { result: r, probedAt: at };
      });
      if (probed === null) return null;
      const { result, probedAt } = probed;
      setTestResults((r) => ({ ...r, [p.id]: result }));
      setTestedAt((t) => ({ ...t, [p.id]: probedAt }));
      // (q) Item 12-memory (A) — the previous Test's notice ("tested from this
      // Mac only…") belongs to the previous Test: it goes the moment THIS one
      // has its native verdict, and is re-written below only if the fleet leg
      // is skipped again.
      setVpnNotices((m) => dropKey(m, p.id));
      // E-2: exit-geo through the proxy. A null result is a genuine probe
      // failure (V-857) rather than a missing dependency, and the card says so.
      if (isProxyUsable(result)) {
        const exit = await probeProxyExit({
          host: p.host,
          port: p.port,
          username: p.username,
          password: p.password,
        });
        if (stale()) return null;
        setExitResults((r) => ({ ...r, [p.id]: exit }));
        if (exit === null) {
          // (l) #14 — the honest "exit geo unavailable" state must survive
          // the next cache emit (the fleet test's persist below, the sweeper,
          // a list adoption): `saveProbeResult` above carried the PREVIOUS
          // exit across, so without this write the very next emit re-hydrated
          // that older IP beside "Tested just now" as if THIS Test measured it.
          void clearExitResult(p.id, probedAt).catch(() => undefined);
        }
        if (exit !== null) {
          // Persist the FULL geo enrichment (city/region/timezone/asn), not just
          // ip/country — mirrors ProfilesView so the Profiles hub + a reload show
          // the same exit location for a proxy tested from here.
          void saveExitResult(p.id, exit.ip, exit.country, {
            city: exit.city ?? null,
            region: exit.region ?? null,
            timezone: exit.timezone ?? null,
            asnOrg: exit.asn_org ?? null,
          }).catch(() => undefined);
        }
        // N-2 — the passive OS fingerprint comes from the control plane's OWN
        // test: only the destination of the proxy's connection can see the SYN
        // the proxy's kernel built, and the native probe above is the proxy's
        // client, not its destination. Only a proxy stored on the account can
        // be tested there. Best-effort: a miss keeps the prior verdict, and
        // nothing here can change the connectivity result above.
        //
        // (q) Item 12-memory (A) — the row is STORED here when it is not yet
        // (an API key is the only precondition, and it is checked FIRST: a
        // customer with no key cannot store anything). This leg used to sit
        // behind `p.serverId !== undefined` with no else, so a SOCKS5 proxy
        // added on this tab and Tested before its first launch greened natively
        // and silently skipped the fleet: no relay verdict, no OS fingerprint,
        // and a '~' QUIC chip whose hint said "run Test" — the loop the owner
        // read as "it's not detecting my QUIC". Each way the leg does NOT run
        // now leaves the row a notice naming the cause and the next step.
        if (settings.apiKey === null || settings.apiKey.length === 0) {
          setVpnNotices((m) => ({ ...m, [p.id]: SOCKS5_TEST_NO_API_KEY_NOTICE }));
        } else {
          let serverId: string | undefined = p.serverId;
          if (serverId === undefined) {
            try {
              const ensured = await ensureAccountProxyRow(p, settings.baseUrl, settings.apiKey);
              if (stale()) return null;
              serverId = ensured?.id;
              if (ensured?.created === true) {
                // Mirror the persisted `serverId` into this grid's list, so the
                // next Test / Check of the row takes the stored path at once.
                const storedId = ensured.id;
                setState((s) => ({
                  ...s,
                  proxies: s.proxies.map((x) => (x.id === p.id ? { ...x, serverId: storedId } : x)),
                }));
              }
            } catch (err) {
              if (stale()) return null;
              setVpnNotices((m) => ({ ...m, [p.id]: socks5FleetTestNotStoredNotice(err) }));
            }
          }
          if (serverId !== undefined) {
            // The control plane's own test is the ONLY source of the passive OS
            // fingerprint AND the honest fleet-side latency/QUIC verdict — only a
            // proxy stored on the account can be tested there. Best-effort: a miss
            // keeps the prior verdicts, and nothing here changes the connectivity
            // result measured above.
            // T-1 — ask for the FLEET vantage: the Mac that will run the profile
            // measures it; the server says so (or says it fell back) in the reply.
            // T-27 — the fetch, the parse of the verdicts and the cache write are
            // ONE shared step (lib/proxy-server-test) with the profile card's Test,
            // so the two cannot drift again; only the grid's own state is applied
            // here. The QUIC stamp inside it is the SERVER's `quic_measured_at`
            // (drop 5) — not this Mac's clock at reply time.
            const outcome = await testProxyOnServer(settings.baseUrl, settings.apiKey, serverId);
            if (stale()) return null;
            // The ok / failed application is shared with the VPN row's check (b).
            applyServerProbeOutcome(p.id, outcome);
            void persistServerProbe(p.id, outcome);
          }
        }
      } else {
        // Proxy is no longer usable (not reachable / auth failed) — drop any
        // exit-geo from a prior successful probe so the card can't show a
        // stale "exit IP · country" next to "Auth failed" / "Not reachable".
        setExitResults((r) => dropKey(r, p.id));
        setOsFingerprints((m) => dropKey(m, p.id));
        setServerLatency((m) => dropKey(m, p.id));
        setServerProbeAt((m) => dropKey(m, p.id));
        setQuicMeasured((m) => dropKey(m, p.id));
        setServerVantage((m) => dropKey(m, p.id));
        setQuicProbe((m) => dropKey(m, p.id));
        // (P2) — the fleet leg does not run when the native probe failed, so a
        // standing fleet failure is exactly as stale as the numbers above it.
        setVpnFailures((m) => dropKey(m, p.id));
      }
      return result;
    } catch (err) {
      if (stale()) return null;
      const result: ProxyTestResult = {
        reachable: false,
        auth_ok: false,
        udp_associate: false,
        // A synthesised result is not evidence of routing. Fail closed: an
        // unknown proxy must never inherit a usable verdict by omission.
        can_route: false,
        connect_reply: 0xff,
        latency_ms: 0,
        message: humanizeError(err, "Couldn't test this proxy. Check the details and try again."),
      };
      setTestResults((r) => ({ ...r, [p.id]: result }));
      setExitResults((r) => dropKey(r, p.id));
      setOsFingerprints((m) => dropKey(m, p.id));
      setServerLatency((m) => dropKey(m, p.id));
      setQuicMeasured((m) => dropKey(m, p.id));
      setServerVantage((m) => dropKey(m, p.id));
      setQuicProbe((m) => dropKey(m, p.id));
      return result;
    } finally {
      // Always clear the spinner for the id THIS probe owns — even when a
      // mid-probe edit/remove bumped the epoch (stale()). The stale-guard's
      // early returns above skip the state writes, but the card must not stay
      // pinned on a spinning 'Testing…'; scope the clear so a newer probe that
      // re-armed testingId to another id isn't stomped.
      setTestingId((cur) => (cur === p.id ? null : cur));
    }
  }

  // Capability-board port (approved proxy-health demo, 2026-06-12):
  // probe ALL saved proxies sequentially. Sequential by design — the
  // native probe opens real sockets; parallel probes through consumer
  // egress endpoints skew each other's latency numbers.
  const [testingAll, setTestingAll] = useState(false);
  /**
   * Sweep every proxy, or just `only` when the grid hands up a selection.
   *
   * Parameterised rather than given a sibling: this function owns the
   * run-claiming protocol (activeTestAllRunRef + runId) that stops a stale sweep
   * announcing over a newer one, and a second copy of that protocol is a second
   * thing to keep correct.
   */
  async function handleTestAll(only?: ProxyConfig[]): Promise<void> {
    // `disabled` is state-driven and therefore takes one render to land. Guard
    // synchronously too, so a double activation cannot start two socket sweeps.
    if (activeTestAllRunRef.current !== null) return;
    const targets = (only ?? state.proxies).filter((p) => isSweepable(p.scheme));
    // Normally unreachable through the disabled button, but keep direct/rapid
    // invocation honest: zero probes should not flash busy or claim completion.
    if (targets.length === 0) return;

    const runId = nextTestAllRunRef.current++;
    activeTestAllRunRef.current = runId;
    setTestAllSummary(null);
    setTestingAll(true);
    const results: ProxyTestResult[] = [];
    const vpn = emptyVpnTally();
    try {
      // Only SOCKS5 (or legacy-undefined) proxies have an honest native SOCKS5
      // probe. Running it against a VPN/HTTP endpoint always returns a false
      // negative, so a VPN row goes through ITS check instead (b): the endpoint
      // pre-flight, then the same fleet test — never the SOCKS5 handshake. An
      // HTTP row has neither and is not in `targets`.
      for (const p of targets) {
        if (!isSocks5Probeable(p.scheme)) {
          const check = await handleCheckEndpoint(p);
          // (d)/(h) — a skipped row (test refused), an untested row (nothing
          // could measure the tunnel) and a check that could not run are each
          // their own bucket: never a checked tunnel that is "not up".
          if (check === null) continue;
          if (check.checkFailed === true) {
            vpn.checkFailed += 1;
          } else if (check.skipped !== undefined) {
            vpn.skipped += 1;
            vpn.skippedWhy.push(check.skipped);
          } else if (check.notTested !== undefined) {
            vpn.notTested += 1;
            vpn.notTestedWhy.push(check.notTested);
          } else if (check.tunnelOk !== null) {
            vpn.checked += 1;
            if (check.tunnelOk) {
              vpn.tunnelOk += 1;
              if (check.noLatency === true) vpn.tunnelOkNoLatency += 1;
            }
          }
          continue;
        }
        const result = await handleTest(p);
        // A proxy edited/removed during its probe returns null. Do not inflate
        // the completed count with a result that was deliberately discarded.
        if (result !== null) results.push(result);
      }
    } finally {
      if (activeTestAllRunRef.current === runId) {
        activeTestAllRunRef.current = null;
        setTestingAll(false);
        setTestAllSummary({ runId, text: formatTestAllSummary(results, vpn) });
      }
    }
  }

  // Only SOCKS5 proxies have an honest native probe, and (b) a VPN row has its
  // endpoint check + fleet test; an HTTP row has neither (verified at launch). When
  // NONE are sweepable, "Test all" would flip on→off running zero probes with no feedback
  // — a dead button (audit 2026-07-08); disable it with an explaining title instead.
  const probeableCount = state.proxies.filter((p) => isSweepable(p.scheme)).length;
  // (n) N19 — the tallies count a VPN row from ITS verdict (the fleet answer the row
  // renders), not from `testResults`, which is empty for every endpoint row by
  // construction. Before this, a WireGuard-only pool stayed on the generic "Protected
  // locally…" sentence however many tunnels were up.
  const vpnVerdictState: VpnVerdictState = { vpnFailures, endpointResults, serverVantage };
  const tested = state.proxies.filter((p) => isRowTested(p, testResults, vpnVerdictState));
  const healthy = tested.filter((p) => isRowHealthy(p, testResults, vpnVerdictState));
  // ⛔ NOT VPN-aware on purpose: `udp_associate` is a MEASURED capability of the native
  // SOCKS5 probe. A tunnel carries UDP by construction, but no probe measured it here,
  // and the row's own "UDP via tunnel" chip is where that belongs.
  const udpCapable = tested.filter((p) => {
    const r = testResults[p.id];
    return r !== undefined && r.udp_associate;
  });

  const editing =
    editor.kind === 'edit' ? (state.proxies.find((p) => p.id === editor.id) ?? null) : null;

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* HERO strip (console.html) — section-label + title with at-a-glance
          context on the left; quiet Test-all + primary New-proxy on the
          right. Mirrors the Profiles hub hero rhythm. */}
      <div
        data-component="proxies-hero"
        className="flex flex-wrap items-start gap-4 border-b border-surface-divider pb-3"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-lg text-accent ring-1 ring-accent/25">
            🌍
          </span>
          <div className="min-w-0">
            <span className="section-label text-accent-text">Network egress</span>
            <h2 className="mt-0.5 text-[19px] font-semibold tracking-tight text-ink-primary">
              Egress proxies
              <span className="mono ml-2 text-base font-normal text-ink-muted">
                {state.proxies.length}
              </span>
            </h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
              {tested.length > 0 ? (
                <>
                  <b className="font-semibold text-status-ready">{healthy.length}</b> healthy
                  <span className="text-surface-divider">·</span>
                  <b className="font-semibold text-ink-primary">{udpCapable.length}</b> WebRTC +
                  QUIC
                  <span className="text-surface-divider">·</span>
                  <span className="text-ink-muted">
                    protected locally · encrypted sync at launch
                  </span>
                </>
              ) : (
                <span className="text-ink-muted">
                  Protected locally on this device · synced encrypted when used for a session.
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {state.proxies.length > 0 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleTestAll()}
              disabled={testingAll || testingId !== null || probeableCount === 0}
              title={
                probeableCount === 0
                  ? 'No SOCKS5 or VPN proxies to test — HTTP endpoints are verified at launch'
                  : undefined
              }
            >
              {testingAll ? 'Testing all…' : 'Test all'}
            </button>
          )}
          <button
            type="button"
            className="btn-primary flex items-center gap-1.5"
            onClick={() => {
              if (!saveInFlightRef.current) setEditor({ kind: 'add' });
            }}
            disabled={saving}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M8 3v10M3 8h10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            <span>New proxy</span>
          </button>
        </div>
      </div>

      {/* Add/Edit form renders FIRST (right under the hero) when open, so it's
          immediately in view — no scrolling past the list, no clipped bottom
          (the whole page scrolls inside the app's <main overflow-auto>). */}
      {(editor.kind === 'add' || editor.kind === 'edit') && (
        <ProxyForm
          // Identity-bound key → the form REMOUNTS when the edit target changes,
          // so switching Edit A → Edit B (the list stays clickable below) reseeds
          // the draft instead of writing A's host/port/creds onto B.
          key={editor.kind === 'edit' ? editor.id : 'add'}
          initial={editing !== null ? toDraft(editing) : EMPTY_DRAFT}
          mode={editor.kind}
          saving={saving}
          onCancel={() => {
            if (!saveInFlightRef.current) setEditor({ kind: 'idle' });
          }}
          onSave={handleSave}
        />
      )}

      {/* Pool summary — hidden while the form is open (it's noise then; founder:
          the stats shouldn't show when New proxy is clicked) + only over TESTED
          proxies (no fabricated health for never-probed entries). */}
      {tested.length > 0 && editor.kind === 'idle' && (
        <div
          data-component="proxy-pool-stats"
          className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-surface-divider bg-surface-divider"
        >
          <PoolStat k="Tested" v={`${String(tested.length)} / ${String(state.proxies.length)}`} />
          <PoolStat k="Healthy" v={String(healthy.length)} tone="ok" />
          <PoolStat k="WebRTC + QUIC" v={String(udpCapable.length)} tone="ok" />
        </div>
      )}

      {state.error !== null && (
        <ErrorBanner
          message={state.error}
          onRetry={() => void refresh()}
          retrying={state.loading}
          onDismiss={() => setState((s) => ({ ...s, error: null }))}
        />
      )}

      {state.notice !== null && (
        <div
          role="status"
          data-component="proxy-notice"
          className="flex items-start justify-between gap-3 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-xs text-ink-primary"
        >
          <span>{state.notice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="px-1 leading-none text-ink-muted hover:text-ink-primary"
            onClick={() => setState((s) => ({ ...s, notice: null }))}
          >
            ×
          </button>
        </div>
      )}

      {testAllSummary !== null && (
        <div
          role="status"
          aria-live="polite"
          data-component="proxy-test-all-summary"
          className="flex items-start justify-between gap-3 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-xs text-ink-primary"
        >
          <span>{testAllSummary.text}</span>
          <button
            type="button"
            aria-label="Dismiss test summary"
            className="px-1 leading-none text-ink-muted hover:text-ink-primary"
            onClick={() => setTestAllSummary(null)}
          >
            ×
          </button>
        </div>
      )}

      {state.proxies.length === 0 ? (
        <Empty loading={state.loading} onAdd={() => setEditor({ kind: 'add' })} />
      ) : (
        <ProxyTable
          proxies={state.proxies}
          busyId={busyId}
          testingId={testingId}
          testingAll={testingAll}
          testResults={testResults}
          endpointResults={endpointResults}
          exitResults={exitResults}
          testedAt={testedAt}
          osFingerprints={osFingerprints}
          serverLatency={serverLatency}
          serverProbeAt={serverProbeAt}
          quicMeasured={quicMeasured}
          serverVantage={serverVantage}
          quicProbe={quicProbe}
          vpnFailures={vpnFailures}
          vpnNotices={vpnNotices}
          noFleetMac={noFleetMac}
          onEdit={(id) => setEditor({ kind: 'edit', id })}
          onRemove={(id) => void handleRemove(id)}
          onTest={(p) => void handleTest(p)}
          onCheckEndpoint={(p) => void handleCheckEndpoint(p)}
          onRemoveMany={(ids) => void handleRemoveMany(ids)}
          onTestMany={(ps) => void handleTestAll(ps)}
        />
      )}
    </div>
  );
}

// ─── subcomponents ────────────────────────────────────────────────

function Empty({ loading, onAdd }: { loading: boolean; onAdd: () => void }): JSX.Element {
  if (loading) {
    return <ProxyListSkeleton />;
  }
  return (
    <EmptyState
      icon={
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 2v6m0 8v6M4.93 4.93l4.24 4.24m5.66 5.66l4.24 4.24M2 12h6m8 0h6M4.93 19.07l4.24-4.24m5.66-5.66l4.24-4.24" />
        </svg>
      }
      title="No proxies configured"
      description="Add a SOCKS5 endpoint to route session traffic through your own egress IP. Proxy credentials are protected locally and synced in encrypted form to your account when used for a session."
      action={
        <button
          type="button"
          className="btn-primary btn-primary-bright px-4 py-2 text-sm"
          onClick={onAdd}
        >
          Add a proxy
        </button>
      }
    />
  );
}

/**
 * First-load state, shaped like the grid it precedes.
 *
 * A skeleton whose silhouette does not match what arrives is a layout jump: the
 * page settles into a different shape than the one it promised. This one is
 * rows, because the page is rows.
 */
function ProxyListSkeleton(): JSX.Element {
  return (
    <SkeletonRegion label="Loading proxies">
      <div
        data-component="proxy-list-skeleton"
        className="overflow-hidden rounded-lg border border-surface-divider bg-surface-raised"
      >
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 border-b border-surface-divider/40 px-3 py-2.5 last:border-b-0"
          >
            <Skeleton className="h-3.5 w-3.5 rounded-sm" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="ml-auto h-3 w-12" />
            <Skeleton className="h-4 w-16 rounded-[5px]" />
            <Skeleton className="h-6 w-14 rounded-md" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

type SortKey = 'status' | 'label' | 'scheme' | 'latency' | 'tested';

/**
 * Where a proxy sits when sorting by "what needs me". Lower comes first.
 *
 * ⚠️ This ordering is the whole reason the grid is safe to prefer over cards. A
 * row is a thin target: a failure reads as a coloured stripe and a word, which
 * is easy to walk past when you opened the page for another reason. Sorting
 * problems to the top means you do not have to notice — the broken proxy is
 * simply the first thing under the header.
 *
 * Untested ranks BELOW slow and above healthy: it is a gap in knowledge rather
 * than a fault, but it is still not a proxy you should assume works.
 */
function statusRank(
  result: ProxyTestResult | undefined,
  serverLatencyMs?: number,
  fleetFailed = false,
): number {
  // (P2) — the Mac that RUNS the profile said this proxy is not usable. That is
  // a fault and it sorts with the faults: such a row used to rank 3 (healthy,
  // from the local handshake) and sink to the BOTTOM of the page whose whole
  // safety argument is "the broken proxy is simply the first row", and it was
  // absent from the hero's "needs attention" for the one vantage that predicts
  // a session.
  if (fleetFailed) return 0;
  if (result === undefined) return 2;
  if (!result.reachable || !result.auth_ok || !result.can_route) return 0;
  // (P2) — judged by the SAME number the pill judges (the test Mac's when there
  // is one). Ranking by the native number while the pill read "slow from the
  // test Mac" put a row the customer was told is slow at the bottom.
  return (serverLatencyMs ?? result.latency_ms ?? 0) > LATENCY_GOOD_MS ? 1 : 3;
}

/** (n) N19 — the state every VPN-aware tally reads, so the hero counts, the pool stats
 *  and the status sort cannot answer differently about the same row. */
interface VpnVerdictState {
  vpnFailures: Record<string, string>;
  endpointResults: Record<string, EndpointResolveResult>;
  serverVantage: Record<string, ServerVantage>;
}

/**
 * (n) N19 — a VPN row's health, from the SAME state the row itself renders.
 *
 * ⛔ MEASURED: every tally on this page read `testResults` only, and
 * `deriveProbeViewWithEndpointRows` DELETES the entry of every endpoint row from
 * `testResults` by design (a VPN row's placeholder is not a SOCKS5 verdict). So for a
 * WireGuard or OpenVPN row `testResults[p.id]` is permanently undefined: the hero said
 * nothing needed attention while the row beside it read "tunnel down", sort-by-status
 * left that row exactly where it was, and a VPN-only pool never reached the "N healthy"
 * line no matter how many tunnels came up.
 *
 * 'down' is the row's red: the fleet's failure sentence, or an endpoint that does not
 * resolve. 'up' is the only thing that can claim a tunnel — a FLEET-measured vantage;
 * a control-plane fallback measured no tunnel and stays 'untested', exactly as the row's
 * own pill does.
 */
function vpnRowVerdict(id: string, s: VpnVerdictState): 'down' | 'up' | 'untested' {
  if (s.vpnFailures[id] !== undefined) return 'down';
  if (s.endpointResults[id]?.resolved === false) return 'down';
  if (s.serverVantage[id]?.measuredFrom === 'fleet') return 'up';
  return 'untested';
}

/** (n) N19 — "has this row been checked at all", for the hero's `tested` tally. */
function isRowTested(
  p: ProxyConfig,
  testResults: Record<string, ProxyTestResult>,
  s: VpnVerdictState,
): boolean {
  return isVpnScheme(p.scheme)
    ? vpnRowVerdict(p.id, s) !== 'untested'
    : testResults[p.id] !== undefined;
}

/** (n) N19 — "is this row healthy", for the hero + pool stats. A VPN row is healthy when
 *  a fleet Mac brought its tunnel up; a SOCKS5 row when its native probe says so. */
function isRowHealthy(
  p: ProxyConfig,
  testResults: Record<string, ProxyTestResult>,
  s: VpnVerdictState,
): boolean {
  if (isVpnScheme(p.scheme)) return vpnRowVerdict(p.id, s) === 'up';
  const r = testResults[p.id];
  // (P2) — a SOCKS5 row the fleet could not use is not healthy, whatever the
  // local handshake managed. The hero counted it as healthy while the row's own
  // pill (and now the sort) called it a failure.
  return r !== undefined && isProxyUsable(r) && s.vpnFailures[p.id] === undefined;
}

/** (n) N19 — `statusRank` with the VPN branch: a tunnel that is down sorts to the top
 *  like an unreachable SOCKS5 row, an up tunnel sorts by its fleet latency, and a row
 *  with no verdict keeps the "untested" middle. */
function rowStatusRank(
  p: ProxyConfig,
  testResults: Record<string, ProxyTestResult>,
  serverLatency: Record<string, number>,
  s: VpnVerdictState,
): number {
  if (!isVpnScheme(p.scheme))
    return statusRank(testResults[p.id], serverLatency[p.id], s.vpnFailures[p.id] !== undefined);
  const verdict = vpnRowVerdict(p.id, s);
  if (verdict === 'down') return 0;
  if (verdict === 'untested') return 2;
  // (P2) — LATENCY_GOOD_MS, not a fourth copy of the literal: the constant fed
  // the pill and both meters while this branch kept its own 100, so moving it
  // would have painted a VPN meter green beside a sort that called it slow.
  return (serverLatency[p.id] ?? 0) > LATENCY_GOOD_MS ? 1 : 3;
}

function ProxyTable({
  proxies,
  busyId,
  testingId,
  testingAll,
  testResults,
  exitResults,
  testedAt,
  osFingerprints,
  serverLatency,
  serverProbeAt,
  quicMeasured,
  serverVantage,
  quicProbe,
  vpnFailures,
  vpnNotices,
  noFleetMac,
  endpointResults,
  onEdit,
  onRemove,
  onTest,
  onCheckEndpoint,
  onRemoveMany,
  onTestMany,
}: {
  proxies: ProxyConfig[];
  busyId: string | null;
  testingId: string | null;
  testingAll: boolean;
  testResults: Record<string, ProxyTestResult>;
  exitResults: Record<string, ProxyExitProbeResult | null>;
  testedAt: Record<string, number>;
  osFingerprints: Record<string, CachedOsFingerprint>;
  serverLatency: Record<string, number>;
  /** (P2) — when each server latency was measured, so the fleet line can date
   *  its own number rather than borrowing the native verdict's date. */
  serverProbeAt: Record<string, number>;
  quicMeasured: Record<string, MeasuredQuic>;
  /** T-1 — where each server latency was measured, and the fleet relay verdict. */
  serverVantage: Record<string, ServerVantage>;
  quicProbe: Record<string, boolean>;
  /** (b) — the fleet's failure sentence per VPN row whose tunnel did not come up. */
  vpnFailures: Record<string, string>;
  /** (d) — the server's sentence per VPN row whose test was NOT RUN (a notice). */
  vpnNotices: Record<string, string>;
  /** (o) O5 — the rows whose last server test reached NO fleet Mac (`not_run:
   *  'no_node'`). Absent = a Mac answered, or no server test has landed yet. */
  noFleetMac: Record<string, true>;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  endpointResults: Record<string, EndpointResolveResult>;
  onTest: (p: ProxyConfig) => void;
  onCheckEndpoint: (p: ProxyConfig) => void;
  onRemoveMany: (ids: string[]) => void;
  onTestMany: (ps: ProxyConfig[]) => void;
}): JSX.Element {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'status',
    dir: 'asc',
  });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  /**
   * The selection, intersected with the proxies that still exist.
   *
   * DERIVED rather than synced in an effect. A proxy removed elsewhere must not
   * keep voting — a stale id would make "Remove 3" act on two and the count in
   * the bulk bar lie — and an effect fixes that one render too late, so the
   * wrong number is briefly on screen. Deriving it cannot be stale.
   */
  const live = useMemo(() => {
    const ids = new Set(proxies.map((p) => p.id));
    return new Set([...selected].filter((id) => ids.has(id)));
  }, [proxies, selected]);

  // (n) N19 — the VPN verdict state the rank + the attention count read, built from the
  // props the rows already render so a row and the tally above it cannot disagree.
  const vpnVerdictState: VpnVerdictState = useMemo(
    () => ({ vpnFailures, endpointResults, serverVantage }),
    [vpnFailures, endpointResults, serverVantage],
  );

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const val = (p: ProxyConfig): string | number => {
      const r = testResults[p.id];
      switch (sort.key) {
        case 'label':
          return p.label.toLowerCase();
        case 'scheme':
          return schemeLabel(p.scheme).text.toLowerCase();
        case 'latency':
          // Sort by the number the row's PILL judges — the test Mac's when there is
          // one, else the native probe's. (P2) the cell no longer displays one
          // merged value; it displays both, stacked and labelled, so "the value
          // the row displays" is no longer a single thing and this comparator is
          // deliberately ordered by the top line, the one that predicts a
          // session. An unreachable native has no latency; Infinity parks it at
          // the end ascending rather than letting a 0 masquerade as fastest.
          return (
            serverLatency[p.id] ??
            (r !== undefined && r.reachable ? (r.latency_ms ?? Infinity) : Infinity)
          );
        case 'tested':
          return testedAt[p.id] ?? 0;
        case 'status':
        default:
          // (n) N19 — VPN-aware: a tunnel-down row ranks 0 and floats to the top of
          // the default sort exactly like an unreachable SOCKS5 row. Reading
          // `testResults` alone left every VPN row at the "untested" rank 2 — the
          // page's whole safety argument ("the broken proxy is the first row") did
          // not hold for a scheme whose verdict never lands in that map.
          return rowStatusRank(p, testResults, serverLatency, vpnVerdictState);
      }
    };
    // Tie-break on the ORIGINAL position, not the label. Equal-status rows are
    // the common case (nothing tested yet, or everything healthy), so an
    // alphabetical tie-break would silently reorder the whole page relative to
    // the order the proxies were added — and "the first Remove button" would
    // stop meaning the first proxy. Index keeps ties exactly where they were and
    // is just as stable across renders.
    const order = new Map(proxies.map((p, i) => [p.id, i]));
    return [...proxies].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    });
  }, [proxies, sort, testResults, testedAt, serverLatency, vpnVerdictState]);

  // (n) N19 — the hero's "N needs attention" counts a tunnel the fleet could not bring
  // up, or an endpoint that does not resolve, through the same rank the sort uses.
  const attention = proxies.filter(
    (p) => rowStatusRank(p, testResults, serverLatency, vpnVerdictState) === 0,
  ).length;
  const selectedProxies = sorted.filter((p) => live.has(p.id));
  const allSelected = proxies.length > 0 && live.size === proxies.length;

  function toggleSort(key: SortKey): void {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  }

  // #4 — the anchor for shift-click range selection, in the current sorted display
  // order. Mass-selecting proxies used to mean clicking each ~13px checkbox one by
  // one; now a row click toggles, and shift+row-click selects the whole range.
  const lastClickedIdRef = useRef<string | null>(null);
  function toggleOne(id: string, shiftKey = false): void {
    // (q) Item 4 — the anchor is read BEFORE the state update is queued, not
    // inside the updater. The updater ran lazily (at render, whenever this
    // view had another update pending — a probe-cache emit, a Test in flight),
    // by which time `lastClickedIdRef.current` had already been moved to the
    // row being shift-clicked; `anchor === id` then skipped the range and the
    // click toggled ONE row. MEASURED in jsdom: shift-clicking the row body
    // after clicking A selected only A and E — so this was never only the
    // checkbox handler's dropped modifier.
    const anchor = lastClickedIdRef.current;
    lastClickedIdRef.current = id;
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && anchor !== null && anchor !== id) {
        const order = sorted.map((p) => p.id);
        const a = order.indexOf(anchor);
        const b = order.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i += 1) {
            const rid = order[i];
            if (rid !== undefined) next.add(rid);
          }
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' =>
    sort.key !== key ? 'none' : sort.dir === 'asc' ? 'ascending' : 'descending';

  function Th({
    label,
    sortKey,
    align,
  }: {
    label: string;
    sortKey?: SortKey;
    align?: 'right';
  }): JSX.Element {
    const cls =
      'whitespace-nowrap px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted';
    if (sortKey === undefined) {
      return (
        <th scope="col" className={`${cls} ${align === 'right' ? 'text-right' : 'text-left'}`}>
          {label}
        </th>
      );
    }
    const active = sort.key === sortKey;
    return (
      <th
        scope="col"
        aria-sort={ariaSort(sortKey)}
        className={`${cls} ${align === 'right' ? 'text-right' : 'text-left'}`}
      >
        <button
          type="button"
          onClick={() => toggleSort(sortKey)}
          className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-ink-primary ${
            active ? 'text-ink-primary' : ''
          }`}
        >
          {label}
          <span aria-hidden="true" className={active ? '' : 'opacity-0 group-hover:opacity-40'}>
            {active ? (sort.dir === 'asc' ? '\u2191' : '\u2193') : '\u2191'}
          </span>
        </button>
      </th>
    );
  }

  return (
    <div data-component="proxy-table" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 px-1 text-[11px] text-ink-muted">
        <span>
          {proxies.length} {proxies.length === 1 ? 'proxy' : 'proxies'}
          {attention > 0 && (
            <>
              {' \u00b7 '}
              <span className="font-semibold text-status-error">
                {attention} need{attention === 1 ? 's' : ''} attention
              </span>
            </>
          )}
        </span>
        {sort.key !== 'status' && (
          <button
            type="button"
            className="text-ink-muted underline-offset-2 hover:text-ink-primary hover:underline"
            onClick={() => setSort({ key: 'status', dir: 'asc' })}
          >
            Sort by status
          </button>
        )}
      </div>

      {/* The grid is wide by design; it scrolls INSIDE this box so the page
          body never scrolls sideways. */}
      <div className="overflow-x-auto rounded-lg border border-surface-divider bg-surface-raised">
        <table className="w-full min-w-[880px] border-collapse text-[12px]">
          <thead>
            <tr className="group border-b border-surface-divider">
              <th scope="col" className="w-9 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label={allSelected ? 'Clear selection' : 'Select all proxies'}
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(proxies.map((p) => p.id)))
                  }
                  className="h-4 w-4 cursor-pointer accent-[rgb(var(--accent-rgb))]"
                />
              </th>
              <Th label="Proxy" sortKey="label" />
              <Th label="Type" sortKey="scheme" />
              <Th label="Endpoint" />
              <Th label="Exit" />
              <Th label="Latency" sortKey="latency" align="right" />
              <Th label="Capabilities" />
              <Th label="OS" />
              <Th label="Status" sortKey="status" />
              <Th label="Last test" sortKey="tested" />
              <Th label="" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <ProxyRow
                key={p.id}
                proxy={p}
                selected={live.has(p.id)}
                onToggle={(shiftKey) => toggleOne(p.id, shiftKey)}
                busy={busyId === p.id}
                testing={testingId === p.id}
                testingAll={testingAll}
                result={testResults[p.id]}
                endpointResult={endpointResults[p.id]}
                exit={p.id in exitResults ? exitResults[p.id] : undefined}
                testedAt={testedAt[p.id]}
                osFingerprint={osFingerprints[p.id]}
                serverLatencyMs={serverLatency[p.id]}
                serverProbeAtMs={serverProbeAt[p.id]}
                quicMeasured={quicMeasured[p.id]}
                serverVantage={serverVantage[p.id]}
                quicProbe={quicProbe[p.id]}
                vpnFailure={vpnFailures[p.id]}
                vpnNotice={vpnNotices[p.id]}
                noFleetMac={noFleetMac[p.id] === true}
                onEdit={() => onEdit(p.id)}
                onRemove={() => onRemove(p.id)}
                onTest={() => onTest(p)}
                onCheckEndpoint={() => onCheckEndpoint(p)}
              />
            ))}
          </tbody>
        </table>

        {live.size > 0 && (
          <div
            data-component="proxy-bulk-bar"
            className="flex flex-wrap items-center gap-3 border-t border-surface-divider bg-surface-inset px-3 py-2 text-[11.5px]"
          >
            <span className="text-ink-secondary">{live.size} selected</span>
            <button
              type="button"
              className="rounded-md border border-surface-divider px-2.5 py-1 text-ink-secondary transition-colors hover:border-ink-muted hover:text-ink-primary disabled:opacity-50"
              // A SOCKS5 row has the native probe and (b) a VPN row its endpoint
              // check + fleet test; a selection of only HTTP rows makes onTestMany a
              // silent no-op (handleTestAll filters to isSweepable). Disable + say why.
              disabled={
                testingAll ||
                testingId !== null ||
                !selectedProxies.some((p) => isSweepable(p.scheme))
              }
              title={
                selectedProxies.some((p) => isSweepable(p.scheme))
                  ? undefined
                  : 'Only SOCKS5 and VPN proxies can be tested; the selection has none.'
              }
              onClick={() => onTestMany(selectedProxies)}
            >
              Test selected
            </button>
            <button
              type="button"
              className="rounded-md border border-surface-divider px-2.5 py-1 text-ink-secondary transition-colors hover:border-status-error hover:text-status-error disabled:opacity-50"
              disabled={busyId !== null}
              onClick={() => onRemoveMany(selectedProxies.map((p) => p.id))}
            >
              Remove selected
            </button>
            <button
              type="button"
              className="ml-auto text-ink-muted hover:text-ink-primary"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One proxy, one row.
 *
 * ⚠️ Row actions are QUIET (bordered, ink-coloured), not the filled accent the
 * card used. That is deliberate and not only density: the accent is oxblood
 * #a83b4d and status-error is #d8453c, near enough that a filled accent button
 * on every row competes with the one colour that means "this is broken". In a
 * grid, saturated colour belongs to state, not to chrome.
 */
function ProxyRow({
  proxy: p,
  selected,
  onToggle,
  busy,
  testing,
  testingAll,
  result,
  exit,
  testedAt,
  osFingerprint,
  serverLatencyMs,
  serverProbeAtMs,
  quicMeasured,
  serverVantage,
  quicProbe,
  vpnFailure,
  vpnNotice,
  noFleetMac,
  endpointResult,
  onEdit,
  onRemove,
  onTest,
  onCheckEndpoint,
}: {
  proxy: ProxyConfig;
  selected: boolean;
  onToggle: (shiftKey: boolean) => void;
  busy: boolean;
  testing: boolean;
  testingAll: boolean;
  result: ProxyTestResult | undefined;
  // undefined = exit-geo never recorded for this proxy; null = probed, and the
  // echo round-trip did not complete through this proxy (V-857).
  exit: ProxyExitProbeResult | null | undefined;
  testedAt: number | undefined;
  /** N-2 — the control plane's passive OS fingerprint of this proxy's stack. */
  osFingerprint: CachedOsFingerprint | undefined;
  /** T-1 — the control plane's server-measured latency, preferred over the native
   *  one and labelled so it is never read as the laptop's number. */
  serverLatencyMs: number | undefined;
  /** (P2) — when `serverLatencyMs` was measured. `testedAt` dates the NATIVE
   *  verdict on a SOCKS5 row, and the cell prints both numbers. */
  serverProbeAtMs: number | undefined;
  /** T-6 — the QUIC verdict measured in a live session, for the capability chip. */
  quicMeasured: MeasuredQuic | undefined;
  /** T-1 — where serverLatencyMs was measured (+ the fleet node), so the number
   *  is labelled with the machine that took it; undefined = a server number
   *  recorded before the vantage was reported (plain "server" marker). */
  serverVantage: ServerVantage | undefined;
  /** T-1 — the fleet Mac's QUIC-relay verdict, its own chip; never merged. */
  quicProbe: boolean | undefined;
  /** (b) — the fleet's failure sentence when this VPN row's tunnel did not come
   *  up, and (P2) a SOCKS5 row's too: the Mac that runs the profile answering
   *  "this proxy does not work" is the same fact whatever the scheme, and on a
   *  SOCKS5 row it used to be dropped on the floor. */
  vpnFailure?: string;
  /** (d) — the server's sentence when this VPN row's test was NOT RUN: a live
   *  session holds the tunnel, or the measuring Mac was busy. A notice beside
   *  the row's verdict, never a failure. */
  vpnNotice?: string;
  /** (o) O5 — the last server test of this row found NO fleet Mac to run it
   *  (`not_run: 'no_node'`). The QUIC absence it leaves behind is about the
   *  FLEET, not about this tunnel, and the chip says which. */
  noFleetMac: boolean;
  endpointResult: EndpointResolveResult | undefined;
  onEdit: () => void;
  onRemove: () => void;
  onTest: () => void;
  onCheckEndpoint: () => void;
}): JSX.Element {
  const reachable = result?.reachable ?? false;
  const healthy = result !== undefined && isProxyUsable(result);
  // T-1 — the number to LEAD with: the server-measured one (taken near the
  // fleet that runs the profile) when there is one, else the native probe's, so
  // a proxy with no server row still has a verdict. ⚠️ (P2) this is no longer
  // "the number the cell shows" — the cell shows both sides separately below.
  // `lat` now feeds only the health pill and the status sort, i.e. the single
  // question "is this proxy fast enough for the session it will run".
  const fromServer = serverLatencyMs !== undefined;
  const lat = serverLatencyMs ?? result?.latency_ms;
  // T-1 — the words beside a server number name the machine that measured it.
  // A number cached before the vantage was reported keeps the plain "server"
  // marker rather than borrowing a label it never earned.
  const vantage = serverVantage !== undefined ? vantageLabel(serverVantage) : undefined;
  const vantageText = vantage?.label ?? 'server';
  const vantageTitle = vantage?.title ?? SERVER_LATENCY_TITLE;
  const latGood = lat !== undefined && lat <= LATENCY_GOOD_MS;
  // (P2) — the two numbers are kept APART. `lat` above is still the one the
  // health pill and the meter lead with (the test Mac's when it exists, because
  // that is the machine a session runs on); these are the per-side facts the
  // cell prints, so neither is presented as the other.
  //
  // The native number is shown only when the handshake actually connected —
  // an unreachable probe's `latency_ms` is not a latency — which is the same
  // condition the single-number cell used before.
  const nativeNumber = reachable ? result?.latency_ms : undefined;
  // Only a SOCKS5-probeable row HAS a "this Mac" side at all: no native
  // handshake is ever run against a tunnel or an HTTP proxy (handleTest routes
  // those to the endpoint check), so naming this Mac on those rows would invent
  // a measurement nobody attempted.
  const hasNativeSide = isSocks5Probeable(p.scheme);
  // The pill's words follow the number the pill is judging. A server number
  // whose machine was never reported keeps the modest "from the server" (its
  // hover text is SERVER_LATENCY_TITLE, which says exactly that much) rather
  // than claiming the Mac that runs the profiles.
  const latOriginPhrase = fromServer ? (vantage?.label ?? 'from the server') : NATIVE_VANTAGE_LABEL;
  const latOriginTitle = fromServer ? vantageTitle : PROBE_ORIGIN_TITLE;
  // (P2) — each line's hover carries the date of ITS OWN number. `testedAt` is
  // the native verdict's time on a SOCKS5 row (lib's `serverProbeStamps` keys
  // endpoint rows only, by design) and a fleet number survives a native
  // re-test, so one date beside two measurements dates at most one of them.
  const serverLineTitle =
    serverProbeAtMs !== undefined
      ? `${vantageTitle} Measured ${new Date(serverProbeAtMs).toLocaleString()}.`
      : vantageTitle;
  const nativeLineTitle =
    testedAt !== undefined
      ? `${PROBE_ORIGIN_TITLE} Measured ${new Date(testedAt).toLocaleString()}.`
      : PROBE_ORIGIN_TITLE;
  // (P2) — WHY a side has no number, from state this row already holds. The
  // single "has not measured this proxy yet" sentence was FALSE for two of the
  // four states it covered (see the constants).
  const serverMissing: { word: string; title: string } | null =
    serverLatencyMs !== undefined
      ? null
      : vpnFailure !== undefined
        ? { word: SERVER_FAILED_WORD, title: `${SERVER_FAILED_TITLE_PREFIX} ${vpnFailure}` }
        : serverVantage !== undefined
          ? { word: SERVER_NO_TIMING_WORD, title: SERVER_NO_TIMING_TITLE }
          : noFleetMac
            ? { word: NO_TEST_MAC_WORD, title: NO_TEST_MAC_LATENCY_TITLE }
            : { word: NO_SERVER_NUMBER_WORD, title: NO_SERVER_NUMBER_TITLE };
  // …and nothing at all when the row's own notice already names the absent
  // vantage (no API key, not storable): SOCKS5_TEST_NO_API_KEY_NOTICE says
  // "Tested from this Mac only… from the test Mac too — that is where … the
  // fleet latency are measured", so the label would be a second copy of a
  // sentence the customer has read, on every row, in the widest column.
  const serverMissingShown = hasNativeSide && vpnNotice === undefined ? serverMissing : null;
  const nativeMissing: { word: string; title: string } | null =
    nativeNumber !== undefined
      ? null
      : result === undefined
        ? { word: NO_NATIVE_NUMBER_WORD, title: NO_NATIVE_NUMBER_TITLE }
        : !reachable
          ? { word: NATIVE_NO_CONNECT_WORD, title: NATIVE_NO_CONNECT_TITLE }
          : { word: NATIVE_NO_TIMING_WORD, title: NATIVE_NO_TIMING_TITLE };
  const exitIp = exit?.ip;
  const exitCountry = exit?.country ?? null;
  const failed = result !== undefined && !healthy;

  return (
    <tr
      onClick={(e) => {
        // #4 — a row click toggles selection; shift+click selects the range from the
        // last-clicked row. Clicks on real controls (buttons, the checkbox, links,
        // the row's inputs) keep their own behaviour, so this never eats a Test/Edit.
        if (
          (e.target as HTMLElement).closest(
            'button, input, a, select, textarea, [contenteditable="true"]',
          )
        ) {
          return;
        }
        onToggle(e.shiftKey);
      }}
      className={`cursor-pointer select-none border-b border-surface-divider/40 transition-colors last:border-b-0 hover:bg-surface-inset/50 ${
        selected ? 'bg-[rgb(var(--accent-rgb)/0.07)]' : ''
      }`}
    >
      <td
        className={`px-3 py-2 ${failed ? 'shadow-[inset_3px_0_0_rgb(var(--status-error-rgb))]' : ''}`}
      >
        <input
          type="checkbox"
          aria-label={`Select ${p.label}`}
          checked={selected}
          // (q) Item 4 — the modifier SURVIVES a shift+click on the checkbox
          // itself: the row handler returns early for a click on the input, and
          // this handler used to call `onToggle(false)`, so shift-clicking A's
          // box then E's box selected only A and E; the range worked only when
          // the shift-click landed on the row body. React drives a checkbox's
          // onChange from the native click, so its modifier keys are here.
          onChange={(e) => onToggle((e.nativeEvent as MouseEvent).shiftKey === true)}
          className="h-4 w-4 cursor-pointer accent-[rgb(var(--accent-rgb))]"
        />
      </td>

      <td className="max-w-[190px] px-3 py-2">
        <div className="truncate font-semibold tracking-tight text-ink-primary">{p.label}</div>
        {p.username !== null && p.username.length > 0 && (
          <div className="mono truncate text-[10px] text-ink-muted">{p.username}</div>
        )}
      </td>

      <td className="whitespace-nowrap px-3 py-2 text-ink-secondary">
        <span aria-hidden="true">{schemeLabel(p.scheme).icon}</span> {schemeLabel(p.scheme).text}
      </td>

      <td className="mono whitespace-nowrap px-3 py-2 text-[11px] text-ink-muted">
        {p.host}:{p.port}
      </td>

      <td className="whitespace-nowrap px-3 py-2">
        <span aria-hidden="true" className="mr-1.5">
          {exitCountry !== null ? flagEmoji(exitCountry) : '\ud83c\udf0d'}
        </span>
        {/* ⚠️ V-857 — THREE states, not two. `undefined` = never probed;
            `null` = probed and the echo round-trip did not complete through this
            proxy; an ip = a real measured exit. Collapsing null into undefined
            tells a customer who just ran a test to "run Test", sending them round
            the same loop. The null wording names the PROBE outcome and never our
            release schedule — pointing at a release tells them to wait instead of
            to look. */}
        {exitIp !== undefined ? (
          <span className="mono text-[11px] text-ink-secondary">{exitIp}</span>
        ) : exit === null ? (
          <span className="text-[10.5px] text-ink-muted" title={EXIT_GEO_UNAVAILABLE_TITLE}>
            {EXIT_GEO_UNAVAILABLE}
          </span>
        ) : isVpnScheme(p.scheme) ? (
          // (l) #3 / #10 — a VPN row with no exit MEASURED: says why and names
          // the check by its one name; the profile card reads the same
          // constant, so grid and card agree about the same proxy.
          <span className="italic text-[10.5px] text-ink-muted" title={VPN_NO_EXIT_YET_TITLE}>
            {VPN_NO_EXIT_YET}
          </span>
        ) : isSocks5Probeable(p.scheme) ? (
          <span className="italic text-[10.5px] text-ink-muted">run Test for exit IP</span>
        ) : (
          // (l) #2 — an HTTP row: no check here measures an exit, so no prompt
          // promising one. The proxy itself is verified when a session launches.
          <span className="italic text-[10.5px] text-ink-muted">{HTTP_VERIFIED_AT_LAUNCH}</span>
        )}
        {/* #6 — exit LOCATION (city, region). The flag already conveys the country;
            city/region is the incremental detail, shown when the probe captured it.
            Was not rendered anywhere on this tab before. */}
        {exit?.city != null && exit.city.length > 0 && (
          <div
            data-component="exit-location"
            className="mt-0.5 max-w-[180px] truncate text-[10px] font-normal text-ink-muted"
            title={[exit.city, exit.region]
              .filter((s): s is string => typeof s === 'string' && s.length > 0)
              .join(', ')}
          >
            {[exit.city, exit.region]
              .filter((s): s is string => typeof s === 'string' && s.length > 0)
              .join(', ')}
          </div>
        )}
      </td>

      <td className="whitespace-nowrap px-3 py-2 text-right">
        {/* (b) — a VPN row has no native `result`; its number is the fleet's, and
            it shows on the fleet's say-so (fromServer), not on a handshake that
            never ran.

            (P2) — BOTH sides, stacked and each labelled: the machine that runs
            the profile on top, this computer under it. When one side has no
            number, its own line says which side is missing, so the other is
            never read as the whole answer. A row with no number on either side
            is unchanged ('down' after a failed handshake, else the em dash). */}
        {serverLatencyMs !== undefined || (hasNativeSide && nativeNumber !== undefined) ? (
          <div className="inline-flex flex-col items-end gap-0.5">
            {serverLatencyMs !== undefined ? (
              <span
                className="inline-flex items-center justify-end gap-1.5"
                title={serverLineTitle}
                data-latency-vantage={serverVantage?.measuredFrom ?? 'server'}
              >
                <span className="mono tabular-nums text-ink-secondary">{serverLatencyMs}ms</span>
                {/* T-1 — say WHERE a server-measured number came from: a test Mac
                    (the kind that runs the profile) or, when none was free, the
                    server itself — the fallback is visible, never silent. */}
                <span className="rounded-sm bg-surface-inset px-1 text-[8px] font-semibold uppercase tracking-wide text-ink-muted">
                  {vantageText}
                </span>
                <LatencyMeter ms={serverLatencyMs} />
              </span>
            ) : (
              serverMissingShown !== null && (
                <span
                  className="inline-flex items-center justify-end gap-1.5 opacity-60"
                  title={serverMissingShown.title}
                  data-latency-missing="server"
                >
                  {/* The state word sits where the NUMBER would, at the cell's
                      own size — readable, and narrower than the measured line
                      above it, so a missing side never widens the column. The
                      8px chip is left holding a short machine name, which is
                      what it held before this row printed two sides. */}
                  <span className="mono text-ink-muted">{serverMissingShown.word}</span>
                  <span className="rounded-sm bg-surface-inset px-1 text-[8px] font-semibold uppercase tracking-wide text-ink-muted">
                    {TEST_MAC_CHIP_LABEL}
                  </span>
                </span>
              )
            )}
            {hasNativeSide &&
              (nativeNumber !== undefined ? (
                <span
                  className="inline-flex items-center justify-end gap-1.5"
                  title={nativeLineTitle}
                  data-latency-vantage="this_mac"
                >
                  <span className="mono tabular-nums text-ink-secondary">{nativeNumber}ms</span>
                  <span className="rounded-sm bg-surface-inset px-1 text-[8px] font-semibold uppercase tracking-wide text-ink-muted">
                    {NATIVE_VANTAGE_LABEL}
                  </span>
                  <LatencyMeter ms={nativeNumber} />
                </span>
              ) : (
                nativeMissing !== null && (
                  <span
                    className="inline-flex items-center justify-end gap-1.5 opacity-60"
                    title={nativeMissing.title}
                    data-latency-missing="this_mac"
                  >
                    <span className="mono text-ink-muted">{nativeMissing.word}</span>
                    <span className="rounded-sm bg-surface-inset px-1 text-[8px] font-semibold uppercase tracking-wide text-ink-muted">
                      {NATIVE_CHIP_LABEL}
                    </span>
                  </span>
                )
              ))}
          </div>
        ) : (
          <span className="mono text-ink-muted opacity-60">
            {result !== undefined ? 'down' : '\u2014'}
          </span>
        )}
      </td>

      <td className="px-3 py-2">
        {isVpnScheme(p.scheme) ? (
          // (h) — a VPN row has no SOCKS5 `result` (its placeholder is deleted
          // from testResults by design), so the chip set below was unreachable
          // and the cell read a permanent "untested" naming a Test button the
          // row does not have. A tunnel carries UDP; the one protocol probed
          // through it is QUIC (the fleet's relay leg, or a live session's h3).
          <VpnQuicChip quicMeasured={quicMeasured} quicProbe={quicProbe} noFleetMac={noFleetMac} />
        ) : result !== undefined && reachable ? (
          <ProxyCapabilityChips
            result={result}
            quicMeasured={quicMeasured}
            quicProbe={quicProbe}
            size="xs"
          />
        ) : (
          <span
            className="rounded-sm bg-surface-divider/60 px-1 py-px text-[9px] text-ink-muted"
            title={
              result !== undefined
                ? 'Exit down on last test — no protocols verified.'
                : 'Never probed — click Test to check egress protocols.'
            }
          >
            {result !== undefined ? 'no egress' : 'untested'}
          </span>
        )}
      </td>

      <td className="px-3 py-2">
        {/* (o) O4 — "measuring" is a claim about work in progress, and the ONLY thing
            that measures a proxy's stack is the Test this row's button starts (there
            is no scheduler behind it). So the measuring state is rendered from THIS
            client's in-flight probe — `testing` — and never from an absent value; a
            row nobody has tested says "not measured", which is what is true of it.

            ⛔ (o) 2026-09-11 follow-up — and NOT EVEN THEN on a VPN row. `testing` is
            set for the "Check VPN" button too, but the control plane fingerprints no
            tunnel: `'host' in resolved` is false for every openvpn/wireguard wire, so
            the observer is never consulted and the reply says `vpn_tunnel`. The chip
            claimed a stack measurement was running for the whole 30-45 s fleet wait
            and then contradicted itself. A VPN row states its cause from its own
            SCHEME — true before the first Check, while one runs, and after a tunnel
            that failed (states in which no reply carries the cause at all). */}
        <ProxyOsChip
          fingerprint={
            osFingerprint ??
            (isVpnScheme(p.scheme)
              ? VPN_TUNNEL_OS_FINGERPRINT
              : testing
                ? OS_FINGERPRINT_MEASURING
                : undefined)
          }
          size="xs"
        />
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-col items-start gap-0.5">
          {isSocks5Probeable(p.scheme) ? (
            <HealthPill
              result={result}
              healthy={healthy}
              latGood={latGood}
              originPhrase={latOriginPhrase}
              originTitle={latOriginTitle}
              fleetFailure={vpnFailure}
            />
          ) : (
            <EndpointHealthPill
              endpoint={endpointResult}
              tunnelUp={serverVantage?.measuredFrom === 'fleet'}
              noLatency={!fromServer}
              latGood={latGood}
              failure={vpnFailure}
              vantageTitle={vantageTitle}
            />
          )}
          {/* (P2) — NOT gated on the scheme any more. A SOCKS5 row's fleet
              failure was stored nowhere and rendered nowhere, so the only thing
              the grid said about the session-predicting vantage was a green
              pill and a false "has not measured this proxy yet". This is the
              sentence the pill's own comment promised was "beside this pill". */}
          {vpnFailure !== undefined && (
            <span
              className="max-w-[240px] whitespace-normal break-words text-[10px] leading-tight text-status-error"
              title={vpnFailure}
            >
              {vpnFailure}
            </span>
          )}
          {/* (h) finding 3 — the notice sits beside a standing failure too: the
              failure is the LAST verdict (the cache's), the notice is what THIS
              check did not do; hiding one behind the other lost either. */}
          {/* (q) Item 12-memory (A) — on a SOCKS5 row too: the notice is what
              the Test did NOT do (no key / not storable → no fleet leg), which
              the native pill alone cannot say. */}
          {vpnNotice !== undefined && (
            <span
              data-component="proxy-row-notice"
              className="max-w-[240px] whitespace-normal break-words text-[10px] leading-tight text-ink-muted"
              title={vpnNotice}
            >
              {vpnNotice}
            </span>
          )}
          {failed && result.message.length > 0 && (
            <span
              className="max-w-[240px] whitespace-normal break-words text-[10px] leading-tight text-status-error"
              title={result.message}
            >
              {result.message}
            </span>
          )}
        </div>
      </td>

      <td className="whitespace-nowrap px-3 py-2 text-[10.5px] text-ink-muted">
        {(result !== undefined || endpointResult !== undefined) && testedAt !== undefined ? (
          <RelativeTime iso={new Date(testedAt).toISOString()} tooltipPrefix="Tested" />
        ) : (
          <RelativeTime iso={p.createdAt} tooltipPrefix="Added" />
        )}
      </td>

      <td className="whitespace-nowrap px-3 py-2 text-right">
        <div className="inline-flex items-center gap-1.5">
          {/* The row Test runs a SOCKS5 probe, which is meaningless for a
              VPN/HTTP endpoint (it always read "unreachable"). Only offer it for
              a SOCKS5 proxy; otherwise say where it IS verified. */}
          {isSocks5Probeable(p.scheme) ? (
            <button
              type="button"
              className="rounded-md border border-surface-divider px-2 py-1 text-[11px] text-ink-secondary transition-colors hover:border-ink-muted hover:text-ink-primary disabled:opacity-50"
              onClick={onTest}
              disabled={testing || testingAll}
            >
              {testing ? 'Testing…' : result !== undefined ? RETEST_ACTION : 'Test'}
            </button>
          ) : (
            <div className="inline-flex items-center gap-1.5">
              {/* N4 — a VPN row has no SOCKS5 probe, but its endpoint host CAN be
                  DNS-resolved on demand (endpoint_resolve); the tunnel itself still
                  verifies at launch. Mirrors the in-form endpoint check. */}
              {/* (l) #2 / #10 — the button is named for what the row's check
                  DOES: a VPN row's "Check VPN" (the card's menu says the same)
                  brings the tunnel up on the test Mac; an HTTP row's "Check
                  endpoint" is the DNS pre-flight alone, and its title must not
                  promise a tunnel test or an exit the code never runs for it. */}
              <button
                type="button"
                className="rounded-md border border-surface-divider px-2 py-1 text-[11px] text-ink-secondary transition-colors hover:border-ink-muted hover:text-ink-primary disabled:opacity-50"
                onClick={onCheckEndpoint}
                disabled={testing || testingAll}
                title={isVpnScheme(p.scheme) ? CHECK_VPN_TITLE : CHECK_ENDPOINT_TITLE}
              >
                {testing
                  ? 'Checking…'
                  : endpointResult !== undefined
                    ? RECHECK_ACTION
                    : isVpnScheme(p.scheme)
                      ? CHECK_VPN_ACTION
                      : CHECK_ENDPOINT_ACTION}
              </button>
              {endpointResult !== undefined && (
                <span
                  className={`text-[10px] ${endpointResult.resolved ? 'text-status-ready' : 'text-status-error'}`}
                  title={endpointResult.message}
                >
                  {endpointResult.resolved ? `endpoint ✓ ${endpointResult.ip}` : 'endpoint ✗'}
                </span>
              )}
            </div>
          )}
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[11px] text-ink-muted transition-colors hover:text-ink-primary"
            onClick={onEdit}
          >
            Edit
          </button>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[11px] text-ink-muted transition-colors hover:text-status-error disabled:opacity-60"
            onClick={onRemove}
            disabled={busy}
          >
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </td>
    </tr>
  );
}

/**
 * (P2) — the 30px meter beside ONE number, coloured by THAT number.
 *
 * Each side of the cell gets its own: a 180ms measured on the Mac that runs the
 * profile must not be painted green by a fast local handshake, and a slow
 * tunnel must not redden the local number. The single meter this replaces was
 * coloured by the MERGED value, so whichever number it sat beside, it was
 * sometimes describing the other one.
 */
function LatencyMeter({ ms }: { ms: number }): JSX.Element {
  const fill = ms > 0 ? Math.max(6, Math.min(100, (ms / 250) * 100)) : 0;
  return (
    <span className="inline-block h-1 w-[30px] overflow-hidden rounded-[2px] bg-surface-divider">
      <span
        className="block h-full rounded-[2px]"
        style={{
          width: `${fill.toFixed(0)}%`,
          background:
            ms <= LATENCY_GOOD_MS ? 'rgb(var(--status-ready-rgb))' : 'rgb(var(--status-busy-rgb))',
        }}
      />
    </span>
  );
}

// Health pill — the single at-a-glance verdict for a proxy card. Quiet
// 'untested' before the first probe; ready/error tone after.
function HealthPill({
  result,
  healthy,
  latGood,
  originPhrase,
  originTitle,
  fleetFailure,
}: {
  result: ProxyTestResult | undefined;
  healthy: boolean;
  latGood: boolean;
  /** (P2) — the words for the machine whose number `latGood` describes:
   *  'from this Mac' for the native handshake, else the label of the machine
   *  the server reported. The pill used to hard-code the native phrase while
   *  `latGood` came from the SERVER number when there was one, so a 180ms
   *  measured on the Mac that runs the profile read "slow from this Mac" under
   *  a "measured from your computer" hover. */
  originPhrase: string;
  originTitle: string;
  /** (P2) — the sentence the Mac that RUNS the profile returned when it could
   *  not use this proxy. It outranks every native verdict below: the session
   *  runs there, not here, and a proxy that admits this laptop's IP and nobody
   *  else's is exactly the case the two vantages exist to separate. */
  fleetFailure?: string;
}): JSX.Element {
  if (fleetFailure !== undefined) {
    return (
      <span
        className="shrink-0 rounded-[5px] bg-status-error/12 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-status-error"
        title={fleetFailure}
      >
        {FLEET_FAILED_PILL}
      </span>
    );
  }
  if (result === undefined) {
    return (
      <span className="shrink-0 rounded-[5px] bg-surface-inset px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ink-muted">
        untested
      </span>
    );
  }
  if (!healthy) {
    // (P2) — these three take no origin WORDS: each is a fact about the native
    // handshake only (`result`), which is always this Mac's. They do take its
    // hover, because the latency cell beside them may be showing the test Mac's
    // number and a bare red verdict with no provenance reads as a claim about
    // the proxy everywhere. (The earlier comment here excused the omission by
    // pointing at a failure sentence that was gated off for this scheme and
    // whose state was never written — a cached claim; both are fixed above.)
    const label = !result.reachable ? 'unreachable' : !result.auth_ok ? 'auth fail' : 'no route';
    return (
      <span
        className="shrink-0 rounded-[5px] bg-status-error/12 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-status-error"
        title={PROBE_ORIGIN_TITLE}
      >
        {label}
      </span>
    );
  }
  return (
    <span
      className={`shrink-0 rounded-[5px] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
        latGood ? 'bg-status-ready/12 text-status-ready' : 'bg-status-busy/14 text-status-busy'
      }`}
      title={originTitle}
    >
      {`${latGood ? 'healthy' : 'slow'} ${originPhrase}`}
    </span>
  );
}

/**
 * (b) — the health pill of a VPN/HTTP row, which has no SOCKS5 verdict to
 * describe. Its evidence is the endpoint pre-flight and, for a VPN row stored
 * on the account, the fleet test that followed it: `tunnel up` only when a
 * fleet Mac brought the tunnel up and measured through it; `endpoint ok` when
 * only the DNS resolve has run; `tunnel down` when the fleet said so. Never
 * "healthy from this Mac" — this Mac never made a connection.
 */
/** (o) O5 — the sentence for a QUIC verdict that is missing because the FLEET was
 *  unavailable, not because the tunnel failed anything. It names the cause and the
 *  machine that would measure it, and it does NOT tell the customer to press a button
 *  that cannot produce a value while every Mac is busy. */
const NO_TEST_MAC_QUIC_HINT =
  'Not measured yet — no test Mac was free; QUIC is measured from the Mac that runs your profiles.';

/**
 * (h) — the Protocols cell of a VPN row: ONE QUIC chip, strongest evidence
 * first (a live session's HTTP/3 verdict outranks the fleet relay leg), and
 * an honest "not measured" that names the button this row HAS. Never a WebRTC
 * or UDP chip: UDP is not a probed grant on a tunnel — the tunnel carries it.
 */
function VpnQuicChip({
  quicMeasured,
  quicProbe,
  noFleetMac,
}: {
  quicMeasured: MeasuredQuic | undefined;
  quicProbe: boolean | undefined;
  /** (o) O5 — the LAST server test of this row reached no fleet Mac at all
   *  (`not_run: 'no_node'` — none free, the dispatch never landed, or the
   *  deployment has none). The reply then carries no QUIC leg, because only a
   *  fleet Mac can run one through a tunnel: the absence below is about the
   *  FLEET, not about this tunnel. False = either a Mac answered, or no server
   *  test has landed on this row yet.
   *
   *  ⛔ NOT derived from the vantage. `measured_from: 'control_plane'` rides on
   *  the fleet-miss reply, but that reply is `ok:false` + `not_run`, and the view
   *  writes a `serverVantage` only from an `ok` outcome — so for a VPN row, which
   *  the control plane never measures, the vantage is 'fleet' or undefined and a
   *  `vantage === 'control_plane'` test was dead on arrival. */
  noFleetMac: boolean;
}): JSX.Element {
  const verdict: { ok: boolean; hint: string } | null =
    quicMeasured === 'h3'
      ? { ok: true, hint: 'HTTP/3 verified in a live session through this tunnel.' }
      : quicMeasured === 'h2-only'
        ? {
            ok: false,
            hint: 'No HTTP/3 — a live session used HTTP/2 over TCP through this tunnel.',
          }
        : quicProbe === true
          ? {
              ok: true,
              hint: 'QUIC relays through this tunnel — measured from the test Mac, the kind that runs your profiles.',
            }
          : quicProbe === false
            ? {
                ok: false,
                hint: 'QUIC does not relay through this tunnel — measured from the test Mac. HTTP/3 falls back to HTTP/2 over TCP.',
              }
            : null;
  if (verdict === null) {
    // (o) O5 — absence has two unlike causes and one of them is NOT about this row.
    // When the last test found no fleet Mac (busy, or a deployment with none), the
    // reply carried no QUIC leg at all, and no number of presses of Check can add one
    // until a Mac frees up. Telling the customer to press it again is the loop that
    // reads as "it's not detecting my QUIC". Name the cause.
    return (
      <span
        className="rounded-sm bg-surface-divider/60 px-1 py-px text-[9px] text-ink-muted"
        data-component="vpn-quic-chip"
        data-ok="unmeasured"
        data-unmeasured={noFleetMac ? 'no_fleet_mac' : 'never_tested'}
        title={
          noFleetMac
            ? NO_TEST_MAC_QUIC_HINT
            : `Not measured yet — run ${CHECK_VPN_ACTION}: the test Mac brings the tunnel up and probes QUIC through it.`
        }
      >
        QUIC untested
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-sm px-1 py-px text-[9px] ${
        verdict.ok ? 'bg-status-ready/15 text-status-ready' : 'bg-surface-inset text-ink-muted'
      }`}
      data-component="vpn-quic-chip"
      data-ok={verdict.ok ? 'true' : 'false'}
      title={verdict.hint}
    >
      <span aria-hidden="true">{verdict.ok ? '✓' : '⤵'}</span>
      QUIC
    </span>
  );
}

function EndpointHealthPill({
  endpoint,
  tunnelUp,
  noLatency,
  latGood,
  failure,
  vantageTitle,
}: {
  endpoint: EndpointResolveResult | undefined;
  tunnelUp: boolean;
  /** (i) I4 — beside `tunnelUp`: the fleet Mac brought the tunnel up but
   *  reported no latency; the pill says so instead of reading "endpoint ok"
   *  under an exit and a QUIC chip that same reply put on the row. */
  noLatency: boolean;
  latGood: boolean;
  failure: string | undefined;
  vantageTitle: string;
}): JSX.Element {
  const base = 'shrink-0 rounded-[5px] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide';
  if (failure !== undefined) {
    return (
      <span className={`${base} bg-status-error/12 text-status-error`} title={failure}>
        tunnel down
      </span>
    );
  }
  if (tunnelUp && noLatency) {
    return (
      <span
        className={`${base} bg-status-ready/12 text-status-ready`}
        title={VPN_TUNNEL_UP_NO_LATENCY_TITLE}
      >
        tunnel up · no latency
      </span>
    );
  }
  if (tunnelUp) {
    return (
      <span
        className={`${base} ${latGood ? 'bg-status-ready/12 text-status-ready' : 'bg-status-busy/14 text-status-busy'}`}
        title={vantageTitle}
      >
        {latGood ? 'tunnel up' : 'tunnel up · slow'}
      </span>
    );
  }
  if (endpoint === undefined) {
    return <span className={`${base} bg-surface-inset text-ink-muted`}>untested</span>;
  }
  if (!endpoint.resolved) {
    return (
      <span className={`${base} bg-status-error/12 text-status-error`} title={endpoint.message}>
        unresolved
      </span>
    );
  }
  return (
    <span className={`${base} bg-surface-inset text-ink-secondary`} title={ENDPOINT_OK_TITLE}>
      {ENDPOINT_OK_PILL}
    </span>
  );
}

/**
 * (n) N7 — the wg0.conf LINE behind each field name the server's schema reports.
 *
 * `WireguardRefusal.field` is the schema path (`allowed_ips`, `peer_public_key`, …) —
 * the API's wire name, which appears NOWHERE in the file the customer is looking at.
 * `Address`, `DNS` and `Endpoint` differ only in case, so their sentences already point
 * at a findable line; the snake_case ones do not, and `[Peer] PublicKey` is not even the
 * same word.
 */
const WG_CONF_LINE_BY_FIELD: Record<string, string> = {
  private_key: 'PrivateKey',
  peer_public_key: '[Peer] PublicKey',
  preshared_key: 'PresharedKey',
  endpoint: 'Endpoint',
  allowed_ips: 'AllowedIPs',
  address: 'Address',
  dns: 'DNS',
};

/** zod's DEFAULT `.max()` sentence, which names no field at all. api-types declares
 *  `.max()` before `.regex()` on allowed_ips/address/dns, so for an over-long value this
 *  is `issues[0]` and it was reaching the customer verbatim. */
const ZOD_TOO_LONG_RE = /^String must contain at most (\d+) character\(s\)\.?$/;

// The one-line "where and why" of a VPN refusal, for the submit hint and the Save
// tooltip. An OVPN refusal points at a LINE of the pasted blob (the finder's own number).
// A WireGuard refusal names a FIELD, which (n) N7 translates to the wg0.conf line the
// customer can actually search for — leaving alone the sentences that already open with
// it, so the server's own wording still reaches them wherever it is findable.
function vpnRefusalMessage(r: OpenvpnRefusal | WireguardRefusal): string {
  if ('line' in r) return `Line ${r.line.toString()}: ${r.reason}`;
  const line = WG_CONF_LINE_BY_FIELD[r.field];
  if (line === undefined) return r.reason;
  // Already points at the line ("address must be …", "PresharedKey is not a 44-char …").
  if (r.reason.toLowerCase().startsWith(line.toLowerCase())) return r.reason;
  // A sentence that opens with the WIRE name: swap in the line name, keep the rest.
  if (r.reason.startsWith(`${r.field} `)) return `${line}${r.reason.slice(r.field.length)}`;
  // A sentence that names nothing — zod's length default. Say the line AND the cap
  // rather than handing over "String must contain at most 1024 character(s)".
  const tooLong = ZOD_TOO_LONG_RE.exec(r.reason);
  if (tooLong !== null) return `${line} is too long — at most ${tooLong[1] ?? ''} characters.`;
  return `${line}: ${r.reason}`;
}

/** (n) N4 — what the wg0.conf box says while a row already HAS a saved config: the box
 *  is a REPLACE field, not the config. Shown as the placeholder, never as its value. */
const WG_SAVED_PLACEHOLDER =
  'Paste a new wg0.conf here to replace the saved one — leave this empty to keep it.';
/** (n) N4 — one keystroke in that box is not a configuration, so the parser's
 *  first-field complaint would name a line the text never had. */
const WG_REPLACE_INCOMPLETE_HINT =
  'That is not a complete wg0.conf yet — the saved WireGuard config is kept until you paste one.';
/** (n) N4 — appended to a real parse refusal while a saved config stands, so the customer
 *  knows the bad text did NOT wipe what the row already holds. */
const WG_SAVED_KEPT_SUFFIX =
  ' — the saved WireGuard config is kept until a complete wg0.conf is pasted.';

/** (n) N4 — is this text even an ATTEMPT at a wg0.conf? A single character in the replace
 *  box is not, and reporting "PrivateKey is not a 44-char base64 key" about it sends the
 *  customer hunting for a field they never typed. A real conf attempt — a section header
 *  or a PrivateKey line — gets the parser's own specific reason. */
function looksLikeWireGuardConf(text: string): boolean {
  return /^\s*\[\s*(interface|peer)\s*\]/im.test(text) || /^\s*privatekey\s*=/im.test(text);
}

/**
 * (n) N9 — the paste-time hint for either VPN editor.
 *
 * It used to be one muted <span> for both outcomes: a refusal ("PresharedKey is not a
 * 44-char base64 key …") rendered in exactly the same small grey text as the "✓ endpoint
 * …" confirmation, with no role — so a screen reader never announced the refusal at all,
 * and a sighted customer had to READ a success and a failure to tell them apart. A
 * refusal is an alert (announced, and coloured like every other error in this form); the
 * confirmation is a quiet status.
 */
function VpnHint({ hint, isError }: { hint: string; isError: boolean }): JSX.Element {
  return (
    <span
      data-component="vpn-paste-hint"
      role={isError ? 'alert' : 'status'}
      className={`mt-1 text-2xs ${isError ? 'text-status-error' : 'text-ink-muted'}`}
    >
      {hint}
    </span>
  );
}

export function ProxyForm({
  initial,
  mode,
  saving = false,
  onCancel,
  onSave,
  compact = false,
}: {
  initial: ProxyDraft;
  mode: 'add' | 'edit';
  saving?: boolean;
  onCancel: () => void;
  onSave: (d: ProxyDraft) => void | Promise<void>;
  /** T-21 — embedded inside a host that already owns the surrounding card
   *  (the New-Profile / Edit-Profile / first-run proxy panels). Drops this
   *  form's own card chrome + header and tightens spacing so it reads as one
   *  block inside the host, without changing any field, validation, or the
   *  onSave contract. Default false = the standalone Proxies-tab appearance. */
  compact?: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState<ProxyDraft>(initial);
  const [validation, setValidation] = useState<DraftValidation>({ ok: true, errors: {} });
  const [pasteVal, setPasteVal] = useState('');
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  // OVPN/WG — the wg0.conf textarea text (the parsed WG block doesn't retain
  // the raw conf; OpenVPN keeps its blob in draft.openvpn.config_blob) + a
  // parse-feedback hint.
  // (n) N4 — EMPTY, never the old '(saved WireGuard config)' sentinel. That sentinel was
  // the textarea's VALUE, so the box read as if that sentence were the configuration, and
  // one keystroke re-parsed it: the hint said "PrivateKey is not a 44-char base64 key"
  // about text the customer never entered, `draft.wireguard` was dropped, Save went dead
  // ("Paste a valid wg0.conf configuration.") and the only ways out were Cancel or
  // re-pasting the whole conf. The box is a REPLACE field now — empty means keep what is
  // saved, which is what `savedWireguard` below holds.
  const [wgText, setWgText] = useState('');
  /** (n) N4 — the block this row already has (edit mode). A failed parse of replacement
   *  text must not delete it: the customer edited the REPLACEMENT, not the saved config.
   *  Undefined in add mode, where a failed parse correctly leaves nothing to save. */
  const savedWireguard = initial.wireguard;
  const [vpnHint, setVpnHint] = useState<string | null>(null);
  /** (n) N9 — every hint this form sets is a PROBLEM except the paste-time confirmation,
   *  which is the only one that opens with '✓'. Derived from the hint itself rather than
   *  tracked beside it at a dozen setVpnHint sites, where the two would drift. */
  const vpnHintIsError = vpnHint !== null && !vpnHint.startsWith('✓');
  // #2 — when a pasted OVPN config has lines the server will refuse (e.g. a bare
  // `script-security 2` with no script directives), hold the auto-fixed blob here so
  // the hint can offer a one-click "Remove unsupported lines". Null = nothing to fix.
  const [vpnFixable, setVpnFixable] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const locked = saving || submitting;
  // N1 (owner: OVPN "still won't launch/save") + WG parity — the VPN config the control
  // plane will REFUSE. OpenVPN: a script directive / `script-security >= 2` or an
  // unresolvable inline cert/key file reference (webhook-target-guard, enforced at proxy
  // create/update). WireGuard: the built block fails the server's own
  // WireGuardProxyConfigSchema (a mask-less Address, a DNS search domain, …), or the raw
  // conf carries a PresharedKey line the fleet cannot honour. Both computed with the SAME
  // shared api-types code the server enforces, on the CURRENT draft, so the form blocks
  // exactly what a save would 400 on instead of a round-trip failure. null = acceptable;
  // an OVPN `.fixable` carries the one-click strip.
  const vpnRefusal = useMemo(
    () =>
      draft.scheme === 'wireguard'
        ? wireguardRefusal(draft.scheme, draft.wireguard, wgText)
        : openvpnRefusal(draft.scheme, draft.openvpn?.config_blob ?? ''),
    [draft.scheme, draft.wireguard, draft.openvpn?.config_blob, wgText],
  );
  const formRef = useRef<HTMLFormElement>(null);

  // React 18's DOM types do not expose the standard `inert` attribute yet.
  // Apply its presence imperatively so every draft control (including file
  // inputs and a field that retained keyboard focus) is genuinely non-interactive
  // while the save settles, without re-indenting the whole form in a fieldset.
  useEffect(() => {
    const form = formRef.current;
    if (form === null) return;
    if (locked) form.setAttribute('inert', '');
    else form.removeAttribute('inert');
  }, [locked]);

  const scheme = draft.scheme ?? 'socks5';
  const isVpn = scheme === 'openvpn' || scheme === 'wireguard';
  // Advice, recomputed as the customer types — unlike `validation`, which is
  // set on submit/test. A local or allowlist-only proxy saves fine and fails
  // when the profile runs on Driftstack's servers; the moment to say so is
  // while the host is being entered, not after the launch that cannot use it.
  const liveWarnings = validateDraft(draft).warnings;
  // The credentials note is about THE proxy being described, so it waits for a
  // host: on a blank form it would be a warning about nothing.
  const showAuthWarning = draft.host.trim().length > 0;

  function setField<K extends keyof ProxyDraft>(key: K, value: ProxyDraft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  // Switch proxy type — clear the now-irrelevant fields so a half-typed socks5
  // password can't ride along on a VPN proxy (and vice versa).
  //
  // (n) N1 — and so the OTHER scheme's VPN block can't either. Switching to a VPN
  // scheme used to clear only username/password, so a wg0.conf pasted before the
  // switch stayed in `draft.wireguard` while the customer pasted an .ovpn: Add
  // persisted BOTH blocks (lib/proxies addProxy has no scheme check) and every
  // launch through the row then died on the control plane's `.strict()` per-scheme
  // branch — "Unrecognized key(s) in object: 'wireguard'" — with no way to see why
  // from the form. The draft carries exactly ONE block now: the one that belongs to
  // `next`. Same retention also made WireGuard → OpenVPN → WireGuard show an EMPTY
  // wg0.conf box over a still-saveable earlier paste.
  function handleSchemeChange(next: NonNullable<ProxyDraft['scheme']>): void {
    setVpnHint(null);
    setVpnFixable(null);
    setWgText('');
    setDraft((d) => ({
      ...d,
      scheme: next,
      ...(next === 'openvpn' || next === 'wireguard' ? { username: null, password: null } : {}),
      // Coming BACK to the row's own scheme restores what it already had saved —
      // the box is empty again, and (n) N4's rule is that an empty box means "keep
      // the saved config". In add mode there is nothing saved, so both stay dropped.
      openvpn: next === 'openvpn' ? (d.openvpn ?? initial.openvpn) : undefined,
      wireguard: next === 'wireguard' ? (d.wireguard ?? savedWireguard) : undefined,
    }));
  }

  // wg0.conf paste → parse + build → fill host/port (endpoint) + the WG block.
  function handleWgPaste(text: string): void {
    setWgText(text);
    if (text.trim() === '') {
      // (n) N4 — an empty replace box keeps the saved config (undefined in add mode,
      // where there is nothing to keep and the submit gate still asks for a paste).
      setVpnHint(null);
      setDraft((d) => ({ ...d, wireguard: savedWireguard }));
      return;
    }
    const built = buildWireGuardProxyInput(draft.label, parseWireGuardConfigDetailed(text));
    if ('error' in built) {
      // (n) N4 — the refusal describes the text in the box; it never deletes the block the
      // row already holds, and it says so.
      setVpnHint(
        savedWireguard === undefined
          ? built.error
          : looksLikeWireGuardConf(text)
            ? `${built.error}${WG_SAVED_KEPT_SUFFIX}`
            : WG_REPLACE_INCOMPLETE_HINT,
      );
      setDraft((d) => ({ ...d, wireguard: savedWireguard }));
      return;
    }
    setDraft((d) => ({
      ...d,
      scheme: 'wireguard',
      host: built.host,
      port: built.port,
      wireguard: built.wireguard,
    }));
    // WG parity with the OVPN paste path: say at paste time what the control plane (or
    // the tunnel) would refuse, instead of a green "✓ endpoint" over a config Save then
    // blocks. The block stays in the draft so the gate + Save tooltip carry the same reason.
    // (n) N7 — through the SAME message builder as the Save tooltip and the submit hint,
    // so the paste hint names the wg0.conf line too and the three cannot disagree.
    const refusal = wireguardRefusal('wireguard', built.wireguard, text);
    setVpnHint(
      refusal !== null
        ? vpnRefusalMessage(refusal)
        : `✓ endpoint ${built.host}:${built.port.toString()}`,
    );
  }

  // .ovpn paste → validate + extract remote → fill host/port + the OVPN block
  // (config_blob = the pasted text; optional username/password ride alongside).
  function handleOvpnPaste(text: string, autoNote?: string): void {
    setVpnFixable(null); // re-evaluated below; only the unsupported-lines branch sets it
    if (text.trim() === '') {
      setVpnHint(null);
      setDraft((d) => ({ ...d, openvpn: undefined }));
      return;
    }
    const v = validateOpenVpnConfig(text);
    if (!v.ok) {
      setVpnHint(v.reason);
      // Keep the blob so the user can fix it, but don't mark it valid. The spread
      // must come FIRST so the NEW text wins — `{ config_blob: text, ...(d.openvpn) }`
      // let the stale `config_blob` inside d.openvpn override every keystroke (the
      // textarea reverted on each edit when invalid).
      setDraft((d) => ({ ...d, openvpn: { ...(d.openvpn ?? {}), config_blob: text } }));
      return;
    }
    // Paste-time surface of the server's OVPN rejects (item 6c client half): the
    // control plane refuses a config that runs scripts (findUnsupportedOpenvpnLines)
    // or references an external cert/key FILE with no inline block
    // (findUnresolvableOpenvpnFileReferences). Catch both here with the SAME shared
    // api-types finders the server enforces, so the user fixes it instantly instead
    // of a round-trip 400. Keep the blob so they can edit in place.
    const dangerous = findUnsupportedOpenvpnLines(text);
    if (dangerous[0] !== undefined) {
      // N1 (owner) — auto-normalize on ANY entry point (paste OR file upload). The strip
      // only removes/lowers what the control plane refuses (script-security >= 2 -> 1,
      // script directives), and ALL of it is inert on Driftstack (the fleet forces
      // --script-security 1 and never invokes user scripts), so apply it directly with a
      // transparent note instead of stopping behind a button. A remaining external
      // cert/key file reference is caught by the fileRef check after the recursion.
      const auto = openvpnAutoStrip('openvpn', text);
      if (auto !== null) {
        handleOvpnPaste(auto.config, auto.note);
        return;
      }
      // Defensive fallback (a refusal the strip could not change): keep the explicit fix.
      const fixed = stripUnsupportedOpenvpnLines(text);
      const n = dangerous.length;
      setVpnHint(
        `Line ${dangerous[0].line.toString()}: ${dangerous[0].reason}. Driftstack will refuse this config` +
          `${n > 1 ? ` (and ${(n - 1).toString()} more line${n - 1 > 1 ? 's' : ''})` : ''}.`,
      );
      setVpnFixable(fixed.config !== text ? fixed.config : null);
      setDraft((d) => ({ ...d, openvpn: { ...(d.openvpn ?? {}), config_blob: text } }));
      return;
    }
    const fileRef = findUnresolvableOpenvpnFileReferences(text);
    if (fileRef[0] !== undefined) {
      setVpnHint(`Line ${fileRef[0].line.toString()}: ${fileRef[0].reason}`);
      setDraft((d) => ({ ...d, openvpn: { ...(d.openvpn ?? {}), config_blob: text } }));
      return;
    }
    const built = buildOpenVpnProxyInput(
      draft.label,
      text,
      { host: v.remoteHost, port: v.remotePort },
      {
        username: draft.openvpn?.username,
        password: draft.openvpn?.password,
      },
    );
    if ('error' in built) {
      setVpnHint(built.error);
      return;
    }
    setDraft((d) => ({
      ...d,
      scheme: 'openvpn',
      host: built.host,
      port: built.port,
      openvpn: built.openvpn,
    }));
    setVpnHint(
      autoNote !== undefined
        ? `✓ remote ${built.host}:${built.port.toString()} — ${autoNote}`
        : `✓ remote ${built.host}:${built.port.toString()}`,
    );
  }

  /**
   * (o) O6 — a row STORED with a VPN config the control plane refuses. OpenVPN self-heals
   * (the strip is a safe, reversible normalisation); WireGuard cannot be healed without
   * guessing where the tunnel routes, so it says what is wrong instead — see the
   * wireguard arm inside. Both close the same dead end: Save greyed, nothing visible.
   *
   * The paste and upload paths auto-strip before any gate, so nothing refusable can be
   * created today. But a row created by a build that predates that gate opens through
   * `toDraft`, which seeds `draft.openvpn.config_blob` VERBATIM — and until this effect
   * existed nothing normalized it, because the form's only other effect is the `inert`
   * lock. The customer then hit a dead end with no way out and no message:
   *   • Save is disabled on `vpnRefusal !== null`, so its `title` is the only trace;
   *   • `vpnHint` is null on mount, so there is no visible sentence at all;
   *   • the "Remove unsupported lines" button never renders, because `vpnFixable`'s
   *     only reachable setter is inside `handleSubmit`, which a disabled Save cannot
   *     reach — and meanwhile every launch re-PUTs the raw blob and 400s.
   * The only escape was typing a character into the textarea to re-fire the paste path.
   *
   * So: run that same path once, on mount, through `handleOvpnPaste` — the identical
   * function the textarea calls — so the row heals the first time it is opened and
   * shows the SAME transparent adjustment note a paste shows. Not a silent rewrite.
   *
   * ⛔ `openvpnAutoStrip` returns null when there is nothing refusable, so a clean
   * stored config is left byte-for-byte alone and shows no note. It also never invents
   * missing material: a config referencing an external cert/key file is untouched here
   * and still surfaces its own honest refusal.
   */
  const seededOvpnNormalized = useRef(false);
  useEffect(() => {
    if (seededOvpnNormalized.current) return;
    seededOvpnNormalized.current = true;
    // (o) 2026-09-11 follow-up — WIREGUARD REACHES THE SAME DEAD END, and it cannot be
    // healed the way an .ovpn can. A stored WG block is refused by the control plane's
    // own schema (a mask-less `Address = 10.7.0.2`, a DNS search domain, a malformed
    // PresharedKey) and `wireguardRefusal` runs that schema over the SEEDED block on
    // mount — so Save is dead, its `title` the only trace, `vpnHint` null, the "Remove
    // unsupported lines" affordance OpenVPN-only, and the textarea empty by design
    // (N4: it is a REPLACE field). That is strictly worse than the OpenVPN case: there
    // the offending blob is at least visible in the box.
    //
    // ⛔ There is deliberately NO auto-fix here. Inventing the missing half of an
    // address, or dropping a DNS entry, would change where the tunnel routes — the form
    // must not guess that. So the heal is the HONEST one: say what the control plane
    // refuses, in its own words, name the field, and name the action that CAN clear it
    // (replace the conf). Save stays disabled, because the config really is refusable.
    if (initial.scheme === 'wireguard') {
      // Same call the Save gate makes, on the same inputs the mount has: the seeded
      // block and an empty replacement box. It cannot disagree with `vpnRefusal`.
      const refusal = wireguardRefusal('wireguard', initial.wireguard, '');
      if (refusal === null) return;
      setVpnHint(
        `This saved WireGuard config is one Driftstack refuses — ${refusal.field}: ${refusal.reason}. ` +
          'Paste or upload a corrected wg0.conf above to replace it; the saved one cannot be launched as it is.',
      );
      return;
    }
    if (initial.scheme !== 'openvpn') return;
    const seeded = initial.openvpn?.config_blob ?? '';
    const auto = openvpnAutoStrip('openvpn', seeded);
    if (auto === null) {
      // Nothing the strip can heal — but the row may STILL be refusable (an external
      // cert/key file reference the config must inline). That is the original dead
      // end in full: Save greyed, no sentence, no button. Say what is wrong, in the
      // finder's own words, and name the action that can clear it — the same honest
      // heal the WireGuard arm above does. Save stays disabled; the config really is
      // refusable, and the strip must never invent the missing material.
      const refusal = openvpnRefusal('openvpn', seeded);
      if (refusal !== null) {
        setVpnHint(
          `Line ${refusal.line.toString()}: ${refusal.reason} ` +
            'Paste or upload a corrected .ovpn above to replace it; the saved one cannot be launched as it is.',
        );
      }
      return;
    }
    handleOvpnPaste(auto.config, auto.note);
    // Mount-only (empty dep list + the ref): this heals what the row was SEEDED with.
    // Re-running it on a later `initial` identity would fight the customer's own edits
    // in the textarea — which is why the effect reads `initial`, never `draft`.
  }, []);

  // Upload a .ovpn / wg0.conf file instead of pasting — reads it as text and
  // routes through the same parse handler. Resets the input so re-picking the
  // same file fires onChange again.
  function handleVpnFile(
    e: React.ChangeEvent<HTMLInputElement>,
    apply: (text: string) => void,
  ): void {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') apply(reader.result);
    };
    reader.onerror = () => setVpnHint('Could not read that file.');
    reader.readAsText(file);
  }

  // Quick-paste: accept a proxy in any common format and auto-fill the four
  // fields. Clears itself on a successful parse so a pasted password doesn't
  // linger in a visible field.
  function handlePaste(value: string): void {
    setPasteVal(value);
    if (value.trim() === '') {
      setPasteHint(null);
      return;
    }
    const parsed = parseProxyString(value);
    if (parsed === null) {
      setPasteHint('Could not parse — fill the fields below manually.');
      return;
    }
    setDraft((d) => ({
      ...d,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
    }));
    setPasteVal('');
    setPasteHint(
      `Filled ${parsed.host}:${parsed.port}${parsed.username !== null ? ' (with auth)' : ''}.`,
    );
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    // T-21 — when this form is embedded inside a host that is itself a <form>
    // (the New-Profile / Edit-Profile modals wrap their body in one), the submit
    // of THIS form bubbles through React's delegated listener to the outer form
    // too. Stop it here so clicking "Add proxy" adds the proxy and never also
    // fires the host's own submit (which would create the profile). Harmless in
    // the standalone Proxies tab, where there is no ancestor form.
    e.stopPropagation();
    if (submitInFlightRef.current) return;
    const v = validateDraft(draft);
    setValidation(v);
    if (!v.ok) return;
    // N1 — a refusable VPN config never leaves the form: surface the offending line
    // (OVPN) or field (WireGuard) and, for OVPN, re-offer the one-click fix rather than
    // posting it to a certain 400.
    if (vpnRefusal !== null) {
      setVpnHint(
        `${vpnRefusalMessage(vpnRefusal)}. Fix this before saving — ` +
          `Driftstack will refuse this config.`,
      );
      setVpnFixable('fixable' in vpnRefusal ? vpnRefusal.fixable : null);
      return;
    }
    submitInFlightRef.current = true;
    setSubmitting(true);
    try {
      await onSave(draft);
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  }

  // In-form connection test — validate before you save, so a bad host/port or
  // wrong creds surfaces here instead of failing on first launch.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);

  // VPN endpoint pre-flight — VPN endpoints are mostly UDP (no honest TCP/SOCKS5
  // probe), so we DNS-resolve the endpoint host: catches a typo'd/dead host
  // without claiming the tunnel works (full tunnel verifies at launch).
  const [resolving, setResolving] = useState(false);
  const [resolveResult, setResolveResult] = useState<EndpointResolveResult | null>(null);
  async function handleTestEndpoint(): Promise<void> {
    const v = validateDraft(draft);
    setValidation(v);
    if (!v.ok) return;
    setResolving(true);
    setResolveResult(null);
    try {
      setResolveResult(await resolveEndpoint(draft.host, draft.port));
    } catch (err) {
      setResolveResult({
        resolved: false,
        ip: '',
        message: humanizeError(
          err,
          "Couldn't resolve this endpoint. Check the details and try again.",
        ),
      });
    } finally {
      setResolving(false);
    }
  }
  async function handleTestConnection(): Promise<void> {
    const v = validateDraft(draft);
    setValidation(v);
    if (!v.ok) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProxy({
        host: draft.host,
        port: draft.port,
        username: draft.username,
        password: draft.password,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({
        reachable: false,
        auth_ok: false,
        udp_associate: false,
        // A synthesised result is not evidence of routing. Fail closed: an
        // unknown proxy must never inherit a usable verdict by omission.
        can_route: false,
        connect_reply: 0xff,
        latency_ms: 0,
        message: humanizeError(err, "Couldn't test this proxy. Check the details and try again."),
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => void handleSubmit(e)}
      aria-busy={locked}
      aria-disabled={locked}
      className={
        compact
          ? 'relative flex flex-col gap-2.5'
          : 'relative flex flex-col gap-3 overflow-hidden rounded-xl border border-surface-divider bg-surface-raised p-4 shadow-lg'
      }
    >
      {!compact && (
        <>
          {/* Soft accent glow (matches the Command Center hero) so the form reads
              as a premium surface rather than a flat dark box. Dropped in the
              compact embed, where the host already owns the card surface. */}
          <div
            aria-hidden
            className="pointer-events-none absolute -right-10 -top-16 h-36 w-36 rounded-full opacity-40"
            style={{
              background: 'radial-gradient(circle, rgb(var(--accent-rgb)/0.45), transparent 70%)',
            }}
          />
          <header className="flex items-start gap-3 border-b border-surface-divider pb-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-base text-accent ring-1 ring-accent/25">
              🌍
            </span>
            <div className="min-w-0 flex-1">
              <span className="section-label text-accent-text">
                {mode === 'add' ? 'Add proxy' : 'Edit proxy'}
              </span>
              <p className="mt-0.5 text-xs text-ink-muted">
                Route sessions through your own egress — SOCKS5, OpenVPN or WireGuard.
              </p>
            </div>
            <span className="mono shrink-0 rounded-full border border-surface-divider bg-surface-inset px-2 py-0.5 text-2xs font-semibold text-ink-secondary">
              {scheme.toUpperCase()}
            </span>
          </header>
        </>
      )}
      <Field label="Type">
        <select
          className="form-input"
          value={scheme}
          onChange={(e) => handleSchemeChange(e.target.value as NonNullable<ProxyDraft['scheme']>)}
        >
          <option value="socks5">SOCKS5</option>
          <option value="http">HTTP</option>
          <option value="openvpn">OpenVPN</option>
          <option value="wireguard">WireGuard</option>
        </select>
      </Field>
      <Field label="Label" error={validation.errors.label}>
        <input
          type="text"
          className="form-input"
          value={draft.label}
          onChange={(e) => setField('label', e.target.value)}
          placeholder="prod-eu-west"
        />
      </Field>
      {!isVpn && (
        <>
          <Field label="Quick paste — host:port:user:pass or user:pass@host:port">
            <input
              type="text"
              className="form-input mono"
              value={pasteVal}
              onChange={(e) => handlePaste(e.target.value)}
              placeholder="paste a proxy line to auto-fill the fields below"
              autoComplete="off"
              spellCheck={false}
            />
            {pasteHint !== null && (
              <span className="mt-1 text-2xs text-ink-muted">{pasteHint}</span>
            )}
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Host" error={validation.errors.host}>
                <input
                  type="text"
                  className="form-input mono"
                  value={draft.host}
                  onChange={(e) => setField('host', e.target.value)}
                  placeholder="proxy.example.com"
                />
                {/* The SAME component the wizard and both profile modals now use.
                    This markup was the original and the only one; three other entry
                    points showed nothing because each would have had to re-derive
                    the advice from its own partly-filled state. */}
                <ProxyHostWarning host={draft.host} />
              </Field>
            </div>
            <Field label="Port" error={validation.errors.port}>
              <input
                type="number"
                className="form-input mono"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(e) => setField('port', Number(e.target.value))}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username (optional)">
              <input
                type="text"
                className="form-input mono"
                value={draft.username ?? ''}
                onChange={(e) =>
                  setField('username', e.target.value.length > 0 ? e.target.value : null)
                }
                autoComplete="off"
              />
            </Field>
            <Field label="Password (optional)">
              <input
                type="text"
                // ⛔ NOT type="password". A proxy credential is configuration the operator
                // is pasting and needs to VERIFY against their provider's dashboard; masking
                // it hides typos in the one field whose typo reads downstream as
                // "auth_failed" on a working proxy (owner 2026-08-30: "proxy password
                // should just be clean visible, not hidden"). It is not a login secret and
                // there is no shoulder-surfing threat model for a local desktop tool.
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="form-input mono"
                value={draft.password ?? ''}
                onChange={(e) =>
                  setField('password', e.target.value.length > 0 ? e.target.value : null)
                }
                autoComplete="off"
              />
              {showAuthWarning && liveWarnings?.auth !== undefined && (
                <span
                  data-component="proxy-auth-warning"
                  role="note"
                  className="mt-1 text-2xs text-status-busy"
                >
                  {liveWarnings.auth}
                </span>
              )}
            </Field>
          </div>
        </>
      )}
      {/* (n) N9 — the textarea is alone inside its <label>. The upload control is itself a
          <label> (a nested <label> is invalid HTML) and BOTH it and the hint used to sit
          inside this one, so a screen reader read the textarea's name as "Paste your
          wg0.conf … Upload a wg0.conf file ✓ endpoint …" — the button's caption and the
          last parse result glued onto the field's name. They are siblings now, the field
          keeps its own caption, and the hint is announced on its own. */}
      {scheme === 'wireguard' && (
        <div className="flex flex-col">
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-ink-muted">
              Paste your wg0.conf — keys, endpoint + allowed IPs auto-fill
            </span>
            <textarea
              className="form-input mono min-h-[120px]"
              value={wgText}
              onChange={(e) => handleWgPaste(e.target.value)}
              // (n) N4 — the saved-config sentence is the PLACEHOLDER, never the value: a
              // placeholder disappears the moment the customer types, and typing over it
              // cannot be mistaken for editing the configuration itself.
              placeholder={
                savedWireguard !== undefined
                  ? WG_SAVED_PLACEHOLDER
                  : '[Interface]\nPrivateKey = …\n[Peer]\nPublicKey = …\nEndpoint = host:port'
              }
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {validation.errors.wireguard !== undefined && (
            <span className="text-2xs text-status-error">{validation.errors.wireguard}</span>
          )}
          {/* (n) N4 — what the row already holds, so "leave this empty to keep it" names
              something the customer can see. Never the private key or the pre-shared key. */}
          {savedWireguard !== undefined && (
            <span data-component="wg-saved-summary" className="mt-1 text-2xs text-ink-muted">
              {`Saved: endpoint ${savedWireguard.endpoint} · address ${savedWireguard.address} · allowed IPs ${savedWireguard.allowed_ips}`}
              {savedWireguard.dns !== undefined && savedWireguard.dns.length > 0
                ? ` · DNS ${savedWireguard.dns}`
                : ''}
            </span>
          )}
          <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 self-start rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent-text hover:bg-accent/20 focus-within:ring-2 focus-within:ring-accent-ring">
            <span aria-hidden>⤓</span> Upload a wg0.conf file
            <input
              type="file"
              accept=".conf,.txt,text/plain"
              className="sr-only"
              onChange={(e) => handleVpnFile(e, handleWgPaste)}
            />
          </label>
          {vpnHint !== null && <VpnHint hint={vpnHint} isError={vpnHintIsError} />}
        </div>
      )}
      {scheme === 'openvpn' && (
        <>
          {/* (n) N9 — same structure as the WireGuard editor above, for the same reason:
              the upload <label> and the hint were nested inside the field's <label>. */}
          <div className="flex flex-col">
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-ink-muted">
                Paste your .ovpn — the remote endpoint auto-fills
              </span>
              <textarea
                className="form-input mono min-h-[120px]"
                value={draft.openvpn?.config_blob ?? ''}
                onChange={(e) => handleOvpnPaste(e.target.value)}
                placeholder={'client\nremote vpn.example.com 1194 udp\ndev tun\n…'}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {validation.errors.openvpn !== undefined && (
              <span className="text-2xs text-status-error">{validation.errors.openvpn}</span>
            )}
            <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 self-start rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent-text hover:bg-accent/20 focus-within:ring-2 focus-within:ring-accent-ring">
              <span aria-hidden>⤓</span> Upload a .ovpn file
              <input
                type="file"
                accept=".ovpn,.conf,.txt,text/plain"
                className="sr-only"
                onChange={(e) => handleVpnFile(e, handleOvpnPaste)}
              />
            </label>
            {vpnHint !== null && <VpnHint hint={vpnHint} isError={vpnHintIsError} />}
            {vpnFixable !== null && (
              <button
                type="button"
                data-action="strip-unsupported-ovpn"
                onClick={() => {
                  const fixed = vpnFixable;
                  if (fixed !== null) handleOvpnPaste(fixed);
                }}
                className="mt-1 self-start rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-2xs font-medium text-accent-text hover:bg-accent/20"
              >
                Remove unsupported lines (lower script-security to 1)
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Auth username (optional)">
              <input
                type="text"
                className="form-input mono"
                value={draft.openvpn?.username ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    openvpn: {
                      config_blob: d.openvpn?.config_blob ?? '',
                      ...(d.openvpn ?? {}),
                      username: e.target.value.length > 0 ? e.target.value : undefined,
                    },
                  }))
                }
                autoComplete="off"
              />
            </Field>
            <Field label="Auth password (optional)">
              <input
                type="text"
                // ⛔ NOT type="password". A proxy credential is configuration the operator
                // is pasting and needs to VERIFY against their provider's dashboard; masking
                // it hides typos in the one field whose typo reads downstream as
                // "auth_failed" on a working proxy (owner 2026-08-30: "proxy password
                // should just be clean visible, not hidden"). It is not a login secret and
                // there is no shoulder-surfing threat model for a local desktop tool.
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="form-input mono"
                value={draft.openvpn?.password ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    openvpn: {
                      config_blob: d.openvpn?.config_blob ?? '',
                      ...(d.openvpn ?? {}),
                      password: e.target.value.length > 0 ? e.target.value : undefined,
                    },
                  }))
                }
                autoComplete="off"
              />
            </Field>
          </div>
        </>
      )}
      {testResult !== null && (
        <div
          data-component="form-test-result"
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs ${
            isProxyUsable(testResult)
              ? 'border-status-ready/40 bg-status-ready/10 text-status-ready'
              : 'border-status-error/40 bg-status-error/10 text-status-error'
          }`}
        >
          <span
            className="font-semibold"
            title={isProxyUsable(testResult) ? PROBE_ORIGIN_TITLE : undefined}
          >
            {isProxyUsable(testResult) ? '✓ Connected from this Mac' : '✗ Failed'}
          </span>
          {testResult.reachable && (
            <span className="text-ink-secondary">
              {testResult.auth_ok ? 'auth ok' : 'auth failed'} · {testResult.latency_ms}ms · UDP{' '}
              {testResult.udp_associate ? '✓' : '✗'} · route {testResult.can_route ? '✓' : '✗'}
            </span>
          )}
          {!testResult.reachable && (
            <span className="text-ink-secondary">{testResult.message}</span>
          )}
        </div>
      )}
      {resolveResult !== null && (
        <div
          data-component="form-endpoint-result"
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs ${
            resolveResult.resolved
              ? 'border-status-ready/40 bg-status-ready/10 text-status-ready'
              : 'border-status-error/40 bg-status-error/10 text-status-error'
          }`}
        >
          <span
            className="font-semibold"
            title={resolveResult.resolved ? PROBE_ORIGIN_TITLE : undefined}
          >
            {resolveResult.resolved ? '✓ Endpoint reachable from this Mac' : '✗ Endpoint not found'}
          </span>
          <span className="text-ink-secondary">{resolveResult.message}</span>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 pt-2">
        {!isVpn ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleTestConnection()}
            disabled={testing || locked}
            title="Probe this proxy from this Mac — reachability, auth, latency, UDP — before saving"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        ) : (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleTestEndpoint()}
            disabled={resolving || locked}
            title="Check the VPN endpoint host resolves from this Mac — full tunnel verifies at launch"
          >
            {resolving ? 'Checking…' : 'Test endpoint'}
          </button>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={locked}
            onClick={() => {
              if (!submitInFlightRef.current) onCancel();
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={locked || vpnRefusal !== null}
            aria-busy={locked}
            title={
              vpnRefusal !== null ? `${vpnRefusalMessage(vpnRefusal)} — fix it first` : undefined
            }
          >
            {locked
              ? mode === 'add'
                ? 'Adding…'
                : 'Saving…'
              : mode === 'add'
                ? 'Add proxy'
                : 'Save changes'}
          </button>
        </div>
      </div>
    </form>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs text-ink-muted">{label}</span>
      {children}
      {error !== undefined && <span className="text-2xs text-status-error">{error}</span>}
    </label>
  );
}

function PoolStat({ k, v, tone }: { k: string; v: string; tone?: 'ok' }): JSX.Element {
  // Opaque surface-raised on every cell (matches the status-site card surface
  // the founder asked us to mirror); the "healthy" signal comes from the green
  // label + value, not a translucent tint that washes out over the grid divider.
  return (
    <div className="bg-surface-raised px-3 py-2.5">
      <p className={`section-label ${tone === 'ok' ? 'text-status-ready/80' : ''}`}>{k}</p>
      <p
        className={`mono mt-0.5 text-2xl font-bold tracking-tight ${
          tone === 'ok' ? 'text-status-ready' : 'text-ink-primary'
        }`}
      >
        {v}
      </p>
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────

/** Map an ISO-3166 alpha-2 country code to its flag emoji (mirrors the
 *  Profiles hub helper). Returns a globe for an unrecognised code. */
function flagEmoji(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return '🌍';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function toDraft(p: ProxyConfig): ProxyDraft {
  // Carry the scheme + the VPN config block forward (only when present, matching
  // addProxy/updateProxy's optional-field style). Without this an OpenVPN/
  // WireGuard proxy editing through the form — even a label-only rename — saved
  // back with scheme + config DROPPED, silently reverting a working VPN proxy
  // into a broken SOCKS5 one (the editor then renders the SOCKS5 fields and
  // updateProxy persists no scheme/openvpn/wireguard).
  return {
    label: p.label,
    host: p.host,
    port: p.port,
    username: p.username,
    password: p.password,
    ...(p.scheme !== undefined ? { scheme: p.scheme } : {}),
    ...(p.openvpn !== undefined ? { openvpn: p.openvpn } : {}),
    ...(p.wireguard !== undefined ? { wireguard: p.wireguard } : {}),
  };
}

function friendlyError(err: unknown, fallback: string): string {
  return humanizeError(err, fallback);
}

/** Return a copy of `rec` without `key` (same reference if absent, so React
 *  state updates short-circuit). Used to evict a proxy's in-memory probe
 *  results when its endpoint changes or it is deleted. */
function dropKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}
