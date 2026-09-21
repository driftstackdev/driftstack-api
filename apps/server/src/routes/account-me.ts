// V-237 — customer self-profile endpoint.
// GET /v1/account/me — returns the calling account's identity + tier
// + concurrent-session usage/cap + profile usage/cap. Powers the GUI
// client's tier-aware enforcement display (file 128 spec mirror) so
// the customer sees "X / Y concurrent sessions" + "P / Q profiles"
// before the API enforces the cap with a 429 tier-limit problem
// (V-814 — this said 402, which the server has never returned here).
//
// Distinct from `/v1/account/rate-limits` (per-bucket limit config)
// and `/v1/account/audit-log` (event ledger) — this is the dashboard
// header view.

import { randomUUID } from 'node:crypto';
import { knownRequestKeys, reportUnknownRequestFields } from '../lib/unknown-request-fields.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AccountOrganizationSchema,
  AccountProxyInputSchema,
  AccountProxyOsFingerprintSchema,
  AccountProxyUpdateSchema,
  AVATAR_MAX_BYTES,
  findUnresolvableOpenvpnFileReferences,
  lowerOpenvpnScriptSecurity,
  PROFILES_PER_TIER,
  PROXIES_PER_TIER,
  TIER_CONCURRENT_SESSION_LIMITS,
  UpdateAccountMeRequestSchema,
  UploadAvatarRequestSchema,
  UuidSchema,
  type AccountProxyMetadata,
  type AccountProxyOsFingerprint,
  type AccountTier,
} from '@driftstack/api-types';
import { resolveEffectiveAccount, type AccountAuthRepo } from '../services/auth.js';
import type { AuthCache } from '../services/auth-cache.js';
import type { SessionRepo } from '../services/sessions.js';
import type { AgentSessionsRepo } from '../services/agent-sessions.js';
import type { ProfilesRepo } from '../services/profiles.js';
import type { MfaService } from '../services/mfa.js';
import type { AccountAuditService } from '../services/account-audit.js';
import { readClientIp } from '../lib/client-ip.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';
import type {
  AccountProxiesRepo,
  AccountProxyRow,
  AccountProxyRowUpdates,
} from '../db/account-proxies-repo.js';
import {
  UnsafeProxyHostError,
  UNSAFE_TARGET_DETAIL,
  WIREGUARD_WRAPPED_PRESHARED_KEY_FIELD,
  type AccountProxiesService,
  type ProxyDispatchResolution,
} from '../services/account-proxies.js';
import {
  encryptAccountProxySecret,
  readAccountProxySecret,
  type AccountProxySecretSlot,
} from '../lib/account-proxy-secret-encryption.js';
import {
  probeCapabilityUpdates,
  readingWasTakenThroughCurrentIdentity,
  type MeasuredProbeCapabilities,
} from '../services/proxy-reading-persist.js';
import {
  classifyUnsafeHost,
  classifyUnsafeVpnTargets,
  unsupportedOpenvpnDirectiveDetail,
  unresolvableOpenvpnFileReferenceDetail,
} from '../lib/webhook-target-guard.js';
import { defaultTcpProbe } from '../services/proxy-backends/socks5.js';
import { avatarKey, type R2 } from '../lib/r2.js';
import {
  BadRequestError,
  ConflictError,
  FeatureUnavailableError,
  ForbiddenError,
  NotFoundError,
} from '../lib/errors.js';
import { requireTierFeature } from '../lib/errors-helpers.js';
import type { FingerprintedOs } from '../lib/tcp-os-fingerprint.js';
import {
  DEFAULT_PROBE_TARGET_URL,
  type ProbeProxyDescriptor,
  type ProxyConnectivityProbe,
} from '../services/proxy-connectivity-probe.js';
import type { FleetControlRegistry } from '../services/fleet-control-registry.js';
import {
  probeReachedVerdict,
  type ProbeEgressResult,
} from '../schemas/harness-control-protocol.js';
import {
  publicOsFingerprintUnavailable,
  publicProxyTestMeasuredBy,
  publicProxyTestNotRun,
  resolveProxyTestVantage,
} from '../services/customer-safe-proxy-test-vocabulary.js';

/** V-352b — avatar presigned-GET TTL. 1h is long enough that a single
 *  dashboard render doesn't churn signed URLs but short enough that
 *  rotating the bucket secret invalidates outstanding URLs in <1h. */
const AVATAR_PRESIGN_TTL_SECONDS = 60 * 60;

export interface AccountMeRoutesOptions {
  /** Session count source — same repo SessionsService uses. */
  sessionRepo: SessionRepo;
  /** Profile count source — same repo ProfilesService uses. */
  profilesRepo: ProfilesRepo;
  /** V-352 — needed for PATCH /v1/account/me (name + timezone update). */
  authRepo: AccountAuthRepo;
  /** V-352 — invalidated on PATCH /v1/account/me so the next request
   *  picks up the updated row instead of the stale cached AccountContext. */
  authCache?: AuthCache | null;
  /** V-352b — public-bucket R2 client for avatar upload + presigned GET.
   *  Null when public bucket is not configured (avatar endpoints return 503). */
  r2Public?: R2 | null;
  /** V-353h — MFA service. When wired, GET /v1/account/me surfaces
   *  `mfa_enrolled` so the dashboard can render enrollment status
   *  without a second roundtrip. Null = MFA not wired (flag always
   *  false on the response). */
  mfaService?: MfaService | null;
  /** 2026-05-19 — when set, /v1/account/me falls back to the OAuth
   *  link's `provider_avatar_url` for `avatar_url` whenever the
   *  account has no R2-uploaded avatar set. Lets Gmail/GitHub
   *  sign-ins show their IDP profile picture without going through
   *  an upload flow. Null/omitted → no fallback (legacy behaviour). */
  oauthLinksRepo?: {
    listForAccount(accountId: string): Promise<readonly { providerAvatarUrl: string | null }[]>;
  };
  /** ARC A — per-account customer proxies repo. When wired, the
   *  /v1/account/me/proxies CRUD surface is live. Null/omitted → the routes
   *  return 503 (feature not configured). */
  accountProxiesRepo?: AccountProxiesRepo | null;
  /** ARC A — PROFILE_MASTER_KEY (decoded). Needed to wrap proxy passwords under
   *  the account TMK. Null → passwords can't be stored; a create/update that
   *  carries a password is rejected (503) rather than stored in the clear. */
  profileMasterKey?: Buffer | null;
  /** ARC A slice 4b — injectable TCP-reachability probe for the proxy test
   *  endpoint (resolves on connect, rejects on timeout/refused). Defaults to the
   *  SOCKS5 backend's defaultTcpProbe; tests inject a deterministic stub. */
  proxyTcpProbe?: (host: string, port: number, timeoutMs: number) => Promise<void>;
  /**
   * The SAME probe the pre-launch gate runs. When present, `…/proxies/:id/test`
   * answers the question a customer is actually asking — "will this proxy let me
   * launch?" — instead of "is the port open?".
   *
   * Those diverged, and the divergence is what a real block looked like from the
   * outside on 2026-08-18: five proxies that TCP-connected and authenticated
   * cleanly, so every reachability check said healthy, while the provider
   * refused every CONNECT and the launch gate blocked all of them. A customer
   * with a green Test and a red launch has no way to reconcile the two, and the
   * reasonable conclusion is that the product is broken.
   */
  /** The launch probe (and, N-2, its OS observation). Typed off the class so a
   *  new method on the probe cannot be silently unknown here. */
  proxyConnectivityProbe?: Pick<
    ProxyConnectivityProbe,
    'probe' | 'observeOs' | 'observeOsAtExit' | 'observerTarget'
  >;
  /**
   * Resolves the stored row to dispatch config (decrypts the password). Typed as
   * a Pick of the real service rather than a restated shape: `resolveForDispatch`
   * returns a socks5 config OR a VPN wire OR null, and writing that union out by
   * hand here would drift from the service the gate calls.
   */
  /** (V3) — `resolveForDispatchWithReason` is the same resolve carrying the CAUSE
   *  of a null; the fleet arm reads it ONLY after a null, to say which of the nine
   *  causes it was instead of "could not be read" for all of them. */
  accountProxiesService?: Pick<
    AccountProxiesService,
    'resolveForDispatch' | 'resolveForDispatchWithReason'
  >;
  /** Best-effort audit emitter for proxy.created / proxy.deleted (egress-config
   *  changes are security-relevant + already have dashboard labels/filters).
   *  Omitted → no audit (the customer op still succeeds). */
  accountAudit?: AccountAuditService;
  /** T-1 — fleet control-plane registry. When wired, `…/proxies/:id/test?vantage=fleet`
   *  measures the proxy FROM a fleet Mac (the machine that runs profiles) instead of
   *  the control plane. Omitted, or no uncordoned node free → the route falls back to
   *  the control-plane probe and labels the result `control_plane` (never a 500). */
  fleetControlRegistry?: FleetControlRegistry;
  /**
   * (d) 2026-09-10 — the account's agent sessions, read by the fleet-vantage
   * proxy Test to REFUSE probing a VPN row a live session is browsing through.
   * A fleet probe brings a SECOND tunnel up on the same VPN account while the
   * session already holds one, and many VPN accounts allow exactly one
   * connection — so the probe can drop the live session. The node's own
   * `node_busy` covers the same-node case; this covers the cross-node case,
   * which only the control plane can see. Omitted → no guard (the stateless
   * composition is unchanged). Typed as a Pick of the real repo so the method
   * cannot drift from the one the session routes use.
   */
  agentSessions?: Pick<AgentSessionsRepo, 'listOpenByAccount'>;
}

// T-1 — the vantage a proxy test is measured from. `cp` (default) keeps the
// control-plane probe; `fleet` measures from the Mac that will run the
// profile. Query-parameter parsing (both the documented `?check=quick|full`
// and the legacy `?vantage=cp|fleet`) now lives in
// `resolveProxyTestVantage` (`services/customer-safe-proxy-test-vocabulary.ts`),
// so the route and the OpenAPI document read one definition of the bound.

/** T-1 — the neutral egress endpoint a fleet node routes to THROUGH the proxy,
 *  derived from the SAME target the control-plane probe uses so both vantages
 *  measure the identical exit. */
const FLEET_PROBE_TARGET: { host: string; port: number } = (() => {
  const u = new URL(DEFAULT_PROBE_TARGET_URL);
  return { host: u.hostname, port: u.port !== '' ? Number(u.port) : 443 };
})();

/**
 * (o) 2026-09-11 — a proxy test's OS-fingerprint half: the measurement, or the
 * REASON there is none. A union, not two optional keys, so "a fingerprint AND a
 * cause" is unrepresentable — a client that sees the cause knows the value is
 * absent, and cannot be handed both.
 *
 * ⛔ The three causes are not interchangeable to a customer. `vpn_tunnel` and
 * `observer_off` are PERMANENT for that row / that deployment: telling someone to
 * press Test again is advice that can never terminate. `not_observed` is the only
 * one a retry can change. Merging them into bare absence is precisely what put a
 * dead-end hint under every blank OS chip.
 */
type OsFingerprintFields =
  | {
      os_fingerprint: {
        os: FingerprintedOs;
        confidence: 'high' | 'medium' | 'low' | 'none';
        reason: string;
        observed_ip: string;
        observed_via: 'proxy_host' | 'exit_ip';
        /** (V-219) Whether the reading describes the path a website gets — see
         *  `OsObservation.singleHostVantage`. The client withholds a match or
         *  mismatch CLAIM unless this is explicitly true. */
        single_host_vantage: boolean;
        /** (V-219) Taken on the web port at an IP literal — see
         *  `OsObservation.webPortVantage`. Absent/false means the client must
         *  not treat the reading as the path a website gets. */
        web_port_vantage: boolean;
      };
    }
  | { os_fingerprint_unavailable: 'vpn_tunnel' | 'not_observed' | 'observer_off' };

/**
 * (V6 2026-09-16) ITEM 3 — the node's frame carries THREE kinds of field, and only
 * one of them may reach a customer under a name that means "we measured this".
 *
 *   1. MEASUREMENTS — `reachable`, `auth_ok`, `can_route`, `exit_ip`, the `exit_*`
 *      geo. Probed on every path. Reported.
 *   2. ASSERTIONS — on the VPN path `udp_associate: true` and `h2_ok: true` are
 *      LITERALS the node writes about the tunnel's NATURE. Nothing dialled, nothing
 *      timed out, nothing could have come back false. Read from the node source
 *      2026-09-16.
 *   3. NON-MEASUREMENTS — `quic_ok: false` beside `quic_detail: "skipped: …"`, and
 *      (contracted, arriving) an explicit `null` on `udp_associate` / `quic_ok`.
 *      The node is saying IT DID NOT LOOK.
 *
 * ⛔ A customer must never be told their tunnel lacks QUIC because we did not look,
 * and must never be shown a green "HTTP/2 ✓" that no probe earned. So (2) and (3)
 * are ABSENT from the reply, and absence is the wire's "not measured" — every
 * surface renders it as "not measured yet", never as a negative verdict.
 *
 * ⚠️ THE DISCRIMINATOR FOR UDP ON A VPN ROW IS `udp_detail`, NOT THE BOOLEAN.
 * Today's node sends the bare literal `true` with no detail; the migrated node
 * sends a real verdict WITH its sentence (or `null` + `"skipped: …"`). A bare
 * boolean on a VPN row is therefore the legacy assertion and is dropped, while the
 * same boolean beside a detail is the measurement and is reported. That makes the
 * node change deployable in either order: nothing here needs to ship with it, and
 * the field lights up the moment a node starts saying what it measured.
 *
 * ⚠️ QUIC takes no such clause, deliberately: the node has ALWAYS said "skipped:"
 * on the VPN path, so a VPN `quic_ok` arriving without that prefix is already a
 * genuine relay measurement and has been reported as one since (e).
 *
 * Exported and pure so the rule is pinned directly, not only through the route.
 */
export function capabilityReadingsForReply(
  scheme: string,
  frame: Pick<
    ProbeEgressResult,
    'udp_associate' | 'udp_detail' | 'h2_ok' | 'quic_ok' | 'quic_detail'
  >,
): { udp_associate?: boolean; udp_detail?: string; h2_ok?: boolean; quic_ok?: boolean } {
  const vpn = scheme === 'openvpn' || scheme === 'wireguard';
  const legSkipped = (detail: string | null | undefined): boolean =>
    typeof detail === 'string' && detail.startsWith('skipped:');
  const udpDetail = typeof frame.udp_detail === 'string' ? frame.udp_detail : undefined;
  const udpMeasured =
    typeof frame.udp_associate === 'boolean' &&
    !legSkipped(udpDetail) &&
    // The legacy VPN literal: a boolean the node never backed with a sentence.
    !(vpn && udpDetail === undefined);
  const quicMeasured = typeof frame.quic_ok === 'boolean' && !legSkipped(frame.quic_detail);
  return {
    ...(udpMeasured ? { udp_associate: frame.udp_associate as boolean } : {}),
    // The node's own sentence rides even when the boolean does not: "skipped: …"
    // is exactly what tells a surface WHY there is no verdict, and it is the only
    // thing on the wire that can.
    ...(udpDetail !== undefined ? { udp_detail: udpDetail } : {}),
    // ⛔ NEVER on a VPN row. There is no three-state contract coming for h2_ok and
    // no probe behind it on that path — the honest reply is silence.
    ...(vpn ? {} : { h2_ok: frame.h2_ok }),
    ...(quicMeasured ? { quic_ok: frame.quic_ok as boolean } : {}),
  };
}

/**
 * The `reason` a customer sees beside an OS reading. The classifier's own sentence
 * describes packet internals a first-time user cannot act on; it stays in the log
 * line written beside the reading, and the customer is told in plain words where
 * the reading came from.
 */
function customerOsFingerprintReason(os: FingerprintedOs): string {
  return os === 'unknown'
    ? 'The operating system could not be determined from this connection.'
    : 'Based on how this proxy responds to a network connection.';
}

/**
 * (p) 2026-09-16 — the row's STORED OS reading in the shape the wire already uses,
 * or null when there is none this server can state truthfully.
 *
 * ⛔ Cleaned through the PUBLISHED schema rather than hand-copied field by field.
 * The column is jsonb: it holds whatever object the route last wrote, which for a
 * reading taken before V-219 has no vantage flags at all, and for a hypothetical
 * newer writer could hold an `os` this contract cannot name. Parsing it with the
 * one schema the reply and the list both publish means a value outside the closed
 * set DROPS THE READING (null — "never measured") instead of reaching a client as
 * an OS it cannot render, and there is no second copy of the closed set here to
 * drift from the contract.
 *
 * ⛔ The two vantage flags are normalised to FALSE before the parse, never
 * defaulted to true: they are what a client's match / mismatch claim rests on, and
 * a reading that never stated them must not be promoted into one that does.
 */
function storedOsFingerprint(
  row: Pick<AccountProxyRow, 'osFingerprint'>,
): AccountProxyOsFingerprint | null {
  const stored = row.osFingerprint;
  if (stored === null) return null;
  // 2026-09-21 — the customer-worded `direct_reading` / `website_like_reading`
  // aliases ride the LIST/GET/PUT shape too now, computed off the SAME
  // normalised booleans `single_host_vantage` / `web_port_vantage` use below
  // (via `withCustomerFingerprintAliases`, the one function `/:id/test`
  // already uses for this) — guaranteeing identical values rather than a
  // second copy of the mapping that could drift from it.
  const parsed = AccountProxyOsFingerprintSchema.safeParse(
    withCustomerFingerprintAliases({
      ...stored,
      single_host_vantage: stored.single_host_vantage === true,
      web_port_vantage: stored.web_port_vantage === true,
    }),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * (0124) — the row's STORED Test readings for QUIC and UDP, in the wire shape the
 * list, the single-row replies and the /:id/test result all carry.
 *
 * Three states per leg, and they must stay three on the wire: `true` (a Test
 * measured it working), `false` (a Test measured it NOT working — a real
 * negative, never re-spelled as null) and `null` (no Test has measured it).
 *
 * ⛔ Never a reading this server cannot DATE — the rule `storedOsForReply` keeps
 * for the OS reading. The writer always moves a value with its timestamp, so an
 * undated value can only be a row something else wrote; a client ages these by
 * the `_at` stamp, and an undatable reading would arrive looking current. It is
 * served as null ("never measured"), which errs toward looking again.
 */
export function storedProbeReadings(
  row: Pick<AccountProxyRow, 'quicProbe' | 'quicProbeAt' | 'udpProbe' | 'udpProbeAt'>,
): {
  quic_probe: boolean | null;
  quic_probe_at: string | null;
  udp_probe: boolean | null;
  udp_probe_at: string | null;
} {
  const quicDated = row.quicProbe !== null && row.quicProbeAt !== null;
  const udpDated = row.udpProbe !== null && row.udpProbeAt !== null;
  return {
    quic_probe: quicDated ? row.quicProbe : null,
    quic_probe_at: quicDated ? (row.quicProbeAt?.toISOString() ?? null) : null,
    udp_probe: udpDated ? row.udpProbe : null,
    udp_probe_at: udpDated ? (row.udpProbeAt?.toISOString() ?? null) : null,
  };
}

/**
 * (o) — the exact `reason` `ProxyConnectivityProbe.observeOs` returns when the
 * deployment configured NO raw-socket observer (`this.osObserver === undefined`,
 * `services/proxy-connectivity-probe.ts`). Matched, not inferred: the probe
 * reports "no observer is configured" and "the observer tunnel was refused"
 * through the SAME `{ observed: false, reason }` shape, and those two causes take
 * a customer to opposite places — one says retrying cannot work, the other says
 * it might. Pinned against the real probe in
 * `tests/unit/a-blank-os-chip-carries-its-cause.test.ts`, so rewording the probe's
 * literal reds a test here rather than silently downgrading every deployment with
 * the observer off to "not observed".
 */
const OBSERVER_NOT_CONFIGURED_REASON = 'observer not configured';

/**
 * (n) N15 — what a VPN row's customer is told when the NODE could not return a
 * measurement, and — the load-bearing half — whether that answer is a VERDICT
 * about the tunnel or a `not_run` notice about the Mac.
 *
 * ⛔ Before this, EVERY non-busy node error was `not_run: 'node_error'` ("the test
 * could not be completed on the measuring Mac; try again shortly"). That branch is
 * exactly where a FAILED WIREGUARD BRING-UP lands: the node wraps bring-up in
 * `withVPNEgress`, whose catch tears the tunnel down and answers
 * `probeEgressRefusal(error: <token>)` — a frame with `error !== null`, which the
 * correlator maps to `{ status: 'error', message: <token> }`. So a wrong key, a
 * wrong PSK, a dead endpoint or an anti-leak failure all arrived as "the Mac is
 * having a moment": the row KEPT its last green verdict and its stale exit /
 * timezone, and no amount of retrying could ever change the sentence.
 *
 * The node's tokens are a CLOSED static set (A3 `cf1343076`) and they split in two:
 *   * a VERDICT about the tunnel — `handshake_failed`, `endpoint_unreachable`,
 *     `egress_leak_detected`: the node DID try to bring the tunnel up and it did
 *     not come up (or came up leaking). `not_run` is ABSENT so a client renders
 *     the red "tunnel down", and the stored exit is contradicted (`exit_superseded_at`
 *     stamped) exactly as on the verdict path;
 *   * a NOT-RUN — `node_busy`, `bad_config*`, `bad_request`, `egress_bin_missing`,
 *     `tunnel_up_no_socks`, the post-tunnel `timeout` / `probe_failed`, a send
 *     failure, and ANY token this build does not know: nothing was learned about
 *     the tunnel, so the row keeps what it holds.
 *
 * ⛔ The residual is a NOT-RUN, deliberately. An unknown token is a node newer
 * than this build; guessing "tunnel down" from a word we cannot read would publish
 * a red verdict nothing measured. An unrecognised token therefore keeps today's
 * sentence and `node_error`.
 *
 * Copy rules (owner directive): `egress_bin_missing` / `tunnel_up_no_socks` read as
 * OUR fault, never the customer's config; `endpoint_unreachable` says the endpoint
 * did not answer within the tunnel's wait and NEVER "check your address" — from the
 * node, a wrong endpoint and a down endpoint are indistinguishable.
 */
export interface VpnProbeRefusal {
  /** The customer-facing sentence. Never the raw token. */
  reason: string;
  /** Absent ⇒ this IS a tunnel verdict (and the stored exit is superseded). */
  notRun?: 'node_busy' | 'node_error';
}

export function classifyVpnProbeFailure(
  message: string,
  scheme: 'openvpn' | 'wireguard',
): VpnProbeRefusal {
  const token = message.trim().toLowerCase();
  const name = scheme === 'wireguard' ? 'WireGuard' : 'OpenVPN';
  // Substring, not equality: the node sends the bare token today, but the
  // registry/correlator wrap send failures and provenance mismatches in prose,
  // and `bad_config:<field>` carries a suffix. The existing `node_busy` test was
  // a substring test and stays one.
  const has = (t: string): boolean => token.includes(t);

  // ── NOT-RUN, checked first: a busy Mac and a refused config are about the
  //    RUN, and must never be read as a tunnel that is down.
  if (has('node_busy')) {
    return {
      reason: 'Our test service is busy right now. Try again in a minute.',
      notRun: 'node_busy',
    };
  }
  // `egress_bin_missing` = the node's own VPN binary is not executable;
  // `tunnel_up_no_socks` = the tunnel came up but the node's local listener never
  // did. Both are NODE faults — the config was never disproved — so the sentence
  // owns the failure rather than sending the customer to re-check their keys.
  if (has('egress_bin_missing') || has('tunnel_up_no_socks')) {
    return {
      reason: `We could not run the test, so your ${name} configuration was not checked. This is a problem on our side — try again shortly.`,
      notRun: 'node_error',
    };
  }
  // Post-tunnel exit probe: the tunnel came up, the exit check did not finish.
  // Not a verdict about the tunnel (it was up), and not a config problem.
  if (has('probe_failed') || has('timeout')) {
    return {
      reason: `Your ${name} connection was established, but we could not finish checking where its traffic exits. Try again shortly.`,
      notRun: 'node_error',
    };
  }

  // ── VERDICTS: the node tried to bring the tunnel up and it did not come up.
  // ⛔ `egress_leak_detected` is a verdict about THIS config: the tunnel came up
  // and traffic did not leave through it, so the node fail-closed. Telling the
  // customer their tunnel is fine would be the worst possible answer.
  if (has('egress_leak_detected')) {
    return {
      reason: `Your ${name} connection started, but your traffic did not go through it, so we stopped it. This configuration is not safe to browse with.`,
    };
  }
  // ⛔ No "check your address". The node waits out the tunnel's init window and
  // cannot tell a wrong endpoint from a down one; naming the address as the fault
  // would send a customer to edit a line that is correct.
  if (has('endpoint_unreachable')) {
    return {
      reason: `The ${name} server did not answer in time, so the connection did not start. The server may be down, blocked, or not accepting this configuration — we cannot tell which.`,
    };
  }
  if (has('handshake_failed')) {
    return {
      reason: `The ${name} connection could not be established. Check the keys and the server address, and make sure the server accepts this configuration.`,
    };
  }

  // Residual — `bad_config*`, `bad_request`, a send failure, or a token from a
  // node newer than this build. Today's sentence, and NOT a verdict.
  return {
    reason: 'The test could not be completed. Try again shortly.',
    notRun: 'node_error',
  };
}

/**
 * Resolve the profile cap for a tier. `PROFILES_PER_TIER` returns
 * `'custom'` for enterprise (negotiated per-customer); we surface
 * that as `null` to the customer (read: "no fixed cap on this tier;
 * see your contract"). All other tiers return a numeric cap.
 */
function profileCapFor(tier: AccountTier): number | null {
  const cap = PROFILES_PER_TIER[tier];
  return cap === 'custom' ? null : cap;
}

/**
 * ⛔ A stored reading may not outlive what it was measured THROUGH.
 *
 * Every reading an account_proxies row carries — the passive OS fingerprint,
 * the exit identity (plus the stamp that dates its contradiction) and the
 * measured QUIC verdict — was produced by connecting through this proxy. A PUT
 * that repoints the row leaves some of them describing a machine the row no
 * longer points at, so they are cleared in the SAME update that moves it: the
 * row is never left half-invalidated (a reading beside an address that cannot
 * have produced it, or a value beside a nulled timestamp).
 *
 * Which edit drops what, and why:
 *
 *  • host / port / scheme — a DIFFERENT machine (or a different service on the
 *    same one) answers now, so EVERYTHING goes.
 *
 *  • VPN material — the .ovpn blob, the OpenVPN account inside it, the
 *    WireGuard key / peer / endpoint / address / dns. ⛔ ITS OWN LINE, and NOT
 *    covered by host/port: for a VPN row the display host and port are DERIVED
 *    from the conf's endpoint (`buildOpenVpnProxyInput`) and username/password
 *    are structurally null, so a provider key rotation — a new conf, the same
 *    server — moves none of the fields above. The desktop client fixed exactly
 *    this bug on its side (`vpnMaterialChanged` in ProxiesView), and a VPN row's
 *    `exit_observed` is the ONLY source of its country and timezone, so a stale
 *    one is not a cosmetic detail.
 *    It takes the MACHINE arm rather than the credential one because the tunnel
 *    endpoint lives INSIDE the material — `remote` is a line in the blob — and
 *    this boundary cannot tell "same server, new keys" from "new server"
 *    without parsing it. The cautious reading of an ambiguous change is that the
 *    machine moved; the route's own SSRF note says the same thing (the real
 *    egress is the embedded remote, not the display host).
 *
 *  • username / password — the same machine answers, but the credential is the
 *    exit SELECTOR on a rotating-residential gateway (country / sticky session
 *    are encoded in it), and BOTH writers of `exit_observed` ('session' and
 *    'probe') measured it inside a session authenticated as that user. So the
 *    exit identity goes, and with it the QUIC verdict — 'h3' vs 'h2-only' is
 *    what that exit's path carried — and an OS reading taken OF THE EXIT
 *    (`observed_via: 'exit_ip'`). What survives is an OS reading whose
 *    `observed_via` is 'proxy_host': that is the TCP stack of the front door at
 *    an unchanged host:port, and no credential moves it.
 *
 *  • label — invalidates nothing.
 *
 * ⛔ EVERY COMPARISON IS AGAINST THE STORED VALUE, NEVER AGAINST KEY PRESENCE.
 * The desktop client PUTs the WHOLE proxy — label, scheme, host, port, username,
 * password, VPN block — before every launch and every Test
 * (`ensureAccountProxyRow` → `accountProxyInputFor` in
 * apps/gui-client/src/lib/proxy-server-test.ts), so "a password key arrived" is
 * the NORMAL case, and clearing on it would wipe a good reading on every launch
 * — the very complaint this arc answers.
 *
 * ⛔ WHICH IS WHY SECRETS REACH THIS FUNCTION DECRYPTED. A stored secret is an
 * AEAD envelope over a random nonce: the same string re-wrapped is different
 * ciphertext, so comparing envelopes would report every launch as a rotation,
 * and comparing their PRESENCE (the rule this replaced) cannot see a rotation at
 * all — a password swapped for a different string, or a re-pasted VPN conf with
 * new keys, invalidated nothing. The caller holds the master key and unwraps
 * both sides, so a string→string rotation IS an edit here.
 *   There is no client-side fallback to lean on: the desktop client does delete
 * its local cache entry on such an edit, but the entry is re-seeded from THIS
 * row on the next list refresh (`adoptListOsFingerprint` /
 * `adoptListExitObserved` in proxy-server-test.ts), so a reading this route
 * keeps comes straight back. The server is the only place the decision holds.
 *
 * ⛔ A stored secret this deployment CANNOT read (no master key, wrong key,
 * corrupt envelope) counts as CHANGED against anything submitted. We cannot show
 * the reading was taken through the material now on the row, and a reading we
 * cannot justify is not one we may keep.
 *
 * Nothing here probes: the readings are dropped whether or not the new address
 * answers. A reading we cannot replace is not a reading we may keep.
 */
export type ProxySecretMaterial = { readable: true; value: string | null } | { readable: false };

/** Whether a submitted secret CHANGES the stored one. `undefined` means this PUT
 *  carried none, which is never an edit; an unreadable stored secret differs
 *  from everything (see the header). */
function secretMaterialChanged(
  existing: ProxySecretMaterial,
  submitted: string | null | undefined,
): boolean {
  if (submitted === undefined) return false;
  if (!existing.readable) return true;
  return existing.value !== submitted;
}

/**
 * A VPN block reduced to ONE comparable string.
 *
 * Field-wise and key-SORTED, never `JSON.stringify(row.config)`: the non-secret
 * half is jsonb, Postgres does not preserve an object's key order, and a
 * round-tripped row would then read as an edit on every launch. Fields that are
 * absent are dropped, so "no dns" and "dns: undefined" are the same material —
 * which is exactly how `buildVpnSecretAndConfig` stores them.
 */
export function canonicalVpnMaterial(fields: Record<string, string | undefined>): string {
  return JSON.stringify(
    Object.entries(fields)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

export function proxyReadingsInvalidatedByEdit(
  existing: Pick<AccountProxyRow, 'scheme' | 'host' | 'port' | 'username' | 'osFingerprint'> & {
    /** The row's stored password, DECRYPTED by the caller. */
    password: ProxySecretMaterial;
    /** The row's VPN material, decrypted + canonicalised. `{readable: true,
     *  value: null}` on a socks5/http row, which has none. */
    vpnMaterial: ProxySecretMaterial;
  },
  edit: {
    scheme?: string;
    host?: string;
    port?: number;
    username?: string | null;
    /** The PLAINTEXT password this PUT writes — absent when it writes none. */
    password?: string | null;
    /** The canonicalised VPN material this PUT writes — absent when the body
     *  carried no VPN block. */
    vpnMaterial?: string | null;
  },
): AccountProxyRowUpdates {
  const machineEdited =
    (edit.host !== undefined && edit.host !== existing.host) ||
    (edit.port !== undefined && edit.port !== existing.port) ||
    (edit.scheme !== undefined && edit.scheme !== existing.scheme) ||
    secretMaterialChanged(existing.vpnMaterial, edit.vpnMaterial);
  const credentialEdited =
    (edit.username !== undefined && edit.username !== existing.username) ||
    secretMaterialChanged(existing.password, edit.password);
  // Measured inside an authenticated session through this proxy's egress.
  const sessionReadings = {
    exitObserved: null,
    exitObservedAt: null,
    // The contradiction stamp dates the exit it contradicted. Left behind on a
    // cleared exit it would make a list consumer refuse the NEXT observation
    // (it refuses one dated at or before the stamp), so it goes with it.
    exitSupersededAt: null,
    quicMeasured: null,
    quicMeasuredAt: null,
    // (0124) What a Test measured about QUIC and UDP. Both legs are measured
    // THROUGH the proxy, authenticated as the stored user, so they describe the
    // path that credential selects exactly as the exit identity does — and they
    // go on the same two arms for the same reason. Left behind, a stored `false`
    // would be the worst survivor of all: it is the one value that tells a client
    // NOT to look again, said about a machine the row no longer points at.
    quicProbe: null,
    quicProbeAt: null,
    udpProbe: null,
    udpProbeAt: null,
  } satisfies AccountProxyRowUpdates;
  const osReading = {
    osFingerprint: null,
    osFingerprintAt: null,
  } satisfies AccountProxyRowUpdates;
  // The background refresher's streak belongs to the address (and the credential)
  // we could not reach, not to the row. `freshness_consecutive_failures` drives a
  // linear backoff up to 24h (PROXY_FRESHNESS_MAX_BACKOFF_STEPS), so a proxy that
  // was switched off long enough to condemn its exit and is then REPOINTED at a
  // working server would not be dialled again for a day — the columns this very
  // update just cleared staying blank, i.e. the customer's fix producing an empty
  // chip instead of a fresh reading. Nulling the attempt stamp makes the row due
  // on the next sweep tick (ITEM 4's claim reads exactly these two columns).
  const freshnessSlate = {
    freshnessConsecutiveFailures: 0,
    freshnessAttemptedAt: null,
  } satisfies AccountProxyRowUpdates;
  if (machineEdited) return { ...sessionReadings, ...osReading, ...freshnessSlate };
  if (credentialEdited) {
    return {
      ...sessionReadings,
      ...(existing.osFingerprint?.observed_via === 'exit_ip' ? osReading : {}),
      ...freshnessSlate,
    };
  }
  return {};
}

/**
 * Add the customer-worded `direct_reading` / `website_like_reading` aliases
 * beside the original `single_host_vantage` / `web_port_vantage` booleans on
 * an OS-fingerprint object. Additive only — the originals are untouched, for
 * `apps/gui-client`'s existing readers of this exact shape.
 */
function withCustomerFingerprintAliases(fp: Record<string, unknown>): Record<string, unknown> {
  const out = { ...fp };
  if (typeof fp['single_host_vantage'] === 'boolean') {
    out['direct_reading'] = fp['single_host_vantage'];
  }
  if (typeof fp['web_port_vantage'] === 'boolean') {
    out['website_like_reading'] = fp['web_port_vantage'];
  }
  return out;
}

/**
 * ⛔ THE ONE MAPPING POINT for `POST …/proxies/:id/test`'s result vocabulary —
 * see `customer-safe-proxy-test-vocabulary.ts`. `runAccountProxyTest` below
 * computes its result exactly as it always has, in the route's own internal
 * words (`os_fingerprint_unavailable` causes, `not_run` causes, and the
 * `single_host_vantage` / `web_port_vantage` field names); this is the single
 * place those cross into the closed public vocabulary, on the way OUT to the
 * customer — mapped at read time, same direction as
 * `customerSafeEgressCapabilities`, so every one of `runAccountProxyTest`'s
 * many return points (host-safety refusal, both probes, every `not_run`
 * branch) is covered by construction rather than by a mapping call repeated
 * at each one, which is how a future branch would ship unmapped.
 *
 * Takes and returns a loosely-typed object on purpose: `runAccountProxyTest`
 * returns one of several structurally-different object-literal shapes (an
 * `ok:true` cp result, an `ok:false` result, the richer fleet-measured
 * result), and this function's job is a field-name walk over whichever one
 * arrived, not a re-statement of that union.
 */
function toPublicProxyTestResult(
  result: Record<string, unknown>,
  logger: Parameters<typeof publicProxyTestNotRun>[1],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...result };
  if (typeof out['os_fingerprint_unavailable'] === 'string') {
    const mapped = publicOsFingerprintUnavailable(out['os_fingerprint_unavailable'], logger);
    if (mapped === null) delete out['os_fingerprint_unavailable'];
    else out['os_fingerprint_unavailable'] = mapped;
  }
  if (typeof out['not_run'] === 'string') {
    out['not_run'] = publicProxyTestNotRun(out['not_run'], logger);
  }
  if (out['os_fingerprint'] !== null && typeof out['os_fingerprint'] === 'object') {
    out['os_fingerprint'] = withCustomerFingerprintAliases(
      out['os_fingerprint'] as Record<string, unknown>,
    );
  }
  // 2026-09-21 — `measured_by` beside `measured_from`: additive, same rule as
  // the fingerprint aliases above. `measured_from` itself is UNCHANGED (still
  // its original 'fleet' / 'control_plane' values) — see
  // `customer-safe-proxy-test-vocabulary.ts`.
  if (typeof out['measured_from'] === 'string') {
    const measuredBy = publicProxyTestMeasuredBy(out['measured_from'], logger);
    if (measuredBy !== undefined) out['measured_by'] = measuredBy;
  }
  return out;
}

export function registerAccountMeRoutes(app: FastifyInstance, opts: AccountMeRoutesOptions): void {
  const { sessionRepo, profilesRepo, authRepo } = opts;
  const authCache = opts.authCache ?? null;
  const r2Public = opts.r2Public ?? null;
  const mfaService = opts.mfaService ?? null;
  const oauthLinksRepo = opts.oauthLinksRepo ?? null;
  const accountProxiesRepo = opts.accountProxiesRepo ?? null;
  const proxyMasterKey = opts.profileMasterKey ?? null;
  const proxyTcpProbe = opts.proxyTcpProbe ?? defaultTcpProbe;
  const proxyConnectivityProbe = opts.proxyConnectivityProbe;
  const accountProxiesService = opts.accountProxiesService;
  const accountAudit = opts.accountAudit ?? null;
  const fleetControlRegistry = opts.fleetControlRegistry;
  const agentSessions = opts.agentSessions;

  // Best-effort audit emit for proxy lifecycle (egress-config changes). Carries
  // only non-secret metadata (id / label / scheme) — NEVER the credential.
  // Swallows failures so an audit hiccup never breaks the customer operation.
  async function emitProxyAudit(
    request: FastifyRequest,
    accountId: string,
    action: 'proxy.created' | 'proxy.updated' | 'proxy.deleted',
    proxy: { id: string; label: string; scheme: string },
  ): Promise<void> {
    if (!accountAudit) return;
    try {
      await accountAudit.record({
        accountId,
        actorType: 'customer',
        action,
        targetResourceId: `proxy_${proxy.id}`,
        payload: { proxy_id: proxy.id, label: proxy.label, scheme: proxy.scheme },
        ipAddress: readClientIp(request),
      });
    } catch {
      // Swallow — audit emit failures must not break the proxy operation.
    }
  }

  // 2026-05-19 — first non-null providerAvatarUrl from the
  // account's OAuth links, used as fallback when avatar_r2_key is
  // null. Swallows errors (best-effort enrichment; a stale /me
  // read should never 500 because oauth_links hiccuped).
  async function oauthAvatarFallback(accountId: string): Promise<string | null> {
    if (!oauthLinksRepo) return null;
    try {
      const links = await oauthLinksRepo.listForAccount(accountId);
      for (const link of links) {
        if (link.providerAvatarUrl) return link.providerAvatarUrl;
      }
      return null;
    } catch (err) {
      app.log.warn({ err, accountId }, 'oauth avatar fallback lookup failed');
      return null;
    }
  }

  // V-352b — best-effort presigned GET URL for the avatar. Returns null
  // when no avatar is set, when the public R2 bucket is not configured,
  // or when the presign call itself fails (logged + swallowed: a stale
  // /me read should never 500 just because R2 hiccuped).
  async function presignAvatar(key: string | null): Promise<string | null> {
    if (!key) return null;
    if (!r2Public) return null;
    try {
      return await r2Public.presignGet({
        key,
        expiresIn: AVATAR_PRESIGN_TTL_SECONDS,
      });
    } catch (err) {
      app.log.warn({ err, key }, 'avatar presign failed');
      return null;
    }
  }

  app.get(
    '/v1/account/me',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');

      const accountId = ctx.account.id;
      const tier = ctx.account.tier;

      // Parallel fan-out: counts + tier-derived caps + avatar presign + MFA.
      // Tier caps come from in-memory constants so they cost nothing.
      //
      // ⛔ V-1988 — `profile_count` and `profile_cap` are published side by side
      // and DO NOT describe the same population. `countByAccount` filters
      // `notDeleted`, so this number counts LIVE profiles only; the cap that
      // actually refuses a create counts LIVE + TRASHED (profiles-repo
      // `insertWithLimit`, no notDeleted filter — deliberate anti-abuse from
      // 2026-06-17, so a customer cannot hoard recoverable profiles past their
      // limit). A customer holding trashed profiles therefore sees headroom the
      // create path will not honour, for up to the 30-day trash retention.
      //
      // Left as-is rather than quietly changed: making this number include
      // trashed rows alters what a PUBLISHED field means, which is the owner's
      // call, not a sweep's. Recorded in docs/internal/OPEN-ITEMS.md.
      const [activeSessions, profileCount, r2AvatarUrl, mfaStatus, oauthFallback, onboardingAt] =
        await Promise.all([
          sessionRepo.countActiveSessions(accountId),
          profilesRepo.countByAccount(accountId),
          presignAvatar(ctx.account.avatarR2Key),
          mfaService ? mfaService.getStatus(accountId) : Promise.resolve(null),
          ctx.account.avatarR2Key ? Promise.resolve(null) : oauthAvatarFallback(accountId),
          // T-13 — read fresh from the account row (not the cached AccountContext)
          // so a completion recorded on another device is reflected immediately.
          authRepo.getOnboardingCompletedAt(accountId),
        ]);
      // R2-uploaded avatar wins; OAuth IDP avatar is the fallback
      // (matches account_avatar_source enum priority: user > idp).
      const avatarUrl = r2AvatarUrl ?? oauthFallback;
      const avatarSource = ctx.account.avatarR2Key ? 'user' : oauthFallback ? 'idp' : 'none';

      return {
        id: `acc_${accountId}`,
        email: ctx.account.email,
        name: ctx.account.name,
        tier,
        status: ctx.account.status,
        // V-352 — IANA timezone (null = UTC fallback for client renders).
        timezone: ctx.account.timezone,
        // V-298a — readable account handle (null when unset).
        slug: ctx.account.slug,
        // V-298b — data-residency region preference (null when unset).
        region: ctx.account.region,
        // T-13 — ISO instant the customer first completed onboarding (null when
        // never). The desktop client seeds its first-run gate from this so a
        // finished customer never re-sees the "Get set up" card on a new install.
        onboarding_completed_at: onboardingAt !== null ? onboardingAt.toISOString() : null,
        // V-352b — selected avatar URL: a short-lived (1h) presigned R2
        // customer upload, otherwise the linked-IDP fallback. Null only
        // when neither source is available.
        avatar_url: avatarUrl,
        // A URL alone cannot tell a removable customer upload from the
        // read-only OAuth fallback. Keep that distinction public so clients
        // never offer a destructive control that cannot affect the image.
        avatar_source: avatarSource,
        // V-353h — MFA enrollment flag for dashboard header / settings.
        mfa_enrolled: mfaStatus !== null && mfaStatus.enrolled,
        concurrent_session_cap: TIER_CONCURRENT_SESSION_LIMITS[tier],
        concurrent_session_active: activeSessions,
        profile_cap: profileCapFor(tier),
        profile_count: profileCount,
        // V-326c — owner accounts the caller is a member of (empty
        // array when not on any team). Each entry exposes the public
        // owner id + the owner's email/name (so the dashboard can label
        // a team by who owns it, not a bare acc_<uuid>) + the role granted
        // to the caller. Used by the dashboard / GUI to render an
        // "acting as" account picker.
        teams: ctx.teams.map((t) => ({
          owner_account_id: `acc_${t.ownerAccountId}`,
          owner_email: t.ownerEmail ?? `acc_${t.ownerAccountId}`,
          owner_name: t.ownerName ?? null,
          role: t.role,
          membership_id: `mem_${t.membershipId}`,
        })),
      };
    },
  );

  // V-352 — partial update of the calling account's basics
  // (name + timezone). Other fields (email / tier / status /
  // stripeCustomerId) have dedicated flows and aren't reachable here.
  // Note: V-326 effective-account header is intentionally NOT honored
  // — /v1/account/me always operates on the caller's own account.
  // Acting on a team owner's account.name / timezone would be
  // surprising; if needed, lands in V-352c with explicit semantics.
  app.patch(
    '/v1/account/me',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = UpdateAccountMeRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid body.');
      }
      reportUnknownRequestFields({
        body: request.body ?? {},
        knownKeys: knownRequestKeys(UpdateAccountMeRequestSchema),
        reply,
        logger: request.log,
        route: 'PATCH /v1/account/me',
      });
      // T-13 — remember first-time onboarding completion on the CALLER's own
      // account, exactly like the identity edits below (name / timezone / slug /
      // region). Onboarding is a per-user getting-started flag — the GET above
      // reads the caller's OWN state — so the write marks the caller's own
      // account, NOT the acting-as effective account. Marking an owner's
      // onboarding because a member acted for them would be inconsistent with that
      // read and a header-driven write to another account, which the
      // team-scoped-write invariant forbids. The setter writes only when the
      // column is NULL (idempotent: a second completion never moves it) and never
      // clears it, so only the literal `true` this schema accepts can stamp it.
      if (parsed.data.onboarding_completed === true) {
        await authRepo.setOnboardingCompleted(ctx.account.id, new Date());
      }
      let updated;
      try {
        updated = await authRepo.updateAccountBasics(ctx.account.id, parsed.data);
      } catch (err) {
        // V-298a — repo throws SLUG_TAKEN when the unique-constraint
        // collides with another account's slug. 409 surfaces it.
        if (err instanceof Error && err.message === 'SLUG_TAKEN') {
          throw new ConflictError('That slug is already taken. Pick a different one.');
        }
        throw err;
      }
      if (!updated) throw new NotFoundError('Account not found.');
      // Invalidate the cached AccountContext so the next request reads
      // the freshly-updated row. Best-effort; cache failure must never
      // block the user-facing op.
      if (authCache) {
        try {
          await authCache.invalidateAccount(ctx.account.id);
        } catch {
          /* swallow */
        }
      }
      // Return the same full-shape response as GET /me — the OpenAPI
      // spec + every SDK type claim AccountMeResponse (16 fields).
      // Previously the route returned only the 8 written/persisted
      // fields, causing a type-vs-runtime mismatch on every SDK
      // consumer (avatar_url / mfa_enrolled / concurrent_session_*
      // / profile_* / teams[] all undefined under types claiming
      // string|null / boolean / number / array).
      const tier = updated.tier;
      const [activeSessions, profileCount, r2AvatarUrl, mfaStatus, oauthFallback, onboardingAt] =
        await Promise.all([
          sessionRepo.countActiveSessions(updated.id),
          profilesRepo.countByAccount(updated.id),
          presignAvatar(updated.avatarR2Key),
          mfaService ? mfaService.getStatus(updated.id) : Promise.resolve(null),
          updated.avatarR2Key ? Promise.resolve(null) : oauthAvatarFallback(updated.id),
          // T-13 — the caller's own onboarding state, read fresh so a completion
          // just written in this request (self-scoped case) is reflected back.
          authRepo.getOnboardingCompletedAt(updated.id),
        ]);
      const avatarUrl = r2AvatarUrl ?? oauthFallback;
      const avatarSource = updated.avatarR2Key ? 'user' : oauthFallback ? 'idp' : 'none';
      return {
        id: `acc_${updated.id}`,
        email: updated.email,
        name: updated.name,
        tier,
        status: updated.status,
        timezone: updated.timezone,
        slug: updated.slug,
        region: updated.region,
        onboarding_completed_at: onboardingAt !== null ? onboardingAt.toISOString() : null,
        avatar_url: avatarUrl,
        avatar_source: avatarSource,
        mfa_enrolled: mfaStatus !== null && mfaStatus.enrolled,
        concurrent_session_cap: TIER_CONCURRENT_SESSION_LIMITS[tier],
        concurrent_session_active: activeSessions,
        profile_cap: profileCapFor(tier),
        profile_count: profileCount,
        teams: ctx.teams.map((t) => ({
          owner_account_id: `acc_${t.ownerAccountId}`,
          owner_email: t.ownerEmail ?? `acc_${t.ownerAccountId}`,
          owner_name: t.ownerName ?? null,
          role: t.role,
          membership_id: `mem_${t.membershipId}`,
        })),
      };
    },
  );

  // Per-account org-sync (2026-06-16) — the effective account's organization
  // TAXONOMY: the empty folders (+icons) and tags defined in the GUI rail
  // before assignment. Unlike the identity/edit route at exact /v1/account/me,
  // this nested profile resource honors X-Driftstack-Account so its taxonomy
  // and the profiles it organizes always share an owner. Team members may read;
  // team writes require admin. Stored as accounts.organization jsonb (0079).
  // Not part of the cached AccountContext, so no auth-cache invalidation needed.
  app.get(
    '/v1/account/me/organization',
    { preHandler: [app.requireAuth, app.requireScope('read:profiles'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      const org = await authRepo.getOrganization(effective.accountId);
      return org ?? { folders: [], tags: [] };
    },
  );

  app.put(
    '/v1/account/me/organization',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      // Resolve and authorize the selected owner before parsing the body. A
      // malformed payload must never turn a nonmember/member authorization
      // failure into a body-validation oracle, and must never reach the repo.
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      if (effective.kind === 'team' && effective.role !== 'admin') {
        throw new ForbiddenError(
          'Team members need the admin role to change profile organization.',
        );
      }
      const parsed = AccountOrganizationSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid organization.');
      }
      reportUnknownRequestFields({
        body: request.body ?? {},
        knownKeys: knownRequestKeys(AccountOrganizationSchema),
        reply,
        logger: request.log,
        route: 'PUT /v1/account/me/organization',
      });
      await authRepo.setOrganization(effective.accountId, parsed.data);
      return parsed.data;
    },
  );

  // ARC A — per-account customer proxies (CRUD). The customer registers their
  // own SOCKS5/HTTP proxies so a session can be dispatched through one (the
  // session-dispatch wiring lands in a later slice). All routes are
  // account_owner-scoped; the password is WRITE-ONLY — wrapped under the account
  // TMK on write, NEVER returned (responses expose has_password). 503 when the
  // feature isn't wired. The connection-test endpoint is deliberately deferred
  // to the slice that ships the SSRF host-guard (testing a customer-controlled
  // host is an SSRF vector — don't expose it before the guard exists).
  function proxyToMetadata(r: AccountProxyRow): AccountProxyMetadata {
    return {
      id: r.id,
      label: r.label,
      scheme: r.scheme as AccountProxyMetadata['scheme'],
      host: r.host,
      port: r.port,
      username: r.username,
      has_password: r.wrappedPassword !== null,
      has_secret: r.wrappedSecret !== null,
      // T-6 — the QUIC verdict a real session measured through this proxy, or
      // null when never measured. The client keeps the QUIC mark inferred (never
      // green) until a real 'h3' lands here, so null must stay null, never a
      // default.
      quic_measured: r.quicMeasured as AccountProxyMetadata['quic_measured'],
      quic_measured_at: r.quicMeasuredAt !== null ? r.quicMeasuredAt.toISOString() : null,
      // (0124) — what a TEST last measured about QUIC and UDP through this proxy,
      // each with its date. Separate from `quic_measured` above on purpose: that is
      // what a live session negotiated, this is what a Test's own check found.
      // true / false are both readings; null = never measured, never a default —
      // it is the only value that tells a client the reading is still missing.
      ...storedProbeReadings(r),
      // (d) B5 — the last exit identity observed THROUGH this proxy: by a live
      // session (the capabilityReport relay, 'session') or by the fleet-vantage
      // Test ('probe'), latest wins. The ONLY source of a VPN row's location /
      // timezone the GUI can show without running a test. null = never observed
      // — never a placeholder, so a client cannot colour a cell nobody measured.
      exit_observed:
        r.exitObserved === null
          ? null
          : {
              ip: r.exitObserved.ip,
              country: r.exitObserved.country,
              timezone: r.exitObserved.timezone,
              observed_via: r.exitObserved.observed_via,
              observed_at: r.exitObservedAt?.toISOString() ?? null,
            },
      // (i) I7 — when a fleet verdict found the tunnel DOWN while `exit_observed`
      // was set: the stored exit is what was last SEEN, this is when it was
      // CONTRADICTED. A client adopting the exit from this list (the grid on a
      // second Mac, which never saw the failing test) refuses an observation
      // dated at or before it, so both Macs agree the tunnel was seen down.
      // Cleared by the next exit observation (session or probe). null = never
      // contradicted — never a default.
      exit_superseded_at: r.exitSupersededAt?.toISOString() ?? null,
      // (p) 2026-09-16 — the STORED OS reading, carried exactly as `exit_observed`
      // above is. Until now this column had NO ROUTE OUT: the /:id/test route wrote
      // it (migration 0119) and the only reader was a live session's capability
      // report, so a proxy checked on one Mac showed nothing on a second one, or
      // after a reinstall — the owner's "we are not saving the OS fingerprint of
      // already checked proxies". null = never measured, never a default.
      //
      // ⛔ The DATE rides with it, and it is not decoration: this is a reading the
      // row has been holding, not one this request took. A client ages it with the
      // same TTL it ages its own readings by, so a stored reading from last week is
      // hidden exactly as a local one from last week is — and a row that cannot be
      // dated (`os_fingerprint_at: null`) is one a client must refuse rather than
      // render as current.
      os_fingerprint: storedOsFingerprint(r),
      os_fingerprint_at: r.osFingerprintAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    };
  }

  // SSRF guard — reject a proxy host that resolves to an internal-reachable
  // address (loopback / RFC-1918 / link-local / cloud metadata / numeric-IP
  // encoding) before it's ever stored or dispatched through. Reuses the shared
  // host classifier (same one the webhook + SOCKS5 egress guards use).
  function assertSafeProxyHost(host: string): void {
    const unsafe = classifyUnsafeHost(host);
    if (unsafe !== null) {
      throw new BadRequestError(
        'The proxy host must be a public internet address. Private or local network addresses are not allowed.',
      );
    }
  }

  // Wrap a plaintext proxy password under the account TMK with exact proxy/slot
  // AAD. Empty/null → null (no secret). A non-empty password with no master key
  // configured
  // is a 503 — we NEVER store a proxy password in the clear.
  function wrapProxyPassword(
    accountId: string,
    proxyId: string,
    password: string | null,
  ): string | null {
    if (password === null || password.length === 0) return null;
    if (proxyMasterKey === null) {
      throw new FeatureUnavailableError(
        'Saving proxy passwords is not available on this installation.',
      );
    }
    return encryptAccountProxySecret(
      proxyMasterKey,
      { accountId, proxyId, slot: 'password' },
      password,
    );
  }

  // Wrap a non-empty VPN secret payload under the account TMK + proxy/slot AAD. Like
  // wrapProxyPassword but mandatory (a VPN proxy always carries a secret) — 503
  // if encryption isn't configured (NEVER store a VPN key in the clear).
  function wrapProxySecret(
    accountId: string,
    proxyId: string,
    slot: Exclude<AccountProxySecretSlot, 'password'>,
    secret: string,
  ): string {
    if (proxyMasterKey === null) {
      throw new FeatureUnavailableError('VPN proxies are not available on this installation.');
    }
    return encryptAccountProxySecret(proxyMasterKey, { accountId, proxyId, slot }, secret);
  }

  // Unwrap a STORED envelope for comparison only — `proxyReadingsInvalidatedByEdit`
  // needs to know whether a submitted secret is the one already on the row, and
  // the envelope itself cannot answer that (random nonce per write). The plaintext
  // never leaves the comparison: it is not logged, not returned and not stored.
  // An envelope this deployment cannot read is reported as UNREADABLE rather than
  // as "no secret" — the rule treats the two differently, and quietly reading an
  // unreadable credential as absent would make a rotation look like a no-op.
  function storedSecretMaterial(args: {
    accountId: string;
    proxyId: string;
    slot: AccountProxySecretSlot;
    stored: string | null;
  }): ProxySecretMaterial {
    if (args.stored === null) return { readable: true, value: null };
    if (proxyMasterKey === null) return { readable: false };
    try {
      return {
        readable: true,
        value: readAccountProxySecret(
          proxyMasterKey,
          { accountId: args.accountId, proxyId: args.proxyId, slot: args.slot },
          args.stored,
        ),
      };
    } catch {
      return { readable: false };
    }
  }

  // The identity material a STORED VPN row authenticates with, in the same
  // canonical form `buildVpnSecretAndConfig` produces for an incoming block, so
  // the two are comparable. The WireGuard preshared key is unwrapped as well: it
  // lives in `config` as its own envelope (WIREGUARD_WRAPPED_PRESHARED_KEY_FIELD)
  // whose ciphertext changes on every write, so comparing it wrapped would read
  // as a rotation on every launch.
  function storedVpnMaterial(accountId: string, row: AccountProxyRow): ProxySecretMaterial {
    if (row.scheme !== 'openvpn' && row.scheme !== 'wireguard') {
      return { readable: true, value: null };
    }
    // A VPN row with no secret is malformed, not a row with nothing to compare.
    if (row.wrappedSecret === null) return { readable: false };
    const secret = storedSecretMaterial({
      accountId,
      proxyId: row.id,
      slot: row.scheme === 'openvpn' ? 'openvpn-config' : 'wireguard-private-key',
      stored: row.wrappedSecret,
    });
    if (!secret.readable || secret.value === null) return { readable: false };
    const cfg = row.config;
    const str = (k: string): string | undefined =>
      typeof cfg[k] === 'string' ? cfg[k] : undefined;
    if (row.scheme === 'openvpn') {
      // The secret is `{config_blob[, password]}` as this route wrote it; the
      // account username rides the non-secret config.
      let parsed: unknown;
      try {
        parsed = JSON.parse(secret.value);
      } catch {
        return { readable: false };
      }
      const blob = (parsed as { config_blob?: unknown }).config_blob;
      const password = (parsed as { password?: unknown }).password;
      if (typeof blob !== 'string') return { readable: false };
      return {
        readable: true,
        value: canonicalVpnMaterial({
          config_blob: blob,
          password: typeof password === 'string' ? password : undefined,
          username: str('username'),
        }),
      };
    }
    const wrappedPresharedKey = str(WIREGUARD_WRAPPED_PRESHARED_KEY_FIELD);
    let presharedKey: string | undefined;
    if (wrappedPresharedKey !== undefined) {
      const psk = storedSecretMaterial({
        accountId,
        proxyId: row.id,
        slot: 'wireguard-preshared-key',
        stored: wrappedPresharedKey,
      });
      if (!psk.readable || psk.value === null) return { readable: false };
      presharedKey = psk.value;
    }
    return {
      readable: true,
      value: canonicalVpnMaterial({
        private_key: secret.value,
        peer_public_key: str('peer_public_key'),
        preshared_key: presharedKey,
        endpoint: str('endpoint'),
        allowed_ips: str('allowed_ips'),
        address: str('address'),
        dns: str('dns'),
      }),
    };
  }

  function parseProxyId(value: string): string {
    const parsed = UuidSchema.safeParse(value);
    if (!parsed.success) throw new BadRequestError('Proxy id must be a valid UUID.');
    return parsed.data.toLowerCase();
  }

  // Resolve the encrypted-secret + non-secret config for a VPN scheme. Returns
  // null for socks5/http (the caller keeps the password path). For openvpn the
  // SECRET is {config_blob[,password]} (the blob embeds certs/keys); for
  // wireguard it's the private_key, plus the preshared_key when the peer has
  // one — wrapped as its own envelope under the same slot and carried in
  // `config` (see WIREGUARD_WRAPPED_PRESHARED_KEY_FIELD for why), so the key
  // is never in the jsonb in the clear. The non-secret structured fields ride
  // `config` (jsonb) so the GUI/dispatch can read them without decrypting.
  //
  // `material` is the same block as ONE comparable string (see
  // `canonicalVpnMaterial`), built from the PLAINTEXT pieces here because the two
  // stored halves cannot be compared: the envelopes re-encrypt on every write and
  // the jsonb does not preserve key order. It is what tells a re-keyed VPN row
  // from the desktop client's per-launch resync of the identical block.
  function buildVpnSecretAndConfig(
    accountId: string,
    proxyId: string,
    input: {
      scheme?: string;
      openvpn?: { config_blob: string; username?: string; password?: string };
      wireguard?: {
        private_key: string;
        peer_public_key: string;
        preshared_key?: string;
        endpoint: string;
        allowed_ips: string;
        address: string;
        dns?: string;
      };
    },
  ): { wrappedSecret: string; config: Record<string, unknown>; material: string } | null {
    if (input.scheme === 'openvpn') {
      if (!input.openvpn) {
        throw new BadRequestError('Add your OpenVPN configuration to save an OpenVPN proxy.');
      }
      const { config_blob: submittedBlob, username, password } = input.openvpn;
      // ⛔ (V-217) `script-security 2` is LOWERED to 1 here, not refused. Measured
      // 2026-09-14 (A3): every OpenVPN profile the owner's provider issues carries it
      // at line 46, so EVERY upload was a 400 and the only way in was hand-editing
      // each download — this was the "OpenVPN profiles won't save".
      //
      // Lowering is safe for three independent reasons: the directive only PERMITS
      // scripts and runs nothing itself; every directive that DOES run something is
      // still refused right below, so there is nothing left for a raised level to
      // permit; and the node strips it again and forces `--script-security 1` on the
      // openvpn process. ⚠️ Do NOT widen this to the script directives — silently
      // deleting a line that would have run the customer's program changes what their
      // config does without telling them.
      //
      // The lowered blob is what gets validated AND what gets stored: the artefact we
      // checked must be the artefact we keep.
      const { config: config_blob } = lowerOpenvpnScriptSecurity(submittedBlob);
      // SSRF: the real egress is the embedded `remote <host>`, NOT the display host — guard it.
      const unsafeVpn = classifyUnsafeVpnTargets({ configBlob: config_blob });
      if (unsafeVpn !== null) {
        // T-20 — a provider .ovpn routinely carries `up /etc/openvpn/update-resolv-conf`,
        // and one sentence for both refusals left the owner unable to tell which line
        // to remove. The directive refusal now names the first offending line; the
        // SSRF refusal keeps its address sentence (the target is the fix there).
        throw new BadRequestError(
          unsafeVpn === 'unsafe-directive'
            ? unsupportedOpenvpnDirectiveDetail(config_blob)
            : 'The server address in your OpenVPN config (the `remote` line, or an `http-proxy` or `socks-proxy` line) must be a public internet address. Private or local network addresses are not allowed.',
        );
      }
      // Reject a config that references EXTERNAL cert/key files (`ca ca.crt`) with
      // no inline block: the session renders only client.ovpn + auth.txt, so such a
      // file cannot exist and openvpn dies late as an opaque "Options error". Fail
      // here naming the directive. Cross-source pin with the node's parse-reject
      // (A3 8a03a3929) — both read findUnresolvableOpenvpnFileReferences.
      if (findUnresolvableOpenvpnFileReferences(config_blob).length > 0) {
        throw new BadRequestError(unresolvableOpenvpnFileReferenceDetail(config_blob));
      }
      const secret = JSON.stringify({ config_blob, ...(password ? { password } : {}) });
      return {
        wrappedSecret: wrapProxySecret(accountId, proxyId, 'openvpn-config', secret),
        config: { ...(username ? { username } : {}) },
        // Mirrors exactly what is stored above (a falsy username/password is not
        // stored, so it is not material either), and is read back by
        // `storedVpnMaterial`. The LOWERED blob, because that is the artefact we
        // keep — comparing the submitted one would call every re-upload a change.
        material: canonicalVpnMaterial({
          config_blob,
          password: password ? password : undefined,
          username: username ? username : undefined,
        }),
      };
    }
    if (input.scheme === 'wireguard') {
      if (!input.wireguard) {
        throw new BadRequestError('Add your WireGuard configuration to save a WireGuard proxy.');
      }
      const { private_key, peer_public_key, preshared_key, endpoint, allowed_ips, address, dns } =
        input.wireguard;
      // SSRF: the real egress is the endpoint (+ dns), NOT the display host — guard them.
      if (classifyUnsafeVpnTargets({ endpoint, dns }) !== null) {
        throw new BadRequestError(
          'The WireGuard endpoint and DNS addresses must be public internet addresses. Private or local network addresses are not allowed.',
        );
      }
      // `address` is written unconditionally: the schema requires it now, because the
      // dispatch wire always did and a row without one failed closed at every launch.
      return {
        wrappedSecret: wrapProxySecret(accountId, proxyId, 'wireguard-private-key', private_key),
        config: {
          peer_public_key,
          endpoint,
          allowed_ips,
          address,
          ...(dns ? { dns } : {}),
          ...(preshared_key !== undefined
            ? {
                [WIREGUARD_WRAPPED_PRESHARED_KEY_FIELD]: wrapProxySecret(
                  accountId,
                  proxyId,
                  'wireguard-preshared-key',
                  preshared_key,
                ),
              }
            : {}),
        },
        // Every field that decides which tunnel this is, including the two
        // secrets — `storedVpnMaterial` unwraps both to compare against it.
        material: canonicalVpnMaterial({
          private_key,
          peer_public_key,
          preshared_key,
          endpoint,
          allowed_ips,
          address,
          dns: dns ? dns : undefined,
        }),
      };
    }
    // socks5/http: a stray VPN block is a client error (avoids a half-typed row).
    if (input.openvpn || input.wireguard) {
      throw new BadRequestError(
        'An OpenVPN configuration can only be used with the OpenVPN proxy type, and a WireGuard configuration with the WireGuard type.',
      );
    }
    return null;
  }

  app.get(
    '/v1/account/me/proxies',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      if (!accountProxiesRepo) throw new FeatureUnavailableError('Proxies are not configured.');
      const rows = await accountProxiesRepo.list(ctx.account.id);
      return { data: rows.map(proxyToMetadata) };
    },
  );

  app.post(
    '/v1/account/me/proxies',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      if (!accountProxiesRepo) throw new FeatureUnavailableError('Proxies are not configured.');
      // AccountProxyInputSchema is a discriminatedUnion on `scheme` with no
      // default (mirrors egress.ts's ProxyConfigSchema) — an omitted `scheme`
      // no longer matches any branch. Fill the pre-V1 ergonomic default
      // (omitted scheme => socks5) into the RAW body here so the wire
      // contract for existing callers is unchanged.
      const rawBody = (request.body ?? {}) as Record<string, unknown>;
      const bodyWithScheme = 'scheme' in rawBody ? rawBody : { ...rawBody, scheme: 'socks5' };
      const parsed = AccountProxyInputSchema.safeParse(bodyWithScheme);
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid proxy.');
      }
      assertSafeProxyHost(parsed.data.host);
      // 6.g — OpenVPN / WireGuard egress is a paid-tier feature. `TIER_FEATURES.vpnEgress`
      // has said so since it was introduced ("`false` on free (SOCKS5 proxy only)"), and the
      // dashboard pricing table paints its Access column straight from that flag — but nothing
      // enforced it, so a free account could register a VPN profile and egress through it.
      // Free still gets its one proxy (PROXIES_PER_TIER.free === 1); it has to be socks5/http.
      if (parsed.data.scheme === 'openvpn' || parsed.data.scheme === 'wireguard') {
        requireTierFeature(ctx.account.tier, 'vpnEgress');
      }
      const id = randomUUID();
      // VPN schemes carry an encrypted secret (config_blob / private_key) + a
      // non-secret config block; socks5/http use the write-only password.
      const vpn = buildVpnSecretAndConfig(ctx.account.id, id, parsed.data);
      const wrappedPassword =
        vpn === null ? wrapProxyPassword(ctx.account.id, id, parsed.data.password) : null;
      const input = {
        id,
        label: parsed.data.label,
        scheme: parsed.data.scheme,
        host: parsed.data.host,
        port: parsed.data.port,
        username: parsed.data.username,
        wrappedPassword,
        ...(vpn !== null ? { wrappedSecret: vpn.wrappedSecret, config: vpn.config } : {}),
      };
      const proxyCap = PROXIES_PER_TIER[ctx.account.tier];
      const row =
        proxyCap === 'custom'
          ? await accountProxiesRepo.create(ctx.account.id, input)
          : await accountProxiesRepo.createIfUnderLimit(ctx.account.id, input, proxyCap);
      if (row === null) {
        throw new BadRequestError(
          `Proxy limit reached (${String(proxyCap)}). Delete an existing proxy to add another.`,
        );
      }
      await emitProxyAudit(request, ctx.account.id, 'proxy.created', row);
      reply.code(201);
      return proxyToMetadata(row);
    },
  );

  app.put(
    '/v1/account/me/proxies/:id',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      if (!accountProxiesRepo) throw new FeatureUnavailableError('Proxies are not configured.');
      const id = parseProxyId((request.params as { id: string }).id);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const parsed = AccountProxyUpdateSchema.safeParse(body);
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid proxy.');
      }
      const existing = await accountProxiesRepo.findById({ id, accountId: ctx.account.id });
      if (existing === null) throw new NotFoundError('Proxy not found.');
      if (
        parsed.data.scheme === undefined &&
        (existing.scheme === 'openvpn' || existing.scheme === 'wireguard') &&
        'password' in body
      ) {
        throw new BadRequestError(
          'To change a VPN password, submit the full VPN configuration again.',
        );
      }
      if (parsed.data.host !== undefined) assertSafeProxyHost(parsed.data.host);
      // Gate on the scheme the row would END UP with, not the one submitted. That keeps the
      // remediation path open: an account whose tier lacks vpnEgress can still PUT
      // `scheme: 'socks5'` over a VPN row it registered before this gate existed (or delete
      // it). What it cannot do is keep a VPN row alive by editing around the restriction.
      const effectiveScheme = parsed.data.scheme ?? existing.scheme;
      if (effectiveScheme === 'openvpn' || effectiveScheme === 'wireguard') {
        requireTierFeature(ctx.account.tier, 'vpnEgress');
      }
      const updates: AccountProxyRowUpdates = {};
      if (parsed.data.label !== undefined) updates.label = parsed.data.label;
      if (parsed.data.scheme !== undefined) updates.scheme = parsed.data.scheme;
      if (parsed.data.host !== undefined) updates.host = parsed.data.host;
      if (parsed.data.port !== undefined) updates.port = parsed.data.port;
      if (parsed.data.username !== undefined) updates.username = parsed.data.username;
      // VPN re-config: a VPN block (with its matching scheme) re-wraps the secret
      // + rewrites config + clears any password. Otherwise the socks5/http
      // password path: key absent = keep existing; null = clear; string = (re)wrap.
      const vpn = buildVpnSecretAndConfig(ctx.account.id, id, parsed.data);
      if (vpn !== null) {
        updates.wrappedSecret = vpn.wrappedSecret;
        updates.config = vpn.config;
        updates.wrappedPassword = null;
      } else {
        if ('password' in body) {
          updates.wrappedPassword = wrapProxyPassword(
            ctx.account.id,
            id,
            parsed.data.password ?? null,
          );
        }
        // Moving AWAY from a VPN scheme (openvpn/wireguard -> socks5/http) must
        // clear the stale wrapped VPN secret + config — otherwise the old
        // private_key/config_blob ciphertext (and a misleading has_secret=true)
        // survive indefinitely under the new non-VPN row.
        if (
          parsed.data.scheme !== undefined &&
          parsed.data.scheme !== 'openvpn' &&
          parsed.data.scheme !== 'wireguard'
        ) {
          updates.wrappedSecret = null;
          updates.config = {};
        }
      }
      // ⛔ A reading may not outlive the address — or the identity — it was taken
      // through. Merged INTO the same `updates` object, so the row is repointed
      // and its stale readings dropped by ONE statement: there is no window in
      // which a moved proxy still advertises the old machine's OS / exit / QUIC,
      // and no second round-trip that can fail after the first one landed.
      // `proxyReadingsInvalidatedByEdit` carries the rule (and why each line of
      // it) — host/port/scheme and the VPN material drop everything, a credential
      // drops what was measured through the authenticated session, a label drops
      // nothing. Both secrets are handed over DECRYPTED, because ciphertext
      // cannot answer "is this the same credential".
      Object.assign(
        updates,
        proxyReadingsInvalidatedByEdit(
          {
            scheme: existing.scheme,
            host: existing.host,
            port: existing.port,
            username: existing.username,
            osFingerprint: existing.osFingerprint,
            password: storedSecretMaterial({
              accountId: ctx.account.id,
              proxyId: id,
              slot: 'password',
              stored: existing.wrappedPassword,
            }),
            vpnMaterial: storedVpnMaterial(ctx.account.id, existing),
          },
          {
            scheme: parsed.data.scheme,
            host: parsed.data.host,
            port: parsed.data.port,
            username: parsed.data.username,
            // A VPN block forces the top-level password to null above, and that
            // IS what this PUT writes. Otherwise the key is submitted only when
            // the body carried one (omitted = keep existing = not an edit).
            password:
              vpn !== null ? null : 'password' in body ? (parsed.data.password ?? null) : undefined,
            ...(vpn === null ? {} : { vpnMaterial: vpn.material }),
          },
        ),
      );
      const row = await accountProxiesRepo.update({
        id,
        accountId: ctx.account.id,
        expectedScheme: existing.scheme,
        updates,
      });
      if (row === null) {
        const current = await accountProxiesRepo.findById({ id, accountId: ctx.account.id });
        if (current === null) throw new NotFoundError('Proxy not found.');
        throw new ConflictError(
          'This proxy changed since you last loaded it. Refresh and try again.',
        );
      }
      await emitProxyAudit(request, ctx.account.id, 'proxy.updated', row);
      return proxyToMetadata(row);
    },
  );

  app.delete(
    '/v1/account/me/proxies/:id',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      if (!accountProxiesRepo) throw new FeatureUnavailableError('Proxies are not configured.');
      const id = parseProxyId((request.params as { id: string }).id);
      // Read the row first so the audit entry carries its label/scheme (delete
      // returns only a boolean). Best-effort — a missing read still deletes.
      const existing = await accountProxiesRepo.findById({ id, accountId: ctx.account.id });
      const ok = await accountProxiesRepo.delete({ id, accountId: ctx.account.id });
      if (!ok) throw new NotFoundError('Proxy not found.');
      if (existing !== null) {
        await emitProxyAudit(request, ctx.account.id, 'proxy.deleted', existing);
      }
      reply.code(204);
      return null;
    },
  );

  // ARC A slice 4b — server-side connection test. TCP-reachability probe to the
  // owned proxy's host:port (SSRF host-guard runs first, fail-closed). Returns a
  // discriminated result (ok=true+latency_ms | ok=false+reason), 200 either way —
  // an unreachable proxy is a result, not an error. 404 for an unknown/foreign id.
  app.post<{ Params: { id: string }; Querystring: { vantage?: string; check?: string } }>(
    '/v1/account/me/proxies/:id/test',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    // The internal handler computes the response in the route's OWN words
    // (`os_fingerprint_unavailable`, `not_run`, `single_host_vantage` /
    // `web_port_vantage`) exactly as it always has; `toPublicProxyTestResult`
    // is the ONE place that maps them to the closed customer vocabulary —
    // mirrors `customerSafeEgressCapabilities` being the one mapping point for
    // the egress-warning vocabulary rather than a mapping call at every branch
    // that can produce a result.
    async (request) => toPublicProxyTestResult(await runAccountProxyTest(request), request.log),
  );

  async function runAccountProxyTest(
    request: FastifyRequest<{
      Params: { id: string };
      Querystring: { vantage?: string; check?: string };
    }>,
  ) {
    const ctx = request.account;
    if (!ctx) throw new Error('account context missing after requireAuth');
    if (!accountProxiesRepo) throw new FeatureUnavailableError('Proxies are not configured.');
    const id = parseProxyId(request.params.id);
    const row = await accountProxiesRepo.findById({ id, accountId: ctx.account.id });
    if (row === null) throw new NotFoundError('Proxy not found.');
    // T-6 — surface the QUIC verdict a real session measured through this
    // proxy on every ok:true result, so the desktop client can show a
    // confirmed QUIC mark instead of one inferred from UDP association. Read
    // from the row already fetched; null stays null (never measured).
    const quicMeasured: AccountProxyMetadata['quic_measured'] =
      row.quicMeasured as AccountProxyMetadata['quic_measured'];
    const quicFields = {
      quic_measured: quicMeasured,
      quic_measured_at: row.quicMeasuredAt !== null ? row.quicMeasuredAt.toISOString() : null,
    };
    if (classifyUnsafeHost(row.host) !== null) {
      return {
        ok: false as const,
        reason:
          'This proxy host is not allowed. It must be a public internet address, not a private or local network address.',
      };
    }
    // T-1 — which machine measures the proxy. `?check=quick|full` is the
    // documented customer name; `?vantage=cp|fleet` is the original name,
    // still accepted (never documented again) so nothing that already links
    // to it breaks. `check` wins when both are present. An unknown value on
    // either is a 400, not a silent default — see
    // `resolveProxyTestVantage`.
    const resolvedVantage = resolveProxyTestVantage(request.query);
    if ('error' in resolvedVantage) {
      throw new BadRequestError(resolvedVantage.error);
    }
    const vantage = resolvedVantage.vantage;

    // N-2 — the OS fingerprint, and it belongs to BOTH vantages.
    //
    // ⛔ It is a CONTROL-PLANE observation that does not ride the node's
    // result: `observeOs` CONNECTs through the proxy to our own raw-socket
    // observer and reads the SYN the proxy's own kernel built, so it is measured
    // from HERE no matter which machine measured the latency. It used to be
    // attached on the cp branch alone, so a customer whose GUI asked for the
    // fleet vantage lost the chip with nothing on the wire to say why.
    //
    // Returns the fields to spread onto an ok result, or `{}` when nothing was
    // observed — a miss is ABSENCE, never a placeholder OS, so no client can
    // colour a cell on a value nobody measured. It NEVER throws: on the fleet
    // branch an exception here would be caught by `runFleetProbe`'s own handler
    // and fall the whole request back to the control plane, which would relabel
    // a node measurement `control_plane`. A wrong provenance is worse than a
    // missing chip.
    //
    // (o) 2026-09-11 — AND WHEN NOTHING WAS OBSERVED, WHY. A bare `{}` said
    // "absent" and nothing else, so the desktop client rendered every miss with
    // one hint — "Run Test on a proxy stored on your account; the control plane
    // fingerprints the proxy's own TCP stack" — which is advice that CANNOT
    // produce a value for two of the three causes. `os_fingerprint_unavailable`
    // is the machine-readable cause a client branches on; the three values are
    // the three arms that already existed here, now reported instead of merged.
    // (V-219) A VPN row's stack, read from the observer record the FLEET NODE
    // caused by connecting to the observer through the tunnel it brought up
    // (`observerTarget` on the probeEgress frame). No dial from here: the
    // control plane cannot bring a tunnel up. Until a node connects, the lookup
    // misses and the row keeps the `vpn_tunnel` cause it always had — a miss
    // is never coerced into a reading, and the cause it falls back to is still
    // true of every node that predates the contract.
    const vpnOsFingerprintFields = async (
      exitIp: string | null,
      sinceMs: number,
    ): Promise<OsFingerprintFields> => {
      if (
        proxyConnectivityProbe === undefined ||
        typeof proxyConnectivityProbe.observeOsAtExit !== 'function' ||
        exitIp === null
      ) {
        return { os_fingerprint_unavailable: 'vpn_tunnel' as const };
      }
      try {
        const os = await proxyConnectivityProbe.observeOsAtExit(exitIp, sinceMs);
        if (!os.observed) {
          request.log.info(
            { proxyId: row.id, reason: os.reason },
            'proxy test: vpn os fingerprint not observed',
          );
          return { os_fingerprint_unavailable: 'vpn_tunnel' as const };
        }
        request.log.info(
          { proxyId: row.id, os: os.os, confidence: os.confidence, reason: os.reason },
          'proxy test: os fingerprint observed',
        );
        return {
          os_fingerprint: {
            os: os.os,
            confidence: os.confidence,
            reason: customerOsFingerprintReason(os.os),
            observed_ip: os.observedIp,
            observed_via: os.via,
            single_host_vantage: os.singleHostVantage,
            web_port_vantage: os.webPortVantage,
          },
        };
      } catch (err) {
        request.log.info({ proxyId: row.id, err }, 'proxy test: vpn os fingerprint lookup failed');
        return { os_fingerprint_unavailable: 'vpn_tunnel' as const };
      }
    };
    const osFingerprintFields = async (
      descriptor: ProbeProxyDescriptor,
      exitIp: string | null | undefined,
    ): Promise<OsFingerprintFields> => {
      // No probe wired at all (a fixture, or a deployment with no master key):
      // nothing on this deployment fingerprints anything, which is the same
      // thing a customer needs told as a probe with no observer configured.
      if (proxyConnectivityProbe === undefined) {
        return { os_fingerprint_unavailable: 'observer_off' as const };
      }
      try {
        const os = await proxyConnectivityProbe.observeOs(descriptor, exitIp ?? undefined);
        if (!os.observed) {
          // info, not debug: production runs at info, and a miss that cannot be
          // read there is the silent failure this field exists to avoid. One
          // line per customer-initiated test; the launch path never reaches it.
          request.log.info(
            { proxyId: row.id, reason: os.reason },
            'proxy test: os fingerprint not observed',
          );
          return {
            os_fingerprint_unavailable:
              os.reason === OBSERVER_NOT_CONFIGURED_REASON
                ? ('observer_off' as const)
                : ('not_observed' as const),
          };
        }
        request.log.info(
          { proxyId: row.id, os: os.os, confidence: os.confidence, reason: os.reason },
          'proxy test: os fingerprint observed',
        );
        return {
          os_fingerprint: {
            os: os.os,
            confidence: os.confidence,
            reason: customerOsFingerprintReason(os.os),
            observed_ip: os.observedIp,
            observed_via: os.via,
            // (V-219) Whether this reading describes the path a website gets.
            // The client withholds a match/mismatch CLAIM when it is false —
            // see the owner's browserleaks measurement in the probe's comment.
            single_host_vantage: os.singleHostVantage,
            web_port_vantage: os.webPortVantage,
          },
        };
      } catch (err) {
        request.log.info({ proxyId: row.id, err }, 'proxy test: os fingerprint observation failed');
        // A throw is the observer tunnel failing, never the observer being off:
        // `observeOs` answers the off case without touching the network.
        return { os_fingerprint_unavailable: 'not_observed' as const };
      }
    };

    // N-2 — persist the observed fingerprint onto the proxy row so a live agent
    // session can later project the exit's OS onto its capability_report. ONLY
    // when a fingerprint was observed: a miss (os_fingerprint absent) writes
    // NOTHING and leaves the column as-is — never coercing a miss to a value, and
    // never nulling a value a previous test measured. Best-effort and owner-scoped
    // (id + accountId): a failure is logged but never fails the customer's test.
    // `accountProxiesRepo` is non-null here (checked at the top of the handler);
    // the local binding carries that narrowing into this closure.
    const proxiesRepo = accountProxiesRepo;
    // (o) — takes the union, so the "no fingerprint, here is why" members reach
    // it and are correctly no-ops: a CAUSE is not a measurement and must never
    // touch the stored column.
    const persistOsFingerprintIfObserved = async (
      fields: OsFingerprintFields | Record<string, never>,
    ): Promise<void> => {
      const fp = 'os_fingerprint' in fields ? fields.os_fingerprint : undefined;
      if (fp === undefined) return;
      try {
        // ⛔ Rule 4 (services/proxy-reading-persist.ts) — `row` was read before a
        // probe that can take ~12 seconds, and a PUT inside that window can have
        // repointed the proxy, clearing this very column in the same statement.
        // Writing now would restore a reading of the PREVIOUS address, dated
        // after the move, onto the row the customer just fixed. The background
        // refresher fences its write the same way, against the same helper.
        const current = await proxiesRepo.findById({ id: row.id, accountId: ctx.account.id });
        if (current === null || !readingWasTakenThroughCurrentIdentity(row, current)) {
          request.log.info(
            { proxyId: row.id },
            'proxy test: the proxy changed while the test ran — the fingerprint describes the previous address and is not stored',
          );
          return;
        }
        await proxiesRepo.update({
          id: row.id,
          accountId: ctx.account.id,
          updates: { osFingerprint: fp, osFingerprintAt: new Date() },
        });
      } catch (err) {
        request.log.info({ proxyId: row.id, err }, 'proxy test: failed to persist os fingerprint');
      }
    };

    // (0124) — persist what THIS test measured about QUIC and UDP onto the row,
    // so the reading outlives the desktop that pressed Test and a stored `false`
    // can be told apart from a reading nobody has taken. WHAT may be written is
    // `probeCapabilityUpdates` (services/proxy-reading-persist.ts): a measured
    // leg is stored as measured, true OR false, with its date; an absent leg
    // writes nothing. Owner-scoped, best-effort, and it NEVER throws: on the fleet
    // branch a throw is caught by `runFleetProbe`'s own handler and would relabel
    // a node measurement `control_plane`.
    //
    // ⛔ Rule 4's identity fence is IN THE WRITE here, not before it
    // (`storeProbeReadingsIfSameIdentity`). `persistOsFingerprintIfObserved`
    // above reads the row and then updates it; for these columns that gap is
    // not acceptable, because the value a PUT landing inside it would let
    // through can be a `false` — on the NEW address, telling every consumer not
    // to look again at a machine nobody has measured. `row` is the identity the
    // node dialled, so it is the identity the statement must still find.
    //
    // `measuredAt` is the reading's date — when the node's frame resolved, not
    // when this write runs (the OS observation sits between the two).
    //
    // ⛔ Returns the row AS THE STATEMENT LEFT IT, which is what the reply
    // carries (a leg this test did not measure, or that a later measurement
    // already holds, reads as stored) — or null when nothing was stored: no leg
    // was measured, the write threw, or the statement matched no row because it
    // is gone or no longer carries the identity the node dialled. That last case
    // is NOT the same as "repointed": a PUT that resubmits the SAME password
    // re-wraps the envelope (the desktop sends one before every launch), fails
    // the fence, and KEEPS the stored readings. So on null the reply never
    // guesses from `row`, which was read BEFORE the test — it re-reads
    // (`probeReadingsAsTheRowStands`).
    const persistProbeReadingsIfMeasured = async (
      measured: MeasuredProbeCapabilities,
      measuredAt: Date,
    ): Promise<AccountProxyRow | null> => {
      const updates = probeCapabilityUpdates({ measured, at: measuredAt, row });
      if (updates === null) return null;
      try {
        const written = await proxiesRepo.storeProbeReadingsIfSameIdentity({
          id: row.id,
          accountId: ctx.account.id,
          probedIdentity: row,
          readings: updates,
        });
        if (written === null) {
          request.log.info(
            { proxyId: row.id },
            'proxy test: the proxy was edited or removed while the test ran — the QUIC/UDP readings are not stored',
          );
        }
        return written;
      } catch (err) {
        request.log.info(
          { proxyId: row.id, err },
          'proxy test: failed to persist the QUIC/UDP readings',
        );
        return null;
      }
    };

    // (0124) — the Test readings the row holds NOW, for a reply whose own test
    // stored none: a control-plane test (it measures neither leg, so the stored
    // reading, dated, is the only QUIC/UDP answer it has) and a fleet test that
    // wrote nothing. Carried beside `quicFields` on those replies.
    //
    // ⛔ RE-READ, never `row`. `row` was read before a test that can run for many
    // seconds, and a PUT inside that window that repoints the proxy nulls these
    // columns in the same statement. Serving the snapshot would hand back the
    // PREVIOUS address's reading — possibly a `false` — for a row that now points
    // somewhere else, while the list says "never tested". Re-reading makes the
    // reply agree with the list in every case: a repointed row reads null, a row
    // whose password was merely resubmitted reads the reading it kept, and a row
    // deleted mid-test reads null.
    //
    // Never throws (on the fleet branch a throw would relabel a node measurement
    // `control_plane`). When the store cannot be READ — the one case with no
    // better knowledge of the row — the snapshot is served.
    const probeReadingsAsTheRowStands = async (): Promise<
      ReturnType<typeof storedProbeReadings>
    > => {
      try {
        const current = await proxiesRepo.findById({ id: row.id, accountId: ctx.account.id });
        return storedProbeReadings(
          current ?? { quicProbe: null, quicProbeAt: null, udpProbe: null, udpProbeAt: null },
        );
      } catch (err) {
        request.log.info(
          { proxyId: row.id, err },
          'proxy test: failed to re-read the stored QUIC/UDP readings',
        );
        return storedProbeReadings(row);
      }
    };

    // (p) 2026-09-16 — the row's STORED OS reading, attached to a reply whose OWN
    // test observed none. The precedent is two lines of this same handler: the
    // QUIC verdict a live session measured is spread onto every ok reply from the
    // row (`quicFields`), while the OS reading — measured by this very route,
    // minutes earlier, and stored — was dropped, so a test that missed answered
    // `os_fingerprint_unavailable` and nothing else and the customer's chip went
    // blank on a proxy this deployment had already fingerprinted.
    //
    // ⛔ A FRESH OBSERVATION ALWAYS WINS: when `fields` already carries one this
    // returns nothing, so the stored reading can never overwrite what this test
    // just measured. The cause (`os_fingerprint_unavailable`) is NOT removed when
    // a stored reading is attached — it explains why THIS test produced nothing,
    // and the pair is how a client tells a stored reading from a fresh one.
    //
    // ⛔ And never a reading this server cannot DATE: `os_fingerprint_at` is what
    // the client ages it by, so a row holding a reading with no timestamp is left
    // alone rather than sent as something that will read as measured just now.
    const storedOsForReply = (
      fields: OsFingerprintFields | Record<string, never>,
    ):
      | { os_fingerprint: AccountProxyOsFingerprint; os_fingerprint_at: string }
      | Record<string, never> => {
      if ('os_fingerprint' in fields) return {};
      const stored = storedOsFingerprint(row);
      if (stored === null || row.osFingerprintAt === null) return {};
      return { os_fingerprint: stored, os_fingerprint_at: row.osFingerprintAt.toISOString() };
    };

    // The control-plane probe — today's behaviour, byte-for-byte. It is BOTH the
    // answer for vantage=cp and the fallback for vantage=fleet, so it lives in one
    // place rather than being duplicated and drifting.
    const runControlPlaneProbe = async () => {
      const startedAt = Date.now();
      // Prefer the LAUNCH probe. A reachability check answers a question nobody
      // asked: a proxy can accept TCP and authenticate perfectly and still refuse
      // to route, which is what "SOCKS5 reply 0x02 not allowed by ruleset" means
      // and what blocked every launch on 2026-08-18 while every reachability
      // check reported healthy. Falling back to TCP only when the probe or the
      // resolver is absent (fixtures, and deployments with no master key).
      if (
        proxyConnectivityProbe !== undefined &&
        accountProxiesService !== undefined &&
        row.scheme === 'socks5'
      ) {
        const resolved = await accountProxiesService.resolveForDispatch({
          proxyId: row.id,
          accountId: ctx.account.id,
          tier: ctx.account.tier,
        });
        if (resolved === null) {
          return {
            ok: false as const,
            reason: 'This proxy’s stored configuration could not be read. Re-add it and try again.',
          };
        }
        // A VPN wire carries `type`, not host/port — nothing to dial with a
        // SOCKS5 probe. Unreachable for a scheme-socks5 row, but the union says
        // it is possible, so fall through to the reachability check rather than
        // asserting it away.
        if (!('host' in resolved)) {
          await proxyTcpProbe(row.host, row.port, 8_000);
          // (o) — same cause as the fleet branch's twin of this narrowing: a
          // VPN wire has no SOCKS5 endpoint for the observer to dial through,
          // so there is no SYN to read and no retry can produce one.
          const osFields = { os_fingerprint_unavailable: 'vpn_tunnel' as const };
          return {
            ok: true as const,
            latency_ms: Date.now() - startedAt,
            ...quicFields,
            ...(await probeReadingsAsTheRowStands()),
            ...osFields,
            // (p) — the cause says no reading can be taken HERE; it does not say
            // the row has none. A tunnel the fleet has fingerprinted still shows
            // its reading, dated, beside the cause.
            ...storedOsForReply(osFields),
          };
        }
        const descriptor = {
          protocol: 'socks5' as const,
          host: resolved.host,
          port: resolved.port,
          ...(resolved.username !== undefined ? { username: resolved.username } : {}),
          ...(resolved.password !== undefined ? { password: resolved.password } : {}),
        };
        const result = await proxyConnectivityProbe.probe(descriptor);
        if (result.ok) {
          const latency_ms = Date.now() - startedAt;
          // N-2 — passive OS fingerprint of the proxy's own TCP stack, via the
          // shared helper above. ONE implementation on purpose: this attachment
          // existed here and nowhere else, and the fleet branch shipped without
          // it for four days because a second copy was never written.
          const osFields = await osFingerprintFields(descriptor, result.exitIdentity?.ip);
          await persistOsFingerprintIfObserved(osFields);
          return {
            ok: true as const,
            latency_ms,
            ...quicFields,
            ...(await probeReadingsAsTheRowStands()),
            ...osFields,
            // (p) — this test observed nothing; the row may still hold a reading.
            // A no-op when `osFields` carries a fresh one.
            ...storedOsForReply(osFields),
          };
        }
        // The same four sentences the desktop client renders, so a customer who
        // reads one and then the other is not told two different stories.
        const copy: Record<string, string> = {
          unreachable: 'The proxy did not answer. Check the host and port, and that it is online.',
          auth_failed: 'The proxy rejected the username and password. Re-enter them and try again.',
          timeout: 'The proxy was too slow to respond. It may be overloaded — try again shortly.',
          egress_blocked:
            'The proxy connected but could not reach the internet. Check with your proxy provider.',
        };
        return {
          ok: false as const,
          reason:
            copy[result.reason ?? ''] ?? 'The proxy could not be verified. Check its details.',
        };
      }
      try {
        await proxyTcpProbe(row.host, row.port, 8_000);
        // (p) — a reachability check looks at no SYN at all, so it is the purest
        // case of "this test observed none": the row's stored reading, dated,
        // is the only OS answer there is.
        return {
          ok: true as const,
          latency_ms: Date.now() - startedAt,
          ...quicFields,
          ...(await probeReadingsAsTheRowStands()),
          ...storedOsForReply({}),
        };
      } catch {
        // The probe can surface Node socket/TLS details (and a remote endpoint
        // can influence some protocol text). Keep the public discriminated
        // result stable; raw transport diagnostics never belong in an API body.
        return {
          ok: false as const,
          reason: 'Proxy unreachable. Check the host, port, and firewall.',
        };
      }
    };

    // T-1 — the FLEET vantage: dispatch the measurement to the Mac that will run
    // the profile. Returns the node-measured shape on success, or null to signal
    // "fall back to the control plane" — no free node, an unresolvable config, a
    // node error/timeout, or any throw. Never lets an exception reach the client,
    // so vantage=fleet can never 500: it degrades to the cp probe instead.
    /** (h) finding 2 — WHY no fleet node measured the row, so the VPN branch
     *  below can say the true thing instead of asserting "no Mac was free"
     *  for causes a retry cannot fix. `no_fleet` = this deployment cannot
     *  dispatch a VPN test at all (no fleet registry, or no proxies service
     *  to resolve the row); `unresolvable` = the stored row cannot be turned
     *  into a dispatchable config (unreadable secret, unsafe targets);
     *  `no_node` = the fleet exists and was asked, and no node produced a
     *  measurement (none free, dispatch unavailable/timed out, an error with
     *  no node to blame, any unexpected throw). A tier refusal is not a miss:
     *  it is thrown, exactly as the launch path surfaces it. */
    type FleetMiss = {
      miss: 'no_fleet' | 'unresolvable' | 'no_node';
      /** (V3) — for `unresolvable` only: the sentence that names the cause. A
       *  policy refusal (a script directive the control plane will not run, an
       *  external cert/key reference) is NOT "could not be read", and the one
       *  sentence this arm used to give was false for it.
       *
       *  ⛔ (V4 follow-up) — there was a `reason?: ProxyUnresolvableReason`
       *  here too and NOTHING READ IT: the closed-set code reaches triage
       *  through the `request.log.info` beside each producer, not through the
       *  reply, and the customer-facing pick below branches on `detail`. A
       *  written-never-read field on a reply-shaping type reads to the next
       *  editor as though some consumer branched on it. */
      detail?: string;
    };
    /** The row's STORED exit as a /test reply carries it beside a `not_run`
     *  (live_session / no_node). (h) finding 1 — it rides WITH the date it was
     *  observed: the stored exit is what a session saw BEFORE whatever the
     *  fleet said since, and a client that keeps a "this exit was contradicted
     *  at T" stamp can only honour it when the reply dates the observation
     *  rather than letting the reply time stand in for it. `observed_at` is
     *  null for a row whose observation predates the column.
     *  (i) I7 follow-up — and NEVER a CONTRADICTED exit: a non-null
     *  `exitSupersededAt` always postdates the stored exit (every exit write
     *  clears it), so the stored exit is one a fleet verdict has since found
     *  the tunnel down behind. The Mac that ran that test refuses to show it;
     *  a Mac with no local stamp would adopt it off this reply — so the reply
     *  attaches none (the LIST still carries it beside the stamp, dated). */
    const storedExitUnlessSuperseded = (): {
      ip: string;
      country: string | null;
      timezone: string | null;
      observed_via: 'session' | 'probe';
    } | null => (row.exitSupersededAt !== null ? null : (row.exitObserved ?? null));
    const storedExitForReply = ():
      | {
          exit_observed: {
            ip: string;
            country: string | null;
            timezone: string | null;
            region: null;
            city: null;
            observed_at: string | null;
          };
        }
      | Record<string, never> => {
      const stored = storedExitUnlessSuperseded();
      if (stored === null) return {};
      return {
        exit_observed: {
          ip: stored.ip,
          country: stored.country,
          timezone: stored.timezone,
          region: null,
          city: null,
          observed_at: row.exitObservedAt === null ? null : row.exitObservedAt.toISOString(),
        },
      };
    };
    const runFleetProbe = async () => {
      // VPN exit parity — NO scheme guard here any more. An openvpn/wireguard row
      // dispatches too: `resolveForDispatch` already returns the flat inline VPN
      // wire for those schemes (and null for http, which falls back below), and
      // the node is the ONLY vantage that can see through a tunnel. Before this a
      // VPN row silently fell back to the control-plane TCP probe of the display
      // host, which measures nothing about the tunnel.
      if (fleetControlRegistry === undefined || accountProxiesService === undefined) {
        return { miss: 'no_fleet' } satisfies FleetMiss;
      }
      try {
        // (d) 2026-09-10 — REFUSE a VPN probe while a live session browses
        // through this row. The probe would bring a SECOND tunnel up on the
        // same VPN account while the session already holds one, and many VPN
        // accounts allow exactly one connection: the probe can drop the live
        // session. The node's own `node_busy` only sees tunnels on ITSELF; a
        // session on another Mac is invisible there, so the cross-node case is
        // the control plane's to refuse. Nothing is dispatched, so nothing was
        // measured: `measured_from` says `control_plane` (a node did not
        // measure this) and the stored exit — the session's own observation
        // of the tunnel — rides along so the GUI still shows where it exits.
        // A closed session holds no tunnel and does not block. A socks5/http
        // row is untouched: its test is a plain CONNECT, not a second tunnel.
        // (g) G1 — `listOpenByAccount` returns only NON-closed rows (the
        // filter is the repo's contract, pushed to SQL), so the account's
        // closed history is never fetched — nor its transcripts decrypted —
        // per VPN fleet test. Trust that contract here rather than
        // re-checking `status`: a repo that leaked closed rows would then
        // refuse, and the "closed session does not block" arm would catch it.
        if (
          agentSessions !== undefined &&
          (row.scheme === 'openvpn' || row.scheme === 'wireguard')
        ) {
          const open = await agentSessions.listOpenByAccount(ctx.account.id);
          const live = open.find((s) => s.proxyId === row.id);
          if (live !== undefined) {
            request.log.info(
              { proxyId: row.id, agentSessionId: live.id, status: live.status },
              'proxy test: refusing a VPN fleet probe while a live session holds the tunnel',
            );
            // (h) finding 24 — promise "its exit is shown from that session"
            // ONLY when a stored exit is actually attached below; otherwise
            // the sentence would point at an exit cell that reads "run Check".
            // (i) I3 — and only when that exit IS the session's: a stored
            // exit a fleet probe observed (`observed_via: 'probe'`) is "the
            // last check's exit", not something the live session reported.
            // The prose names the exit's real source; a person reading the
            // exit cell must not be told a session observed what a check did.
            // (i) I7 follow-up — a CONTRADICTED exit (`exitSupersededAt` set)
            // is attached by neither `storedExitForReply` nor this sentence:
            // the last check found the tunnel DOWN and produced no exit, and
            // the Mac that ran it shows an empty cell, so "its exit is shown
            // from the last check" would name an exit nobody shows. Same
            // predicate as the attachment, so prose and payload cannot part.
            const stored = storedExitUnlessSuperseded();
            const exitSource =
              stored === null ? 'none' : stored.observed_via === 'session' ? 'session' : 'probe';
            return {
              ok: false,
              reason:
                exitSource === 'session'
                  ? 'This VPN is being used by a running session, so the exit IP shown is from that session. End the session to check the VPN.'
                  : exitSource === 'probe'
                    ? 'This VPN is being used by a running session, so the exit IP shown is from its last check. End the session to check the VPN.'
                    : 'This VPN is being used by a running session. End the session to check the VPN.',
              measured_from: 'control_plane' as const,
              // ⛔ A refusal is NOT a failed tunnel. `not_run` is the
              // machine-readable discriminator a client branches on, so a
              // wait that measured nothing is never rendered as "tunnel
              // down" — the prose is for a person, never for a branch.
              not_run: 'live_session' as const,
              ...storedExitForReply(),
            };
          }
        }
        const resolved = await accountProxiesService.resolveForDispatch({
          proxyId: row.id,
          accountId: ctx.account.id,
          tier: ctx.account.tier,
        });
        if (resolved === null) {
          // (V3 2026-09-12) — ask WHY, and say it. This whole request is the
          // customer asking "why can't you measure my VPN", so a second read of
          // the row on the FAILURE path only is the cheapest possible way to
          // answer it honestly; the success path is untouched. `resolveForDispatch`
          // stays the first call deliberately — it is the one the fleet arm has
          // always made, and the one this route's suites intercept.
          // ⛔ (V4 follow-up) — IN ITS OWN try/catch. This call sits inside the
          // closure's outer `try`, whose handler answers with
          // `{ miss: 'no_node' }` — "No fleet Mac was free to test this VPN
          // tunnel. Try again in a minute." The verdict is ALREADY established
          // by the first resolve above: the row is not dispatchable. If this
          // purely DIAGNOSTIC second read then threw (a DB blip on the second
          // findById, a decrypt-library fault), the customer would be handed a
          // fabricated cause AND a retry promise for a row no retry can fix,
          // and the true answer would be lost. A diagnostic must never be able
          // to change the verdict it exists to explain — so a throw here
          // degrades to the unresolvable answer with no cause, which is
          // exactly what this arm said before the cause existed.
          let why: ProxyDispatchResolution | null = null;
          try {
            why = await accountProxiesService.resolveForDispatchWithReason({
              proxyId: row.id,
              accountId: ctx.account.id,
              tier: ctx.account.tier,
            });
          } catch (err) {
            request.log.info(
              { proxyId: row.id, err },
              'proxy test: the diagnostic re-resolve threw; answering unresolvable with no cause',
            );
          }
          request.log.info(
            { proxyId: row.id, reason: why?.reason },
            'proxy test: stored row is not dispatchable',
          );
          return {
            miss: 'unresolvable',
            ...(why?.detail !== undefined ? { detail: why.detail } : {}),
          } satisfies FleetMiss;
        }
        // (V-219) Stamped BEFORE the dispatch: a SYN the node causes through a
        // tunnel cannot predate it, so the observer lookup below refuses older
        // records the same way `observeOs` refuses records older than its dial.
        const dispatchedAtMs = Date.now();
        const dispatch = await fleetControlRegistry.probeEgress({
          inlineProxyConfig: resolved,
          target: FLEET_PROBE_TARGET,
          // The node connects here once, through the tunnel, so a VPN row's
          // device stack is on record under the exit it reports.
          // Guarded on the METHOD, not only the object: the route's deps type is
          // a Pick, and a caller wiring only `probe`/`observeOs` (every
          // fixture, and any older composition root) must dispatch exactly as
          // before rather than throw here and read as "no node was free".
          observerTarget:
            typeof proxyConnectivityProbe?.observerTarget === 'function'
              ? proxyConnectivityProbe.observerTarget()
              : undefined,
        });
        // (0124) — WHEN the node's readings were taken, stamped the moment its
        // frame resolves and before anything else is awaited. The QUIC/UDP
        // readings are stored under THIS date, not the date of the write: on a
        // SOCKS5 row the write sits behind the OS observation (seconds), so a
        // date taken there would trail the measurement, and two Tests of one
        // proxy finishing out of order would be ranked by who WROTE last.
        const measuredAt = new Date();
        if (dispatch.status !== 'ok') {
          // (e) 2026-09-10 — a node that could not RUN the probe (node_busy,
          // bad_config:*, handshake_failed…) surfaces here as an error outcome.
          // For a socks5 row the control-plane fallback is a REAL measurement
          // (the control plane speaks SOCKS5 itself), so it stands. For a VPN
          // row the control plane cannot bring a tunnel up — its fallback is a
          // bare TCP connect that says nothing about the tunnel — so the only
          // honest answer is the node's refusal, labelled as the fleet's, with
          // no measurement fields (nothing ran).
          if (
            dispatch.status === 'error' &&
            (row.scheme === 'openvpn' || row.scheme === 'wireguard') &&
            dispatch.nodeId !== undefined
          ) {
            // (n) N15 — classify the node's STATIC token before deciding
            // `not_run`. A failed bring-up (`handshake_failed`,
            // `endpoint_unreachable`, `egress_leak_detected`) arrives on this
            // branch and IS a verdict about the tunnel; calling it a `not_run`
            // left the row on its last green verdict with a stale exit forever,
            // and no retry could change the sentence. See classifyVpnProbeFailure.
            const refusal = classifyVpnProbeFailure(dispatch.message, row.scheme);
            if (refusal.notRun === undefined) {
              // (i) I7 parity — a tunnel the node found DOWN contradicts the
              // stored exit NOW, exactly as the verdict path below does for
              // `!usable && probeReachedVerdict(r)`. The exit is KEPT (it is
              // still the last thing seen, at its own date) and the stamp dates
              // the contradiction, so the /proxies list can carry it to a Mac
              // that never saw this test. Best-effort like the verdict path's
              // write: a throw here would be caught by this closure's handler
              // and RELABEL the node's verdict as `control_plane`.
              try {
                await proxiesRepo.update({
                  id: row.id,
                  accountId: ctx.account.id,
                  updates: { exitSupersededAt: new Date() },
                });
              } catch (err) {
                request.log.info(
                  { proxyId: row.id, err },
                  'proxy test: failed to stamp exit_superseded_at for a failed VPN bring-up',
                );
              }
            }
            return {
              ok: false,
              reason: refusal.reason,
              latency_ms: null,
              node_id: dispatch.nodeId,
              measured_from: 'fleet' as const,
              // (d) — `not_run` is the discriminator a client branches on (never
              // the prose): present when NOTHING was learned about the tunnel,
              // ABSENT when the node reached a tunnel verdict.
              ...(refusal.notRun !== undefined ? { not_run: refusal.notRun } : {}),
            };
          }
          return { miss: 'no_node' } satisfies FleetMiss;
        }
        const r = dispatch.result;
        // ⛔ `r.ok` IS NOT "THE PROXY WORKS". Its contract on the node's frame is
        // "the probe reached a verdict" — a proxy that answers nothing at all
        // comes back `ok:true` with reachable/auth_ok/udp_associate/can_route all
        // false and `quic_detail: "skipped: endpoint_unreachable"`. Measured on a
        // live proxy 2026-09-06, four consecutive identical results.
        //
        // On the other two members of this union `ok` means the proxy is USABLE,
        // and a client reads one field. Passing the node's flag straight through
        // under the same name published a PASS for a dead proxy: the desktop card
        // showed a successful test for something no session could ever launch on.
        // One field, one meaning — so translate here, at the protocol boundary,
        // rather than asking every client to know which member it is holding.
        //
        // The sentences are the cp branch's, deliberately: a customer who reads
        // one and then the other must not be told two different stories. Reported
        // in the order the probe establishes the legs, so they are told the FIRST
        // thing that went wrong rather than the last.
        const fleetFailure = ((): string | undefined => {
          // W-28 — ask the question through the reader, which prefers the node's
          // `status` and falls back to `ok`. The schema has already refused any
          // frame where the two disagree, so this cannot pick a side quietly.
          if (!probeReachedVerdict(r)) {
            // (e) 2026-09-10 — `node_busy`: the node refuses a VPN probe while ANY
            // userspace tunnel is live on it (a second tunnel could break the live
            // session), and also under its own concurrency backpressure. A wait,
            // not a verdict on the proxy.
            if (typeof r.error === 'string' && /node_busy/i.test(r.error)) {
              return 'Our test service is busy right now. Try again in a minute.';
            }
            return 'The test could not be completed. Try again shortly.';
          }
          if (!r.reachable) {
            return 'The proxy did not answer. Check the host and port, and that it is online.';
          }
          if (!r.auth_ok) {
            return 'The proxy rejected the username and password. Re-enter them and try again.';
          }
          if (!r.can_route) {
            return 'The proxy connected but could not reach the internet. Check with your proxy provider.';
          }
          return undefined;
        })();
        const usable = fleetFailure === undefined;
        // N-2 — the fingerprint is measured by the CONTROL PLANE even here (see
        // `osFingerprintFields`), so it rides ALONGSIDE the node's latency rather
        // than coming back from the node. Only on an `ok` result: a proxy the node
        // could not use has no stack worth fingerprinting and must not spend the
        // observer's budget. The `'host' in resolved` narrowing IS REACHABLE: a
        // VPN wire carries `type` and no host/port (there is no SOCKS5 endpoint to
        // dial through), so an openvpn/wireguard row takes the no-fingerprint arm.
        //
        // ⛔ (o) 2026-09-11 — and THAT ARM IS THE WHOLE VPN POPULATION. `'host' in
        // resolved` is false for EVERY openvpn/wireguard row, so before this the
        // chip on a VPN profile card was blank permanently, under a hint telling
        // the owner to press Test — the one action that provably cannot change it.
        // The arm now reports its cause: `vpn_tunnel`, "there is no SOCKS5 stack
        // here to fingerprint", which is true and terminates.
        //
        // ⛔ (o) 2026-09-11 follow-up — `vpn_tunnel` is a property of the SCHEME,
        // never of the verdict. It used to sit behind a `!usable ? {}` gate, so
        // the cause was emitted ONLY when the tunnel came up — i.e. in the one
        // state the owner does not need it. In the two states a VPN owner
        // actually presses Check in (the handshake failed; the row has never
        // tested green) the reply carried no cause at all, and the desktop chip
        // fell back to "Run Test … the control plane fingerprints the proxy's
        // own TCP stack" — a button that row does not have, promising a
        // measurement that can never exist for a tunnel. The narrowing decides
        // FIRST now: a VPN wire always reports its cause, and the observer is
        // still spent only on a usable socks5 row.
        //
        // The socks5 `!usable` arm still reports NOTHING on purpose: a proxy the
        // node could not use has its cause in `reason` already, and "fingerprint
        // unavailable because VPN" would be false about a broken socks5 row.
        const osFields: OsFingerprintFields | Record<string, never> =
          'host' in resolved
            ? usable
              ? await osFingerprintFields(
                  {
                    protocol: 'socks5' as const,
                    host: resolved.host,
                    port: resolved.port,
                    ...(resolved.username !== undefined ? { username: resolved.username } : {}),
                    ...(resolved.password !== undefined ? { password: resolved.password } : {}),
                  },
                  r.exit_ip,
                )
              : {}
            : await vpnOsFingerprintFields(usable ? r.exit_ip : null, dispatchedAtMs);
        await persistOsFingerprintIfObserved(osFields);
        // (0124) — which of the node's capability fields are READINGS is decided
        // once, by `capabilityReadingsForReply`, and the SAME answer is both
        // replied and stored: a leg absent from it (skipped, `null`, a VPN row's
        // asserted literal) is absent from the reply AND writes nothing, so the
        // row can never hold a value the customer was not just shown.
        //
        // ⛔ Stored only on a USABLE verdict, like the exit and the OS reading.
        // A frame that reached no verdict carries default falses; a proxy that
        // refused the credential or could not route has its cause in `reason`,
        // and a `false` beside it says the leg had nothing to run over — not
        // that this proxy lacks QUIC. A stored negative stops anyone looking
        // again, so it must be earned by a test of a proxy that works.
        const capabilityReadings = capabilityReadingsForReply(row.scheme, r);
        const probeReadingsPersisted = usable
          ? await persistProbeReadingsIfMeasured(
              {
                ...(capabilityReadings.quic_ok !== undefined
                  ? { quic: capabilityReadings.quic_ok }
                  : {}),
                ...(capabilityReadings.udp_associate !== undefined
                  ? { udp: capabilityReadings.udp_associate }
                  : {}),
              },
              measuredAt,
            )
          : null;
        // VPN exit parity — persist the exit the NODE observed onto the proxy row
        // (`observed_via: 'probe'`, beside the relay's 'session' writes; latest
        // wins), so the /proxies list can show a VPN row's location and hand its
        // timezone to the next launch before any session has run. ONLY when the
        // proxy was USABLE and the node saw an exit: a null exit_ip writes
        // NOTHING and never nulls a value a live session observed earlier.
        // ⛔ (i) I7 follow-up — `usable`, not `exit_ip !== null`: the node's
        // egress-LEAK verdict is `can_route:false` WITH an exit_ip — the node's
        // OWN public address, "traffic is not leaving through the tunnel"
        // (HarnessCoordinator.swift `canRoute:false, exitIp: proxiedIp`). That
        // ip is not this tunnel's exit; storing it dated now would put the
        // fleet Mac's address on the /proxies list as this VPN's location,
        // beside a reply that says `ok:false`, and clear the superseded stamp
        // with a non-exit. Best-effort, owner-scoped, logged at info — mirrors
        // persistOsFingerprintIfObserved: a persistence failure must not throw,
        // because a throw here is caught by this closure's handler and would
        // RELABEL a node measurement as `control_plane`.
        const exitObserved =
          !usable || r.exit_ip === null
            ? undefined
            : {
                ip: r.exit_ip,
                country: r.exit_country ?? null,
                timezone: r.exit_timezone ?? null,
                region: r.exit_region ?? null,
                city: r.exit_city ?? null,
              };
        // Never DOWNGRADE a stored observation: a node that does not yet emit
        // the exit_* keys sends the ip alone, and writing {country: null,
        // timezone: null} over a live session's observation of the same exit
        // would erase real geo. Same ip + no incoming geo + existing geo → keep.
        const incomingHasGeo =
          exitObserved !== undefined &&
          (exitObserved.country !== null || exitObserved.timezone !== null);
        const existingExit = row.exitObserved ?? null;
        const wouldDowngrade =
          exitObserved !== undefined &&
          !incomingHasGeo &&
          existingExit !== null &&
          existingExit.ip === exitObserved.ip &&
          (existingExit.country !== null || existingExit.timezone !== null);
        // (i) I7 — the row's `exit_superseded_at` (migration 0122). Three
        // outcomes, decided by the node's VERDICT (`usable`: reached a verdict,
        // reachable, auth ok, can route) — never by whether an `exit_ip` came
        // back, since the leak frame above carries one on a DOWN verdict:
        //   * the proxy was usable and the node saw an exit → the tunnel was
        //     up: the exit is written (unless it would downgrade stored geo)
        //     AND the stamp is cleared, because a contradiction older than an
        //     observation is spent;
        //   * the node reached a verdict and the proxy is not usable (no
        //     exit, or a leak's non-exit) → the tunnel is DOWN: the stored
        //     exit (if any) is contradicted NOW. It is kept — it is still the
        //     last thing seen, at its own date — and the stamp dates the
        //     contradiction so the /proxies list can carry it to a Mac that
        //     never saw this test;
        //   * nothing ran (`could_not_run`) → nothing was measured, nothing
        //     is written: a wait is not a verdict about the tunnel.
        // Best-effort like the exit write: a persistence failure must not
        // throw, or the node's measurement would be relabelled `control_plane`.
        const stampUpdates: AccountProxyRowUpdates | null =
          exitObserved !== undefined
            ? wouldDowngrade
              ? row.exitSupersededAt !== null
                ? { exitSupersededAt: null }
                : null
              : {
                  exitObserved: {
                    ip: exitObserved.ip,
                    country: exitObserved.country,
                    timezone: exitObserved.timezone,
                    observed_via: 'probe',
                  },
                  exitObservedAt: new Date(),
                  exitSupersededAt: null,
                }
            : // (k) — the stamp is decided by the VERDICT, never by whether an exit is
              // stored: a never-stamped row lists exit_superseded_at as null, which a
              // client reads as "seen up again" and would erase its own fresh failure.
              !usable && probeReachedVerdict(r)
              ? { exitSupersededAt: new Date() }
              : null;
        if (stampUpdates !== null) {
          try {
            await proxiesRepo.update({
              id: row.id,
              accountId: ctx.account.id,
              updates: stampUpdates,
            });
          } catch (err) {
            request.log.info(
              { proxyId: row.id, err },
              'proxy test: failed to persist the probe-observed exit / exit_superseded_at',
            );
          }
        }
        return {
          ok: usable,
          ...(fleetFailure !== undefined ? { reason: fleetFailure } : {}),
          latency_ms: r.latency_ms,
          ...quicFields,
          // (0124) — the row's Test readings AS THEY NOW STAND, so the reply
          // agrees with the list. Where the write landed, that is the row the
          // statement returned. Where nothing was stored — no leg measured, the
          // proxy not usable, the write failed, the row gone or edited mid-test
          // — it is a RE-READ: `row` predates the test and may still hold a
          // reading an edit has since cleared.
          ...(probeReadingsPersisted !== null
            ? storedProbeReadings(probeReadingsPersisted)
            : await probeReadingsAsTheRowStands()),
          ...osFields,
          // (p) — the stored reading rides a fleet reply too, under the same rule
          // (a fresh observation wins, the cause stays). Only on a USABLE verdict:
          // a proxy the node could not use answers `ok:false`, where the OS half of
          // the reply is not part of the published shape and the desktop client
          // reads no reading at all — the list is what carries it there.
          ...(usable ? storedOsForReply(osFields) : {}),
          // (e) 2026-09-10 — a `could_not_run` frame (node_busy, bad_config:*,
          // timeout…) carries no fact except `error`: every measurement field on
          // it is a default false/null, so none is reported.
          //
          // (V6 2026-09-16) ITEM 3 — on a verdict, which of `udp_associate`,
          // `h2_ok` and `quic_ok` is a READING is decided in ONE place,
          // `capabilityReadingsForReply` above: a VPN row's UDP/HTTP-2 literals and
          // a leg the node skipped are ABSENT, and absence is the wire's "not
          // measured". `reachable` / `auth_ok` / `can_route` / `exit_ip` are probed
          // on every path and are reported unchanged.
          ...(probeReachedVerdict(r)
            ? {
                reachable: r.reachable,
                auth_ok: r.auth_ok,
                can_route: r.can_route,
                ...capabilityReadings,
                quic_detail: r.quic_detail,
                exit_ip: r.exit_ip,
              }
            : {}),
          // Spread only when defined — never an `exit_observed: undefined` key.
          ...(exitObserved !== undefined ? { exit_observed: exitObserved } : {}),
          node_id: r.node_id,
          measured_from: 'fleet' as const,
        };
      } catch (err) {
        // (h) finding 2 — a TIER refusal is the route's own answer (the same
        // one POST/PUT and the launch path give for a VPN row on a tier without
        // vpnEgress); swallowing it into "no Mac was free… try again" told a
        // downgraded account to keep retrying something a retry can never fix.
        // An unsafe stored host is a config the fleet must never be handed,
        // not a missing node.
        if (err instanceof ForbiddenError) throw err;
        if (err instanceof UnsafeProxyHostError) {
          request.log.info(
            { proxyId: row.id, err },
            'proxy test: stored proxy host is unsafe; refusing the fleet dispatch',
          );
          // ⛔ (V4 follow-up) — WITH its cause. This return carried no
          // reason/detail, so it fell through to the shipped "could not be
          // read. Re-add it" sentence 40 lines below — the exact class of lie
          // V3 says it eliminated, in the same route, for the one cause where
          // re-adding the same config is guaranteed to be refused again. The
          // service already owns the right words (it answers the EMBEDDED
          // endpoint with them); this is the DISPLAY host, classified by the
          // same `classifyUnsafeHost`, so it gets the same sentence. Note this
          // is also the only way `config_refused_target` can be reported for
          // the display host: the service THROWS for it rather than returning.
          return { miss: 'unresolvable', detail: UNSAFE_TARGET_DETAIL } satisfies FleetMiss;
        }
        request.log.info(
          { proxyId: row.id, err },
          'proxy test: fleet-vantage probe failed, falling back to the control plane',
        );
        return { miss: 'no_node' } satisfies FleetMiss;
      }
    };

    if (vantage === 'fleet') {
      const fleet = await runFleetProbe();
      if (!('miss' in fleet)) return fleet;
      // (h) H1 2026-09-10 — findings 4/10. For an openvpn/wireguard row NEVER
      // fall through to the control-plane probe. The cp cannot bring a tunnel
      // up; its "fallback" for a VPN row is a bare TCP connect to the tunnel
      // endpoint — UDP-only for WireGuard, udp by default for OpenVPN — which
      // fails and was published as `ok:false, reason:'Proxy unreachable…'`
      // with no `not_run`: the GUI rendered a red "tunnel down" with a wrong
      // next step for a tunnel nobody measured. "No node measured it" (registry
      // absent, config unresolvable, dispatch unavailable/timeout, an error
      // outcome with no node to blame, any throw) is a NOT-RUN: `no_node` is
      // the discriminator a client branches on, `control_plane` says no node
      // produced this, no measurement field is present, and the stored exit
      // rides along (as on the live_session refusal) so the row still shows
      // where it exits. A socks5/http row keeps the cp fallback below: there
      // the control plane speaks the protocol itself, so it IS a measurement.
      if (row.scheme === 'openvpn' || row.scheme === 'wireguard') {
        // (h) finding 2 — the sentence says WHAT kept the fleet from measuring,
        // and "try again in a minute" is promised only where a retry can help.
        // A row the fleet cannot be handed (unreadable secret, unsafe target)
        // is a verdict about the ROW, in the words the cp path uses for the
        // same condition on a socks5 row — not a `not_run`, and never "no Mac
        // was free". A deployment with no fleet will never have a free Mac.
        if (fleet.miss === 'unresolvable') {
          return {
            ok: false as const,
            // (V3) — the CAUSE's own sentence when the service named one (for a
            // refused directive it quotes the offending line, exactly as the
            // create/update route does for the same blob); the shipped sentence
            // when it did not, which is also what every unreadable cause says.
            reason:
              fleet.detail ??
              'This VPN’s stored configuration could not be read. Re-add it and try again.',
            measured_from: 'control_plane' as const,
            // ⛔ (V4 follow-up) — `not_run`, and the in-code defence that used
            // to sit here ("a verdict about the ROW … not a `not_run`") was
            // contradicted by its own consequence. `not_run`'s CONTRACT is
            // "present when NOTHING RAN, so `ok:false` is not a verdict about
            // the proxy" — and nothing ran here: no node was dispatched, no
            // tunnel was brought up, no packet left. Its absence made the
            // client classify the reply `failed`, which DROPS the row's
            // exitIp/geo/latency/quic/os and stamps `exitSupersededAt`, so a
            // WireGuard row with a missing `Address` was rendered as a red
            // "VPN tunnel down" and the exit IP the customer had just gained
            // was erased — by a cause that measured nothing about the tunnel.
            // `unresolvable` covers all ten causes truthfully (see
            // ProxyUnresolvableReason); `reason` above still carries the
            // sentence, and the stored exit rides along exactly as it does on
            // the live_session / no_node refusals below.
            not_run: 'unresolvable' as const,
            ...storedExitForReply(),
          };
        }
        return {
          ok: false as const,
          reason:
            fleet.miss === 'no_fleet'
              ? 'VPN checks are not available on this deployment.'
              : 'Our test service is busy right now. Try again in a minute.',
          measured_from: 'control_plane' as const,
          not_run: 'no_node' as const,
          ...storedExitForReply(),
        };
      }
      // No node measured it — return the control-plane result, HONESTLY labelled
      // so a fleet request is never shown a cp measurement as if a node produced it.
      return { ...(await runControlPlaneProbe()), measured_from: 'control_plane' as const };
    }
    // vantage=cp — today's response, unchanged (no measured_from field).
    return runControlPlaneProbe();
  }

  // V-352b — upload (or replace) the calling account's avatar. Inline
  // base64 body, validated for MIME + size, written to R2 public
  // bucket, then the DB pointer + auth-cache flush. The client gets a
  // presigned GET URL (same shape as /v1/account/me) so it never has
  // to handle bucket URLs directly.
  //
  // bodyLimit override: Fastify defaults to 1 MiB JSON. A 2 MiB raw
  // image becomes ~2.8 MiB base64; we cap the route at 3.5 MiB so a
  // legitimate 2 MiB upload + JSON envelope fits and anything beyond
  // is short-circuited as 413 by Fastify before our handler runs.
  app.post(
    '/v1/account/me/avatar',
    {
      preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')],
      bodyLimit: 3.5 * 1024 * 1024,
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      if (!r2Public) {
        throw new FeatureUnavailableError('Avatar uploads are not available on this deployment.');
      }
      const parsed = UploadAvatarRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid body.');
      }
      reportUnknownRequestFields({
        body: request.body ?? {},
        knownKeys: knownRequestKeys(UploadAvatarRequestSchema),
        reply,
        logger: request.log,
        route: 'PUT /v1/account/me/avatar',
      });

      let bytes: Buffer;
      try {
        bytes = Buffer.from(parsed.data.data_base64, 'base64');
      } catch {
        throw new BadRequestError('data_base64 is not valid base64.');
      }
      if (bytes.length === 0) {
        throw new BadRequestError('Avatar image is empty.');
      }
      if (bytes.length > AVATAR_MAX_BYTES) {
        throw new BadRequestError(`Avatar image is too large. Max ${AVATAR_MAX_BYTES} bytes.`);
      }

      const key = avatarKey(ctx.account.id, parsed.data.content_type);
      try {
        await r2Public.putObject({
          key,
          body: bytes,
          contentType: parsed.data.content_type,
        });
      } catch (err) {
        app.log.error({ err, key }, 'avatar upload to R2 failed');
        throw new FeatureUnavailableError('Avatar storage is temporarily unavailable.');
      }

      const updated = await authRepo.updateAccountBasics(ctx.account.id, {
        avatarR2Key: key,
      });
      if (!updated) throw new NotFoundError('Account not found.');

      if (authCache) {
        try {
          await authCache.invalidateAccount(ctx.account.id);
        } catch {
          /* swallow */
        }
      }

      const url = await presignAvatar(updated.avatarR2Key);
      reply.code(200);
      return {
        avatar_url: url,
        content_type: parsed.data.content_type,
        bytes: bytes.length,
      };
    },
  );

  // V-352b — clear the avatar pointer on the account row. The R2
  // object is intentionally left in place: a future sweeper job
  // collects orphaned avatar keys (off the hot path; avatars are
  // already public-readable so leaving stale objects is no worse
  // than the public bucket already is). Returns 204.
  app.delete(
    '/v1/account/me/avatar',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');

      const updated = await authRepo.updateAccountBasics(ctx.account.id, {
        avatarR2Key: null,
      });
      if (!updated) throw new NotFoundError('Account not found.');

      if (authCache) {
        try {
          await authCache.invalidateAccount(ctx.account.id);
        } catch {
          /* swallow */
        }
      }

      reply.code(204);
      return null;
    },
  );
}
