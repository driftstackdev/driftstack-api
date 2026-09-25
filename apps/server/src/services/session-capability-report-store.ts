// Latest validated capability report per live AGENT session.
//
// The harness emits capabilityReport on activation and re-emits it whenever
// streamingState or egressState changes. FleetControlRegistry used to accept
// and ignore those frames, leaving view-only input, blank/failed capture, and a
// dead upstream proxy invisible to the GUI. This bounded store is the live read
// side for PublicAgentSession; the ownership-gated relay is the only writer.
//
// ⛔ IT MUST OUTLIVE THE PROCESS (owner item 7, 2026-09-24: "IN a active
// session i randomly got this; Waiting on the phone — it has not reported yet
// whether it can accept taps"). The store was a Map and nothing else. A restart
// or deploy emptied it; the session read then leaves `capability_report` out,
// and the phone re-sends only on its next state change or its periodic refresh,
// minutes later — so every live Simulator window went back to "Waiting on the
// phone" and lost the right to tap. With Redis configured, every report is
// written through with a TTL tied to the session (the agent-session lifetime
// cap, refreshed on each report), deleted with the session, reloaded by the
// next process (`hydrate()`) and fetched on a miss. Reads stay synchronous and
// in memory — the read path is a projection that cannot await — so Redis is
// the durable copy, never the read path. Without Redis this is the in-memory
// store it always was.

import type { Redis } from 'ioredis';
import type { CapabilityReport } from '../schemas/harness-control-protocol.js';
import { resolveMaxLifetimeHours } from './agent-session-orphan-sweeper.js';

/** Where the durable copy lives. One key per session: `<prefix><sessionId>`. */
export const CAPABILITY_REPORT_REDIS_PREFIX = 'driftstack:agent-session:capability-report:';

/** The Redis commands the store uses (an ioredis client satisfies it). */
export type CapabilityReportRedis = Pick<Redis, 'set' | 'get' | 'del' | 'scan' | 'mget'>;

export interface CapabilityReportPersistence {
  redis: CapabilityReportRedis;
  /** Key prefix; tests pass a unique one. Defaults to CAPABILITY_REPORT_REDIS_PREFIX. */
  keyPrefix?: string;
  /**
   * How long a stored report may outlive its last refresh. Defaults to the
   * agent-session lifetime cap (DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS,
   * 12 h), after which the backstop closes the session anyway: a report can
   * never outlive the session it describes. A live session re-reports well
   * inside it (every state change, and a periodic refresh).
   */
  ttlSeconds?: number;
  /** Failures are logged here, never thrown: a report must never fail a relay. */
  onError?: (err: unknown, op: string) => void;
}

/** How long a Redis miss is remembered before a read asks again. The GUI reads
 *  every few seconds; one Redis round-trip per session per window is plenty. */
const MISS_MEMORY_MS = 10_000;

export interface SessionCapabilityReport {
  timestamp: string;
  manual_input_available: boolean | null;
  streaming_state: CapabilityReport['streamingState'] | null;
  egress_state: CapabilityReport['egressState'] | null;
  proxy_kind: CapabilityReport['proxyKind'];
  proxy_udp_supported: boolean;
  transport_mode_requested: CapabilityReport['transportModeRequested'];
  transport_mode_active: CapabilityReport['transportModeActive'];
  safeguards_passed: boolean;
  /**
   * T-6 — did this session ACTUALLY carry an HTTP/3 connection?
   *
   * `true` once a real QUIC handshake completed; `null` means NOT OBSERVED and
   * must never be read as "no HTTP/3" — the node reports the field only once it
   * has seen a handshake, so an older build, or a session that simply has not
   * negotiated one yet, both report null. This is the only honest QUIC signal:
   * `transport_mode_active` above is the CONFIGURED mode, and a node's
   * interpose flag merely restates it, so neither can answer "did it carry".
   *
   * Without this field the fact was unobservable from the control plane at all,
   * which made a live verification read ABSENT for a reason that had nothing to
   * do with the device.
   */
  h3_connection_observed: boolean | null;
  /**
   * (o) O2 2026-09-11 — HOW MANY HTTP/3 connections the node has seen on this
   * session. `null` means NOT REPORTED (an older harness, or a node that has not
   * sent one yet) and must never be read as zero.
   *
   * ⛔ IT IS NOT A NICER `h3_connection_observed`. That flag is backed by an
   * insert-only Set on the node and can never return to false, so it is a sound
   * "h3 was reached at least once" claim and an UNSOUND liveness signal: a
   * consumer reading it as current refreshes a verdict on a relay that died an
   * hour ago, and the timestamp looks fresh BECAUSE nothing was checking. The
   * count is monotone, so its RATE carries the liveness the latched boolean
   * cannot — and a rate is unobservable from a boolean, however often you read it.
   *
   * The node has sent it since the schema accepted it; nothing consumed it. The
   * customer-safe projection stripped it, so the desktop readout's `· N
   * connections` branch was unreachable code, and the cockpit could only ever
   * show the latched "ever". This field is the one hop that was missing.
   */
  h3_connection_count: number | null;
  /** T-6 — the interpose image was seen loaded in the node's network process.
   *  INTERNAL diagnostic only (it names an implementation detail, and loaded is
   *  not carried), so it is deliberately NOT in the customer subset below. */
  interpose_image_loaded: boolean | null;
  /**
   * T-26 — the LIVE exit identity this session's traffic leaves through, and the
   * IPs its WebRTC candidates surface. `null` means NOT OBSERVED (a pre-T-26
   * harness, or a session that has not yet reported one) and must never be read
   * as "no exit" — the same absent-until-measured contract as
   * `h3_connection_observed` above. Customer-safe (the customer's own egress),
   * so these ARE in the subset below.
   */
  exit_ip: string | null;
  exit_country: string | null;
  exit_timezone: string | null;
  webrtc_candidate_ips: string[] | null;
  observed_at: string | null;
  /**
   * Per-session streaming degradation counters, when the node reported them.
   *
   * ⛔ `null` means UNKNOWN — the node never sent them (older build, or the
   * `DRIFTSTACK_STREAMING_HEALTH_REPORT` flag is off) — and must never be
   * rendered as healthy. This deliberately does NOT default to an object of
   * zeroes: a zero fps for a session nobody measured reads as a dead stream,
   * and a zero stall count for the same session reads as a clean one. Both are
   * claims from no evidence, which is exactly the `safeguards_passed`-off-an-
   * empty-array defect above.
   */
  streaming_health: NonNullable<CapabilityReport['streamingHealth']> | null;
  /**
   * 2026-09-19 ~19:10Z — build identity for THIS session, declared and measured.
   *
   * `webkit_fork_build` is the node's declared checkout; it was measured naming a
   * checkout 20 commits behind the real build. `webkit_framework_sha256` is the
   * raw `wc:…,wk:…,jsc:…` string measured at the spawn path — the frameworks this
   * session is actually running. Kept RAW: the decoder
   * (`fleet-build-drift.decodeWebkitFrameworkSha256`) is the single place that
   * decides whether a value is readable, and a store that pre-parsed would have
   * to invent a second opinion about a malformed value.
   *
   * `reporting_node_id` is the node the ownership gate already matched this frame
   * against. It is here because the drift report has to compare a SESSION's
   * frameworks with its DEVICE's current heartbeat, and the frame itself carries
   * no node id — the relay knows it, and nothing downstream could reconstruct it.
   *
   * ⛔ OPERATOR-ONLY. All three are excluded from `CustomerSafeCapabilityReport`
   * below by name. A build digest is fleet-internal: it identifies our deploy, not
   * the customer's session, and it is exactly the kind of field the allowlist
   * header warns becomes public by accident.
   */
  webkit_fork_build: string | null;
  webkit_framework_sha256: string | null;
  reporting_node_id: string | null;
}

/**
 * The subset of a stored report that may cross to a CUSTOMER.
 *
 * ⛔ AN EXPLICIT ALLOWLIST, NOT A SPREAD. `GET /v1/agent-sessions/:id` used to
 * assign the whole store record to `capability_report`, so every field added
 * here for internal use silently became part of a public API response. That is
 * leak-by-default: the safe case required remembering, and the unsafe case was
 * the one that happened automatically.
 *
 * It happened immediately — adding `streaming_health` for operator diagnosis
 * put eleven harness counters into a customer payload in the same commit, and
 * only a shape test caught it. Adding a field to this function is now a
 * deliberate act with a reviewer.
 */
export type CustomerSafeCapabilityReport = Omit<
  SessionCapabilityReport,
  // 2026-09-19 — the three build-identity fields are fleet-internal: they name
  // OUR deploy, not the customer's session. Omitted here AND stripped from the
  // raw frame in the relay, because this type only governs the agent-session
  // projection while the relay's `raw` spread reaches the public sessions API.
  | 'streaming_health'
  | 'interpose_image_loaded'
  | 'webkit_fork_build'
  | 'webkit_framework_sha256'
  | 'reporting_node_id'
  // Re-declared below: the customer vocabulary has one value the device's lacks.
  | 'egress_state'
> & {
  /** The device's `live` / `dead_proxy`, except that a dead connection on a
   *  session with no proxy of its own is published as
   *  {@link DEFAULT_CONNECTION_DOWN_EGRESS_STATE} (see {@link customerEgressState}). */
  egress_state: CustomerEgressState | null;
  /**
   * N-2 — the customer-safe subset {os, confidence, at} of the exit proxy's cached
   * passive TCP/IP OS fingerprint. `at` is WHEN it was measured (ISO, the proxy
   * row's `os_fingerprint_at`) and crosses to the customer for one reason: this
   * is a stored reading of unbounded age, not a live one, and a surface that
   * cannot say how old it is can only render it as a present-tense fact. A
   * reading with no usable stamp is not projected at all.
   *
   * NOT a harness fact: the CONTROL PLANE measures
   * it (proxy /:id/test) and persists it on the proxy row, and the serve path
   * reads it back here. `null` means NOT OBSERVED — never measured, or the session
   * has no owned proxy to read — and must render as "measuring…", never a
   * placeholder OS (the same absent-until-measured contract as exit_ip).
   *
   * Owner item 9 — HOW the reading was taken crosses too (see
   * {@link SessionOsFingerprint}); the free-text reason and the observed address
   * are deliberately NOT here.
   */
  os_fingerprint: SessionOsFingerprint | null;
};

/**
 * The session's projection of its exit proxy's stored OS reading.
 *
 * `{os, confidence, at}` is the reading and when it was taken. The rest is HOW it
 * was taken, in the exact names the proxy Test reply and the proxy list publish
 * (`observed_via`, `single_host_vantage`, `web_port_vantage`, and the customer
 * names `direct_reading` / `website_like_reading` for the last two): whether an OS
 * that differs from the phone's is a real mismatch or a reading that does not
 * describe the path a website sees is decided from exactly these, and without them
 * a client reading the session can never show the first. The serve path always
 * fills them (the path flags FALSE when a stored reading predates them); they are
 * optional in this type only because the projection itself is a pass-through.
 * `reason` and `observed_ip` stay on the server.
 */
export interface SessionOsFingerprint {
  os: string;
  confidence: string;
  at: string;
  observed_via?: 'proxy_host' | 'exit_ip';
  single_host_vantage?: boolean;
  web_port_vantage?: boolean;
  direct_reading?: boolean;
  website_like_reading?: boolean;
}

/**
 * Did every safeguard the node expects actually report, and did all of them pass?
 *
 * Exported because the relay needs the SAME judgement to decide which warning to
 * emit, and two copies of a safety predicate is how they drift apart.
 *
 * Three cases, deliberately distinct:
 *   • expected set present → every expected layer reported AND all passed.
 *     A missing layer is a NO, because "we did not look" cannot be reported as
 *     "it passed" — that is the fail-open this function exists to close.
 *   • expected set ABSENT → unverifiable. Fall back to at-least-one-and-all-pass,
 *     the strongest honest claim available, and let the relay say completeness
 *     was not verified. Absent is NOT an empty set: an empty set would satisfy
 *     the superset test vacuously.
 *   • no checks at all → false. A positive claim from no evidence.
 */
export function safeguardsPassed(frame: CapabilityReport): boolean {
  const checks = frame.safeguardChecks;
  if (checks.length === 0) return false;
  if (!checks.every((check) => check.passed)) return false;
  const expected = frame.safeguardLayersExpected;
  if (expected === undefined) return true;
  const reported = new Set(checks.map((check) => check.layer));
  return expected.every((layer) => reported.has(layer));
}

/** Expected layers the frame did NOT report. Empty when the node declares no
 *  expectation, which the caller must treat as UNVERIFIED rather than complete. */
export function missingSafeguardLayers(frame: CapabilityReport): string[] {
  const expected = frame.safeguardLayersExpected;
  if (expected === undefined) return [];
  const reported = new Set(frame.safeguardChecks.map((check) => check.layer));
  return expected.filter((layer) => !reported.has(layer));
}

// ─── A dead connection on a session that used no proxy of its own ───────────
//
// A session created with no `proxy_id` runs on the connection Driftstack provides
// (the operator-default upstream; its row keeps `proxyId: null`). When that
// connection stops carrying traffic mid-session, the device marks the session
// `dead_proxy` and keeps it running — the same word it uses for a customer's own
// proxy going silent, because from the phone the two are indistinguishable. The
// desktop app turned it into a red "Proxy connection failed" badge, for a customer
// who chose no proxy and cannot fix ours. Only this server knows which it was, so
// the customer projection publishes the difference. The store itself keeps the
// device's word: operator surfaces read the record, not this projection.
//
// A distinct VALUE rather than a new field, so an app that predates it reads
// correctly too: the desktop app narrows any egress_state it does not know to
// null and shows no badge, which is silent but true, where the old value would
// keep blaming a proxy the customer does not have.

/** What `dead_proxy` is published as on a session with no proxy of its own. */
export const DEFAULT_CONNECTION_DOWN_EGRESS_STATE = 'default_connection_down';

/** The egress_state vocabulary a customer can read. */
export type CustomerEgressState =
  | NonNullable<CapabilityReport['egressState']>
  | typeof DEFAULT_CONNECTION_DOWN_EGRESS_STATE;

/**
 * The customer's egress_state for a session. `proxyId` is the session row's:
 * `null` means no proxy of its own. An `undefined` proxyId (a caller that did not
 * say) is NOT read as null — the device's word stands, the same fail-safe the
 * error-event relay uses.
 */
export function customerEgressState(
  egressState: SessionCapabilityReport['egress_state'],
  session: { proxyId: string | null } | undefined,
): CustomerEgressState | null {
  if (egressState === undefined || egressState === null) return null;
  if (egressState === 'dead_proxy' && session?.proxyId === null) {
    return DEFAULT_CONNECTION_DOWN_EGRESS_STATE;
  }
  return egressState;
}

export function customerSafeCapabilityReport(
  report: SessionCapabilityReport,
  osFingerprint?: SessionOsFingerprint | null,
  // The session the report is about. The GET projection always passes it;
  // without it egress_state is published as the device sent it.
  session?: { proxyId: string | null },
): CustomerSafeCapabilityReport {
  return {
    timestamp: report.timestamp,
    manual_input_available: report.manual_input_available,
    streaming_state: report.streaming_state,
    egress_state: customerEgressState(report.egress_state, session),
    proxy_kind: report.proxy_kind,
    proxy_udp_supported: report.proxy_udp_supported,
    transport_mode_requested: report.transport_mode_requested,
    transport_mode_active: report.transport_mode_active,
    safeguards_passed: report.safeguards_passed,
    // Deliberate addition to the allowlist: this is the customer's honest answer
    // to "does my proxy actually carry HTTP/3", the same class of fact as
    // transport_mode_active beside it. The internal interpose diagnostic is NOT
    // included.
    h3_connection_observed: report.h3_connection_observed,
    // (o) O2 — a DELIBERATE allowlist addition, beside the flag it makes usable.
    // It is the same fact as `h3_connection_observed` at a finer grain — the
    // customer's own session, their own egress — and it carries the liveness the
    // latched boolean structurally cannot. It names no endpoint, identifies no
    // person, and is a small non-negative integer. `null` stays null: NOT
    // REPORTED, never rendered as zero connections.
    h3_connection_count: report.h3_connection_count,
    // T-26 — the live exit identity + WebRTC candidate IPs are the customer's
    // OWN egress facts (T-26 ledger row: live exit IP + WebRTC IP in the
    // simulator), so they cross to the customer. Added deliberately to the
    // allowlist, not spread — the same rule the header states.
    exit_ip: report.exit_ip,
    exit_country: report.exit_country,
    exit_timezone: report.exit_timezone,
    webrtc_candidate_ips: report.webrtc_candidate_ips,
    observed_at: report.observed_at,
    // N-2 — a DELIBERATE allowlist addition (like exit_ip above), but sourced from
    // the proxy row rather than the harness frame: the customer-safe subset of
    // the exit's cached TCP/IP OS fingerprint (SessionOsFingerprint). `?? null`
    // keeps a miss a miss — NOT OBSERVED, rendered "measuring…", never a
    // placeholder OS. The free-text reason and the observed address are NOT
    // crossed to the customer.
    os_fingerprint: osFingerprint ?? null,
  };
}

/** A stored record, validated just enough to serve it: anything else is
 *  treated as absent (never served, never thrown). */
function reportFromStored(raw: string | null): SessionCapabilityReport | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (typeof r.timestamp !== 'string') return null;
    if (r.manual_input_available !== null && typeof r.manual_input_available !== 'boolean') {
      return null;
    }
    return parsed as SessionCapabilityReport;
  } catch {
    return null;
  }
}

export class SessionCapabilityReportStore {
  private readonly map = new Map<string, SessionCapabilityReport>();
  private readonly persistence:
    | (Required<Omit<CapabilityReportPersistence, 'onError'>> &
        Pick<CapabilityReportPersistence, 'onError'>)
    | null;
  /** In-flight read-through fetches, by session. A set/delete for the session
   *  removes its entry, which voids the fetch: an older stored copy must never
   *  overwrite a newer report or resurrect a deleted one. */
  private readonly loads = new Map<string, symbol>();
  /** Sessions Redis recently had nothing for, and when. */
  private readonly misses = new Map<string, number>();

  constructor(
    private readonly maxEntries = 5_000,
    persistence?: CapabilityReportPersistence,
  ) {
    this.persistence =
      persistence === undefined
        ? null
        : {
            redis: persistence.redis,
            keyPrefix: persistence.keyPrefix ?? CAPABILITY_REPORT_REDIS_PREFIX,
            ttlSeconds: Math.max(
              1,
              Math.round(persistence.ttlSeconds ?? resolveMaxLifetimeHours() * 3_600),
            ),
            onError: persistence.onError,
          };
  }

  private keyOf(sessionId: string): string {
    return `${this.persistence?.keyPrefix ?? CAPABILITY_REPORT_REDIS_PREFIX}${sessionId}`;
  }

  private fail(err: unknown, op: string): void {
    this.persistence?.onError?.(err, op);
  }

  /** Insert in memory, evicting the oldest past the bound. */
  private remember(sessionId: string, report: SessionCapabilityReport): void {
    this.map.delete(sessionId);
    this.map.set(sessionId, report);
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /**
   * Reload every report the previous process stored — call once at start-up,
   * before serving. Memory wins over the stored copy (it can only be newer).
   * Never rejects: an unreachable Redis leaves the store empty, exactly as a
   * restart always did.
   */
  async hydrate(): Promise<void> {
    const p = this.persistence;
    if (p === null) return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await p.redis.scan(cursor, 'MATCH', `${p.keyPrefix}*`, 'COUNT', 200);
        cursor = next;
        if (keys.length === 0) continue;
        const values = await p.redis.mget(...keys);
        keys.forEach((key, i) => {
          const sessionId = key.slice(p.keyPrefix.length);
          if (sessionId === '' || this.map.has(sessionId)) return;
          if (this.map.size >= this.maxEntries) return;
          const report = reportFromStored(values[i] ?? null);
          if (report !== null) this.map.set(sessionId, report);
        });
      } while (cursor !== '0');
    } catch (err) {
      this.fail(err, 'hydrate');
    }
  }

  /** Fetch one session's stored copy into memory, in the background. */
  private loadInBackground(sessionId: string): void {
    const p = this.persistence;
    if (p === null || this.loads.has(sessionId)) return;
    const missedAt = this.misses.get(sessionId);
    if (missedAt !== undefined && Date.now() - missedAt < MISS_MEMORY_MS) return;
    const token = Symbol(sessionId);
    this.loads.set(sessionId, token);
    void p.redis.get(this.keyOf(sessionId)).then(
      (raw) => {
        if (this.loads.get(sessionId) !== token) return; // superseded by a set/delete
        this.loads.delete(sessionId);
        const report = reportFromStored(raw);
        if (report === null) {
          if (this.misses.size >= this.maxEntries) this.misses.clear();
          this.misses.set(sessionId, Date.now());
          return;
        }
        if (!this.map.has(sessionId)) this.remember(sessionId, report);
      },
      (err: unknown) => {
        if (this.loads.get(sessionId) === token) this.loads.delete(sessionId);
        this.fail(err, 'get');
      },
    );
  }

  /**
   * `reportingNodeId` is OPTIONAL so every existing caller (and every test fake)
   * keeps compiling and keeps meaning what it meant — an omitted node id stores
   * null, which the drift report reads as "this session cannot be attributed to a
   * device" and therefore never compares. A required parameter would have made
   * the absent case unrepresentable and pushed callers into passing a placeholder,
   * which is how a session gets attributed to the wrong device.
   */
  set(frame: CapabilityReport, reportingNodeId?: string): void {
    const record: SessionCapabilityReport = {
      timestamp: frame.timestamp,
      manual_input_available: frame.manualInputAvailable ?? null,
      streaming_state: frame.streamingState ?? null,
      egress_state: frame.egressState ?? null,
      proxy_kind: frame.proxyKind,
      proxy_udp_supported: frame.proxyUdpSupported,
      transport_mode_requested: frame.transportModeRequested,
      transport_mode_active: frame.transportModeActive,
      // `?? null` preserves the node's absent-until-observed semantics exactly:
      // the field is reported only once a handshake has completed, so absent
      // stays NOT-OBSERVED and never collapses into a false "no HTTP/3".
      h3_connection_observed: frame.h3ConnectionObserved ?? null,
      // (o) O2 — `?? null` and NEVER `?? 0`: a zero is a MEASUREMENT ("this
      // session has carried no HTTP/3 connection"), and a frame that never
      // carried the key has measured nothing. Coercing absence to 0 would put a
      // confident negative on every older harness's session.
      h3_connection_count: frame.h3ConnectionCount ?? null,
      interpose_image_loaded: frame.interposeImageLoaded ?? null,
      // T-26 — `?? null` preserves the node's absent-until-observed semantics
      // exactly: a key the schema dropped (malformed value) or an older harness
      // never sent stays NOT-OBSERVED and never collapses into a false answer.
      exit_ip: frame.exitIp ?? null,
      exit_country: frame.exitCountry ?? null,
      exit_timezone: frame.exitTimezone ?? null,
      webrtc_candidate_ips: frame.webrtcCandidateIps ?? null,
      observed_at: frame.observedAt ?? null,
      // `every` on an EMPTY array is true, so a frame carrying no safeguard
      // checks once reported `safeguards_passed: true` — a positive safety claim
      // asserted from no evidence. Requiring at least one check fixed that case,
      // and the case it fixed turned out not to be the one production produces.
      //
      // ⛔ THE REAL DEFECT WAS THE OPPOSITE, AND THIS LINE FAILED OPEN. The node
      // always seeds its other layers and appends `screen_recording` only when
      // the grant was actually checked — omitting a layer it never looked at,
      // which is right, and which arrives here as a SHORTER array rather than an
      // empty one. The seeded layers then satisfy both halves below, so a session
      // whose screen-recording safeguard was never checked reported
      // `safeguards_passed: TRUE`. `length > 0` is a presence test: it cannot see
      // a member that is missing, only the absence of all of them.
      //
      // So completeness is now asserted against the set the NODE declares:
      // every expected layer must have reported, and every reported check must
      // have passed.
      //
      // ⚠️ An ABSENT expected set is not an empty one. Absent means the node does
      // not declare its expectations, so completeness is unverifiable — fall back
      // to the old predicate, which is the strongest honest claim available, and
      // let the relay say so with `safeguards_expectation_unreported`. Treating
      // absent as "expects nothing" would make the superset vacuously true and
      // rebuild the fail-open one level up.
      safeguards_passed: safeguardsPassed(frame),
      // `?? null` and never `?? {}` — see the field doc. Absent stays absent.
      streaming_health: frame.streamingHealth ?? null,
      // 2026-09-19 — declared + measured build identity, both kept RAW. `?? null`
      // preserves absent-until-measured exactly as every field above: a harness
      // that predates the key, and one whose framework files could not be read,
      // both arrive with nothing, and neither may render as a digest.
      webkit_fork_build: frame.webkitForkBuild ?? null,
      webkit_framework_sha256: frame.webkitFrameworkSha256 ?? null,
      reporting_node_id: reportingNodeId ?? null,
    };
    this.remember(frame.sessionId, record);
    this.loads.delete(frame.sessionId);
    this.misses.delete(frame.sessionId);
    const p = this.persistence;
    if (p !== null) {
      // Best-effort and in order on one connection: a later delete for the
      // same session is issued after this and wins.
      void p.redis
        .set(this.keyOf(frame.sessionId), JSON.stringify(record), 'EX', p.ttlSeconds)
        .catch((err: unknown) => this.fail(err, 'set'));
    }
  }

  get(sessionId: string): SessionCapabilityReport | null {
    const hit = this.map.get(sessionId);
    if (hit !== undefined) return hit;
    // Not in memory: this process may not have seen the report the previous
    // one stored. Fetch it for the next read; this one says "not reported".
    this.loadInBackground(sessionId);
    return null;
  }

  /**
   * Every live report, for the OPERATOR fleet drift report.
   *
   * ⛔ A SNAPSHOT, NOT A VIEW. The array is built at call time so a caller
   * iterating it cannot observe the map mutating under a concurrently arriving
   * frame, and cannot reach the live map to mutate it. The store stays the only
   * writer, which is the same posture the relay's ownership gate depends on.
   *
   * Returns the internal record, NOT the customer-safe projection: this feeds an
   * admin-scoped surface, and the projection deliberately drops the three build
   * fields the drift report exists to read.
   */
  entries(): { sessionId: string; report: SessionCapabilityReport }[] {
    return [...this.map.entries()].map(([sessionId, report]) => ({ sessionId, report }));
  }

  delete(sessionId: string): void {
    this.map.delete(sessionId);
    this.loads.delete(sessionId);
    this.misses.delete(sessionId);
    const p = this.persistence;
    if (p !== null) {
      void p.redis.del(this.keyOf(sessionId)).catch((err: unknown) => this.fail(err, 'del'));
    }
  }

  get size(): number {
    return this.map.size;
  }
}
