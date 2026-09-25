// Ownership-gated live capabilityReport consumer.
//
// One accepted frame updates the agent-session GUI state and, when the agent is
// linked to a driver session, calls the already-existing atomic raw+derived
// egress persistence/webhook path. Processing is serialized per agent session
// so a slower ownership lookup cannot let an older state overwrite a newer one.

import type { Logger } from '../lib/logger.js';
import type { CapabilityReport } from '../schemas/harness-control-protocol.js';
import { makeBoundedNodeLatestRelay } from './bounded-node-latest-relay.js';
import type { SessionCapabilityReportStore } from './session-capability-report-store.js';
import {
  customerEgressState,
  DEFAULT_CONNECTION_DOWN_EGRESS_STATE,
  missingSafeguardLayers,
  safeguardsPassed,
} from './session-capability-report-store.js';
import {
  PUBLIC_SAFEGUARD_LAYERS,
  safeToken,
  unmappedEgressWarnings,
} from './customer-safe-egress-warnings.js';

interface CapabilityReportAgentSessions {
  get(id: string): Promise<{
    nodeId: string | null;
    driftstackSessionId: string | null;
    status: string;
    // T-6 — carried so a measured QUIC verdict can be attributed, owner-scoped,
    // to the proxy this session browsed through. accountId scopes the update;
    // proxyId is NULL when the session used an operator-default egress.
    accountId: string;
    proxyId: string | null;
    // T-26 — the stop-on-exit-IP-change policy and the remembered first exit IP.
    // Optional here so older test fakes (and any caller that predates the policy)
    // read as "no policy": undefined stopOnExitIpChange never triggers enforcement.
    stopOnExitIpChange?: boolean;
    firstExitIp?: string | null;
  } | null>;
  // T-26 — record the FIRST exit IP once, close the session on a change, and
  // stamp the customer-visible from/to. The full repo satisfies these.
  setFirstExitIpIfUnset(id: string, exitIp: string): Promise<unknown>;
  closeWithReasonOutcome(
    id: string,
    reason: string,
  ): Promise<{ kind: 'closed' | 'already_closed' }>;
  recordErrorEvent(
    id: string,
    reportingNodeId: string,
    event: {
      timestamp: string;
      code: string;
      severity: 'info' | 'warn' | 'error' | 'fatal';
      summary: string;
      detail: string | null;
      customerActionable: boolean;
      retryable: boolean;
    },
  ): Promise<unknown>;
}

// T-6 — the owner-scoped account_proxies update the back-fill needs. The real
// AccountProxiesRepo.update matches this: a foreign or absent (id, accountId)
// pair updates no row, so a stray proxy_id is a safe no-op.
interface CapabilityReportAccountProxies {
  update(args: {
    id: string;
    accountId: string;
    updates: {
      quicMeasured?: string;
      quicMeasuredAt?: Date;
      exitObserved?: {
        ip: string;
        country: string | null;
        timezone: string | null;
        // Mirrors the repo's union; this relay only ever writes 'session'.
        observed_via: 'session' | 'probe';
      };
      exitObservedAt?: Date;
      /** (i) I7 — a session exit is the tunnel seen UP: it clears the stamp a
       *  fleet failure left on the row (null), never sets one. */
      exitSupersededAt?: Date | null;
    };
  }): Promise<unknown>;
}

interface CapabilityReportSessionsService {
  ingestEgressCapabilityReport(args: {
    sessionId: string;
    derived: {
      udp_associate: boolean;
      quic_route: 'proxy' | 'disabled';
      dns_remote_resolve: boolean;
      /** Optional and ABSENT-capable — see `deriveSafeguardsTriState` below and
       *  the field's doc comment in packages/api-types/src/egress.ts. */
      safeguards?: 'passed' | 'failed' | 'unverified';
      warnings: string[];
    };
    raw: Record<string, unknown>;
  }): Promise<unknown>;
}

/** `udp_unsupported_by_proxy` on a session with no proxy of its own: the
 *  connection Driftstack provides carried no UDP. Published as `quic_unavailable`
 *  (customer-safe-egress-warnings), because there is no proxy of the customer's to
 *  have refused anything. */
const UDP_UNSUPPORTED_BY_DEFAULT_CONNECTION = 'udp_unsupported_by_default_connection';
/** `safeguard_failed:per_spawn_verification` on a session with no proxy of its
 *  own: the check that traffic left through the connection Driftstack provides did
 *  not pass. Its published layer word says "your proxy", so it is published as the
 *  bare `safeguard_failed`. */
const DEFAULT_CONNECTION_VERIFICATION_FAILED = 'default_connection_verification_failed';
/** The safeguard layer whose published word (`proxy_egress_verification`) names
 *  the customer's proxy. */
const ROUTE_VERIFICATION_LAYER = 'per_spawn_verification';

function deriveWarnings(frame: CapabilityReport, session: { proxyId: string | null }): string[] {
  const warnings: string[] = [];
  // ⛔ A session with NO proxy of its own (proxyId null) runs on the connection
  // Driftstack provides, so the two warnings whose published words blame "your
  // proxy" — the UDP gap and the route check — are ours on it, the same as
  // `dead_proxy` below. Only an explicit null counts: a record without the field
  // is NOT read as no proxy, the fail-safe customerEgressState uses (there the
  // device's word stands; here the proxy form does).
  const noProxyOfItsOwn = session.proxyId === null;
  if (frame.transportModeRequested === 'h2-and-h3' && frame.transportModeActive !== 'h2-and-h3') {
    warnings.push(
      noProxyOfItsOwn ? UDP_UNSUPPORTED_BY_DEFAULT_CONNECTION : 'udp_unsupported_by_proxy',
    );
  }
  if (frame.transportModeActive === 'h2-and-h3' && !frame.h3InterposeLoaded) {
    warnings.push('h3_interpose_unavailable');
  }
  // No checks at all is its OWN signal, not silence. Without this the empty
  // case produced zero warnings AND a true `safeguards_passed`, so a session
  // whose safeguards never ran looked exactly like a verified healthy one.
  if (frame.safeguardChecks.length === 0) {
    warnings.push('safeguards_unreported');
  }
  for (const check of frame.safeguardChecks) {
    if (check.passed) continue;
    warnings.push(
      noProxyOfItsOwn && check.layer === ROUTE_VERIFICATION_LAYER
        ? DEFAULT_CONNECTION_VERIFICATION_FAILED
        : `safeguard_failed:${check.layer}`,
    );
  }
  // ⛔ THE CASE THAT USED TO PASS SILENTLY. A layer the node never checked is
  // omitted rather than reported false — right at the source, and it arrives here
  // as a SHORTER array, not an empty one, so neither the empty-array warning
  // above nor the failed-check loop can see it. A session whose screen-recording
  // safeguard was never looked at reported every safeguard passed.
  //
  // Named per layer, because "something is missing" and "the screen-recording
  // check never ran" send an operator to different places.
  for (const layer of missingSafeguardLayers(frame)) {
    warnings.push(`safeguard_missing:${layer}`);
  }
  // And the honest gap: a node that declares no expected set has not told us what
  // complete looks like, so completeness is UNVERIFIED rather than confirmed.
  // This is not the same as a missing layer and must not read as one — it is the
  // difference between "a check is absent" and "we cannot tell whether one is".
  if (frame.safeguardLayersExpected === undefined) {
    warnings.push('safeguards_expectation_unreported');
  }
  if (frame.streamingState === 'blank') warnings.push('streaming_blank');
  if (frame.streamingState === 'failed') warnings.push('streaming_failed');
  // A dead connection on a session with NO proxy of its own (proxyId null: it
  // runs on the connection Driftstack provides) is ours, not the customer's
  // proxy — the same projection the agent-session read makes
  // (customerEgressState). It is decided HERE, where the session row is in hand,
  // because nothing downstream of this list knows the agent session's proxy:
  // the /v1/sessions responses and the `session.egress_capability_changed`
  // webhook both read this warning, and the public edge projects the raw
  // frame's `egressState` from it (customerSafeEgressCapabilityReport). A
  // record without a proxyId at all is NOT read as null — the device's word
  // stands, the same fail-safe customerEgressState uses.
  if (frame.egressState === 'dead_proxy') {
    warnings.push(
      customerEgressState(frame.egressState, session) === DEFAULT_CONNECTION_DOWN_EGRESS_STATE
        ? DEFAULT_CONNECTION_DOWN_EGRESS_STATE
        : 'dead_proxy',
    );
  }
  return warnings;
}

/**
 * The customer's tri-state answer to "did my egress safeguards hold" for this
 * report — `passed | failed | unverified`. Deliberately derived from the SAME
 * frame, in the SAME place, as `deriveWarnings` immediately above: a
 * `safeguards: 'failed'` report and a `safeguard_failed:<layer>` warning
 * always come from one fact, not two independently-computed ones that could
 * start disagreeing.
 *
 * Reuses `safeguardsPassed()` and `missingSafeguardLayers()` from
 * `session-capability-report-store.ts` — the evidence rule pinned by
 * `safeguards-passed-requires-evidence.test.ts` — rather than restating the
 * completeness logic a second time.
 *
 * ⚠️ STRICTER THAN `safeguardsPassed()` FOR ONE POPULATION, AND DELIBERATELY
 * SO. `safeguardsPassed()` returns `true` once every REPORTED check passed
 * even when the device declared no expected set at all — documented there as
 * "the strongest honest claim available" for the BOOLEAN it feeds
 * (`safeguards_passed` on the agent-session projection). A customer tri-state
 * cannot make that same claim: an undeclared expected set means completeness
 * was never checkable, so THIS function reads `unverified` for exactly the
 * population where `safeguardsPassed()` reads `true`. The two fields answer
 * different questions and are allowed to disagree — see the doc comments on
 * both.
 *
 * Exported (unlike `deriveWarnings` above) so integration tests can seed a
 * realistic `derived.safeguards` value from an actual frame — with or
 * without a declared expected set — rather than hand-typing a literal that
 * could silently drift from what this function would really produce.
 */
export function deriveSafeguardsTriState(
  frame: CapabilityReport,
): 'passed' | 'failed' | 'unverified' {
  // A known failure is the strongest actionable fact even when completeness
  // is ALSO unverifiable, so it is checked, and wins, first.
  if (frame.safeguardChecks.some((check) => !check.passed)) return 'failed';
  if (
    frame.safeguardLayersExpected !== undefined &&
    missingSafeguardLayers(frame).length === 0 &&
    safeguardsPassed(frame)
  ) {
    return 'passed';
  }
  // No checks at all, an expected layer that never reported, or no declared
  // expected set at all: none of these is a failure, but none earns `passed`
  // either — every one of them is "we cannot confirm completeness".
  return 'unverified';
}

const SAFEGUARD_LAYER_UNWORDED_PREFIX = 'safeguard_layer_unworded:';

/**
 * ⛔ EARLY NOTICE, ON DECLARATION — NOT ON FAILURE. `deriveWarnings` above only
 * ever learns about a layer name once it FAILS (`safeguard_failed:<layer>`) or
 * is MISSING from a report that declared an expectation
 * (`safeguard_missing:<layer>`). A brand-new device-side layer that the fork
 * ships and that keeps passing is invisible to both: nothing here would name
 * it until the day it first fails, by which point it has been shipping
 * unclassified — and therefore unworded for `PUBLIC_SAFEGUARD_LAYERS` — for as
 * long as it has existed.
 *
 * This walks every layer name a frame MENTIONS AT ALL — `safeguardLayersExpected`
 * (what the device says a healthy session reports) and every
 * `safeguardChecks[].layer` (what it actually reported this time), passing or
 * not — and reports any that is not a key of `PUBLIC_SAFEGUARD_LAYERS` through
 * the SAME bounded recorder the egress-warning map uses. That recorder already
 * logs a given code at most once per process and keeps counting past its cap,
 * which is exactly "once per process" for this notice too — no second
 * dedupe/bound to invent or drift from the original.
 *
 * ⛔ NO CUSTOMER-VISIBLE CHANGE. This never touches the `warnings` array
 * `deriveWarnings` builds; it is a side channel straight to the recorder an
 * operator reads, the same one `unmappedEgressWarnings.counts()` already
 * exposes. A device-controlled layer name is sanitised through the same
 * `safeToken` the map uses before it is ever logged, for the same reason: it
 * must never put device-chosen text into a log line unshaped.
 */
function recordUnwordedSafeguardLayers(frame: CapabilityReport, logger: Logger): void {
  const layers = new Set<string>();
  for (const layer of frame.safeguardLayersExpected ?? []) layers.add(layer);
  for (const check of frame.safeguardChecks) layers.add(check.layer);
  if (layers.size === 0) return;
  const unworded: string[] = [];
  for (const layer of layers) {
    if (!Object.prototype.hasOwnProperty.call(PUBLIC_SAFEGUARD_LAYERS, layer)) {
      unworded.push(`${SAFEGUARD_LAYER_UNWORDED_PREFIX}${safeToken(layer)}`);
    }
  }
  if (unworded.length > 0) unmappedEgressWarnings.record(unworded, logger);
}

export function makeSessionCapabilityReportRelay(
  agentSessions: CapabilityReportAgentSessions,
  sessionsService: CapabilityReportSessionsService,
  store: SessionCapabilityReportStore,
  logger: Logger,
  // T-6 — the account_proxies repo the QUIC back-fill writes through, and the
  // clock that stamps quic_measured_at. Optional so an unwired construction
  // keeps today's behaviour (store + egress persistence) with no back-fill.
  accountProxies?: CapabilityReportAccountProxies,
  now: () => Date = () => new Date(),
): (frame: CapabilityReport, reportingNodeId: string) => void {
  const process = async (frame: CapabilityReport, reportingNodeId: string): Promise<void> => {
    const session = await agentSessions.get(frame.sessionId);
    if (session === null || session.nodeId !== reportingNodeId || session.status === 'closed') {
      logger.warn(
        {
          component: 'session-capability-report-relay',
          sessionId: frame.sessionId,
          ownerNodeId: session?.nodeId ?? null,
          reportingNodeId,
          sessionStatus: session?.status ?? null,
        },
        'dropped capabilityReport without an exact live session-owner node match',
      );
      return;
    }

    // The node id is carried into the store because the frame does not have one:
    // the ownership gate immediately above is the only place that knows which
    // device this report belongs to, and the operator drift report has to compare
    // a session's frameworks against its DEVICE's current heartbeat.
    //
    // The PREVIOUS report is read first: the QUIC back-fill below dates a
    // latched HTTP/3 observation by when its count ROSE, and only the report
    // before this one knows what the count was (proxy-accuracy audit S2).
    const priorReport = store.get(frame.sessionId);
    store.set(frame, reportingNodeId);

    // Item 4 — notice a new device-side safeguard layer NAME the moment it is
    // first declared or reported, not the moment it first fails. Runs on every
    // accepted frame, ownership-gated the same as the store write above and
    // unconditional on `driftstackSessionId` (below): the layer name is a
    // property of the DEVICE's report, not of whether this session has a
    // driver link.
    recordUnwordedSafeguardLayers(frame, logger);

    // T-26 — stop-on-exit-IP-change enforcement, control-plane side only: the
    // harness already emits the exit IP on the capabilityReport it sends, so no
    // harness change is needed. Fires only when the customer PINNED the session
    // AND the frame carries a PARSED exit IP — a malformed one was dropped by the
    // schema (`.catch(undefined)`), so `exitIp` is undefined and enforcement can
    // never act on garbage.
    if (frame.exitIp !== undefined && session.stopOnExitIpChange === true) {
      const firstExitIp = session.firstExitIp ?? null;
      if (firstExitIp === null) {
        // Remember the FIRST observed exit IP on the SESSION ROW — it survives a
        // control-plane restart, which the in-memory capability store above does
        // NOT. Only-if-unset so a race between two reports records one baseline.
        await agentSessions.setFirstExitIpIfUnset(frame.sessionId, frame.exitIp);
      } else if (firstExitIp !== frame.exitIp) {
        // The exit IP moved under a pinned session. END it through the SAME
        // atomic terminal close the DELETE route and worker-terminal-close use —
        // no second teardown invented. The reporting box is still connected, so
        // the next heartbeat's worker-orphan reconcile re-issues sessionEnd for a
        // CP-terminal session the worker still reports active, tearing the box
        // session down through the existing path too.
        const outcome = await agentSessions.closeWithReasonOutcome(
          frame.sessionId,
          'exit_ip_changed',
        );
        if (outcome.kind === 'closed') {
          // Customer-visible from/to on the durable errorEvent the GET response
          // already surfaces (the existing terminal-reason mechanism), so the GUI
          // can render "Stopped: exit IP changed from A to B". Owner-matched (we
          // verified session.nodeId === reportingNodeId above) and deliberately
          // NOT run through the node-diagnostic scrubber: these are the customer's
          // OWN egress IPs, not fleet-node IPs.
          await agentSessions.recordErrorEvent(frame.sessionId, reportingNodeId, {
            timestamp: frame.observedAt ?? frame.timestamp,
            code: 'exit_ip_changed',
            severity: 'warn',
            summary: `Session stopped: exit IP changed from ${firstExitIp} to ${frame.exitIp}.`,
            detail: null,
            customerActionable: true,
            retryable: false,
          });
        }
        // Evict the live capability state for a now-terminal session (mirrors the
        // DELETE route). The session is ending — skip the QUIC back-fill and
        // egress-persistence below.
        store.delete(frame.sessionId);
        return;
      }
    }

    // T-6 — the MEASURED signal: present-and-true only once a real QUIC handshake
    // completed this session (fork marker). Absent on any harness that has not
    // observed one, so absence writes nothing and only a real observation ever
    // stamps a green verdict onto the proxy.
    const quicReallyObserved = frame.h3ConnectionObserved === true;
    // ⛔ S2 (paths-08) — the flag is LATCHED: once a session carries one HTTP/3
    // connection, every later report (every 240–360 s) says true again. Writing
    // on every one re-dated a single handshake to "now" for the whole session,
    // and that fresh date then beat a newer Test's measured failure on every Mac
    // ("later wins"). A reading is dated when it was TAKEN, so the write happens
    // only when the device's own `h3ConnectionCount` rises — or, from a harness
    // that sends no count, on the first latched sighting this relay sees. Never
    // `frame.observedAt`: that dates the EXIT observation, not the handshake.
    const priorH3Count = priorReport?.h3_connection_count ?? null;
    const h3CountRose =
      frame.h3ConnectionCount !== undefined
        ? frame.h3ConnectionCount > 0 &&
          (priorH3Count === null || frame.h3ConnectionCount > priorH3Count)
        : priorReport?.h3_connection_observed !== true;
    // T-6 — back-fill the REAL, MEASURED QUIC verdict onto the proxy this session
    // browsed through, so the proxy test/chip shows a confirmed result instead of
    // a guess. We write ONLY on a real observation: `quicReallyObserved` is
    // present-and-true only after a QUIC handshake actually completed this
    // session, so we write 'h3'. We DELIBERATELY write NOTHING otherwise — the
    // absence of an observed handshake is "not measured yet", NOT "this proxy
    // can't do QUIC", so recording 'h2-only' from it would be a measured-absence
    // claim we cannot back (the config echo in the other direction). A proxy
    // stays null (chip: inferred) until a session genuinely carries h3 through
    // it. Only when a proxy is actually attributed (proxyId non-null) — an
    // operator-default egress has no owned proxy to mark. Owner-scoped (id +
    // accountId), so a foreign or deleted proxy_id updates no row. Best-effort: a
    // failure is logged but never fails consuming the report.
    if (
      accountProxies !== undefined &&
      session.proxyId !== null &&
      quicReallyObserved &&
      h3CountRose
    ) {
      try {
        await accountProxies.update({
          id: session.proxyId,
          accountId: session.accountId,
          updates: {
            quicMeasured: 'h3',
            quicMeasuredAt: now(),
          },
        });
      } catch (error) {
        logger.error(
          {
            component: 'session-capability-report-relay',
            sessionId: frame.sessionId,
            proxyId: session.proxyId,
            err: error,
          },
          'failed to back-fill measured QUIC verdict onto the proxy',
        );
      }
    }

    // VPN parity — persist the EXIT IDENTITY the box observed for this session onto
    // the attributed proxy row (latest wins). For a SOCKS5 the desktop client probes
    // the exit from the Mac; for OpenVPN/WireGuard only the fleet can see through the
    // tunnel, so this back-fill is the ONLY source of a VPN proxy's location/timezone
    // — the /proxies list surfaces it and the next launch hands the timezone to the
    // simulator. Same owner-scoping and best-effort contract as the QUIC back-fill:
    // only an attributed proxy (proxyId non-null), a failure is logged, never thrown.
    if (accountProxies !== undefined && session.proxyId !== null && frame.exitIp !== undefined) {
      try {
        await accountProxies.update({
          id: session.proxyId,
          accountId: session.accountId,
          updates: {
            exitObserved: {
              ip: frame.exitIp,
              country: frame.exitCountry ?? null,
              timezone: frame.exitTimezone ?? null,
              observed_via: 'session',
            },
            exitObservedAt: now(),
            // (i) I7 — the tunnel is up (a session is browsing through it and
            // just reported its exit), so a fleet failure's contradiction stamp
            // no longer describes it. Cleared with every exit write.
            exitSupersededAt: null,
          },
        });
      } catch (error) {
        logger.error(
          {
            component: 'session-capability-report-relay',
            sessionId: frame.sessionId,
            proxyId: session.proxyId,
            err: error,
          },
          'failed to back-fill the observed exit onto the proxy',
        );
      }
    }

    // ⛔ THE BACK-FILL ABOVE RUNS FIRST, DELIBERATELY. This guard belongs to the
    // egress ingest below, which passes `session.driftstackSessionId` as its
    // subject and genuinely cannot run without one. The back-fill needs only
    // accountId + proxyId and had inherited this return BY POSITION — so every
    // session created without a customer-supplied driver-session link (the normal
    // shape, including every session the desktop app creates) could never record
    // a measured QUIC verdict, however real the observation was.
    if (session.driftstackSessionId === null) return;

    // The CONFIGURED routing state: an h2-and-h3 transport whose interpose flag
    // is set. h3InterposeLoaded is a restatement of the requested mode, not an
    // observation, so this describes what egress was CONFIGURED, never that QUIC
    // was measured — it feeds quic_route (a routing flag), never the customer's
    // "measured QUIC" verdict.
    const quicViaProxy = frame.transportModeActive === 'h2-and-h3' && frame.h3InterposeLoaded;
    // ⛔ `raw` IS STORED IN FULL, AND THAT IS NOW THE DELIBERATE CHOICE.
    //
    // It used to be a leak: this blob is persisted as
    // `sessions.egress_capability_report` and WAS echoed verbatim by
    // `publicSession()` on the public sessions API, so declaring a key on the
    // schema published it. The fix is at the EDGE, not here —
    // `customerSafeEgressCapabilityReport` (services/customer-safe-egress-
    // capability-report.ts) allowlists the four public responses, so an unknown
    // key from the device is private by default.
    //
    // ⚠️ SO THE BY-NAME DELETION OF `webkitFrameworkSha256` THAT USED TO SIT HERE
    // IS GONE, ON PURPOSE. It was a denylist of one: it protected against the
    // single key somebody had already thought of, left `webkitForkBuild` beside
    // it on the customer API, and cost the stored row a measurement it is the
    // only durable holder of. A row filtered on the way in is a worse forensic
    // record than the frame we received, with no way to get it back.
    //
    // ⛔ AND IT IS THE STORED ROW, NOT THE DRIFT REPORT, THAT THE DELETION COST.
    // `computeFleetBuildDrift` reads `capabilityReportStore.entries()` (see
    // routes/mac-nodes-register.ts), and `store.set(frame, …)` above is handed
    // the WHOLE frame — so the drift report always had the measured digest and
    // the deletion never touched it. What the deletion actually removed is the
    // only copy that outlives the process: the store is an in-memory Map bounded
    // at 5,000 entries. Worth stating precisely, because "the drift report needs
    // it" is a claim a future reader can check against the drift report and find
    // false, and then discard the real reason with it.
    //
    // Store everything; publish an allowlist.
    //
    // Only `type` is dropped: it names the wire envelope, not the session.
    const { type: _type, ...raw } = frame;
    await sessionsService.ingestEgressCapabilityReport({
      sessionId: session.driftstackSessionId,
      derived: {
        udp_associate: frame.proxyUdpSupported,
        quic_route: quicViaProxy ? 'proxy' : 'disabled',
        // The harness proxy chain never installs a local resolver; it forwards
        // hostnames to the upstream proxy (ProxyChain.swift H3.exec.116).
        dns_remote_resolve: true,
        safeguards: deriveSafeguardsTriState(frame),
        warnings: deriveWarnings(frame, session),
      },
      raw,
    });
  };

  return makeBoundedNodeLatestRelay({
    getSessionId: (frame) => frame.sessionId,
    process,
    onError: ({ error, sessionId }) => {
      logger.error(
        { component: 'session-capability-report-relay', sessionId, err: error },
        'failed to consume capabilityReport',
      );
    },
    onOverflow: ({ reportingNodeId, sessionBudget, sessionId }) => {
      logger.warn(
        {
          component: 'session-capability-report-relay',
          reportingNodeId,
          sessionBudget,
          sessionId,
        },
        'dropped capabilityReport because the reporting node exceeded its relay session budget',
      );
    },
  });
}
