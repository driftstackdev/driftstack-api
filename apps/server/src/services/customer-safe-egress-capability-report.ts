// The allowlist that governs the RAW capabilityReport blob on the PUBLIC
// sessions API — `sessions.egress_capability_report`.
//
// ⛔ WHAT THIS FILE EXISTS TO CLOSE. The relay stores the device's whole
// capabilityReport frame (minus `type`) as `sessions.egress_capability_report`,
// and `publicSession()` in `routes/sessions.ts` echoed that blob VERBATIM on
// four customer surfaces: `GET /v1/sessions/:id`, `GET /v1/sessions`,
// `POST /v1/sessions` and `POST /v1/profiles/:id/launch`. There was no filter
// of any kind on that path. So DECLARING a key on
// `CapabilityReportPayloadSchema` was, by itself, enough to publish it — the
// device team shipped a key and it was on the public API the same day, with
// nobody in between. `webkitForkBuild`, an internal build string naming one of
// our checkouts, rode that path for months. A measured framework digest was
// kept off it last night only by deleting that one key by name before storage:
// a denylist of one, which protects against exactly the key somebody already
// thought of.
//
// ⭐ THE DIRECTION IS THE WHOLE POINT. An unknown key is now PRIVATE. A key the
// device adds tomorrow does not reach a customer until someone classifies it in
// `EGRESS_CAPABILITY_REPORT_AUDIENCE` below, and TypeScript will not compile
// this file until they do — `Record<EgressCapabilityReportKey, …>` is total over
// the schema's key set, so a new schema key is a missing property and a removed
// one is an excess property. The safe case is now the automatic one and the
// unsafe case requires a reviewer, which is the inverse of what shipped.
//
// ⛔ THIS IS A FILTER, NOT A PROJECTION. It never renames, never derives and
// never inserts a key that was absent: absence on this frame means UNMEASURED
// everywhere (see the `?? null` contract all over the schema and the store), and
// a filter that materialised `exitIp: null` would turn "nobody looked" into
// "there is no exit". Keys are copied through under their own camelCase names,
// present only when the stored blob actually carried them. ONE VALUE is the
// exception, and only a value: `egressState` `dead_proxy` reads
// `default_connection_down` when the same row's warnings say the dead connection
// was the one Driftstack provides (see the note in the function).
//
// ⚠️ THE OTHER LIST. `customerSafeCapabilityReport` in
// `session-capability-report-store.ts` guards the OTHER way out of this same
// frame — the agent-session projection, which is snake_case and derived. The two
// lists cannot be merged (different key namespaces, and the raw frame carries
// keys the store record never materialises), so they are held in agreement by a
// guard rather than by memory: `tests/unit/a-new-device-key-is-private-by-
// default.test.ts` fails when a fact is public through one list and private
// through the other.
//
// ⚠️ NOT A SCHEMA CHANGE. The published OpenAPI document declares
// `egress_capability_report` as `{ type: ["object","null"], additionalProperties:
// {} }` — an OPAQUE object — and the route's own comment tells consumers to
// prefer the typed `egress_capabilities`. Narrowing which keys appear INSIDE an
// opaque object is not a break in that contract.

import type { CapabilityReport } from '../schemas/harness-control-protocol.js';
import { DEFAULT_CONNECTION_DOWN_EGRESS_STATE } from './session-capability-report-store.js';

/** Every key the capabilityReport frame can carry, minus the `type` discriminator
 *  the relay already strips (it names the wire envelope, not the session). */
export type EgressCapabilityReportKey = Exclude<keyof CapabilityReport, 'type'>;

/**
 * `customer` — an observation ABOUT THE CUSTOMER'S OWN SESSION that they
 *   legitimately act on: the exit identity it presents, whether QUIC carried,
 *   what their proxy supports, whether the stream is live.
 * `operator` — infrastructure. Our build strings, our framework digests, our
 *   rollout phases, our interpose/safeguard mechanisms, our upstream endpoints,
 *   our transport counters. These say HOW, and nothing customer-visible says HOW.
 */
export type EgressCapabilityReportAudience = 'customer' | 'operator';

/**
 * ⛔ TOTAL OVER THE SCHEMA, ON PURPOSE. Adding a key to
 * `CapabilityReportPayloadSchema` without adding it here is a TYPE ERROR in this
 * file, not a silent publication on the customer API. That compile error is the
 * enforcement; the test suite carries the same check at runtime so a `skipLibCheck`
 * or a JS consumer cannot route around it.
 *
 * ⚠️ WHEN IN DOUBT, `operator`. A key wrongly marked operator costs a customer a
 * field they can ask us for; a key wrongly marked customer is a disclosure we
 * cannot take back.
 */
export const EGRESS_CAPABILITY_REPORT_AUDIENCE: Readonly<
  Record<EgressCapabilityReportKey, EgressCapabilityReportAudience>
> = {
  // ── Customer observations ────────────────────────────────────────────────
  /** When the device made these observations about this session. */
  timestamp: 'customer',
  /** socks5 / openvpn / wireguard — the egress the CUSTOMER configured. */
  proxyKind: 'customer',
  /** Does their proxy carry UDP. Same fact as the typed `udp_associate`. */
  proxyUdpSupported: 'customer',
  /** Does their proxy carry IPv4 / IPv6 — a property of the relay they bought. */
  proxyIpv4Supported: 'customer',
  proxyIpv6Supported: 'customer',
  /** Where their own exit appears to be. The customer buys on this. */
  proxyGeoCountry: 'customer',
  proxyGeoRegion: 'customer',
  /** residential / mobile / datacenter / isp — the classification of THEIR relay. */
  proxyIpType: 'customer',
  /** The transport their session asked for and the one it got. WHAT, not HOW. */
  transportModeRequested: 'customer',
  transportModeActive: 'customer',
  /** Did a real QUIC handshake complete on their session, and how many. The only
   *  honest measured answer to "does my proxy actually carry HTTP/3"; already
   *  customer-safe on the agent-session projection. */
  h3ConnectionObserved: 'customer',
  h3ConnectionCount: 'customer',
  /** The device profile their session presented. Already published on the SAME
   *  response as the top-level `archetype`, in the same vocabulary. */
  archetypeId: 'customer',
  /** Can they type into this session right now. Drives their own UI. */
  manualInputAvailable: 'customer',
  /** provisioning / live / blank / failed / permission_denied — the state of the
   *  stream they are watching, and already customer-safe on the agent projection. */
  streamingState: 'customer',
  /** live / dead_proxy — their proxy stopped answering. A warning meant for them. */
  egressState: 'customer',
  /** The exit identity their session presents, and the IPs a WebRTC handshake
   *  would surface. Explicitly customer facts: this is the leak check they pay for. */
  exitIp: 'customer',
  exitCountry: 'customer',
  exitTimezone: 'customer',
  webrtcCandidateIps: 'customer',
  /** When the exit identity above was observed. A reading with no stamp can only
   *  be rendered as a present-tense fact, which it is not. */
  observedAt: 'customer',

  // ── Operator-only ────────────────────────────────────────────────────────
  /** The AGENT session id. This blob hangs off the DRIVER session, whose own id
   *  is already on the response — so this is a second, internal identifier for a
   *  different object. An identifier the customer did not ask for and cannot use. */
  sessionId: 'operator',
  /** `phase_1_socks5` / `phase_2_openvpn` / `phase_3_wireguard` names OUR egress
   *  rollout phasing. `proxyKind` beside it carries the same distinction in the
   *  customer's own vocabulary, so nothing is lost. */
  egressPhase: 'operator',
  /** Whether OUR proxy chain was built with no local-resolver directive: a
   *  property of the argument list we hand our own proxy process. It is also, by
   *  its own schema doc, ONE OF THREE inputs and NOT the answer — and absent by
   *  structure on VPN sessions, where it must not read as "no local resolver".
   *  The typed `egress_capabilities.dns_remote_resolve` is the customer's field. */
  dnsLocalResolverAbsent: 'operator',
  /** Our dyld interpose library. `h3InterposeLoaded` is in any case a RESTATEMENT
   *  of `transportModeActive` rather than an observation, and `interposeImageLoaded`
   *  is an lsof of our network process's image list — the store already calls that
   *  one "INTERNAL diagnostic only" and keeps it out of the other allowlist. */
  h3InterposeLoaded: 'operator',
  interposeImageLoaded: 'operator',
  /** A switch inside our own TLS handling. Names a mechanism; measures nothing
   *  about the customer's egress. */
  httpsSkipActive: 'operator',
  /** Our per-layer safeguard machinery. `layer` names internal mechanisms and
   *  `detail` is 4096 free characters straight off the device — the widest
   *  uncontrolled channel on the frame. The customer's half of this fact already
   *  reaches them twice: `egress_capabilities.warnings` carries
   *  `safeguard_failed:<layer>` / `safeguard_missing:<layer>`, and the agent
   *  projection carries `safeguards_passed`. */
  safeguardChecks: 'operator',
  safeguardLayersExpected: 'operator',
  /** Build identity of OUR fleet. `webkitForkBuild` names a checkout;
   *  `webkitFrameworkSha256` digests our fork's frameworks. Both identify our
   *  deploy and tell a customer nothing about their own session. `webkitForkBuild`
   *  is the key the review found already on a customer surface. */
  webkitForkBuild: 'operator',
  webkitFrameworkSha256: 'operator',
  /** `host:port` of the upstream this session egresses through. It is the
   *  customer's own endpoint ONLY when the session uses a proxy they own — for an
   *  operator-default egress there is no customer row at all and this is OUR
   *  hostname and port. A field that is safe for some members of its population
   *  and a disclosure for the rest is not safe. */
  proxyUpstream: 'operator',
  /** Eleven transport counters from our streaming SDK. Adding them for operator
   *  diagnosis once put all eleven into a customer payload in the same commit;
   *  the other allowlist has excluded them by name ever since. */
  streamingHealth: 'operator',
};

/** The keys that may cross to a customer, sorted so the set is stable to read
 *  in a failure message. Derived from the classification above — never a second
 *  hand-maintained list. */
export const PUBLIC_EGRESS_CAPABILITY_REPORT_KEYS: readonly EgressCapabilityReportKey[] = (
  Object.keys(EGRESS_CAPABILITY_REPORT_AUDIENCE) as EgressCapabilityReportKey[]
)
  .filter((key) => EGRESS_CAPABILITY_REPORT_AUDIENCE[key] === 'customer')
  .sort();

const PUBLIC_KEY_SET: ReadonlySet<string> = new Set<string>(PUBLIC_EGRESS_CAPABILITY_REPORT_KEYS);

/**
 * The customer-visible view of a stored capability-report blob.
 *
 * ⛔ THE ONE IMPLEMENTATION. Every public session response that echoes this blob
 * calls THIS function; `publicSession()` in `routes/sessions.ts` is the single
 * mapper behind all four of them. A second copy is how two lists start drifting,
 * and the drift is invisible because both copies keep returning an object.
 *
 * `null` in, `null` out — no report has arrived yet, and that is not the same as
 * a report with nothing customer-visible in it (`{}`). A non-object value (a
 * blob written by an older path, or an array) is refused rather than spread: a
 * spread of an array produces index keys, which is a confident answer from a
 * shape nobody checked.
 *
 * Keys are copied only when PRESENT. `undefined` is never materialised, because
 * absent means unmeasured on every field of this frame.
 */
export function customerSafeEgressCapabilityReport(
  stored: Record<string, unknown> | null | undefined,
  // The SAME row's stored `egress_capabilities` (the internal vocabulary). Read
  // for one fact only — see the `egressState` note below. Omitted, the blob is
  // filtered and nothing else.
  derived?: unknown,
): Record<string, unknown> | null {
  if (stored === null || stored === undefined) return null;
  if (typeof stored !== 'object' || Array.isArray(stored)) return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(stored)) {
    if (!PUBLIC_KEY_SET.has(key)) continue;
    const value = stored[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  // ⚠️ THE ONE VALUE THIS FILTER PROJECTS, and why it cannot be done at rest.
  // The device says `dead_proxy` whether the connection that died is the
  // customer's proxy or the one Driftstack provides for a session with no proxy
  // of its own — it cannot tell them apart. The capability relay CAN (it holds
  // the agent session's proxyId) and records the difference as the
  // `default_connection_down` warning, in the same row, written with this blob
  // from the same frame. The blob itself stays the device's frame at rest
  // (operators read it), so the customer's copy is projected here, from that
  // warning: publishing `dead_proxy` beside `default_connection_down` would
  // contradict the warning and blame a proxy the customer does not have. Only
  // the VALUE changes — no key is renamed, derived or inserted, and a blob with
  // no `egressState` still has none.
  if (out.egressState === 'dead_proxy' && warnsDefaultConnectionDown(derived)) {
    out.egressState = DEFAULT_CONNECTION_DOWN_EGRESS_STATE;
  }
  return out;
}

/** Whether a stored `egress_capabilities` object carries the relay's
 *  `default_connection_down` warning. Anything malformed reads as no. */
function warnsDefaultConnectionDown(derived: unknown): boolean {
  if (derived === null || typeof derived !== 'object' || Array.isArray(derived)) return false;
  const warnings = (derived as Record<string, unknown>)['warnings'];
  return Array.isArray(warnings) && warnings.includes(DEFAULT_CONNECTION_DOWN_EGRESS_STATE);
}
