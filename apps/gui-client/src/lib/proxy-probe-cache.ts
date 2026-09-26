// Proxy probe-result cache — night-arc B (2026-06-12).
//
// The native SOCKS5 probe result (reachability / auth / UDP-associate /
// latency) was previously view-local state in ProxiesView, so profile
// cards couldn't show egress capability. This persists the LAST result
// per proxy id in its own store file so any surface can render it —
// with the honest "untested" state when a proxy has never been probed.
//
// Same store-isolation rationale as profiles-meta.ts: settings.json is
// drift-pinned + owns the key lifecycle; cache data stays out of that
// blast radius. Corrupt/missing entries degrade to "untested".

import { LazyStore } from '@tauri-apps/plugin-store';
import { makeWriteLock } from './store-write-lock';
import { isProxyUsable, type ProxyExitProbeResult, type ProxyTestResult } from './proxies';
import { udpRelayOf } from './udp-relay-verdict';
import { cleanMeasuredQuic, type MeasuredQuic } from './account-proxies';
import {
  isFingerprintConfidence,
  isFingerprintedOs,
  isOsFingerprintUnavailable,
  type OsFingerprint,
  OS_FINGERPRINT_TTL_MS,
} from './os-fingerprint-verdict';
import { cleanServerVantage, type ProxyVantage, type ServerVantage } from './proxy-vantage';
import { MEASURED_READING_TTL_MS } from './proxy-reading-windows';
import {
  attributeSessionProxy,
  makeH3ObservationLedger,
  parseH3Observation,
  type H3BindingLike,
} from './session-h3-observation';

/** N-2 — the control plane's passive OS fingerprint of the proxy's own stack,
 *  with when it was recorded. */
export interface CachedOsFingerprint extends OsFingerprint {
  at: number;
}

/** T-20 — the verdict of a VPN/HTTP row's pre-flight, which is a DNS resolve of
 *  the endpoint (`endpoint_resolve`), not a SOCKS5 handshake. Field names match
 *  the native `EndpointResolveResult`. */
export interface CachedEndpointVerdict {
  resolved: boolean;
  ip: string;
  message: string;
}

export interface CachedProbe {
  result: ProxyTestResult;
  /** Epoch ms when the probe ran. */
  at: number;
  /** T-20 — present when the row's last check was an endpoint resolve rather
   *  than a SOCKS5 probe. `result` is then the fail-closed placeholder (never
   *  usable — see `ENDPOINT_PLACEHOLDER_RESULT`), so every derivation that reads
   *  `result` treats the entry as "not a SOCKS5 verdict", and a surface that
   *  wants to describe the check reads THIS. */
  endpoint?: CachedEndpointVerdict;
  /** E-2 exit-geo (optional — absent until the echo probe succeeds). */
  exitIp?: string;
  exitCountry?: string | null;
  /** T-17 — epoch ms when the exit-geo below was measured. `at` moves on every
   *  native re-test while the geo is preserved across them, so `at` cannot say
   *  how old the exit identity is. Absent on entries written before this field
   *  existed, which `isExitIdentityFresh` reads as NOT fresh. */
  exitAt?: number;
  /** (l) #14 — epoch ms when a native exit probe through a USABLE proxy did
   *  not complete (V-857's "exit geo unavailable" state). Written by
   *  `clearExitResult`, which also drops the exit fields, so a later cache
   *  emit from ANY writer (a fleet test's persist, the sweeper, a list
   *  adoption) reproduces the honest null state instead of re-hydrating the
   *  PREVIOUS exit beside "Tested just now". Cleared by the next exit write. */
  exitProbeFailedAt?: number;
  /** Geo enrichment (2026-06-15) from lumtest through the proxy — best-effort,
   *  absent when lumtest was unreachable. exitCountry stays the baseline. */
  exitCity?: string | null;
  exitRegion?: string | null;
  exitTimezone?: string | null;
  exitAsnOrg?: string | null;
  /** N-2 — absent until the control plane observed the proxy's SYN; preserved
   *  across capability re-tests like the exit-geo. */
  osFingerprint?: CachedOsFingerprint;
  /** T-1 — the SERVER-measured latency (ms) from the control plane's /test
   *  route, measured closer to the fleet than this Mac. Preferred for the
   *  displayed latency when present; preserved across native capability
   *  re-tests like the exit-geo and the OS fingerprint. */
  serverLatencyMs?: number;
  /** T-6 — the QUIC verdict MEASURED in a live session (closed set), with when
   *  it was recorded (epoch ms). Absent = never measured; the chip then stays
   *  inferred ('~') and never renders a green ✓. Preserved across re-tests. */
  quicMeasured?: MeasuredQuic;
  quicMeasuredAt?: number;
  /** T-1 — WHERE serverLatencyMs was measured: 'fleet' (the Mac that runs the
   *  profile; nodeId names it) or 'control_plane' (no fleet Mac was free — the
   *  honest fallback). Absent = a server number recorded before the vantage was
   *  reported, shown under today's plain "server" marker. Travels WITH the
   *  number: a new server result replaces all three, so a fleet label can never
   *  sit beside a control-plane latency. Preserved across native re-tests. */
  measuredFrom?: ProxyVantage;
  nodeId?: string;
  /** T-1 — the fleet Mac's standalone QUIC-relay verdict (true/false), separate
   *  from quicMeasured (a live session's HTTP/3) and never merged with it. */
  quicProbe?: boolean;
  /**
   * Epoch ms when the relay verdict beside it was MEASURED — the twin of
   * `udpProbeAt` below, and it exists for the reason that one gives: the verdict
   * is CARRIED across every reply that measured nothing about QUIC (a
   * control-plane fallback, a skipped leg — see `saveServerProbeResult`), so
   * undated it was aged by nothing and a `✓ QUIC` from a Test pressed last month
   * read in the present tense for the life of the install.
   *
   * Written when a reply measures the leg, carried unchanged when a reply carries
   * the verdict, and read by `isQuicProbeFresh`. ⛔ An ABSENT stamp is NOT fresh
   * and is not an AGED reading either — a verdict nobody can date has no age to
   * state — so an entry written before this field existed falls back to the
   * inferred chip and the automatic capability check (proxy-probe-sweeper) treats
   * it as never measured and re-takes it.
   */
  quicProbeAt?: number;
  /**
   * Epoch ms when a check RAN the relay leg, reached no verdict, and so removed
   * the one this entry held (`saveServerProbeResult`). It exists because the
   * removal alone is undone by the next list sync: the server writes nothing for a
   * leg that reached no verdict, so its row still carries the reading from BEFORE
   * that check, and an entry with no relay verdict admits any datable one. A
   * stored reading dated at or before this stamp is the one that was just retired
   * and is refused (`serverCapabilityReadingsToAdopt`) — the `exitSupersededAt`
   * rule, for the one leg. Dropped by the next reply that MEASURES the leg;
   * carried by every writer that carries the verdict's own date.
   */
  quicProbeRetiredAt?: number;
  /**
   * Epoch ms when an address check could not CONFIRM this row's endpoint is still
   * at the address the readings were taken through — found at a different one, or
   * unresolved on either side of the comparison — and every server-measured field
   * was dropped for it (`saveEndpointResult`). Same reason as the stamp above, for
   * every reading at once: what the server holds was measured before that, and the
   * list adoption must not put it back. A reading dated after it was taken since.
   *
   * Refuses the stored QUIC / UDP readings (`serverCapabilityReadingsToAdopt`) and
   * the stored OS reading (`refusesServerOsReading`). ⛔ NOT the observed EXIT, on
   * purpose: that is refused by `exitSupersededAt` alone. The exit is what a launch
   * sets the device clock's timezone from, only a live session can re-date it, and
   * this stamp is minted by ONE failed lookup — refusing the exit on it would leave
   * every VPN row without the exit its next launch reads, after one sweep that ran
   * offline. The price is that an exit seen through the old address can show
   * beside a new one until a session re-observes it, as it always could.
   */
  serverReadingsRetiredAt?: number;
  /** (V6 2026-09-16) ITEM 3 — the fleet Mac's MEASURED UDP-relay verdict, its
   *  exact sibling. ⛔ ABSENT IS "NOT MEASURED", never "no UDP": the control
   *  plane emits `udp_associate` only for a real reading, so nothing asserted
   *  (a VPN tunnel's literal `true`) or unlooked-at (an explicit null, a skipped
   *  leg) can ever be stored here and later render as a verdict. */
  udpProbe?: boolean;
  /**
   * (V6 2026-09-16, refuter #5) — epoch ms when the UDP verdict beside it was
   * MEASURED, and the reason it exists at all.
   *
   * ⛔ THE VERDICT IS CARRIED ACROSS EVERY REPLY THAT MEASURED NOTHING (see
   * `saveServerProbeResult`), which is right — a non-measurement must not retire a
   * measurement — and, undated, it also meant the verdict was aged by NOTHING while
   * `serverProbeAt` beside it was re-stamped on every one of those replies. Concrete
   * sequence during the contracted node rollout: a migrated Mac measures
   * `udp_associate: false`; the provider fixes UDP; every later Check lands on a
   * legacy Mac whose VPN frame is the bare literal, which the route correctly drops
   * — so the surfaces show "⤵ UDP — No UDP through this tunnel — measured from
   * Driftstack's network" beside "Tested just now", for ever, about a measurement
   * that may be hours old and is no longer true. A negative verdict about a
   * customer's tunnel, stated in the present tense, is the same failure this item
   * exists to prevent, arriving through the cache instead of the wire.
   *
   * So the date travels WITH the verdict: written when a reply measures one, carried
   * unchanged when a reply carries one (a carry re-measures nothing and must not
   * refresh the clock), and read by `isUdpVerdictFresh` in both derivations. An
   * ABSENT stamp is NOT fresh — an entry written before this field existed holds a
   * verdict nobody can date, and the honest rendering of that is "not measured".
   */
  udpProbeAt?: number;
  /** (h) — epoch ms when the SERVER test that wrote serverLatencyMs / the
   *  vantage / quicProbe ran. `at` is the row's LAST check (for a VPN row the
   *  DNS pre-flight, which runs before every fleet test and is re-stamped even
   *  when the fleet then REFUSES to measure), so `at` beside a carried-over
   *  fleet number dated a measurement that never happened. Travels with the
   *  server fields: written with them, carried with them, dropped with them. */
  serverProbeAt?: number;
  /** (h) — epoch ms when a fleet test FAILED to bring this VPN tunnel up and
   *  so contradicted the exit the entry held. The exit fields are dropped at
   *  that moment; this stamp survives the next pre-flight and refuses any
   *  observation dated at or before it (the account list's `exit_observed`
   *  still carries the pre-failure session exit), so a dropped exit cannot
   *  be resurrected by a later cache emit. Cleared by the next exit write
   *  dated after it. */
  exitSupersededAt?: number;
  /** (h) finding 3 — the fleet's sentence for that failure ("The proxy did
   *  not answer…"), persisted beside the stamp so EVERY surface that reads
   *  the cache — the Proxies grid after a remount, the profile card for a
   *  Check that ran in the grid — renders the same "tunnel down", not only the
   *  view that happened to run the check. Written with `exitSupersededAt`,
   *  carried by the pre-flight with it, and cleared by the next fleet answer
   *  that is a verdict (`saveServerProbeResult`) or by an exit seen after the
   *  failure (`saveExitResult`); a `not_run` clears neither, because it said
   *  nothing about the tunnel. */
  fleetFailureReason?: string;
  /**
   * (p) 2026-09-16 — this entry exists ONLY to carry a reading the SERVER holds
   * (the account list's stored OS fingerprint). NOTHING on this Mac has probed
   * the row: `result` is the fail-closed placeholder, so it is never usable, and
   * the derivation keys neither `testResults` nor `testedAt` from it.
   *
   * ⛔ That suppression is the whole point and it is not cosmetic. Without it a
   * proxy nobody here has tested would render a red "not reachable" pill and a
   * "Tested just now" stamp, invented from an entry we wrote ourselves — strictly
   * worse than the blank chip this item exists to fill. Same shape as the
   * endpoint-row placeholder, whose overlay deletes its `result` for the same
   * reason.
   *
   * ⛔ It must survive a reload (`cleanEntry` admits it): dropped on load, the
   * placeholder becomes an ordinary SOCKS5 verdict and the red pill appears on the
   * next app start. And it is DROPPED the moment a real local verdict lands —
   * `saveProbeResult` / `saveEndpointResult` rebuild the entry field by field and
   * do not carry it, which is exactly right: the row is then tested.
   */
  serverSeeded?: true;
}

export type ProbeCacheMap = Record<string, CachedProbe>;

/**
 * How long a probe result is treated as still describing the proxy.
 *
 * Six hours is chosen against the ONE path that acts on the cache without
 * re-testing: bulk launch. Single launch always re-probes (`ProfilesView` —
 * "Re-test the proxy NOW rather than trusting whatever the cache remembers"),
 * but bulk deliberately skips that, because probing N proxies serially would
 * stall the batch. So the cache is load-bearing exactly there, and this bounds
 * how old a verdict a batch can act on.
 *
 * Not shorter: every expiry costs a real TCP + SOCKS5 handshake per proxy, and
 * a residential endpoint that rotates within six hours will be caught by the
 * launch-time gate anyway. Not longer: a lapsed plan or a changed ruleset is
 * invisible until something tests it, and "healthy" from last week is a claim
 * we cannot support.
 */
/** The three view-shaped maps both proxy surfaces render from. */
export interface ProbeViewState {
  testResults: Record<string, ProxyTestResult>;
  exitResults: Record<string, ProxyExitProbeResult | null>;
  testedAt: Record<string, number>;
  /** N-2 — only for proxies whose last capability probe was usable (the
   *  exit-geo rule): no OS verdict beside a red "unreachable" pill. */
  osFingerprints: Record<string, CachedOsFingerprint>;
  /** T-1 — the server-measured latency, surfaced only while the proxy is usable
   *  (same rule as the exit-geo: no server number beside a dead proxy). */
  serverLatency: Record<string, number>;
  /** T-6 — the measured QUIC verdict, surfaced only while the proxy is usable. */
  quicMeasured: Record<string, MeasuredQuic>;
  /** T-1 — where serverLatency was measured (+ the node), same usable-only rule. */
  serverVantage: Record<string, ServerVantage>;
  /** T-1 — the fleet Mac's QUIC-relay verdict, same usable-only rule. */
  quicProbe: Record<string, boolean>;
  /** (V6 2026-09-16) ITEM 3 — the fleet Mac's MEASURED UDP-relay verdict, same
   *  usable-only rule. ⛔ NOT KEYED is "not measured", which every surface renders
   *  as "not measured yet"; only a keyed `false` is a negative verdict. */
  udpProbe: Record<string, boolean>;
  /**
   * (V-219) WHEN the exit beside it was measured — `exitAt`, keyed only for rows
   * that surface an exit at all.
   *
   * ⛔ `testedAt` is NOT this date and reading it as this date is a live defect.
   * The exit probe and the capability probe are SEPARATE calls: `saveProbeResult`
   * preserves the exit across every capability re-test (deliberately — losing the
   * customer's location on a reachability check would be worse), and the
   * background sweeper re-probes CAPABILITY ONLY, every 15 minutes, five rows at
   * a time. So `testedAt` moves without the exit moving, and a row can read
   * "Tested just now" beside an address measured hours or days earlier — which on
   * a rotating residential exit is a different machine in a different city.
   *
   * The launch path already refuses this exit past 30 minutes
   * (`isExitIdentityFresh`, ProfilesView): we decline to ROUTE through a reading
   * this old while still SHOWING it as current. Surfaces with room to say the age
   * say it; the compact chip keeps the value, because an address that admits its
   * age beats no address at all — the owner asked for location to be shown.
   */
  exitSeenAt: Record<string, number>;
  /**
   * (V-219) WHEN the SERVER-measured fields beside it were measured —
   * `serverProbeAt`, keyed only for rows that surface one.
   *
   * ⛔ Same borrowed-freshness shape as `exitSeenAt`, on the number the card
   * PREFERS. `saveProbeResult` carries `serverLatencyMs` across every native
   * capability re-test (deliberately — a reachability check measured no fleet
   * latency and must not erase one), the background sweeper runs native probes
   * every fifteen minutes, and the card shows the server number whenever it has
   * one. So "Tested just now" can sit over a fleet latency measured hours
   * earlier, from a node that may no longer be the one serving this proxy.
   *
   * `serverProbeStamps` already surfaces this date — but only for ENDPOINT rows,
   * which is why the SOCKS5 case needed a home. Keyed here so both derivations
   * and both surfaces read one map.
   */
  serverMeasuredAt: Record<string, number>;
  /**
   * The readings that are NO LONGER CURRENT but are still worth showing — see
   * `AgedReadings`. ⛔ A PARALLEL structure on purpose: every map above keeps
   * exactly the entries it had before this existed, so the launch path and every
   * present-tense consumer behave as they did. A reading is in a map above OR in
   * here, never both.
   */
  aged: AgedReadings;
}

/** A reading that has aged out of the present tense: what was measured, and when. */
export interface AgedReading<T> {
  value: T;
  atMs: number;
}

/**
 * The THIRD display state, between "current" and "not measured".
 *
 * ⛔ WHY IT EXISTS. The four readings below leave their present-tense map after
 * thirty minutes, and that rule is right — a chip that says `✓ QUIC` must be true
 * now. But dropping out of the map is also what "never measured" looks like, so a
 * proxy the customer tested 31 minutes ago rendered exactly like one nobody had
 * ever tested, and told them to press Test on a row they had just tested. The
 * value was on disk the whole time.
 *
 * An entry here is a reading that EXISTS, can be DATED, is NOT fresh, is younger
 * than `AGED_READING_MAX_MS`, and passes the same usable / server-seeded gate its
 * fresh sibling passes. A surface renders it in the PAST tense, muted, with its
 * age — never in the tone of a current verdict — and nothing that ACTS on a
 * reading (the launch path, the sort, the hero) may read this structure.
 */
export interface AgedReadings {
  osFingerprints: Record<string, AgedReading<CachedOsFingerprint>>;
  quicMeasured: Record<string, AgedReading<MeasuredQuic>>;
  quicProbe: Record<string, AgedReading<boolean>>;
  udpProbe: Record<string, AgedReading<boolean>>;
}

/** One row's aged readings — the slice a row component takes. */
export interface AgedRowReadings {
  osFingerprint?: AgedReading<CachedOsFingerprint>;
  quicMeasured?: AgedReading<MeasuredQuic>;
  quicProbe?: AgedReading<boolean>;
  udpProbe?: AgedReading<boolean>;
}

export function emptyAgedReadings(): AgedReadings {
  return { osFingerprints: {}, quicMeasured: {}, quicProbe: {}, udpProbe: {} };
}

/** The aged readings of ONE proxy, or undefined when it has none — so a row that
 *  has nothing aged gets a stable `undefined` prop rather than a fresh `{}`. */
export function agedReadingsFor(aged: AgedReadings, proxyId: string): AgedRowReadings | undefined {
  const osFingerprint = aged.osFingerprints[proxyId];
  const quicMeasured = aged.quicMeasured[proxyId];
  const quicProbe = aged.quicProbe[proxyId];
  const udpProbe = aged.udpProbe[proxyId];
  if (
    osFingerprint === undefined &&
    quicMeasured === undefined &&
    quicProbe === undefined &&
    udpProbe === undefined
  )
    return undefined;
  return {
    ...(osFingerprint !== undefined ? { osFingerprint } : {}),
    ...(quicMeasured !== undefined ? { quicMeasured } : {}),
    ...(quicProbe !== undefined ? { quicProbe } : {}),
    ...(udpProbe !== undefined ? { udpProbe } : {}),
  };
}

/**
 * How long an aged reading is still worth showing.
 *
 * Thirty days. Past that a reading describes a provider configuration nobody
 * should reason from, and "last checked 7 months ago" beside a proxy is noise
 * rather than information — the row then says "not measured", which is what is
 * true of anything a customer could act on. Not shorter: the automatic capability
 * check re-takes a reading after six hours but is budgeted, backed off and needs
 * an API key, so a reading can honestly sit for days on a Free account or a long
 * list, and hiding it again is the defect this state exists to close.
 */
export const AGED_READING_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Is a reading taken at `atMs` an AGED one — datable, and old enough to have left
 * the present tense (the caller has already established it is not fresh) but
 * younger than the cap above?
 *
 * ⛔ An ABSENT or non-finite stamp is NOT aged: an age sentence needs a date, and
 * "Last checked NaN days ago" is not a fallback anyone should see. Such a reading
 * is simply not measured, and the automatic check re-takes it.
 */
export function isAgedReadingShowable(atMs: number | undefined, nowMs: number): boolean {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return false;
  return nowMs - atMs < AGED_READING_MAX_MS;
}

/**
 * Derive the render state from a cache snapshot. Pure, and extracted so the
 * mount path and the change-subscription path cannot drift apart — before P-8
 * this lived inline in `ProxiesView.refresh`, and a background sweep updating
 * the cache had no way to reuse it.
 *
 * ⛔ Exit-geo is re-hydrated ONLY when the last capability probe was healthy.
 * `saveProbeResult` deliberately preserves prior exit-geo across a failed
 * re-test (capability and exit probes are separate calls), so a proxy that was
 * healthy and then went down would otherwise render its old exit IP and country
 * flag beside a red "unreachable" pill — "exits from US 1.2.3.4" for a dead
 * proxy. This is the one rule in the derivation that is not a transcription.
 */
/**
 * W-30 — how long a MEASURED QUIC verdict stays current.
 *
 * ⛔ The verdict is written when a live session observes an HTTP/3 handshake, and
 * it never expired. The signal underneath it could not expire either: the node's
 * `h3ConnectionObserved` is backed by an insert-only set and can never return to
 * false, so "this proxy did h3 once" was being rendered as the MEASURED chip —
 * the strongest mark this UI makes, deliberately distinguished from the inferred
 * `~`. A relay that dies keeps its green tick for the life of the install.
 *
 * 1800s = SIX re-emit cadences. The fleet re-emits a capability report every 300s
 * ±20%, so the worst-case honest gap is 360s and six leaves five clear intervals
 * of slack. ⚠️ Deliberately generous, because the two errors are not symmetric:
 * downgrading a LIVE proxy to inferred is a visible wrong answer on a working
 * setup, while holding a stale verdict a few minutes longer is the state that
 * shipped for months. Better slow to weaken a claim than quick to make a false one.
 *
 * ⚠️ Derived from the BUILD cadence, not from observed arrival times: arrival
 * carries queue and `lsof` jitter the sweep's own gate never controls, and gaps of
 * 236s have been measured below the 240s build floor for that reason.
 */
export const QUIC_VERDICT_TTL_MS = 30 * 60 * 1000;

/**
 * ⛔ THIRTY MINUTES IS CORRECT HERE AND NOWHERE ELSE, and this re-export is the
 * line between the two cases. `QUIC_VERDICT_TTL_MS` above bounds a LIVE-SESSION
 * observation, whose feeding cadence is the fleet's 300 s ±20% capability
 * re-emit; six of those is the derivation in its own comment and it must not be
 * touched. Every OTHER measured reading — the Test relay verdict, the UDP-relay
 * verdict, the OS fingerprint — is fed by the automatic capability check at six
 * hours, and inherited this number by imitation ("same thirty minutes as the QUIC
 * verdict above") rather than by derivation. That imitation is the bug: three
 * windows tracked a cadence that had moved out from under them by a factor of
 * twelve.
 *
 * Re-exported so a reader who lands on the 30-minute literal above finds the
 * other window beside it and can see which of the two their reading belongs to.
 */
export { MEASURED_READING_TTL_MS };

/**
 * Is a measured QUIC verdict still current?
 *
 * ⛔ An ABSENT timestamp is NOT fresh. We cannot establish when it was taken, and
 * "we could not tell" must render as the inferred `~` rather than as a pass —
 * the same rule the chip already applies to a never-measured proxy. It self-heals:
 * the next observation stamps a time.
 */
export function isQuicVerdictFresh(atMs: number | undefined, nowMs: number): boolean {
  if (typeof atMs !== 'number') return false;
  return nowMs - atMs < QUIC_VERDICT_TTL_MS;
}

/**
 * (V6 2026-09-16, refuter #5) Is a measured UDP-relay verdict still current?
 *
 * ⛔ IT WAS THE SAME THIRTY MINUTES as the live QUIC verdict above, and that was
 * the mistake: this reading is not re-taken by a live session every five minutes,
 * it is re-taken by the automatic capability check every SIX HOURS. A window
 * shorter than the cadence that feeds it cannot be satisfied, so a tunnel that
 * really does relay UDP showed its verdict for half an hour and then went quiet
 * for five and a half. `MEASURED_READING_TTL_MS` is derived from that cadence —
 * see proxy-reading-windows for the arithmetic.
 *
 * The reason for expiring it at all is untouched and still right: it describes
 * something measured THROUGH the proxy that the proxy can change underneath us,
 * and a tunnel whose peer starts or stops relaying UDP is the ordinary case, not
 * the exotic one. Past the window it renders AGED, which is the safety net.
 *
 * ⛔ An ABSENT timestamp is NOT fresh, like every neighbour: a verdict we cannot
 * date must not render in the present tense. That is not a theoretical entry —
 * it is every entry written before this stamp existed, and the honest rendering
 * of an undatable verdict is the not-measured chip, which self-heals on the next
 * check. The alternative is what shipped: "No UDP through this tunnel — measured
 * from Driftstack's network" beside a "Tested just now" stamp belonging to a
 * different, later reply that measured nothing about UDP at all.
 */
export function isUdpVerdictFresh(atMs: number | undefined, nowMs: number): boolean {
  if (typeof atMs !== 'number') return false;
  return nowMs - atMs < MEASURED_READING_TTL_MS;
}

/**
 * Is the Test's QUIC-relay verdict (`quicProbe`) still current?
 *
 * ⛔ It was the ONE reading measured through the proxy that nothing aged. Its
 * three neighbours — the live QUIC verdict, the UDP verdict, the OS reading — all
 * leave the present tense after thirty minutes, and this one kept its green tick
 * for the life of the install: the very failure the comment on
 * `QUIC_VERDICT_TTL_MS` describes, surviving in the sibling field.
 *
 * It was left undated deliberately (see `saveObservedQuic`): the verdict is only
 * written when someone presses Test, so a thirty-minute window meant the green
 * chip was essentially never shown. That objection was answered with the AGED
 * reading ("✓ QUIC · 4h ago", `AgedReadings`) and the automatic capability check
 * that re-takes it — and the objection was RIGHT ANYWAY. ⛔ The automatic check
 * runs every six hours, so a thirty-minute window still left the green chip
 * unshowable in steady state: aged became the normal state of a working proxy
 * rather than the gap before its next measurement. That is the owner's "Has QUIC
 * and Apple, but it aint green sometimes".
 *
 * `MEASURED_READING_TTL_MS` is derived from that same cadence — one sweep slot
 * and an hour of margin past it, so a reading cannot go quiet before anything
 * could have re-taken it. Past the window the AGED reading still stands: the
 * safety net is unchanged, it just stops being where a healthy proxy lives.
 *
 * Same rule as `isUdpVerdictFresh`, including the absent stamp: NOT fresh.
 */
export function isQuicProbeFresh(atMs: number | undefined, nowMs: number): boolean {
  if (typeof atMs !== 'number') return false;
  return nowMs - atMs < MEASURED_READING_TTL_MS;
}

/**
 * T-17 — how long a probed EXIT IDENTITY (ip / country / timezone) stays current.
 *
 * ⛔ `exitTimezone` never expired. The simulator's status-bar clock is set from
 * it at launch, so a residential exit that rotated to another zone since the
 * last probe put the wrong time on the device for the whole session — the
 * owner's #3. Thirty minutes matches `QUIC_VERDICT_TTL_MS` above: both describe
 * something measured THROUGH the proxy that the proxy can change underneath us,
 * and a launch is the one moment the value is acted on. Not shorter: every
 * re-probe is a real request through the proxy at the customer's cost.
 *
 * ⛔ AND IT IS DELIBERATELY NOT `MEASURED_READING_TTL_MS`. The windows that moved
 * to the capability cadence moved because they only ever DISPLAYED a reading, and
 * a display that goes quiet before anything can re-take it is a lie about a
 * healthy proxy. This one is ACTED ON: `freshExitIdentity` (ProfilesView) hands
 * the country and timezone to the launch, which sets the simulator's status-bar
 * clock and the Dock flag for the whole session. Past the window it does not go
 * quiet, it RE-PROBES — so the cost of a short window here is one request, not a
 * muted chip, and widening it would put a wrong clock on the device instead.
 * A window a decision consumes is not a display window. Grepped 2026-09-17:
 * `isExitIdentityFresh` is the ONLY freshness predicate in this file with a
 * consumer outside the two view derivations.
 */
export const EXIT_IDENTITY_TTL_MS = 30 * 60 * 1000;

/** Is a probed exit identity still current? Same rule as the QUIC verdict: an
 *  ABSENT timestamp is not fresh — we cannot say when it was taken — and the
 *  launch path then re-probes once, which stamps one. */
export function isExitIdentityFresh(atMs: number | undefined, nowMs: number): boolean {
  if (typeof atMs !== 'number') return false;
  return nowMs - atMs < EXIT_IDENTITY_TTL_MS;
}

/**
 * (V-219) How long a measured OS FINGERPRINT stays current.
 *
 * ⛔ It never expired, and the two fields either side of it did. `at` was
 * written on every reading and read by NOBODY in the whole client, so the grid
 * showed a reading of unbounded age in bare present tense — and because a
 * capability re-test carries the stored fingerprint forward while refreshing the
 * visible "Tested" stamp, it showed it beside a timestamp saying we had just
 * checked. A reading taken through a provider configuration that no longer
 * exists, presented as current.
 *
 * That is not hypothetical: the owner reported `linux` on a proxy whose probe
 * has since failed on every attempt, so what they were looking at could only
 * have been a cached reading with no way to tell its age.
 *
 * ⛔ (2026-09-17 review) THIS PARAGRAPH USED TO SAY "thirty minutes, matching
 * QUIC_VERDICT_TTL_MS and EXIT_IDENTITY_TTL_MS above", and the number is now
 * eight hours — so it stated the defect's own reasoning as current fact beside
 * the fixed value. Copying a neighbour's number IS the bug: a window matched to
 * whatever stood next to it could not follow the cadence when that cadence became
 * six hours, and did not. It is now DERIVED, in `proxy-reading-windows.ts`, from
 * the cadence that re-takes this very reading — see MEASURED_READING_TTL_MS for
 * the arithmetic, and `os-fingerprint-verdict.ts` for the twin of this note.
 *
 * It expires at all for a reason that has not changed: a fingerprint describes
 * something measured THROUGH the proxy, which the proxy can change underneath us.
 * A stack fingerprint feels more permanent than a QUIC verdict, and that
 * intuition is exactly the trap — a residential exit rotates to another machine
 * entirely, and the reading is about the machine, not the row.
 *
 * ⚠️ Re-exported, not defined: the cockpit's session readout ages the SAME
 * reading and must use the SAME number, and it cannot import this module (the
 * Tauri store rides along). The single definition lives in the import-free
 * os-fingerprint-verdict, so the two surfaces cannot drift apart.
 */
export { OS_FINGERPRINT_TTL_MS };

/**
 * Is a measured OS fingerprint still current?
 *
 * ⛔ An ABSENT timestamp is NOT fresh, same as its neighbours: we cannot say when
 * it was taken, and an undatable reading must not render as a current one.
 *
 * ⚠️ CAUSES DO NOT AGE. A placeholder carrying `unavailable` is not a
 * measurement — "a VPN tunnel has no SOCKS5 stack to fingerprint" is true
 * however old it is, and expiring it would replace a true explanation with
 * "never measured", which is worse and sends the customer to press Test on a row
 * that can never produce a value. Only real readings expire.
 */
export function isOsFingerprintFresh(fp: CachedOsFingerprint | undefined, nowMs: number): boolean {
  if (fp === undefined) return false;
  if (fp.unavailable !== undefined) return true;
  return typeof fp.at === 'number' && nowMs - fp.at < OS_FINGERPRINT_TTL_MS;
}

/**
 * T-20 — the `result` stored beside an endpoint verdict.
 *
 * Every field that could read as a SOCKS5 pass is false, so `isProxyUsable`
 * is false, no exit-geo / fingerprint / QUIC verdict is surfaced for it, and
 * a cache reader that predates `endpoint` sees a proxy that is not usable
 * rather than one that is. The message is the resolve's own sentence.
 */
export function endpointPlaceholderResult(endpoint: CachedEndpointVerdict): ProxyTestResult {
  return {
    reachable: false,
    auth_ok: false,
    udp_associate: false,
    can_route: false,
    connect_reply: 0xff,
    latency_ms: 0,
    message: endpoint.message,
  };
}

/**
 * (p) 2026-09-16 — the `result` a SERVER-SEEDED entry carries: every field that
 * could read as a pass is false, exactly like the endpoint placeholder, so
 * `isProxyUsable` is false and no consumer that predates `serverSeeded` can read
 * the entry as a healthy proxy. The message says what is true of it.
 */
export const SERVER_SEEDED_PLACEHOLDER_RESULT: ProxyTestResult = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'Not checked on this Mac.',
};

/**
 * T-20 — does a cached entry hold a verdict of the kind THIS row can earn?
 *
 * A SOCKS5 verdict on a VPN row is what the un-gated probe wrote before the
 * fix: a handshake the endpoint never speaks, recorded as "unreachable". It is
 * evidence about the probe, not the proxy, so a surface must read it as
 * untested and the auto-probe must run the right check in its place. The
 * reverse holds too: a row switched from VPN to SOCKS5 keeps an endpoint
 * verdict that says nothing about the listener it now is.
 */
export function verdictMatchesScheme(socks5Probeable: boolean, entry: CachedProbe): boolean {
  // (p) — a server-seeded entry is not a verdict of ANY kind: nothing on this Mac
  // has checked the row, and its `result` is a placeholder. Saying otherwise here
  // would tell the auto-probe the row is already tested and leave it with the
  // server's reading and no local verdict for ever.
  if (entry.serverSeeded === true) return false;
  return socks5Probeable ? entry.endpoint === undefined : entry.endpoint !== undefined;
}

export function deriveProbeViewState(
  cache: ProbeCacheMap,
  nowMs: number = Date.now(),
): ProbeViewState {
  const testResults: Record<string, ProxyTestResult> = {};
  const exitResults: Record<string, ProxyExitProbeResult | null> = {};
  const testedAt: Record<string, number> = {};
  const osFingerprints: Record<string, CachedOsFingerprint> = {};
  const serverLatency: Record<string, number> = {};
  const quicMeasured: Record<string, MeasuredQuic> = {};
  const serverVantage: Record<string, ServerVantage> = {};
  const quicProbe: Record<string, boolean> = {};
  const udpProbe: Record<string, boolean> = {};
  const exitSeenAt: Record<string, number> = {};
  const serverMeasuredAt: Record<string, number> = {};
  const aged = emptyAgedReadings();
  for (const [id, c] of Object.entries(cache)) {
    // ⛔ Owner item 9 (2026-09-24) — ONE gate for every Driftstack reading. A
    // SERVER-SEEDED entry (a proxy this Mac never tested: its readings came from
    // the account list or the automatic capability check) has no local verdict,
    // so it has no red "unreachable" pill for a reading to sit beside — which is
    // why the OS reading below already passed it. The QUIC and UDP readings were
    // held behind `isProxyUsable` alone, which a seeded placeholder can never
    // pass, so the same automatic check that measured all three showed "✓ Apple"
    // beside an untested QUIC and UDP ("has not been measured, but QUIC did").
    // Freshness is unchanged: each reading still ages by its own rule below.
    const readingsShowable = isProxyUsable(c.result) || c.serverSeeded === true;
    // (p) — a SERVER-SEEDED entry holds no local verdict and no local check: it
    // keys neither map, so the row reads as untested everywhere (no red pill from
    // a placeholder, no "Tested …" stamp for a check that never ran) while still
    // carrying the server's reading below.
    if (c.serverSeeded !== true) {
      testResults[id] = c.result;
      if (typeof c.at === 'number') testedAt[id] = c.at;
    }
    // (V-219) Aged HERE, beside the QUIC verdict, for the reason that comment
    // gives: every consumer must age identically, and dropping out of this map
    // is what "not measured" already means downstream.
    // (p) — the usable gate is "no OS verdict beside a red unreachable pill", and
    // a server-seeded row has no pill to sit beside: nothing here has probed it.
    // So the reading shows, under the SAME freshness rule — an old stored reading
    // is hidden exactly as an old local one is, because it is aged by the same
    // function against the stamp the server sent.
    // The AGED arm of each reading sits directly under its fresh one and repeats
    // its gate word for word, so the two cannot drift: a reading lands in the
    // fresh map, or (datable, under the cap) in `aged`, or nowhere.
    if (c.osFingerprint !== undefined && readingsShowable) {
      if (isOsFingerprintFresh(c.osFingerprint, nowMs)) osFingerprints[id] = c.osFingerprint;
      else if (isAgedReadingShowable(c.osFingerprint.at, nowMs))
        aged.osFingerprints[id] = { value: c.osFingerprint, atMs: c.osFingerprint.at };
    }
    if (c.serverLatencyMs !== undefined && isProxyUsable(c.result)) {
      serverLatency[id] = c.serverLatencyMs;
      // Keyed beside the number it dates and only when we can date it: an entry
      // written before `serverProbeAt` existed has no honest answer, and an
      // absent key reads as "we cannot say", never as "just now".
      if (typeof c.serverProbeAt === 'number') serverMeasuredAt[id] = c.serverProbeAt;
    }
    // W-30 — a verdict older than its TTL is dropped here rather than at the chip,
    // so every consumer ages identically: the Proxies grid, the profile card, and
    // anything added later. Falling out of this map is exactly "never measured",
    // which the chip already renders as the inferred `~`.
    if (c.quicMeasured !== undefined && readingsShowable) {
      if (isQuicVerdictFresh(c.quicMeasuredAt, nowMs)) quicMeasured[id] = c.quicMeasured;
      else if (c.quicMeasuredAt !== undefined && isAgedReadingShowable(c.quicMeasuredAt, nowMs))
        aged.quicMeasured[id] = { value: c.quicMeasured, atMs: c.quicMeasuredAt };
    }
    // T-1 — the vantage only means something beside the server number it
    // labels, so it follows the same usable-only rule; the node id rides with it.
    if (c.measuredFrom !== undefined && isProxyUsable(c.result))
      serverVantage[id] = {
        measuredFrom: c.measuredFrom,
        ...(c.nodeId !== undefined ? { nodeId: c.nodeId } : {}),
      };
    // The relay verdict is aged like the UDP one below it — see `isQuicProbeFresh`
    // for why it no longer speaks in the present tense for ever.
    if (c.quicProbe !== undefined && readingsShowable) {
      if (isQuicProbeFresh(c.quicProbeAt, nowMs)) quicProbe[id] = c.quicProbe;
      else if (c.quicProbeAt !== undefined && isAgedReadingShowable(c.quicProbeAt, nowMs))
        aged.quicProbe[id] = { value: c.quicProbe, atMs: c.quicProbeAt };
    }
    // (V6) — the UDP-relay verdict rides the same usable-only rule as the QUIC
    // one above it, AND the same freshness rule as `quicMeasured` two lines up.
    //
    // ⛔ It shipped aged by nothing, on the theory that it is "replaced by the next
    // check". It is not: a reply that measured nothing about UDP CARRIES it (the
    // rollout rule in `saveServerProbeResult`), so a measured `false` outlives every
    // subsequent check indefinitely while the "Tested" stamp beside it moves. Aged
    // HERE, beside its neighbours, so every consumer ages identically and dropping
    // out of this map means exactly what it already means downstream: not measured.
    if (c.udpProbe !== undefined && readingsShowable) {
      if (isUdpVerdictFresh(c.udpProbeAt, nowMs)) udpProbe[id] = c.udpProbe;
      else if (c.udpProbeAt !== undefined && isAgedReadingShowable(c.udpProbeAt, nowMs))
        aged.udpProbe[id] = { value: c.udpProbe, atMs: c.udpProbeAt };
    }
    if (c.exitIp !== undefined && isProxyUsable(c.result)) {
      exitResults[id] = {
        ip: c.exitIp,
        country: c.exitCountry ?? null,
        ...(c.exitCity !== undefined ? { city: c.exitCity } : {}),
        ...(c.exitRegion !== undefined ? { region: c.exitRegion } : {}),
        ...(c.exitTimezone !== undefined ? { timezone: c.exitTimezone } : {}),
        ...(c.exitAsnOrg !== undefined ? { asn_org: c.exitAsnOrg } : {}),
      };
      // Keyed only beside an exit that is actually surfaced, and only when it can
      // be dated: an entry written before `exitAt` existed has no honest answer,
      // and an absent key reads as "we cannot say", never as "just now".
      if (typeof c.exitAt === 'number') exitSeenAt[id] = c.exitAt;
    } else if (c.exitProbeFailedAt !== undefined && isProxyUsable(c.result)) {
      // (l) #14 — V-857's third state, reproduced from the cache: the proxy
      // is usable and the exit probe did not complete. `null`, not absent, so
      // an emit renders "exit geo unavailable" rather than "run Test".
      exitResults[id] = null;
    }
  }
  return {
    testResults,
    exitResults,
    testedAt,
    osFingerprints,
    serverLatency,
    quicMeasured,
    serverVantage,
    quicProbe,
    udpProbe,
    exitSeenAt,
    serverMeasuredAt,
    aged,
  };
}

export const PROBE_TTL_MS = 6 * 60 * 60 * 1000;

/** What a cached verdict is still worth. `untested` and `stale` are distinct:
 *  one has no evidence, the other has evidence we no longer trust, and the two
 *  deserve different words in front of a customer. */
export type ProbeFreshness = 'untested' | 'fresh' | 'stale';

/**
 * Classify a cached probe by age. Pure — `now` is injected — so every boundary
 * is testable without a clock.
 *
 * ⚠️ A timestamp in the FUTURE reads as fresh, which is what we want: it means
 * the host clock moved backwards (DST, an NTP correction, a VM resume), not
 * that the probe is old. Treating it as stale would re-probe every proxy the
 * customer owns on every clock adjustment.
 *
 * That behaviour falls out of the comparison — a negative age is below any
 * positive TTL — so there is deliberately NO special case for it here. An
 * earlier revision had an explicit `if (age < 0) return 'fresh'` guard; a
 * mutation test showed it could be deleted with no test failing, because it
 * could never change the result. It is gone rather than kept as decoration:
 * a branch that cannot alter behaviour still reads as load-bearing.
 */
export function probeFreshness(at: number | undefined, now: number): ProbeFreshness {
  if (at === undefined || !Number.isFinite(at)) return 'untested';
  return now - at >= PROBE_TTL_MS ? 'stale' : 'fresh';
}

/** True when a cached verdict is too old to present as current. `untested` is
 *  NOT stale — there is nothing to have gone off. */
export function isProbeStale(at: number | undefined, now: number): boolean {
  return isProbeStaleAfter(at, now, PROBE_TTL_MS);
}

/** (q) Item 13(c) — the same rule under a caller-chosen age: the sweep's
 *  app-open / focus triggers refresh rows older than a SHORT window (a green
 *  row probed 5 h ago that has since gone down stayed green on every open),
 *  while the steady interval and the display keep `PROBE_TTL_MS`. Same three
 *  answers as `probeFreshness`: undated / non-finite is NOT stale (nothing to
 *  have gone off), a future stamp is fresh (the clock moved, not the proxy). */
export function isProbeStaleAfter(at: number | undefined, now: number, ttlMs: number): boolean {
  if (at === undefined || !Number.isFinite(at)) return false;
  return now - at >= ttlMs;
}

// The "which proxies should a sweep refresh" selection lives ONLY in
// `planSweep` (proxy-probe-sweeper.ts). A simpler `staleProxyIds` used to sit
// here with zero callers; it was NOT a duplicate but a weaker version — it lacked
// the sweeper's three correctness exclusions (a deleted proxy's lingering entry,
// a non-SOCKS5 proxy a SOCKS5 handshake cannot probe informatively, and the
// failure-retry window), so any future caller reaching for it would have swept
// a customer's VPN fleet dead or probed a removed host. One selection, one
// definition: use `planSweep`.

const STORE_FILE = 'proxy-probe-cache.json';
const KEY = 'probes';
/** The automatic capability check's backoff ledger — see `CapabilityCheckAttempt`. */
const ATTEMPTS_KEY = 'capability_attempts';

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (store === null) {
    store = new LazyStore(STORE_FILE);
  }
  return store;
}

type ProbeCacheListener = (cache: ProbeCacheMap) => void;
const listeners = new Set<ProbeCacheListener>();

/**
 * Subscribe to cache writes. Returns an unsubscribe.
 *
 * Both views keep the cache in local state, and before this there was nothing
 * to tell them it had moved — so a background refresh would update the store
 * and leave every open surface rendering the OLD verdict. That is worse than
 * not sweeping at all: the customer would be reading a value we know to be
 * superseded while believing it current.
 */
export function subscribeProbeCache(fn: ProbeCacheListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Notify subscribers. Iterates a COPY, so a listener that unsubscribes itself
 *  during the callback cannot mutate the set mid-iteration; and a throwing
 *  listener is contained, because a broken subscriber must not turn a
 *  successful cache write into a failed one. */
function emitProbeCache(cache: ProbeCacheMap): void {
  for (const fn of [...listeners]) {
    try {
      fn(cache);
    } catch {
      /* a subscriber's fault is not the writer's problem */
    }
  }
}

// Serialize read-modify-write mutations so concurrent probes/invalidations
// can't clobber each other (defense-in-depth; the UI also gates one test at a
// time).
const writeLock = makeWriteLock();

/** N-2 — a stored fingerprint is kept only when every field is one the verdict
 *  can render; a value outside the closed set (a newer server, a corrupt store)
 *  drops the fingerprint, never the whole entry, and never defaults to green. */
function cleanOsFingerprint(raw: unknown): CachedOsFingerprint | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const f = raw as Record<string, unknown>;
  if (!isFingerprintedOs(f.os) || !isFingerprintConfidence(f.confidence)) return undefined;
  if (typeof f.reason !== 'string' || typeof f.at !== 'number') return undefined;
  // (o) O3 — the CAUSE survives the reload. This allowlist is the only way a field
  // outlives a load, so dropping it here would re-open the dead end on the next app
  // start: the placeholder would come back as a bare `os: 'unknown'` and the chip
  // would say "we looked and could not tell" about a row nothing ever looked at.
  // ⛔ `measuring` is deliberately NOT admitted — it is an in-flight UI sentinel, and
  // a persisted one would claim a probe was running across a restart.
  const unavailable = isOsFingerprintUnavailable(f.unavailable) ? f.unavailable : undefined;
  // WHICH MACHINE was read. On the wire as `observed_via` since the field was
  // introduced; the client dropped it here, which is how a reading of the
  // provider's front door reached the chip as a verdict about the exit. Both
  // spellings are admitted because the cache round-trips the camelCase form.
  const viaRaw = f.observedVia ?? f.observed_via;
  const observedVia = viaRaw === 'proxy_host' || viaRaw === 'exit_ip' ? viaRaw : undefined;
  return {
    os: f.os,
    confidence: f.confidence,
    reason: f.reason,
    at: f.at,
    // (V-219) `true` only when the stored record says so. A legacy entry written
    // before the field existed reads `undefined` and therefore FALSE — which is
    // the cautious direction: an old reading cannot promote itself into a
    // confident claim just by predating the check.
    ...(f.singleHostVantage === true ? { singleHostVantage: true as const } : {}),
    ...(f.webPortVantage === true ? { webPortVantage: true as const } : {}),
    ...(observedVia !== undefined ? { observedVia } : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

/** T-20 — a stored endpoint verdict is kept only when every field is present
 *  and typed; anything else is undefined, never a half-verdict. */
function cleanEndpointVerdict(raw: unknown): CachedEndpointVerdict | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  if (typeof e.resolved !== 'boolean' || typeof e.ip !== 'string' || typeof e.message !== 'string')
    return undefined;
  return { resolved: e.resolved, ip: e.ip, message: e.message };
}

function cleanEntry(raw: unknown): CachedProbe | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const res = r.result as Record<string, unknown> | undefined;
  if (typeof r.at !== 'number' || typeof res !== 'object' || res === null) return null;
  if (
    typeof res.reachable !== 'boolean' ||
    typeof res.auth_ok !== 'boolean' ||
    typeof res.udp_associate !== 'boolean' ||
    typeof res.latency_ms !== 'number' ||
    typeof res.message !== 'string'
  ) {
    return null;
  }
  const exitIp = typeof r.exitIp === 'string' ? r.exitIp : undefined;
  const exitCountry =
    typeof r.exitCountry === 'string' || r.exitCountry === null ? r.exitCountry : undefined;
  const optStr = (v: unknown): string | null | undefined =>
    typeof v === 'string' || v === null ? v : undefined;
  const exitCity = optStr(r.exitCity);
  const exitRegion = optStr(r.exitRegion);
  const exitTimezone = optStr(r.exitTimezone);
  const exitAsnOrg = optStr(r.exitAsnOrg);
  const osFingerprint = cleanOsFingerprint(r.osFingerprint);
  const serverLatencyMs = typeof r.serverLatencyMs === 'number' ? r.serverLatencyMs : undefined;
  // T-6 — a stored QUIC verdict outside the closed set is dropped, never coerced
  // (a corrupt store or a newer server must not resurrect as a green chip).
  const quicMeasured = cleanMeasuredQuic(r.quicMeasured) ?? undefined;
  const quicMeasuredAt =
    quicMeasured !== undefined && typeof r.quicMeasuredAt === 'number'
      ? r.quicMeasuredAt
      : undefined;
  // T-1 — a stored vantage outside the closed set is dropped (the number then
  // renders under the plain "server" marker), never shown under a label it did
  // not earn; the node id survives only beside 'fleet'. A stored relay verdict
  // is kept only as a boolean — a string "true" is not a measurement.
  const vantage = cleanServerVantage(r.measuredFrom, r.nodeId);
  const quicProbe = typeof r.quicProbe === 'boolean' ? r.quicProbe : undefined;
  // …and its date, kept only BESIDE the verdict it dates (the `udpProbeAt` rule
  // below). ⛔ This allowlist is the only way the stamp survives a load: dropped
  // here, every relay verdict comes back undatable on the next app start and the
  // chip falls to the inferred `~` until something re-measures it.
  const quicProbeAt =
    quicProbe !== undefined && typeof r.quicProbeAt === 'number' ? r.quicProbeAt : undefined;
  // (V6) — the stored UDP-relay verdict, kept only as a boolean for the reason
  // above it: a string "true" is not a measurement.
  const udpProbe = typeof r.udpProbe === 'boolean' ? r.udpProbe : undefined;
  // (V6, refuter #5) — and its date, kept only BESIDE the verdict it dates, the
  // same rule `quicMeasuredAt` obeys above. ⛔ This allowlist is the only way the
  // stamp survives a load: dropped here, every stored verdict comes back undatable
  // and `isUdpVerdictFresh` hides it — a green ✓ UDP that vanishes on app start.
  const udpProbeAt =
    udpProbe !== undefined && typeof r.udpProbeAt === 'number' ? r.udpProbeAt : undefined;
  // The two retirement stamps. ⛔ Dropped here, a retired reading comes back from
  // the account list on the first sync after every app start.
  const quicProbeRetiredAt =
    typeof r.quicProbeRetiredAt === 'number' ? r.quicProbeRetiredAt : undefined;
  const serverReadingsRetiredAt =
    typeof r.serverReadingsRetiredAt === 'number' ? r.serverReadingsRetiredAt : undefined;
  // T-17 — the exit identity's own stamp; absent reads as "not fresh".
  const exitAt = typeof r.exitAt === 'number' ? r.exitAt : undefined;
  // (l) #14 — the failed-exit-probe stamp; same allowlist rule as below.
  const exitProbeFailedAt =
    typeof r.exitProbeFailedAt === 'number' ? r.exitProbeFailedAt : undefined;
  // (h) — the server test's own stamp, and the fleet-failure stamp that keeps
  // a dropped exit from being adopted back. ⛔ This allowlist is the ONLY way a
  // field survives a load: a field written but not read here is gone on the
  // next emit, which is exactly a superseded exit coming back.
  const serverProbeAt = typeof r.serverProbeAt === 'number' ? r.serverProbeAt : undefined;
  const exitSupersededAt = typeof r.exitSupersededAt === 'number' ? r.exitSupersededAt : undefined;
  const fleetFailureReason =
    typeof r.fleetFailureReason === 'string' && r.fleetFailureReason.length > 0
      ? r.fleetFailureReason
      : undefined;
  // T-20 — an endpoint verdict is kept only whole; a partial one is dropped and
  // the entry then reads as a (non-usable) SOCKS5 verdict, which is the
  // conservative reading for both kinds of row.
  const endpoint = cleanEndpointVerdict(r.endpoint);
  // (p) — ⛔ THIS ALLOWLIST IS THE ONLY WAY THE FLAG SURVIVES A LOAD, and dropping
  // it does not fail quietly: the entry's fail-closed placeholder would come back
  // as an ordinary SOCKS5 verdict, and a proxy nobody has tested here would render
  // a red "not reachable" pill on the next app start. Only the literal `true`.
  const serverSeeded = r.serverSeeded === true ? (true as const) : undefined;
  return {
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(serverSeeded !== undefined ? { serverSeeded } : {}),
    ...(exitIp !== undefined ? { exitIp } : {}),
    ...(exitCountry !== undefined ? { exitCountry } : {}),
    ...(exitAt !== undefined ? { exitAt } : {}),
    ...(exitProbeFailedAt !== undefined ? { exitProbeFailedAt } : {}),
    ...(exitCity !== undefined ? { exitCity } : {}),
    ...(exitRegion !== undefined ? { exitRegion } : {}),
    ...(exitTimezone !== undefined ? { exitTimezone } : {}),
    ...(exitAsnOrg !== undefined ? { exitAsnOrg } : {}),
    ...(osFingerprint !== undefined ? { osFingerprint } : {}),
    ...(serverLatencyMs !== undefined ? { serverLatencyMs } : {}),
    ...(quicMeasured !== undefined ? { quicMeasured } : {}),
    ...(quicMeasuredAt !== undefined ? { quicMeasuredAt } : {}),
    ...(vantage !== undefined ? { measuredFrom: vantage.measuredFrom } : {}),
    ...(vantage?.nodeId !== undefined ? { nodeId: vantage.nodeId } : {}),
    ...(quicProbe !== undefined ? { quicProbe } : {}),
    ...(quicProbeAt !== undefined ? { quicProbeAt } : {}),
    ...(quicProbeRetiredAt !== undefined ? { quicProbeRetiredAt } : {}),
    ...(serverReadingsRetiredAt !== undefined ? { serverReadingsRetiredAt } : {}),
    ...(udpProbe !== undefined ? { udpProbe } : {}),
    ...(udpProbeAt !== undefined ? { udpProbeAt } : {}),
    ...(serverProbeAt !== undefined ? { serverProbeAt } : {}),
    ...(exitSupersededAt !== undefined ? { exitSupersededAt } : {}),
    ...(fleetFailureReason !== undefined ? { fleetFailureReason } : {}),
    at: r.at,
    result: {
      reachable: res.reachable,
      auth_ok: res.auth_ok,
      udp_associate: res.udp_associate,
      // G1 — the relay verdict survives a reload; a value this build does not
      // know reads as 'not_run' (never as a relay), and an absent one stays absent.
      ...(res.udp_relay !== undefined
        ? { udp_relay: udpRelayOf({ udp_relay: res.udp_relay }) }
        : {}),
      // A cache written before routing was measured has no verdict to restore.
      // Default to NOT usable rather than inheriting a green badge from an era
      // when "healthy" meant "authenticated" — a stale optimistic verdict is
      // the failure this whole change exists to end.
      can_route: typeof res.can_route === 'boolean' ? res.can_route : false,
      connect_reply: typeof res.connect_reply === 'number' ? res.connect_reply : 0xff,
      latency_ms: res.latency_ms,
      message: res.message,
    },
  };
}

/**
 * T-27 / W-30 — the persisted cache's schema version, and the one migration.
 *
 * ⛔ `quicMeasuredAt` was added in 3e4de3a36 together with the rule that an
 * ABSENT timestamp is NOT fresh. Every measured verdict persisted before that
 * commit has no timestamp, so on every install that had ever seen a green chip
 * the fix turned it into `~` and nothing would ever restore it: the stamp is
 * only written by a NEW server result or a NEW live observation, and the owner
 * item (#13, "QUIC never green") is exactly the customer who had one stored.
 *
 * The backfill stamps such an entry with its own `at` — the last time anything
 * was measured for that proxy — so it ages from a time we actually recorded
 * rather than being discarded. It runs ONCE, keyed on this version in the same
 * store: after the migration, an entry with a verdict and no stamp is once more
 * "we could not tell", and the not-fresh rule stands for it. A read-time
 * default would have weakened that rule for every entry forever.
 *
 * ⛔ VERSION 3 (2026-09-17) — THE SAME HOLE, ONE FIELD OVER, and it is an UPGRADE
 * CLIFF rather than a theory. `quicProbeAt` did not exist before gui-v0.1.63:
 * `git show gui-v0.1.62:…/proxy-probe-cache.ts | grep -c quicProbeAt` is 0 while
 * `quicProbe` appears 26 times, so every install that ever pressed Test before
 * that release holds a relay verdict with no date. An undated verdict is neither
 * fresh (the not-fresh rule above) nor aged (`isAgedReadingShowable` refuses an
 * absent stamp), so it is shown by NOTHING — a customer who tested yesterday and
 * updated sees "~ QUIC … not yet tested" about a proxy they had just proved, and
 * nothing restores it until they press Test again.
 *
 * `udpProbe` and `udpProbeAt` were added in the same commit (`grep -c udpProbe`
 * on the same v0.1.62 file is 0), so that pair has no hole; `osFingerprint.at`
 * is required by `cleanOsFingerprint` and a reading without it never survives a
 * load, so that one has no hole either. One field, one backfill.
 *
 * ⛔ VERSION 4 (proxy-accuracy audit S1) — a RETIREMENT, not a backfill. Every
 * `udpProbe` this app has stored for a SOCKS5 row came from the fleet node's bare
 * `udp_associate`, which is the node's OWN local relay granting UDP before the
 * customer's proxy is contacted: proxies that refuse UDP and proxies that drop
 * every datagram were stored as "UDP works". The server no longer sends that
 * value and its migration 0145 clears the copies it stored, but the copy on this
 * Mac would keep drawing ✓ UDP for eight hours and an aged one for thirty days.
 * See `retireLocalGrantUdpReadings`.
 */
export const PROBE_CACHE_SCHEMA_VERSION = 4;
const SCHEMA_KEY = 'probes_schema';

/** The one-time W-30 backfill, pure over a cleaned map. Returns the entries
 *  it changed (by id) so the caller can persist exactly those. Exported for
 *  the guard; production reaches it only through `loadProbeCache`. */
export function backfillQuicMeasuredAt(cache: ProbeCacheMap, loadTimeMs: number): string[] {
  const changed: string[] = [];
  for (const [id, c] of Object.entries(cache)) {
    if (c.quicMeasured === undefined || c.quicMeasuredAt !== undefined) continue;
    // `at` is the entry's own last-measured time; a non-finite one (a NaN that
    // survived `typeof === 'number'`) falls back to the load time rather than
    // stamping a value that no arithmetic can age.
    c.quicMeasuredAt = Number.isFinite(c.at) ? c.at : loadTimeMs;
    changed.push(id);
  }
  return changed;
}

/**
 * The V3 backfill — the same shape as the one above, for `quicProbeAt`.
 *
 * ⛔ THE STAMP IS `serverProbeAt ?? at`, IN THAT ORDER, and the order is the
 * whole correctness argument. `quicProbe` is written by ONE writer, the server
 * test, and `serverProbeAt` is that reply's own date — so it is the closest thing
 * on the entry to "when this verdict was measured". `at` is the NATIVE probe's
 * date and moves on every local re-test and every background sweep, so preferring
 * it would make a relay verdict look as young as the last reachability check.
 * Falling back to it anyway is right for an entry too old to carry either field:
 * a date we recorded beats no date, which is what "shown by nothing" means.
 *
 * ⛔⛔ (2026-09-17 review) AND IT IS CLAMPED INTO THE AGED BAND, because NEITHER
 * candidate is this verdict's own date. `saveServerProbeResult` writes
 * `serverProbeAt: at` on EVERY reply including a pure carry — and item A4 has
 * just made a carry the normal outcome — while the background sweep re-stamps
 * `at` about every fifteen minutes. That file says so on itself, about this very
 * field: "a CARRY keeps the original stamp, because a carry measured nothing and
 * may not make an old verdict look new. `serverProbeAt` is re-stamped on every
 * one of these replies, which is exactly why the verdict cannot borrow it."
 * Borrowing it here unclamped would have promoted a verdict of unknown age — a
 * year old, for all this entry can say — to a present-tense GREEN ✓ QUIC chip for
 * a full display window. Clamping to `loadTime - W` restores the value and lands
 * it in the AGED band (`isAgedReadingShowable`, thirty days): it speaks, muted
 * and dated, which is the whole difference between "we measured this recently"
 * and "we measured this, once". That is also what the item asked for in so many
 * words — a pre-upgrade entry renders AGED, not untested.
 *
 * `Math.min`, not a flat `loadTime - W`, so an entry that really was measured
 * moments before the upgrade keeps its older, honest date rather than being aged
 * forward to the boundary.
 *
 * Non-finite guards on both, same as above: a NaN that survived `typeof ===
 * 'number'` would stamp a value no arithmetic can age, so it takes the load time.
 *
 * Pure over a cleaned map; returns the ids it changed so the caller persists
 * exactly those. Exported for the guard; production reaches it only through
 * `loadProbeCache`.
 */
export function backfillQuicProbeAt(cache: ProbeCacheMap, loadTimeMs: number): string[] {
  const changed: string[] = [];
  // The newest a backfilled stamp may claim to be: exactly one display window
  // old, so the reading renders aged rather than current.
  const agedFloor = loadTimeMs - MEASURED_READING_TTL_MS;
  for (const [id, c] of Object.entries(cache)) {
    if (c.quicProbe === undefined || c.quicProbeAt !== undefined) continue;
    const serverAt = Number.isFinite(c.serverProbeAt) ? c.serverProbeAt : undefined;
    const borrowed = serverAt ?? (Number.isFinite(c.at) ? c.at : loadTimeMs);
    c.quicProbeAt = Math.min(borrowed, agedFloor);
    changed.push(id);
  }
  return changed;
}

/**
 * The V4 retirement — drop `udpProbe` / `udpProbeAt` from every entry that is not
 * an endpoint (VPN / HTTP) verdict: a SOCKS5 row this Mac tested, or one only
 * Driftstack measured. Those readings all came from the fleet node's local grant
 * (see the V4 note on `PROBE_CACHE_SCHEMA_VERSION`). An endpoint row's reading is
 * kept: the server only ever sent one beside the node's own sentence. Pure over a
 * cleaned map; returns the ids it changed. Exported for the guard.
 */
export function retireLocalGrantUdpReadings(cache: ProbeCacheMap): string[] {
  const changed: string[] = [];
  for (const [id, c] of Object.entries(cache)) {
    if (c.endpoint !== undefined) continue;
    if (c.udpProbe === undefined && c.udpProbeAt === undefined) continue;
    delete c.udpProbe;
    delete c.udpProbeAt;
    changed.push(id);
  }
  return changed;
}

export async function loadProbeCache(): Promise<ProbeCacheMap> {
  try {
    const raw = await getStore().get<Record<string, unknown>>(KEY);
    if (typeof raw !== 'object' || raw === null) return {};
    const out: ProbeCacheMap = {};
    for (const [id, entry] of Object.entries(raw)) {
      const clean = cleanEntry(entry);
      if (id.length > 0 && clean !== null) out[id] = clean;
    }
    await migrateOnce(out);
    return out;
  } catch {
    return {};
  }
}

/** Run the schema migration exactly once per store. Deliberately NOT under the
 *  write lock: every locked mutation calls `loadProbeCache` while holding it and
 *  the lock is not re-entrant. The write is idempotent, so the unlocked mount
 *  read racing a locked save can only write the same backfilled content twice.
 *  A store that refuses the write leaves the version unset; the migration then
 *  simply runs again on the next load, still producing the same result. */
async function migrateOnce(cache: ProbeCacheMap): Promise<void> {
  const store = getStore();
  const version = await store.get<unknown>(SCHEMA_KEY);
  if (typeof version === 'number' && version >= PROBE_CACHE_SCHEMA_VERSION) return;
  const loadTime = Date.now();
  // ⛔ EACH BACKFILL IS GATED ON THE VERSION IT WAS WRITTEN FOR, not on "we are
  // migrating". Running them all on every bump would re-run a COMPLETED one, and
  // for the V2 backfill that is not a no-op in principle: its own comment says
  // that after it has run, an entry with a verdict and no stamp is once more "we
  // could not tell", and the not-fresh rule stands for it. Re-stamping such an
  // entry at the next version bump would quietly weaken that rule for ever —
  // exactly the "read-time default" the V2 comment rejected, arriving by another
  // door. A store already at V2 therefore gets only the V3 pass.
  //
  // A `Set` because one entry can need both stamps (an install arriving from V1)
  // and the write loop below must not key it twice.
  const before = typeof version === 'number' ? version : 0;
  const changed = [
    ...new Set([
      ...(before < 2 ? backfillQuicMeasuredAt(cache, loadTime) : []),
      ...(before < 3 ? backfillQuicProbeAt(cache, loadTime) : []),
      ...(before < 4 ? retireLocalGrantUdpReadings(cache) : []),
    ]),
  ];
  try {
    // Only the migrated entries are written back — an unrelated entry the
    // cleaner dropped is left in the store exactly as every load before this
    // one left it.
    if (changed.length > 0) {
      const raw = (await store.get<Record<string, unknown>>(KEY)) ?? {};
      for (const id of changed) raw[id] = cache[id];
      await store.set(KEY, raw);
    }
    await store.set(SCHEMA_KEY, PROBE_CACHE_SCHEMA_VERSION);
    await store.save();
  } catch {
    /* the in-memory map is already backfilled; the version stays unset and the
       migration retries on the next load */
  }
}

/**
 * GUI audit #5 — sign-out forgets every cached reading (exits, locations, OS
 * and capability verdicts) and the automatic check's backoff ledger. They are
 * readings of the signed-out account's proxies, which sign-out removes too.
 * Subscribers are told, so an open surface drops what it was showing.
 */
export function forgetProbeCache(): Promise<void> {
  return writeLock(async () => {
    await getStore().set(KEY, {});
    await getStore().set(ATTEMPTS_KEY, {});
    await getStore().save();
    // The proxies these marks name are gone with the account. The edit COUNT
    // stays monotonic: a list sync compares against it.
    pendingMaterialEdits.clear();
    lastMaterialEdit.clear();
    emitProbeCache({});
  });
}

/** Record a probe result. `at` injected by the caller (Date.now()) so the
 *  function stays trivially testable. */
export function saveProbeResult(
  proxyId: string,
  result: ProxyTestResult,
  at: number,
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    // Preserve any prior exit-geo: the capability probe and the exit probe
    // run separately; a capability re-test must not erase known geo.
    const prior = all[proxyId];
    all[proxyId] = {
      result,
      at,
      ...(prior?.exitIp !== undefined ? { exitIp: prior.exitIp } : {}),
      ...(prior?.exitCountry !== undefined ? { exitCountry: prior.exitCountry } : {}),
      ...(prior?.exitCity !== undefined ? { exitCity: prior.exitCity } : {}),
      ...(prior?.exitRegion !== undefined ? { exitRegion: prior.exitRegion } : {}),
      ...(prior?.exitTimezone !== undefined ? { exitTimezone: prior.exitTimezone } : {}),
      ...(prior?.exitAsnOrg !== undefined ? { exitAsnOrg: prior.exitAsnOrg } : {}),
      // T-17 — the exit identity's own stamp travels with the geo it dates.
      ...(prior?.exitAt !== undefined ? { exitAt: prior.exitAt } : {}),
      // (l) #14 — and so does the failed-probe stamp: a capability re-test
      // says nothing about the exit, so the null state it recorded stands.
      ...(prior?.exitProbeFailedAt !== undefined
        ? { exitProbeFailedAt: prior.exitProbeFailedAt }
        : {}),
      ...(prior?.osFingerprint !== undefined ? { osFingerprint: prior.osFingerprint } : {}),
      // T-1/T-6 — the server latency and measured QUIC ride a separate call (the
      // control plane /test), so a native capability re-test must not erase them,
      // exactly like the exit-geo and the OS fingerprint above.
      ...(prior?.serverLatencyMs !== undefined ? { serverLatencyMs: prior.serverLatencyMs } : {}),
      ...(prior?.quicMeasured !== undefined ? { quicMeasured: prior.quicMeasured } : {}),
      ...(prior?.quicMeasuredAt !== undefined ? { quicMeasuredAt: prior.quicMeasuredAt } : {}),
      // T-1 — the vantage, its node, and the fleet QUIC-relay verdict label the
      // server number above; they survive a native re-test with it.
      ...(prior?.measuredFrom !== undefined ? { measuredFrom: prior.measuredFrom } : {}),
      ...(prior?.nodeId !== undefined ? { nodeId: prior.nodeId } : {}),
      ...(prior?.quicProbe !== undefined ? { quicProbe: prior.quicProbe } : {}),
      // Its DATE travels with it, unchanged — this re-test re-measured nothing
      // about QUIC and may not make an old verdict look new (the `udpProbeAt` rule).
      ...(prior?.quicProbeAt !== undefined ? { quicProbeAt: prior.quicProbeAt } : {}),
      // …and so does the record that a check RETIRED one: a native re-test says
      // nothing about QUIC, so it cannot lift the refusal of the reading retired.
      ...(prior?.quicProbeRetiredAt !== undefined
        ? { quicProbeRetiredAt: prior.quicProbeRetiredAt }
        : {}),
      // (V6) — and the fleet UDP-relay verdict with them: a native SOCKS5 re-test
      // measured nothing about the fleet's legs and must not erase one. Its DATE
      // travels with it, unchanged: this re-test did not re-measure UDP, so it may
      // not make an old verdict look new.
      ...(prior?.udpProbe !== undefined ? { udpProbe: prior.udpProbe } : {}),
      ...(prior?.udpProbeAt !== undefined ? { udpProbeAt: prior.udpProbeAt } : {}),
      ...(prior?.serverProbeAt !== undefined ? { serverProbeAt: prior.serverProbeAt } : {}),
      // ⛔ Proxy-accuracy audit G2 (b) — a Driftstack failure and the stamps that
      // retire readings survive a re-test from THIS Mac. This Mac's verdict never
      // retires Driftstack's (§4.3): the failure was a fact about the machine that
      // runs the profile, and a native handshake from here says nothing about it.
      // Dropped here, the next native Test — or the background sweep's — erased
      // "fails from Driftstack" and let the list put the pre-failure readings back.
      ...(prior?.exitSupersededAt !== undefined
        ? { exitSupersededAt: prior.exitSupersededAt }
        : {}),
      ...(prior?.fleetFailureReason !== undefined
        ? { fleetFailureReason: prior.fleetFailureReason }
        : {}),
      ...(prior?.serverReadingsRetiredAt !== undefined
        ? { serverReadingsRetiredAt: prior.serverReadingsRetiredAt }
        : {}),
    };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/** Persist a successful exit-geo probe onto the proxy's cache entry. The geo
 *  enrichment (city/region/timezone/asnOrg) is best-effort — pass null when
 *  lumtest was unreachable; the ip/country baseline still records. */
export function saveExitResult(
  proxyId: string,
  exitIp: string,
  exitCountry: string | null,
  geo: {
    city?: string | null;
    region?: string | null;
    timezone?: string | null;
    asnOrg?: string | null;
  } = {},
  /** T-17 — when the exit was measured. Defaults to now; injected by tests. */
  at: number = Date.now(),
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all; // exit probe only runs after a capability probe
    // ⛔ Proxy-accuracy audit G2 (c) — the stamp's two rules below are ENDPOINT
    // (VPN / HTTP) rules. On a tunnel the only exit is the one Driftstack sees, so
    // an exit seen after a failure is the tunnel seen up. A SOCKS5 row's exit is
    // measured from THIS Mac, which says nothing about the machine that runs the
    // profile: it neither is refused by a Driftstack failure nor lifts one.
    const endpointRow = prior.endpoint !== undefined;
    // (h) — an observation dated at or before the fleet failure that dropped
    // this row's exit describes the tunnel BEFORE it went down; it is not
    // adopted, whoever offers it. A later one clears the stamp: the tunnel
    // was seen up again.
    if (endpointRow && prior.exitSupersededAt !== undefined && at <= prior.exitSupersededAt)
      return all;
    // …and an exit seen AFTER the failure is the tunnel seen up: the failure
    // verdict goes with the stamp (finding 3 — the sentence lives here now).
    // (l) #14 — a measured exit is the answer the failed probe lacked.
    const { exitProbeFailedAt: _probeFailed, ...rest } = prior;
    const { exitSupersededAt: _superseded, fleetFailureReason: _failure, ...withoutFailure } = rest;
    const kept = endpointRow ? withoutFailure : rest;
    all[proxyId] = {
      ...kept,
      exitIp,
      exitCountry,
      exitCity: geo.city ?? null,
      exitRegion: geo.region ?? null,
      exitTimezone: geo.timezone ?? null,
      exitAsnOrg: geo.asnOrg ?? null,
      exitAt: at,
    };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/**
 * (l) #14 — record that a native exit probe through a USABLE proxy did not
 * complete. The entry's exit fields go (they were an EARLIER probe's answer,
 * and `saveProbeResult` had just carried them across this Test's capability
 * write) and `exitProbeFailedAt` is stamped, so the derivation emits the null
 * "exit geo unavailable" state from now on instead of the previous exit. Rides
 * on an existing entry; none is invented. Cleared by the next `saveExitResult`.
 */
export function clearExitResult(proxyId: string, at: number = Date.now()): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all;
    const {
      exitIp: _ip,
      exitCountry: _country,
      exitCity: _city,
      exitRegion: _region,
      exitTimezone: _tz,
      exitAsnOrg: _asn,
      exitAt: _exitAt,
      ...kept
    } = prior;
    all[proxyId] = { ...kept, exitProbeFailedAt: at };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/** N-2 — persist the control plane's passive OS fingerprint onto the proxy's
 *  cache entry. Like the exit-geo it rides on an existing capability entry and
 *  is preserved across re-tests; a proxy with no entry has nothing to attach
 *  it to, and none is invented. */
export function saveOsFingerprint(
  proxyId: string,
  fp: OsFingerprint,
  at: number,
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all;
    all[proxyId] = { ...prior, osFingerprint: cachedFingerprint(fp, at) };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/**
 * The stored form of a reading, built in ONE place.
 *
 * (o) O3 — the reported cause is written beside the reading it stands in for;
 * without it the next load reproduces a bare `unknown` and the dead-end hint.
 * ⛔⛔ (V-219) THE SECOND PLACE THE VANTAGE DIED. This rebuilds the record field by
 * field, and it copied five of them — losing `observedVia` IMMEDIATELY, not merely
 * across a restart. The load-path allowlist (`cleanOsFingerprint`) faithfully admits
 * the field, so it looked covered; there was simply never anything in the store for
 * it to admit, because this was the only mint path. The grid reads the cache-derived
 * map, so the chip had never seen a vantage on a real row.
 *
 * A field-by-field rebuild is the shape that caused this. Anything added to the
 * reading must be added HERE as well, or it is silently discarded.
 *
 * ⛔ (p) 2026-09-16 — and it is a FUNCTION now precisely because there are two mint
 * paths since the account list started carrying the server's stored reading. Two
 * copies of this rebuild is two places to forget the next field in, which is the
 * exact failure written above; the seeder below calls this one.
 */
function cachedFingerprint(fp: OsFingerprint, at: number): CachedOsFingerprint {
  return {
    os: fp.os,
    confidence: fp.confidence,
    reason: fp.reason,
    at,
    ...(fp.observedVia !== undefined ? { observedVia: fp.observedVia } : {}),
    ...(fp.singleHostVantage === true ? { singleHostVantage: true as const } : {}),
    // (V-219) Named beside its twin: a field-by-field rebuild that omits it
    // discards it silently — the drop that happened twice to `observedVia`.
    ...(fp.webPortVantage === true ? { webPortVantage: true as const } : {}),
    ...(fp.unavailable !== undefined ? { unavailable: fp.unavailable } : {}),
  };
}

/**
 * Whether the OS reading the SERVER holds, dated `at`, must NOT be written onto
 * this entry. Pure; shared by the list adoption's pre-check and the locked write.
 *
 * Never rewinds (a reading at or before the one held), and never resurrects: the
 * two stamps that refuse a stored QUIC / UDP reading refuse this one too
 * (`serverCapabilityReadingsToAdopt`). A check that found the tunnel down dropped
 * the OS reading with every other server-measured field, and so did an address
 * check that could not confirm the endpoint is where it was — and the account,
 * which stores nothing on a failure and knows nothing of this Mac's DNS, still
 * holds the reading from BEFORE either. MEASURED without this: the QUIC and UDP
 * readings were refused and the OS chip alone came back beside "tunnel down", and
 * beside an address nobody had fingerprinted. A reading dated after the stamp was
 * taken since, and is adopted.
 */
export function refusesServerOsReading(prior: CachedProbe | undefined, at: number): boolean {
  if (prior === undefined) return false;
  if (prior.osFingerprint !== undefined && prior.osFingerprint.at >= at) return true;
  return [prior.exitSupersededAt, prior.serverReadingsRetiredAt].some(
    (t) => t !== undefined && at <= t,
  );
}

/**
 * (p) 2026-09-16 — write the reading the SERVER holds for this proxy (the account
 * list's `os_fingerprint`, dated by its `os_fingerprint_at`) into the same field a
 * local test writes, so every surface reads ONE map and a reading taken on another
 * Mac — or before a reinstall — shows here.
 *
 * ⛔ Unlike `saveOsFingerprint` this one INVENTS AN ENTRY when there is none, and
 * that is the whole point: the machine that has never tested this proxy is exactly
 * the machine with nothing to attach a reading to. The invented entry is marked
 * `serverSeeded`, so it carries the reading and asserts NOTHING about reachability
 * — see the flag's own note for what would happen if that mark were lost.
 *
 * ⛔ NEVER REWINDS and never churns: a reading at or before the one already stored
 * writes nothing, so a local test measured minutes ago outranks the list's copy of
 * an older one, and a poll every few seconds does not rewrite the store each tick.
 * Freshness is NOT judged here — `deriveProbeViewState` ages every reading with the
 * one TTL, and a second rule here could only disagree with it.
 *
 * ⛔ …and NEVER RESURRECTS — see `refusesServerOsReading`, the one decision this
 * writer and the adoption's pre-check both make.
 */
export function seedServerOsFingerprint(
  proxyId: string,
  fp: OsFingerprint,
  at: number,
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (refusesServerOsReading(prior, at)) return all;
    const base: CachedProbe = prior ?? {
      result: SERVER_SEEDED_PLACEHOLDER_RESULT,
      at,
      serverSeeded: true,
    };
    all[proxyId] = { ...base, osFingerprint: cachedFingerprint(fp, at) };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/**
 * The entry a row with NO local verdict rides on when an AUTOMATIC capability
 * check answers for it: the same fail-closed, `serverSeeded` placeholder the
 * account-list adoption invents, so the reply's readings have somewhere to land
 * and the row still asserts nothing about reachability. A no-op (no store write)
 * when the row already has an entry of any kind.
 */
export function ensureServerSeededEntry(proxyId: string, at: number): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    if (all[proxyId] !== undefined) return all;
    all[proxyId] = { result: SERVER_SEEDED_PLACEHOLDER_RESULT, at, serverSeeded: true };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/** A reading the SERVER holds, with the date the server took it (epoch ms). */
export interface DatedServerReading<T> {
  value: T;
  at: number;
}

/** The capability readings the account list (or a /test reply that measured
 *  neither leg) carries for one row. Each is independent; absent = the server
 *  holds none, cannot date it, or predates the field. */
export interface ServerCapabilityReadings {
  quicMeasured?: DatedServerReading<MeasuredQuic>;
  quicProbe?: DatedServerReading<boolean>;
  udpProbe?: DatedServerReading<boolean>;
}

/**
 * Which of the server's readings THIS entry should adopt. Pure, and the one
 * decision both the adoption's pre-check and the locked write make.
 *
 * ⛔ NEWER WINS, BY THE READING'S OWN DATE — never by arrival. A reading at or
 * before the one already held writes nothing, so a Test run here minutes ago
 * outranks the list's copy of an older one and a poll does not rewrite the store
 * every tick. A local reading with NO stamp is the one exception: it is shown by
 * nothing (undatable is neither fresh nor aged), so a datable reading replaces it.
 *
 * ⛔ …and NEVER RESURRECT, the rule the exit adoption keeps: a check that found
 * this proxy down dropped every server-measured field and stamped when
 * (`exitSupersededAt`). The server stores nothing on a failed test, so its row
 * still carries the readings from BEFORE that failure, and adopting one dated at
 * or before the stamp would put a relay chip back beside "tunnel down".
 *
 * ⛔ The same rule has two more stamps, because a failure is not the only thing
 * that retires a reading while the server keeps its copy. A check that RAN the
 * relay leg and reached no verdict removes the relay verdict
 * (`quicProbeRetiredAt`), and an endpoint found at a different address drops every
 * server-measured field (`serverReadingsRetiredAt`). MEASURED without them: an
 * entry with no relay verdict admits any datable one, so the next list sync put
 * the retired `true` back — as a CURRENT green chip when the stored reading was
 * under thirty minutes old, seconds after the check that retired it.
 */
export function serverCapabilityReadingsToAdopt(
  prior: CachedProbe | undefined,
  readings: ServerCapabilityReadings,
): ServerCapabilityReadings {
  const admits = (
    incoming: DatedServerReading<unknown> | undefined,
    held: unknown,
    heldAt: number | undefined,
    /** This leg's own retirement stamp, when it has one. */
    legRetiredAt?: number,
  ): boolean => {
    if (incoming === undefined || !Number.isFinite(incoming.at)) return false;
    const retiredAt = [prior?.exitSupersededAt, prior?.serverReadingsRetiredAt, legRetiredAt];
    if (retiredAt.some((t) => t !== undefined && incoming.at <= t)) return false;
    return held === undefined || heldAt === undefined || heldAt < incoming.at;
  };
  const adopt: ServerCapabilityReadings = {
    ...(readings.quicMeasured !== undefined &&
    admits(readings.quicMeasured, prior?.quicMeasured, prior?.quicMeasuredAt)
      ? { quicMeasured: readings.quicMeasured }
      : {}),
    ...(readings.quicProbe !== undefined &&
    admits(readings.quicProbe, prior?.quicProbe, prior?.quicProbeAt, prior?.quicProbeRetiredAt)
      ? { quicProbe: readings.quicProbe }
      : {}),
    ...(readings.udpProbe !== undefined &&
    admits(readings.udpProbe, prior?.udpProbe, prior?.udpProbeAt)
      ? { udpProbe: readings.udpProbe }
      : {}),
  };
  // ⛔ …and never adopt a reading only to retire it. The live verdict and the
  // Test's verdict answer ONE question, and the writer keeps the later of two that
  // contradict (see `seedServerCapabilityReadings`). An incoming reading that would
  // lose that comparison on arrival is not adopted at all — adopted-then-deleted
  // reads as "written" to the caller, and the next poll would write it again, and
  // the one after: the store rewritten every tick to change nothing.
  const live =
    adopt.quicMeasured ??
    (prior?.quicMeasured !== undefined
      ? { value: prior.quicMeasured, at: prior.quicMeasuredAt }
      : undefined);
  const relay =
    adopt.quicProbe ??
    (prior?.quicProbe !== undefined
      ? { value: prior.quicProbe, at: prior.quicProbeAt }
      : undefined);
  // (An undated LIVE verdict is shown by nothing and contests nothing — the same
  // condition the writer's own comparison opens with.)
  if (
    live !== undefined &&
    relay !== undefined &&
    live.at !== undefined &&
    (live.value === 'h3') !== relay.value
  ) {
    if (relay.at === undefined || relay.at <= live.at) delete adopt.quicProbe;
    else delete adopt.quicMeasured;
  }
  return adopt;
}

/**
 * Write the capability readings the SERVER holds for this proxy into the fields a
 * local check writes — the twin of `seedServerOsFingerprint`, for the live QUIC
 * verdict and the Test's QUIC / UDP readings, and for the same reason: a proxy
 * checked on another Mac, or before a reinstall, otherwise shows nothing here.
 *
 * Like that seeder it INVENTS a `serverSeeded` entry when there is none, judges
 * NO freshness (the derivation ages every reading, fresh or aged, by the one
 * rule), and re-checks the newer-wins decision under the lock.
 *
 * ⛔ THE LATER MEASUREMENT RETIRES THE ONE IT CONTRADICTS — the rule
 * `saveObservedQuic` and `saveServerProbeResult` already keep between the live
 * verdict and the relay verdict, applied by DATE because an adopted reading is
 * dated in the past: a live `h2-only` adopted here retires a relay `true` only
 * when that relay verdict is not the newer of the two, and the mirror likewise.
 * Without it the chip's strongest-evidence order would let an older live verdict
 * mask a newer relay reading the server has since stored.
 */
export function seedServerCapabilityReadings(
  proxyId: string,
  readings: ServerCapabilityReadings,
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    const adopt = serverCapabilityReadingsToAdopt(prior, readings);
    const stamps = [adopt.quicMeasured?.at, adopt.quicProbe?.at, adopt.udpProbe?.at].filter(
      (t): t is number => t !== undefined,
    );
    if (stamps.length === 0) return all;
    const next: CachedProbe = {
      ...(prior ?? {
        result: SERVER_SEEDED_PLACEHOLDER_RESULT,
        at: Math.max(...stamps),
        serverSeeded: true as const,
      }),
    };
    if (adopt.quicMeasured !== undefined) {
      next.quicMeasured = adopt.quicMeasured.value;
      next.quicMeasuredAt = adopt.quicMeasured.at;
    }
    if (adopt.quicProbe !== undefined) {
      next.quicProbe = adopt.quicProbe.value;
      next.quicProbeAt = adopt.quicProbe.at;
    }
    if (adopt.udpProbe !== undefined) {
      next.udpProbe = adopt.udpProbe.value;
      next.udpProbeAt = adopt.udpProbe.at;
    }
    const contradicts =
      (next.quicMeasured === 'h3' && next.quicProbe === false) ||
      (next.quicMeasured === 'h2-only' && next.quicProbe === true);
    if (contradicts && next.quicMeasuredAt !== undefined) {
      // An undatable relay verdict cannot be shown to be the later one, so it
      // yields; otherwise the older of the two goes, and a tie keeps the live one.
      if (next.quicProbeAt === undefined || next.quicProbeAt <= next.quicMeasuredAt) {
        delete next.quicProbe;
        delete next.quicProbeAt;
      } else {
        delete next.quicMeasured;
        delete next.quicMeasuredAt;
      }
    }
    all[proxyId] = next;
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/** T-1/T-6 — persist the control plane's server-measured latency and the QUIC
 *  verdict it measured in the /test session onto the proxy's cache entry. Like
 *  the exit-geo and OS fingerprint it rides on an existing capability entry (the
 *  native probe ran first) and is preserved across re-tests; a proxy with no
 *  entry has nothing to attach to, and none is invented. The QUIC verdict is a
 *  closed set — a value outside it is dropped, never stored as a would-be green
 *  chip; a fresh valid verdict updates the prior one, and an absent one keeps
 *  the last measurement rather than erasing it.
 *
 *  T-1 — the vantage (measuredFrom + nodeId) and the fleet QUIC-relay verdict
 *  (quicProbe) describe THIS measurement, not the proxy's history, so unlike
 *  quicMeasured they are REPLACED by every server result: present → stored,
 *  absent → removed — unless the caller reports that the node never RAN the
 *  QUIC leg (`quicSkipped`), which is not an absence of verdict but an absence
 *  of measurement. A control-plane fallback after a fleet run must not keep
 *  wearing the fleet label or the fleet relay chip — that is the silent fallback
 *  the owner item forbids. The vantage itself is a closed set (see
 *  proxy-vantage.ts); a value outside it stores as "unlabelled". */
export function saveServerProbeResult(
  proxyId: string,
  server: {
    /** T-1 — a number STORES, `null` CLEARS, `undefined` leaves what is there.
     *  Three answers, not two: a fleet result can be ok with no timing, and
     *  merging that with "nothing new this time" is what leaves a stale number
     *  on the card after a measurement that produced none. */
    latencyMs?: number | null;
    quicMeasured?: MeasuredQuic | null;
    quicMeasuredAt?: number;
    measuredFrom?: ProxyVantage;
    nodeId?: string;
    quicProbe?: boolean;
    /** (V5 2026-09-12) — the node did NOT RUN the QUIC leg on this test
     *  (`quic_detail: "skipped: …"`), so the absent `quicProbe` above is a
     *  non-measurement, not "the Mac ran the leg and produced none". Same
     *  standing as a control-plane fallback below: nothing about QUIC was
     *  measured, so the last fleet verdict stands. */
    quicSkipped?: boolean;
    /**
     * ⛔ (2026-09-17) POSITIVE EVIDENCE THAT THE LEG RAN AND REACHED NO VERDICT —
     * the ONLY thing that may now retire a stored relay verdict.
     *
     * Until today the retirement was driven by ABSENCE: a fleet-vantage reply
     * that carried no `quic_probe` and no "skipped:" detail retired the verdict.
     * But the control plane's own schema says `quic_ok` null = NOT MEASURED
     * (apps/server/src/schemas/harness-control-protocol.ts) and the route OMITS
     * the field for a non-measurement — so a reply that simply lacks the key,
     * for any reason the client cannot see, threw away a true green verdict AND
     * blocked the next list sync from adopting the stored one back. That is the
     * owner's "a proxy was green on quic, and later not green box".
     *
     * The caller sets this only when the node SAID something about the leg (a
     * `quic_detail` that is not "skipped: …") while sending no verdict. Absence
     * of the detail is now absence of evidence, and carries — the rule the UDP
     * leg below has always had.
     */
    quicRan?: boolean;
    /** (V6 2026-09-16) ITEM 3 — the fleet Mac's MEASURED UDP-relay verdict.
     *  A boolean REPLACES the stored one; absent means this reply measured
     *  nothing about UDP and the stored one stands (see the write below). */
    udpProbe?: boolean;
  },
  at: number,
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all;
    let quic = cleanMeasuredQuic(server.quicMeasured) ?? undefined;
    const vantage = cleanServerVantage(server.measuredFrom, server.nodeId);
    // (h) finding 3 — a server VERDICT replaces the fleet-failure sentence
    // too: this is the "next fleet answer" that clears it.
    // ⛔ Proxy-accuracy audit G2 (f) — and ONLY a fleet answer. A control-plane
    // fallback reached the proxy from a different machine; it is shown as its own
    // labelled reading and says nothing about the machine that failed.
    const {
      measuredFrom: _m,
      nodeId: _n,
      quicProbe: _q,
      quicProbeAt: _qa,
      quicProbeRetiredAt: priorRelayRetiredAt,
      udpProbe: _u,
      udpProbeAt: _ua,
      fleetFailureReason: priorFailure,
      ...kept
    } = prior;
    const failureStands = priorFailure !== undefined && vantage?.measuredFrom !== 'fleet';
    // An explicit null erases the stored number so it cannot outlive the
    // measurement that failed to produce one. `undefined` deliberately does not.
    if (server.latencyMs === null) delete kept.serverLatencyMs;
    // ⛔ (V-219) THE MIRROR of the rule in `saveObservedQuic`, and it has to be
    // here or the same defect runs the other way: a NEWER relay measurement is
    // masked by an OLDER live verdict, which outranks it in the chip, until that
    // verdict expires half an hour later.
    //
    // ⛔⛔ (G8 / logic-07) — and the live verdict it is weighed against is BOTH the
    // one already in the cache AND the one this very reply carries back. account-me
    // echoes the row's stored `quic_measured` on the /test response (it is a dated
    // reading, not a fresh measurement), so a fresh relay `quic_ok:false` used to
    // land beside an h3 measured 20 min earlier and the h3 — re-stored from the
    // reply — won the chip. It used to guard on `quic === undefined`, which is
    // exactly the case where the reply carries no live verdict; a reply that DID
    // carry one skipped this rule and re-seeded the stale green. Treat the incoming
    // `quic_measured` as the dated reading it is and let the LATER date win, a tie
    // keeping the live one, exactly as `seedServerCapabilityReadings` does.
    //
    // Only when THIS result actually measured the relay (`server.quicProbe` a
    // boolean -- a carried verdict re-measured nothing and retires nothing), and
    // only when the relay is STRICTLY newer than the live verdict: a live
    // observation that landed while the server test was in flight (dated after
    // `at`), or one dated at the same instant, is the later evidence and must not
    // be retired by it.
    const liveValue = quic ?? kept.quicMeasured;
    const liveAt = quic !== undefined ? (server.quicMeasuredAt ?? at) : kept.quicMeasuredAt;
    const liveContradicted =
      typeof server.quicProbe === 'boolean' &&
      (liveAt === undefined || liveAt < at) &&
      ((server.quicProbe && liveValue === 'h2-only') || (!server.quicProbe && liveValue === 'h3'));
    if (liveContradicted) {
      // Drop the loser whether it came from the cache (`kept`) or from this reply
      // (`quic`): the write below spreads `kept` and then the incoming `quic`, so
      // both sources must be cleared or the reply's copy would still be stored.
      quic = undefined;
      delete kept.quicMeasured;
      delete kept.quicMeasuredAt;
    }
    all[proxyId] = {
      ...kept,
      ...(failureStands ? { fleetFailureReason: priorFailure } : {}),
      ...(typeof server.latencyMs === 'number' ? { serverLatencyMs: server.latencyMs } : {}),
      ...(quic !== undefined
        ? { quicMeasured: quic, quicMeasuredAt: server.quicMeasuredAt ?? at }
        : {}),
      ...(vantage !== undefined ? { measuredFrom: vantage.measuredFrom } : {}),
      ...(vantage?.nodeId !== undefined ? { nodeId: vantage.nodeId } : {}),
      // (q) Item 3 residual — the relay verdict is REPLACED by a fleet answer
      // (present → stored, absent → the Mac ran and produced none → removed),
      // but a CONTROL-PLANE fallback measured nothing about QUIC: the server
      // never emits `quic_ok` off that path, so erasing here turned a green
      // relay chip back to '~' with no cause named, on a fleet miss the
      // customer did not cause. The fleet's last relay fact stands; the
      // vantage/node above still flip to the control plane, so the fallback
      // itself is never silent.
      //
      // ⛔ (V5 2026-09-12) — and the SAME is true of a fleet reply whose QUIC
      // leg the node SKIPPED. `quic_detail: "skipped: …"` is the node's own
      // word for "that leg never ran" (the documented VPN path: the route then
      // omits `quic_ok` — account-me.ts — and the parse refuses one beside the
      // detail — account-proxies.ts), so the absence here is a NON-measurement
      // exactly like the control plane's. MEASURED in the running harness on
      // 2026-09-12, real ProxiesView, real wire body: a SUCCESSFUL re-check of
      // an OpenVPN row (TUNNEL UP · 61 ms from the test Mac · exit + city) turned
      // its green `✓ QUIC` into `QUIC untested` whose hover read "Not measured
      // yet — run Check VPN" — the button that had just run — and on the profile
      // card the chip disappeared from the face altogether. `quicSkipped` is the
      // caller's report of that detail; a fleet answer that RAN the leg and
      // produced no verdict still drops the prior one (the control this rule
      // must not swallow).
      //
      // ⛔ The DATE follows the rule `udpProbeAt` follows below: a MEASUREMENT
      // stamps `at`; a CARRY keeps the original stamp, because a carry measured
      // nothing and may not make an old verdict look new. `serverProbeAt` is
      // re-stamped on every one of these replies, which is exactly why the
      // verdict cannot borrow it.
      //
      // ⛔ AND THE THIRD CASE LEAVES A STAMP. The leg ran and reached no verdict, so
      // the verdict goes — and the SERVER, which writes nothing for such a leg,
      // still holds the one from before. `quicProbeRetiredAt` is what stops the next
      // list sync from adopting it back (`serverCapabilityReadingsToAdopt`). A
      // MEASURED leg drops the stamp (its verdict is newer than anything retired);
      // a carry keeps whatever stamp the entry held, having retired nothing.
      //
      // ⛔⛔ (2026-09-17) THE ORDER OF THE LAST TWO ARMS IS REVERSED, and that is
      // the fix. It used to read "carry if the caller could NAME a reason nothing
      // was measured, else retire", which makes ABSENCE OF EVIDENCE the trigger
      // for throwing a verdict away: every reply that lacked `quic_ok` for a
      // reason this client cannot see — the server's schema documents null as NOT
      // MEASURED and the route omits the key entirely — retired a green relay
      // chip and stamped the entry so the next list sync could not adopt the
      // stored verdict back either. A customer watched QUIC go green and then
      // grey with nothing having changed about their proxy.
      //
      // Now it reads "retire only on POSITIVE evidence the leg ran and produced
      // none (`quicRan`), else carry" — the rule the UDP leg below has always
      // had, and the control this must not swallow is preserved rather than
      // dropped: a MEASURED false still lands in the first arm and replaces the
      // stored verdict with a negative one. `quicSkipped` stays as an explicit
      // veto, so a node that somehow sent both a "skipped:" detail and whatever
      // the caller read as "ran" cannot retire anything.
      ...(typeof server.quicProbe === 'boolean'
        ? { quicProbe: server.quicProbe, quicProbeAt: at }
        : server.quicRan === true && server.quicSkipped !== true
          ? { quicProbeRetiredAt: at }
          : {
              ...(typeof prior.quicProbe === 'boolean'
                ? {
                    quicProbe: prior.quicProbe,
                    ...(prior.quicProbeAt !== undefined ? { quicProbeAt: prior.quicProbeAt } : {}),
                  }
                : {}),
              ...(priorRelayRetiredAt !== undefined
                ? { quicProbeRetiredAt: priorRelayRetiredAt }
                : {}),
            }),
      // (V6 2026-09-16) ITEM 3 — the UDP-relay verdict, and its rule is SIMPLER
      // than the QUIC one above on purpose. `quicProbe` has THREE incoming states
      // (measured / the node ran the leg and reached no verdict / the node never
      // ran it), which is why that clause needs `quicSkipped` to tell the last two
      // apart. UDP has two: the control plane now emits `udp_associate` if and only
      // if it is a reading, so ABSENCE IS ALWAYS A NON-MEASUREMENT — an explicit
      // null, a skipped leg, a VPN row's asserted literal, or a control-plane
      // fallback — and a non-measurement may never retire a measurement.
      //
      // ⛔ That carry is load-bearing through the node rollout: a fleet with one
      // migrated Mac and one legacy Mac would otherwise erase a real verdict every
      // time the legacy one happened to answer — the "a successful re-check turns
      // the green chip untested" defect (V5), arriving through the field added
      // beside the one it was fixed for. A leg that RAN always produces true or
      // false, so nothing honest is being suppressed here.
      //
      // ⛔ AND THE CARRY IS WHY THE VERDICT NEEDS A DATE OF ITS OWN (refuter #5).
      // `serverProbeAt` below is re-stamped on every one of these replies, so an
      // undated verdict carried across them reads as current for ever — "No UDP
      // through this tunnel — measured from Driftstack's network" beside "Tested
      // just now", about a measurement nothing has repeated. A MEASUREMENT stamps
      // `at`; a CARRY keeps the original stamp, because a carry measured nothing
      // and may not make an old verdict look new; `isUdpVerdictFresh` then bounds
      // how long either may speak in the present tense.
      ...(typeof server.udpProbe === 'boolean'
        ? { udpProbe: server.udpProbe, udpProbeAt: at }
        : typeof prior.udpProbe === 'boolean'
          ? {
              udpProbe: prior.udpProbe,
              ...(prior.udpProbeAt !== undefined ? { udpProbeAt: prior.udpProbeAt } : {}),
            }
          : {}),
      // (h) — when THIS server test ran, so a VPN row's "Tested" can date the
      // fleet number it shows rather than the pre-flight that preceded a
      // refusal.
      serverProbeAt: at,
    };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/**
 * (h) — record that a fleet test FAILED to bring a VPN row's tunnel up.
 *
 * ⛔ A failed fleet verdict used to write NOTHING, on the theory that the
 * native probe's entry stands and the views drop what they hold. For a VPN row
 * the fleet IS the verdict, and the entry still held the previous SUCCESSFUL
 * fleet fields (carried over by the pre-flight that ran seconds earlier), so
 * the very next cache emit from ANY writer — a SOCKS5 row's Test, the
 * background sweeper — re-hydrated the grid with a fleet-labelled latency, an
 * exit IP and a relay chip beside the red "tunnel down"; and a Re-check of the
 * failed row flashed "tunnel up" for the whole fleet wait.
 *
 * Every server-measured field goes (latency, vantage, node, relay verdict, OS
 * fingerprint, the live session's QUIC verdict, the exit and its geo) and the
 * exit is marked SUPERSEDED at `at`: the account list still carries the exit
 * the last session saw through this tunnel, and the list adoption must not
 * put it back. The verdict triple (`result` / `at` / `endpoint`) is untouched —
 * the endpoint DID resolve; what failed is the tunnel behind it. Rides on an
 * existing entry; none is invented.
 */
export function saveFleetFailure(
  proxyId: string,
  at: number,
  /** (h) finding 3 — the fleet's sentence, persisted so every surface that
   *  reads this entry (the grid after a remount, the profile card for a check
   *  the grid ran) renders the same "tunnel down". Empty = no sentence. */
  reason = '',
  /**
   * ⛔ Proxy-accuracy audit G2 (a) — a SOCKS5 row: keep what THIS Mac measured.
   * The fleet refusing a SOCKS5 proxy says nothing about the native verdict or
   * the exit this Mac saw through it (a tunnel has no exit but Driftstack's, which
   * is why the default drops it). Every Driftstack reading still goes, the stamp
   * dates the failure, and a `serverSeeded` entry stays seeded — a failure the
   * list carries onto a row this Mac never tested is not a local verdict.
   */
  opts: { keepNativeExit?: boolean } = {},
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all;
    const native = opts.keepNativeExit === true;
    all[proxyId] = {
      result: prior.result,
      at: prior.at,
      ...(prior.endpoint !== undefined ? { endpoint: prior.endpoint } : {}),
      ...(native && prior.serverSeeded === true ? { serverSeeded: true as const } : {}),
      ...(native && prior.exitIp !== undefined ? { exitIp: prior.exitIp } : {}),
      ...(native && prior.exitCountry !== undefined ? { exitCountry: prior.exitCountry } : {}),
      ...(native && prior.exitCity !== undefined ? { exitCity: prior.exitCity } : {}),
      ...(native && prior.exitRegion !== undefined ? { exitRegion: prior.exitRegion } : {}),
      ...(native && prior.exitTimezone !== undefined ? { exitTimezone: prior.exitTimezone } : {}),
      ...(native && prior.exitAsnOrg !== undefined ? { exitAsnOrg: prior.exitAsnOrg } : {}),
      ...(native && prior.exitAt !== undefined ? { exitAt: prior.exitAt } : {}),
      ...(native && prior.exitProbeFailedAt !== undefined
        ? { exitProbeFailedAt: prior.exitProbeFailedAt }
        : {}),
      // ⛔ The OTHER retirement stamps survive this rebuild. While the stamp below
      // stands it refuses everything they would, which is how their loss hid: the
      // failure's stamp is the one stamp that is later REMOVED (`clearFleetFailure`,
      // an exit seen after it), and with these gone nothing was left to refuse a
      // reading taken through an address the endpoint has since moved from.
      // MEASURED: A → unresolved → B, a failed test, the account's clear — and the
      // readings taken through A were adopted beside B.
      ...(prior.serverReadingsRetiredAt !== undefined
        ? { serverReadingsRetiredAt: prior.serverReadingsRetiredAt }
        : {}),
      ...(prior.quicProbeRetiredAt !== undefined
        ? { quicProbeRetiredAt: prior.quicProbeRetiredAt }
        : {}),
      exitSupersededAt: at,
      ...(reason.length > 0 ? { fleetFailureReason: reason } : {}),
    };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/**
 * T-20 — record a VPN/HTTP row's endpoint pre-flight.
 *
 * Stored as an `endpoint` verdict beside the fail-closed placeholder `result`,
 * so `isProxyUsable` and every derivation built on it read "not a SOCKS5
 * verdict" — never a fake pass, and never the un-gated probe's false
 * "unreachable" either. Replaces any SOCKS5 verdict the row held (that verdict
 * was the bug), and carries NOTHING over from it: its exit-geo and server-side
 * fields were measured through a SOCKS5 listener this row does not have.
 *
 * ⛔ (g) A prior ENDPOINT entry is a different case. Its server-measured fields
 * (fleet latency + vantage, the QUIC-relay verdict, the OS fingerprint, the
 * observed exit, a live session's QUIC verdict) came from the fleet probe or
 * the session that followed an EARLIER pre-flight of this very row, and they
 * are carried over when the new verdict is RESOLVED. The grid's Check runs
 * this pre-flight BEFORE it asks the fleet, so without the carry-over a test
 * the control plane REFUSED (`not_run` — a live session holds the tunnel, the
 * node was busy) erased every field the last measurement had written, and the
 * row that "kept what it holds" had nothing left to hold. An UNRESOLVED
 * endpoint still drops them all: nothing can be measured through a dead
 * endpoint, and a number beside "unresolved" would read as current.
 *
 * ⛔ (g-followup) The carry-over is keyed on the ADDRESS, not merely on the
 * entry's shape: the prior entry must itself be a RESOLVED endpoint whose `ip`
 * equals the one just resolved. A hostname that now answers with a different
 * address is a server that was never measured — its predecessor's fleet
 * latency, vantage, relay verdict, OS fingerprint and exit would render as
 * current on the grid (the overlay keys on `endpoint.resolved` alone), and a
 * fleet reply that writes nothing (`not_run` / `unavailable` / `failed`) would
 * leave them there. A changed address drops every server-measured field.
 */
/** The fields of an entry that a fleet probe or a live session wrote — every
 *  optional member except the verdict itself (`result` / `at` / `endpoint`).
 *  Listed by name so a new server-measured field must be added HERE to survive
 *  a pre-flight, rather than surviving by accident of a spread. */
function serverMeasuredFields(
  prior: CachedProbe,
): Omit<Partial<CachedProbe>, 'result' | 'at' | 'endpoint'> {
  const {
    exitIp,
    exitCountry,
    exitAt,
    exitProbeFailedAt,
    exitCity,
    exitRegion,
    exitTimezone,
    exitAsnOrg,
    osFingerprint,
    serverLatencyMs,
    quicMeasured,
    quicMeasuredAt,
    measuredFrom,
    nodeId,
    quicProbe,
    quicProbeAt,
    quicProbeRetiredAt,
    serverReadingsRetiredAt,
    udpProbe,
    udpProbeAt,
    serverProbeAt,
    exitSupersededAt,
    fleetFailureReason,
  } = prior;
  const kept = {
    exitIp,
    exitCountry,
    exitAt,
    exitProbeFailedAt,
    exitCity,
    exitRegion,
    exitTimezone,
    exitAsnOrg,
    osFingerprint,
    serverLatencyMs,
    quicMeasured,
    quicMeasuredAt,
    measuredFrom,
    nodeId,
    quicProbe,
    // …with its date: a verdict that survives the pre-flight undated is one
    // `isQuicProbeFresh` then hides — the silent loss `udpProbeAt` names below.
    quicProbeAt,
    // The retirement stamps outlive the pre-flight for the reason `exitSupersededAt`
    // does below: the pre-flight runs before EVERY check and a list sync follows
    // every refresh, so a stamp lost here is a retired reading adopted back.
    quicProbeRetiredAt,
    serverReadingsRetiredAt,
    // (V6 2026-09-16) ITEM 3 — the fleet UDP-relay verdict survives a pre-flight
    // for the SAME address, exactly like the QUIC one above it. Omitting it here
    // is how a "listed by name" allowlist loses a field silently: the pre-flight
    // runs before EVERY check, so the verdict would be gone by the time the fleet
    // answered and a measured `false` would read as "not measured yet".
    udpProbe,
    // …and its date with it. A verdict that survives the pre-flight undated is a
    // verdict `isUdpVerdictFresh` then hides — the same silent loss, one field over.
    udpProbeAt,
    serverProbeAt,
    // (h) — the superseded stamp is itself a fleet verdict about this row's
    // exit and must outlive the pre-flight that precedes the next test — and
    // so must its sentence (finding 3): "tunnel down" stays on every surface
    // until THIS check answers, exactly as the grid's in-memory copy did.
    exitSupersededAt,
    fleetFailureReason,
  };
  // Absent stays absent: an `undefined` member would still be a key in the
  // stored object (and in a toEqual), where the entry never had one.
  for (const k of Object.keys(kept) as (keyof typeof kept)[]) {
    if (kept[k] === undefined) delete kept[k];
  }
  return kept;
}

export function saveEndpointResult(
  proxyId: string,
  endpoint: CachedEndpointVerdict,
  at: number,
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    const sameAddress =
      endpoint.resolved &&
      prior?.endpoint !== undefined &&
      prior.endpoint.resolved &&
      prior.endpoint.ip === endpoint.ip;
    const carried = sameAddress ? serverMeasuredFields(prior) : {};
    // ⛔ THE RETIREMENT FACTS CROSS EVERY PRE-FLIGHT, RESOLVED OR NOT, because
    // dropping the fields is not the end of them: the account row still carries the
    // readings Driftstack took before, and the list sync that follows every refresh
    // adopts whatever no stamp refuses. They used to travel only inside `carried`,
    // i.e. only across a same-address pre-flight, and ONE failed DNS lookup rebuilt
    // the entry as the bare verdict triple. MEASURED: tunnel found down at T1
    // (`exitSupersededAt`), the background pre-flight fails once at T2, resolves
    // again at T3 — the prior verdict was unresolved, so nothing was carried and
    // nothing minted, and the next sync put the pre-T1 readings back beside a
    // tunnel that was down.
    //
    // The STAMPS only. The failure's sentence (`fleetFailureReason`) still travels
    // in `carried` alone, i.e. with a confirmed same address: it is what the grid
    // paints as "tunnel down", it outranks "address not found" there, and a check
    // that finds the endpoint unresolved — or at an address nobody has tested — is
    // an answer that moves it. A stamp without its sentence refuses old readings
    // and asserts nothing on screen. ⛔ It also no longer LOOKS lost to the list
    // sync, which used to re-stamp the row and bring "tunnel down" back by that
    // accident — so the sync restores the sentence deliberately, once the address
    // resolves again and the account still says down (`adoptListExitObserved`).
    const kept: Partial<CachedProbe> = {
      ...(prior?.exitSupersededAt !== undefined
        ? { exitSupersededAt: prior.exitSupersededAt }
        : {}),
      ...(prior?.quicProbeRetiredAt !== undefined
        ? { quicProbeRetiredAt: prior.quicProbeRetiredAt }
        : {}),
    };
    // ⛔ …AND ANY PRE-FLIGHT THAT CANNOT CONFIRM THE ADDRESS IS THE SAME MINTS ONE.
    // An address we could not confirm is the same is not the same address for the
    // purpose of trusting an old reading: a different ip, an unresolved verdict now,
    // or an unresolved one before (A → unresolved → B names no address to compare
    // in either step, and used to slip through as "no change observed"). Only a row
    // that HAS an address check behind it: a first pre-flight — a second Mac, a
    // fresh install, a server-seeded entry — retires nothing, or the adoption that
    // exists for exactly that row would refuse everything the account holds.
    // Never rewinds: a clock that moved back must not re-admit a retired reading.
    const unconfirmed = prior?.endpoint !== undefined && !sameAddress;
    const readingsRetiredAt = unconfirmed
      ? Math.max(at, prior.serverReadingsRetiredAt ?? Number.NEGATIVE_INFINITY)
      : prior?.serverReadingsRetiredAt;
    all[proxyId] = {
      ...kept,
      ...carried,
      ...(readingsRetiredAt !== undefined ? { serverReadingsRetiredAt: readingsRetiredAt } : {}),
      result: endpointPlaceholderResult(endpoint),
      at,
      endpoint: { resolved: endpoint.resolved, ip: endpoint.ip, message: endpoint.message },
    };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/**
 * T-27 — record a QUIC verdict OBSERVED in a live session (the session's
 * capability report said an HTTP/3 connection completed through this proxy).
 *
 * Touches only the verdict and its stamp. `saveServerProbeResult` is the wrong
 * tool here on purpose: it REPLACES the vantage, node and relay verdict with
 * every call (present → stored, absent → removed), and a live observation
 * carries none of them — routing it through there would strip the fleet label
 * off a latency it did not re-measure. Monotone: a stamp older than the one
 * stored is ignored, so a late-arriving poll cannot rewind a fresher verdict.
 * Rides on an existing entry like every other enrichment; none is invented.
 */
export function saveObservedQuic(
  proxyId: string,
  quic: MeasuredQuic,
  at: number,
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    // ⛔ Owner item 9 (2026-09-24) — a proxy this Mac holds no entry for (never
    // tested here: a second Mac, a reinstall, a proxy created by a launch) used to
    // DROP the live observation, so the Simulator said "HTTP/3 ✓ live" while the
    // card and the grid said nothing about the same proxy. It lands on the same
    // fail-closed `serverSeeded` placeholder the account-list adoption invents:
    // it carries the reading and asserts nothing about reachability.
    const prior: CachedProbe = all[proxyId] ?? {
      result: SERVER_SEEDED_PLACEHOLDER_RESULT,
      at,
      serverSeeded: true,
    };
    if (prior.quicMeasuredAt !== undefined && prior.quicMeasuredAt > at) return all;
    // ⛔⛔ (V-219) A LIVE MEASUREMENT RETIRES A RELAY VERDICT IT CONTRADICTS.
    //
    // `proxyCapabilities` collapses both into ONE chip, strongest evidence
    // first: this verdict, then `quicProbe`. This one EXPIRES (W-30, thirty
    // minutes) and `quicProbe` does not -- so a live `h2-only` measured through
    // the customer's own browser would age out and an older relay `true`
    // underneath it would resurface as a green "HTTP/3 works through this exit".
    // The expiry of the strong signal was being undone by the immortality of the
    // weak one, silently, half an hour later.
    //
    // ⚠️ NOT fixed with a TTL on the relay verdict ALONE, and the reason matters.
    // A live verdict is re-emitted by a running session every ~300s; the relay
    // verdict was written ONLY when someone pressed Test. A thirty-minute window
    // on it, with nothing else, would mean the green chip is essentially never
    // shown -- which is the owner's original complaint, reintroduced by a fix for
    // a different one. (The relay verdict IS aged now -- `isQuicProbeFresh` -- but
    // only together with the two things that answer that objection: an aged
    // verdict still renders, in the past tense with its age, and the automatic
    // capability check re-takes it. This retirement rule is unchanged by that: an
    // AGED relay verdict a live session has since contradicted must not resurface
    // as "✓ QUIC · 4h ago" either.)
    //
    // The rule that needs no window: both are statements about the same MUTABLE
    // property -- does HTTP/3 work through this exit -- so the later measurement
    // wins and the earlier one it contradicts is retired, not kept as a second
    // opinion. Strength only breaks ties at the same instant. Anything stored
    // here necessarily predates this observation (we are inside the write lock,
    // holding the map we just loaded), so no stamp is needed to order them.
    //
    // AGREEMENT is kept: two independent measurements that agree corroborate,
    // and keeping the relay verdict is what leaves the chip green after this
    // one expires -- correct, because nothing has contradicted it.
    //
    // ⚠️ KNOWN LIMIT, stated rather than papered over. Both verdicts are keyed on
    // the PROXY ROW, and on a rotating residential proxy the live session and the
    // relay probe may have gone out through different exits -- so strictly they
    // can both be true of different machines and neither contradicts the other.
    // We cannot tell: neither verdict records which exit produced it. Retiring
    // the older one is still the better approximation, because the alternative is
    // keeping a positive for ever that the customer's own browser has since
    // failed to reproduce. Recording an exit alongside each verdict would settle
    // it properly and is not in this change.
    // The relay verdict's date goes with it: a stamp with nothing to date is how
    // a later carry would come to wear the wrong age.
    const { quicProbe: priorRelay, quicProbeAt: _priorRelayAt, ...withoutRelay } = prior;
    const relayContradicted =
      (quic === 'h3' && priorRelay === false) || (quic === 'h2-only' && priorRelay === true);
    all[proxyId] = {
      ...(relayContradicted ? withoutRelay : prior),
      quicMeasured: quic,
      quicMeasuredAt: at,
    };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

// T-27 — one ledger per process: a latched `h3_connection_observed` is stamped
// once per session; a rising `h3_connection_count` re-stamps.
const h3Ledger = makeH3ObservationLedger();

/** The slice of a listed agent session the live-h3 consumer reads. The SDK
 *  types `capability_report` without the h3 fields; it is parsed as `unknown`. */
export interface LiveSessionLike {
  id: string;
  capability_report?: unknown;
}

/**
 * T-27 (drop 2) — turn the live sessions' capability reports into stored QUIC
 * verdicts on the proxies they launched through.
 *
 * Called from the profile hub's agent-session list poll — the MAIN app, on
 * purpose. The simulator is a separate macOS bundle (`dev.driftstack.simulator`)
 * with its own store directory, so a cache write from SimulatorWindow would
 * land in a file the profile cards never read; the hub's poll already carries
 * every live session's `capability_report` and is the one consumer whose store
 * IS the cards' store. Best-effort per session: a proxy with no cache entry
 * attaches nothing (and stays un-committed in the ledger, so the next poll
 * after a probe writes it), and one failed write does not stop the others.
 * Returns the proxy ids written, for the guard.
 */
export async function recordLiveH3Observations(
  sessions: ReadonlyArray<LiveSessionLike>,
  bindings: ReadonlyArray<H3BindingLike>,
  proxies: ReadonlyArray<{ id: string }>,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const written: string[] = [];
  for (const s of sessions) {
    const obs = parseH3Observation(s.capability_report);
    if (obs === null) continue;
    const proxyId = attributeSessionProxy(s.id, bindings, proxies);
    if (proxyId === null) continue;
    const at = h3Ledger.plan(s.id, obs, nowMs);
    if (at === null) continue;
    try {
      const cache = await saveObservedQuic(proxyId, 'h3', at);
      const stored = cache[proxyId];
      // Committed only when the verdict is actually on the entry: no entry, or
      // a fresher stamp already there, leaves the session to be re-read later.
      if (stored?.quicMeasured === 'h3' && (stored.quicMeasuredAt ?? -1) >= at) {
        h3Ledger.commit(s.id, obs);
        written.push(proxyId);
      }
    } catch {
      /* best-effort — the next poll retries */
    }
  }
  return written;
}

/**
 * (k) K3 — the server's EXPLICIT clear of a fleet failure, adopted from the
 * account list: `exit_superseded_at: null` beside a stamp this entry holds.
 *
 * ⛔ Until this writer existed the only thing that could lift a fleet-failure
 * sentence on a Mac that did not run the next (UP) test was `saveExitResult`
 * with an observation dated after the stamp — so a later UP verdict whose exit
 * the list adoption REFUSES (the server kept its stored geo and only cleared
 * the stamp; the observation is still dated before the failure) left the
 * second Mac reading "tunnel down" indefinitely, while the server's own row
 * said the contradiction was spent. This drops the stamp and its sentence and
 * touches nothing else: the verdict triple stays, and there is no exit or
 * latency to restore — the list adoption that follows writes those if the
 * list carries them. Rides on an existing entry; none is invented. Idempotent:
 * an entry with no stamp is returned unchanged, with no store write.
 */
export function clearFleetFailure(proxyId: string, notAfterMs?: number): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all;
    if (prior.exitSupersededAt === undefined && prior.fleetFailureReason === undefined) return all;
    // (k) review — the caller decided on a SNAPSHOT; a failure this Mac wrote
    // since (a newer stamp) must survive the clear it did not know about.
    if (
      notAfterMs !== undefined &&
      prior.exitSupersededAt !== undefined &&
      prior.exitSupersededAt > notAfterMs
    )
      return all;
    const { exitSupersededAt: _superseded, fleetFailureReason: _failure, ...kept } = prior;
    all[proxyId] = kept;
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/**
 * The rows edited in THIS app session — the in-memory half of `materialUnsynced`,
 * for the moments the stored mark cannot cover:
 *
 *   • the mark is written under the lock, awaits later, and the view does not wait
 *     for `invalidateProbe` before it refreshes — this is recorded synchronously,
 *     in the same turn as the call;
 *   • the mark is best-effort (a ledger that will not read must not keep a stale
 *     verdict on screen), so an edit can land with the entry deleted and NO mark;
 *   • a list sync reads the ledger around its request, and an edit saved after
 *     that — or a mark LIFTED while a list fetched before the store was still in
 *     flight — is one its snapshot cannot show.
 *
 * Two facts, because they answer two questions. `pending` is "edited, and the
 * account not yet shown to hold it": lifted by `clearCapabilityMaterialUnsynced`.
 * `lastEdit` is "edited AFTER count N", which a lift does not undo — a list
 * requested before an edit describes the old endpoint whatever happened since.
 *
 * ⛔ A reader asks IMMEDIATELY before it calls a writer, with no await between.
 * The write lock is a FIFO chain, so an edit that arrives after the question
 * queues its delete BEHIND the adoption's write and removes it; one that arrived
 * before is seen. Not persisted: across a restart the stored mark is the only belt.
 */
const pendingMaterialEdits = new Set<string>();
const lastMaterialEdit = new Map<string, number>();
let materialEditCount = 0;

/** A COPY — a list sync keeps the set as it stood BEFORE its request. */
export function materialEditsPending(): ReadonlySet<string> {
  return new Set(pendingMaterialEdits);
}

/** How many edits this session has seen — the "N" a list sync takes at entry. */
export function materialEditCountNow(): number {
  return materialEditCount;
}

export function materialEditedAfter(proxyId: string, count: number): boolean {
  return (lastMaterialEdit.get(proxyId) ?? 0) > count;
}

export function __resetMaterialEditsForTests(): void {
  pendingMaterialEdits.clear();
  lastMaterialEdit.clear();
  materialEditCount = 0;
}

/** Drop a proxy's cached probe (capability + exit-geo). Called when the
 *  proxy's connection details change — the cached reachability/UDP/exit-IP
 *  no longer describes the live endpoint, so showing it on profile cards
 *  would be dishonest — and when a proxy is deleted, so its entry can't
 *  linger (and a future re-minted id can't inherit stale geo). Idempotent.
 *
 *  ⛔ It also marks the row `materialUnsynced` in the automatic check's ledger,
 *  and that is the half of an edit the cache cannot express. The automatic check
 *  never uploads (the consent rule), so it tests whatever the ACCOUNT holds — and
 *  from this moment until something pushes the new material, that is the OLD
 *  endpoint. A check in that window would write the predecessor's OS / QUIC / UDP
 *  readings onto the edited row in the present tense. The mark keeps the row out
 *  of every automatic plan until `clearCapabilityMaterialUnsynced` lifts it (a
 *  successful store of the row). Its previous attempt stamp is dropped: that
 *  backoff described the endpoint that was checked, and this is a different one.
 *  A DELETED proxy's mark is pruned by the next run (`pruneCapabilityAttempts`). */
export function invalidateProbe(proxyId: string): Promise<ProbeCacheMap> {
  // Before the lock, before any await — see `pendingMaterialEdits`.
  if (proxyId.length > 0) {
    pendingMaterialEdits.add(proxyId);
    lastMaterialEdit.set(proxyId, ++materialEditCount);
  }
  return writeLock(async () => {
    const all = await loadProbeCache();
    // Best-effort beside the cache drop: a ledger the store will not read must
    // not keep a stale verdict on screen. The identity guard in the automatic
    // check (`checkCapabilitiesForRow`) is the second belt for that case.
    const attempts = await readCapabilityAttemptsStrict().catch(() => null);
    const held = attempts?.[proxyId];
    // An ACCOUNT refusal is not a fact about the endpoint, so it (and its date)
    // survives the edit; an ordinary attempt stamp does not.
    const next: CapabilityCheckAttempt =
      held?.planExcluded === true
        ? {
            capabilityCheckAttemptedAt: held.capabilityCheckAttemptedAt,
            planExcluded: true,
            materialUnsynced: true,
          }
        : { capabilityCheckAttemptedAt: 0, materialUnsynced: true };
    const alreadyMarked =
      held?.materialUnsynced === true &&
      held.capabilityCheckAttemptedAt === next.capabilityCheckAttemptedAt &&
      held.readingsNotProducedAt === undefined;
    const marks = attempts !== null && proxyId.length > 0 && !alreadyMarked;
    if (marks) {
      attempts[proxyId] = next;
      await getStore().set(ATTEMPTS_KEY, attempts);
    }
    if (all[proxyId] === undefined) {
      if (marks) await getStore().save();
      return all;
    }
    delete all[proxyId];
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

// ─── The automatic capability check's backoff ledger ─────────────────────────

/**
 * When the app last asked Driftstack, UNPROMPTED, to check a proxy's
 * capabilities, and what it learned that bounds the next ask.
 *
 * ⛔ ITS OWN KEY IN THIS STORE, NOT A FIELD ON `CachedProbe`, and that is a
 * decision rather than a convenience. Four writers in this file rebuild an entry
 * field by field (`saveProbeResult`, `saveEndpointResult`, `saveFleetFailure`,
 * and the load-path allowlist), and this file's own history records a field
 * silently lost to such a rebuild three separate times. A backoff stamp lost that
 * way does not fail visibly — it turns "at most once every six hours" into "after
 * every reachability sweep", i.e. an 11-second dial through the customer's proxy
 * every fifteen minutes, for ever. It also has to exist for a row that has NO
 * entry at all (a refused check writes none), which a field could only do by
 * inventing one. Same file, same lock.
 */
export interface CapabilityCheckAttempt {
  /** Epoch ms of the last AUTOMATIC attempt, whatever its outcome. `0` = none yet
   *  for this endpoint (the record exists only to carry a mark below). */
  capabilityCheckAttemptedAt: number;
  /** The answer was a refusal of the ACCOUNT (its plan, or the credential it
   *  signed in with) — a retry cannot change it, so it backs off for longer.
   *  Only ever `true`. */
  planExcluded?: true;
  /** The local row changed since the account last received it — see
   *  `invalidateProbe`. Only ever `true`. */
  materialUnsynced?: true;
  /** Epoch ms when a SUCCESSFUL automatic check came back and a reading this row
   *  should have was still missing: a leg this proxy does not produce (a VPN's
   *  QUIC leg is skipped today). The planner stops counting the blank as "never
   *  measured" for a long window, instead of bringing a tunnel up every six hours
   *  for ever to be told the same. */
  readingsNotProducedAt?: number;
}

export type CapabilityAttemptMap = Record<string, CapabilityCheckAttempt>;

/** The ledger, read STRICTLY: a store that cannot be read REJECTS. A malformed
 *  record is dropped — that row then reads as never attempted, which costs one
 *  extra check and can never suppress one for ever. */
async function readCapabilityAttemptsStrict(): Promise<CapabilityAttemptMap> {
  const raw = await getStore().get<Record<string, unknown>>(ATTEMPTS_KEY);
  if (typeof raw !== 'object' || raw === null) return {};
  const out: CapabilityAttemptMap = {};
  for (const [id, v] of Object.entries(raw)) {
    if (typeof v !== 'object' || v === null) continue;
    const rec = v as Record<string, unknown>;
    const at = rec.capabilityCheckAttemptedAt;
    if (id.length === 0 || typeof at !== 'number' || !Number.isFinite(at)) continue;
    const notProducedAt = rec.readingsNotProducedAt;
    out[id] = {
      capabilityCheckAttemptedAt: at,
      ...(rec.planExcluded === true ? { planExcluded: true as const } : {}),
      ...(rec.materialUnsynced === true ? { materialUnsynced: true as const } : {}),
      ...(typeof notProducedAt === 'number' && Number.isFinite(notProducedAt)
        ? { readingsNotProducedAt: notProducedAt }
        : {}),
    };
  }
  return out;
}

/**
 * Load the ledger.
 *
 * ⛔ REJECTS when the store cannot be read, and both kinds of caller depend on it.
 * It used to answer `{}`, which reads as "nothing was ever attempted": the runner
 * would then plan every row as overdue, and a WRITER that rebuilt the map from that
 * answer would write the empty map back — one transient read failure wiping every
 * row's backoff, the unbounded dial this ledger exists to prevent. A run that
 * cannot read its ledger does not run; a write that cannot read it does not write.
 */
export function loadCapabilityAttempts(): Promise<CapabilityAttemptMap> {
  return readCapabilityAttemptsStrict();
}

/** One locked read-modify-write of the ledger. `change` returns false for "no
 *  write needed". Rejects when the store refuses the read or the write. */
function updateCapabilityAttempts(
  change: (attempts: CapabilityAttemptMap) => boolean,
): Promise<CapabilityAttemptMap> {
  return writeLock(async () => {
    const attempts = await readCapabilityAttemptsStrict();
    if (!change(attempts)) return attempts;
    await getStore().set(ATTEMPTS_KEY, attempts);
    await getStore().save();
    return attempts;
  });
}

/** Stamp an automatic attempt on each of these rows, in ONE write. Written BEFORE
 *  the request goes out (see the runner), and again with `planExcluded` — for
 *  every row the refusal applies to — when that is what came back. The attempt
 *  and the refusal are REPLACED; the two marks that describe the ROW rather than
 *  the attempt (`materialUnsynced`, `readingsNotProducedAt`) are kept.
 *
 *  ⛔ Rejects when the store refuses the read or the write, and the runner depends
 *  on that: a check whose attempt could not be recorded is a check nothing bounds. */
export function recordCapabilityAttempt(
  proxyIds: ReadonlyArray<string>,
  at: number,
  planExcluded = false,
): Promise<CapabilityAttemptMap> {
  return updateCapabilityAttempts((attempts) => {
    for (const id of proxyIds) {
      if (id.length === 0) continue;
      const { planExcluded: _was, ...kept } = attempts[id] ?? { capabilityCheckAttemptedAt: at };
      attempts[id] = {
        ...kept,
        capabilityCheckAttemptedAt: at,
        ...(planExcluded ? { planExcluded: true as const } : {}),
      };
    }
    return true;
  });
}

/** The account now holds this row's current material (a store of the row
 *  succeeded): lift the `materialUnsynced` mark. No write when there is none. */
export function clearCapabilityMaterialUnsynced(proxyId: string): Promise<CapabilityAttemptMap> {
  // The store SUCCEEDED, whatever the ledger write below does: if that write
  // fails the stored mark stands and still refuses.
  pendingMaterialEdits.delete(proxyId);
  return updateCapabilityAttempts((attempts) => {
    const held = attempts[proxyId];
    if (held?.materialUnsynced !== true) return false;
    const { materialUnsynced: _mark, ...kept } = held;
    attempts[proxyId] = kept;
    return true;
  });
}

/** Record (or, with `undefined`, lift) the "a full answer still left a reading
 *  missing" mark — see `CapabilityCheckAttempt.readingsNotProducedAt`. */
export function noteCapabilityReadingsNotProduced(
  proxyId: string,
  at: number | undefined,
): Promise<CapabilityAttemptMap> {
  return updateCapabilityAttempts((attempts) => {
    const held = attempts[proxyId];
    if (at === undefined) {
      if (held?.readingsNotProducedAt === undefined) return false;
      const { readingsNotProducedAt: _mark, ...kept } = held;
      attempts[proxyId] = kept;
      return true;
    }
    attempts[proxyId] = {
      ...(held ?? { capabilityCheckAttemptedAt: at }),
      readingsNotProducedAt: at,
    };
    return true;
  });
}

/** Drop the ledger records of proxies that no longer exist — a deleted proxy's
 *  record (its `materialUnsynced` mark above all) otherwise lives for ever. */
export function pruneCapabilityAttempts(
  liveProxyIds: ReadonlyArray<string>,
): Promise<CapabilityAttemptMap> {
  const live = new Set(liveProxyIds);
  for (const id of [...lastMaterialEdit.keys()]) {
    if (live.has(id)) continue;
    pendingMaterialEdits.delete(id);
    lastMaterialEdit.delete(id);
  }
  return updateCapabilityAttempts((attempts) => {
    let changed = false;
    for (const id of Object.keys(attempts)) {
      if (live.has(id)) continue;
      delete attempts[id];
      changed = true;
    }
    return changed;
  });
}
