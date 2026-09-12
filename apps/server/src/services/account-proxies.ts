// ARC A — account proxies service. Owns PROFILE_MASTER_KEY + the repo and
// resolves a stored proxy to a dispatch-ready SocksProxyConfig: unwrap the
// password under the account TMK + re-assert the SSRF host-guard, fail-closed.
// Encapsulates the two sensitive operations (cross-account decrypt + SSRF) in
// one tested place, used by the agent-session dispatch.

import type { AccountTier, InlineVpnProxyWire, SocksProxyConfig } from '@driftstack/api-types';
import {
  findUnresolvableOpenvpnFileReferences,
  InlineVpnProxyWireSchema,
} from '@driftstack/api-types';
import type { AccountProxiesRepo, AccountProxyRow } from '../db/account-proxies-repo.js';
import { readAccountProxySecret } from '../lib/account-proxy-secret-encryption.js';
import {
  classifyUnsafeHost,
  classifyUnsafeVpnTargets,
  unresolvableOpenvpnFileReferenceDetail,
  unsupportedOpenvpnDirectiveDetail,
} from '../lib/webhook-target-guard.js';
import { requireTierFeature } from '../lib/errors-helpers.js';

/** Thrown when a stored proxy's host resolves to an internal-reachable address
 *  at dispatch time (defense-in-depth; the host is also guarded at create). The
 *  best-effort dispatch caller catches it and skips — a session is NEVER run
 *  through an SSRF-unsafe proxy. */
export class UnsafeProxyHostError extends Error {
  constructor(public readonly kind: string) {
    super(`Proxy host is not allowed (${kind}).`);
    this.name = 'UnsafeProxyHostError';
  }
}

/**
 * `config` jsonb key under which a WireGuard row carries its PresharedKey — as a
 * record/slot-bound v2 ENVELOPE, never the key itself.
 *
 * Why an envelope in `config` and not a second secret column: the row has one
 * VPN secret column (`wrapped_secret`) and its `wireguard-private-key` slot
 * validates the plaintext as exactly one bare 44-char key, so the PSK cannot
 * ride inside it, and a second column is a migration plus a new slot in the
 * encryption module. A PSK has the same 32-byte base64 shape as the private key,
 * so it wraps under the SAME slot and the same account + proxy AAD: it is never
 * at rest in the clear, and an envelope lifted from another row or account fails
 * GCM here exactly as the private key does. What that shares with the private
 * key is the slot NAME in the AAD — the two envelopes of one row are
 * interchangeable ciphertexts to someone who can already write the database,
 * and swapping them yields a tunnel that fails its handshake, not a disclosure.
 *
 * Written by `buildVpnSecretAndConfig` (routes/account-me.ts); read only by
 * `resolveVpnForDispatch` below. One symbol for both ends so the writer and the
 * reader cannot disagree on the spelling.
 */
export const WIREGUARD_WRAPPED_PRESHARED_KEY_FIELD = 'wrapped_preshared_key';

/** 7-day TTL for a verified per-proxy UDP capability (A3 W2756). A proxy's
 *  UDP_ASSOCIATE support is stable, but a customer can reconfigure the exit, so a
 *  verified value older than this is treated as unknown (→ omit → the fork
 *  re-probes). */
const UDP_CAPABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Read a FRESH verified UDP capability off a proxy row's `config` jsonb. Returns
 *  the bool only when `config.udp_capable` is a real bool AND `config.udp_verified_at`
 *  is an ISO timestamp within the TTL; otherwise undefined (→ resolveForDispatch
 *  omits `udp_capable` → harness leaves DRIFTSTACK_PROXY_UDP_CAPABLE unset → the
 *  fork's async probe = today's safe default). The value is only ever WRITTEN from a
 *  real data-path probe (the deferred Swift probe-writer; A3 to spec the
 *  server→harness control-command), never from a customer claim. */
function freshUdpCapable(config: Record<string, unknown>): boolean | undefined {
  const cap = config['udp_capable'];
  const at = config['udp_verified_at'];
  if (typeof cap !== 'boolean' || typeof at !== 'string') return undefined;
  const verifiedMs = Date.parse(at);
  if (Number.isNaN(verifiedMs)) return undefined;
  if (Date.now() - verifiedMs > UDP_CAPABLE_TTL_MS) return undefined;
  return cap;
}

/**
 * (V3 2026-09-12, owner: "session not starting still") — WHY a stored row could
 * not be turned into a dispatchable egress config.
 *
 * ⛔ Every one of these used to be the same `null`, and both launch-blocking
 * call sites answered it with ONE sentence: "its stored configuration could not
 * be read. Re-add it and try again." For four of the nine causes that sentence
 * is false, and for the two POLICY causes it is actively misleading — a config
 * carrying `script-security 2`, or a `ca ca.crt` line pointing at a file no
 * session can hold, is a config the control plane REFUSES, not one it could not
 * decrypt. The customer was told to re-add a config that would be refused again,
 * and the server log said nothing but "decrypt/config".
 *
 * The code is for the LOG (triage picks the cause without a repro); the sentence
 * it carries is for the customer. Reason codes are a closed set, never prose.
 */
export type ProxyUnresolvableReason =
  /** No such row for this account (deleted, or never owned by it). */
  | 'not_found'
  /** `http` — there is no inline-dispatch slot for it yet. */
  | 'scheme_not_dispatchable'
  /** PROFILE_MASTER_KEY absent on this deployment: nothing here can be unwrapped. */
  | 'encryption_unavailable'
  /** The row carries no wrapped secret at all (a VPN row stored without one). */
  | 'secret_missing'
  /** GCM auth failed: a wrong-account TMK, a post-rotation un-rewrapped row, corruption. */
  | 'secret_unreadable'
  /** The secret decrypted but is not the JSON/shape this scheme stores. */
  | 'config_unreadable'
  /** Policy: a script-executing directive (or `script-security` >= 2). */
  | 'config_refused_directive'
  /** Policy: a cert/key line naming an external file the session cannot provide. */
  | 'config_refused_file_reference'
  /** Policy/SSRF: the tunnel's own target is a private/loopback/metadata address. */
  | 'config_refused_target'
  /** The flat dispatch wire is missing a required field (a WG row with no `address`). */
  | 'config_incomplete';

/** The resolve, WITH the reason a null carries. `config === null` iff `reason`
 *  is set, and `detail` is then the sentence to show the row's OWNER (both
 *  callers are owner-scoped). */
export interface ProxyDispatchResolution {
  config: (SocksProxyConfig & { udp_capable?: boolean | null }) | InlineVpnProxyWire | null;
  reason?: ProxyUnresolvableReason;
  detail?: string;
}

/** The "we could not read what you stored" sentence, per scheme family. The
 *  three unreadable causes share it deliberately: the customer's action is the
 *  same (re-save the material), and the CODE is what separates them for triage.
 *  Kept byte-identical to the sentence the /test route and the pre-launch gate
 *  already shipped, so a re-save instruction nobody needed to change does not
 *  change under customers who have read it. */
function unreadableDetail(vpn: boolean): string {
  return vpn
    ? 'This VPN’s stored configuration could not be read. Re-add it and try again.'
    : 'This proxy’s stored configuration could not be read. Re-add it and try again.';
}

/** The refusal sentence for an unsafe VPN target — the same words the create /
 *  update route answers the same classification with, so a customer who reads
 *  one and then the other is not told two different stories. */
export const UNSAFE_TARGET_DETAIL =
  'This VPN configuration targets a private, loopback, link-local, or metadata address, which Driftstack will not route to. Fix the endpoint (or DNS) and save it again.';

/**
 * ⚠️ WHY THE WORD BELOW IS ALWAYS "missing", and why an "invalid" clause was
 * REMOVED again after being written (2026-09-12 review of V3).
 *
 * A review filed the `config_incomplete` sentence as a lie for
 * `preshared_key` — the one flat-wire field with a FORMAT rule rather than a
 * presence rule (`InlineWireGuardWireSchema`, a 44-char base64 regex) and
 * `.optional()`, so every issue it can raise is a value that is PRESENT and
 * malformed, which "missing" would misname. The schema measurement is right and
 * the conclusion is wrong: THIS SERVICE CANNOT REACH THAT ISSUE.
 *
 * MEASURED 2026-09-12, both directions:
 *   * `InlineWireGuardWireSchema.safeParse({…, preshared_key: 'nope'})` →
 *     `invalid_string` on `['preshared_key']`. The schema can produce it.
 *   * but the PSK reaching that parse is the plaintext of an unwrapped
 *     envelope, and `account-proxy-secret-encryption` runs `validatePlaintext`
 *     on BOTH ends — `encryptAccountProxySecret` before the write AND
 *     `decryptPayload` after the read (its last statement) — against that SAME
 *     44-char regex. A malformed PSK cannot be stored, and one corrupted at rest
 *     THROWS on read, which this file answers with `secret_unreadable`, never
 *     `config_incomplete`.
 *   * every OTHER field of both wire members is presence-only (`min(1)` or a
 *     literal the service sets itself), so the only issues reachable here are
 *     `invalid_type` (the field is absent from `config`) and `too_small` (it is
 *     the empty string) — for both of which "missing" is what the customer's
 *     file actually shows.
 *
 * ⛔ So a missing/invalid partition here would be an unreachable branch carrying
 * customer copy, guarded only by a test that fabricated a row the system cannot
 * produce — which is worse than the sentence it replaced. If a format rule is
 * ever added to a field NOT mirrored in the encryption module's validator, this
 * is the note to come back to.
 *
 * The name each flat-wire field has in the FILE the customer pasted, for the
 *  `config_incomplete` sentence. A WireGuard .conf calls `address` `Address`;
 *  telling someone their `address` is missing names our wire, not their file.
 *  An unmapped field falls back to its wire name (nothing is dropped). */
const WIRE_FIELD_CONFIG_NAME: Readonly<Record<string, string>> = {
  private_key: 'PrivateKey',
  peer_public_key: 'PublicKey (the peer’s)',
  preshared_key: 'PresharedKey',
  endpoint: 'Endpoint',
  allowed_ips: 'AllowedIPs',
  address: 'Address',
  dns: 'DNS',
  config_blob: 'the OpenVPN configuration',
};

export class AccountProxiesService {
  constructor(
    private readonly repo: AccountProxiesRepo,
    private readonly masterKey: Buffer | null,
  ) {}

  /** Owner-scoped existence check for the session-create validation path —
   *  null when not found / wrong account (the route maps null → 404). */
  findOwned(id: string, accountId: string): Promise<AccountProxyRow | null> {
    return this.repo.findById({ id, accountId });
  }

  /**
   * Resolve a stored proxy to a dispatch-ready SocksProxyConfig. Owner-scoped.
   * Returns null when the proxy isn't found for this account, or isn't `socks5`
   * (http proxies aren't injectable through the SocksProxyConfig dispatch slot
   * yet). Unwraps the password only for this exact account + proxy + password
   * slot and re-asserts the SSRF host-guard —
   * an internal-reachable host throws UnsafeProxyHostError (fail-closed).
   */
  async resolveForDispatch(args: {
    proxyId: string;
    accountId: string;
    /**
     * V-786 — the OWNER account's tier, required rather than optional so a new
     * call site cannot resolve an egress config without stating one.
     *
     * `vpnEgress` used to be checked only where a proxy is REGISTERED
     * (`routes/account-me.ts` POST + PUT). A stored proxy outlives the tier that
     * was allowed to store it: an account that registered an OpenVPN or
     * WireGuard profile while paid and then downgraded to free kept egressing
     * through it indefinitely, because nothing on the launch path looked, and
     * `handleTierChanged` audits and emails without touching `account_proxies`.
     * Rows predating the registration gate were in the same position.
     *
     * Enforced HERE because this is the single choke point that turns a stored
     * row into a dispatchable egress config. A check on the create route alone
     * is a check on one call site, which is the shape of the bug being fixed.
     */
    tier: AccountTier;
  }): Promise<(SocksProxyConfig & { udp_capable?: boolean | null }) | InlineVpnProxyWire | null> {
    return (await this.resolveForDispatchWithReason(args)).config;
  }

  /**
   * (V3) — the same resolve, carrying WHY a null is null (see
   * `ProxyUnresolvableReason`). `resolveForDispatch` above is this method's
   * `.config`, so there is ONE implementation and a caller that does not need
   * the reason is unchanged, byte for byte, in behaviour and in signature.
   *
   * Used by the two sites that REFUSE A LAUNCH on a null (the pre-launch gate
   * and the dispatch fail-closed) and by the /test route's fleet arm — the three
   * places a customer or an on-call engineer reads the answer.
   */
  async resolveForDispatchWithReason(args: {
    proxyId: string;
    accountId: string;
    tier: AccountTier;
  }): Promise<ProxyDispatchResolution> {
    const row = await this.repo.findById({ id: args.proxyId, accountId: args.accountId });
    if (row === null) {
      return {
        config: null,
        reason: 'not_found',
        detail: 'This proxy is no longer on your account. Add it again and try again.',
      };
    }
    // The host (socks5 host / VPN endpoint host) was validated at create; re-assert
    // here so a row inserted by any other path can't smuggle a private/loopback/
    // metadata host into egress. Applies to ALL schemes.
    const unsafe = classifyUnsafeHost(row.host);
    if (unsafe !== null) throw new UnsafeProxyHostError(unsafe);

    if (row.scheme === 'openvpn' || row.scheme === 'wireguard') {
      // Throws ForbiddenError. Both launch call sites are fail-closed on a throw
      // (the dispatch's outer wrapper skips the dispatch; the pre-launch gate
      // surfaces it), so an unentitled account cannot egress through this row
      // even if the create-time check is ever bypassed or removed.
      requireTierFeature(args.tier, 'vpnEgress');
      return this.resolveVpnForDispatch(row, args.accountId);
    }
    if (row.scheme !== 'socks5') {
      // http isn't an inline-dispatch target
      return {
        config: null,
        reason: 'scheme_not_dispatchable',
        detail:
          'An HTTP proxy can’t carry a session yet. Use a SOCKS5 proxy, or an OpenVPN / WireGuard configuration.',
      };
    }

    let password: string | undefined;
    if (row.wrappedPassword !== null) {
      if (this.masterKey === null) {
        return {
          config: null,
          reason: 'encryption_unavailable',
          detail: unreadableDetail(false),
        };
      }
      try {
        password = readAccountProxySecret(
          this.masterKey,
          { accountId: args.accountId, proxyId: row.id, slot: 'password' },
          row.wrappedPassword,
        );
      } catch {
        // wrong-account TMK / corrupted blob / post-rotation un-rewrapped row → GCM
        // auth fails. Fail CLOSED to null (mirror the VPN branch below) so the
        // dispatch's `resolved === null` path closes the row honestly + releases the
        // concurrency slot, instead of letting the throw escape to the best-effort
        // outer catch — which would strand the session active-but-undispatched
        // (phantom slot until the 12h reaper) and spin the GUI on "No frame yet".
        return { config: null, reason: 'secret_unreadable', detail: unreadableDetail(false) };
      }
    }
    // Proxy UDP pre-detection (A3 W2756): emit the verified capability when fresh
    // so the harness can skip the per-session ~3s probe; omitted (→ fork async-probe
    // = today's behavior) until the deferred probe-writer populates config.
    const udpCapable = freshUdpCapable(row.config);
    return {
      config: {
        host: row.host,
        port: row.port,
        udp_associate: true,
        ...(udpCapable !== undefined ? { udp_capable: udpCapable } : {}),
        // Resolve DNS through the proxy, not the local host — avoids a DNS leak
        // that would reveal the real egress (the egress design's default intent).
        require_remote_dns: true,
        ...(row.username !== null ? { username: row.username } : {}),
        ...(password !== undefined ? { password } : {}),
      },
    };
  }

  /**
   * Build the FLAT inline VPN dispatch wire (A3 W2163: sibling fields, NOT
   * nested) from a stored VPN row. Unwraps only the exact account + proxy +
   * protocol slot, so moving a valid envelope to another row or slot fails GCM.
   * The non-secret fields ride `config` (jsonb). Returns null when encryption
   * isn't configured or the row is malformed (fail-closed; the session just runs
   * without this proxy rather than dispatching a broken VPN).
   */
  private resolveVpnForDispatch(row: AccountProxyRow, accountId: string): ProxyDispatchResolution {
    if (row.wrappedSecret === null) {
      return { config: null, reason: 'secret_missing', detail: unreadableDetail(true) };
    }
    if (this.masterKey === null) {
      return { config: null, reason: 'encryption_unavailable', detail: unreadableDetail(true) };
    }
    let secret: string;
    try {
      secret = readAccountProxySecret(
        this.masterKey,
        {
          accountId,
          proxyId: row.id,
          slot: row.scheme === 'openvpn' ? 'openvpn-config' : 'wireguard-private-key',
        },
        row.wrappedSecret,
      );
    } catch {
      // wrong-account TMK / corrupted blob → fail-closed
      return { config: null, reason: 'secret_unreadable', detail: unreadableDetail(true) };
    }
    const cfg = row.config;
    const str = (k: string): string | undefined =>
      typeof cfg[k] === 'string' ? cfg[k] : undefined;

    let candidate: unknown;
    if (row.scheme === 'openvpn') {
      // secret = JSON { config_blob, password? }; username rides config.
      let parsed: { config_blob?: unknown; password?: unknown };
      try {
        parsed = JSON.parse(secret) as typeof parsed;
      } catch {
        return { config: null, reason: 'config_unreadable', detail: unreadableDetail(true) };
      }
      if (typeof parsed.config_blob !== 'string') {
        return { config: null, reason: 'config_unreadable', detail: unreadableDetail(true) };
      }
      const blob = parsed.config_blob;
      // SSRF re-guard at dispatch (defense-in-depth): the real egress is the embedded
      // `remote <host>`, never the display host already checked above. Fail-closed.
      //
      // ⛔ (V3) — THIS IS A POLICY REFUSAL, NOT A READ FAILURE, and saying "could
      // not be read" here is what sent the owner round the loop: a row stored by a
      // build older than `stripUnsupportedOpenvpnLines` still carries its
      // `script-security 2` line, the launch refused it HERE, and the sentence the
      // customer got named decryption. The classifier already knows which of the
      // two it is, so each says its own thing — the directive case in the same
      // words, naming the same line, that the create/update route answers the same
      // blob with (`unsupportedOpenvpnDirectiveDetail`).
      const unsafeTargets = classifyUnsafeVpnTargets({ configBlob: blob });
      if (unsafeTargets !== null) {
        return unsafeTargets === 'unsafe-directive'
          ? {
              config: null,
              reason: 'config_refused_directive',
              detail: unsupportedOpenvpnDirectiveDetail(blob),
            }
          : { config: null, reason: 'config_refused_target', detail: UNSAFE_TARGET_DETAIL };
      }
      // (V3) — and the EXTERNAL cert/key reference, which the create route has
      // refused since T-20 but the dispatch never looked at: a row stored before
      // that check (or by any other writer) dispatched fine and then died inside
      // openvpn on the node as a generic "Options error" naming neither field nor
      // cause. Cross-source pin with the node's own parse-reject (A3 8a03a3929) —
      // the node refuses the same config, so nothing that launches today stops
      // launching; it just fails here, early, naming the line.
      if (findUnresolvableOpenvpnFileReferences(blob).length > 0) {
        return {
          config: null,
          reason: 'config_refused_file_reference',
          detail: unresolvableOpenvpnFileReferenceDetail(blob),
        };
      }
      candidate = {
        type: 'openvpn',
        config_blob: parsed.config_blob,
        ...(str('username') !== undefined ? { username: str('username') } : {}),
        ...(typeof parsed.password === 'string' ? { password: parsed.password } : {}),
      };
    } else {
      // wireguard: secret = the raw private_key; the rest rides config.
      // SSRF re-guard at dispatch (defense-in-depth): the real egress is the endpoint (+ dns),
      // never the display host already checked above. Fail-closed.
      if (classifyUnsafeVpnTargets({ endpoint: str('endpoint'), dns: str('dns') }) !== null) {
        return { config: null, reason: 'config_refused_target', detail: UNSAFE_TARGET_DETAIL };
      }
      // PresharedKey: stored as its own envelope under the private-key slot (see
      // WIREGUARD_WRAPPED_PRESHARED_KEY_FIELD). Unwrapped under the exact account +
      // proxy, like the private key; a PSK the peer expects and we cannot recover
      // is a tunnel that will never handshake, so an unwrap failure fails CLOSED
      // (null) rather than dispatching the row without it.
      const wrappedPresharedKey = str(WIREGUARD_WRAPPED_PRESHARED_KEY_FIELD);
      let presharedKey: string | undefined;
      if (wrappedPresharedKey !== undefined) {
        try {
          presharedKey = readAccountProxySecret(
            this.masterKey,
            { accountId, proxyId: row.id, slot: 'wireguard-preshared-key' },
            wrappedPresharedKey,
          );
        } catch {
          // wrong-account TMK / corrupted blob → fail-closed
          return { config: null, reason: 'secret_unreadable', detail: unreadableDetail(true) };
        }
      }
      candidate = {
        type: 'wireguard',
        private_key: secret,
        peer_public_key: str('peer_public_key'),
        ...(presharedKey !== undefined ? { preshared_key: presharedKey } : {}),
        endpoint: str('endpoint'),
        allowed_ips: str('allowed_ips'),
        address: str('address'),
        ...(str('dns') !== undefined ? { dns: str('dns') } : {}),
      };
    }
    // Validate the FLAT wire before it leaves the server — a missing field
    // (e.g. a WG row stored before `address` was captured) fails closed here
    // rather than erroring every session at the harness provision step.
    const parsed = InlineVpnProxyWireSchema.safeParse(candidate);
    if (parsed.success) return { config: parsed.data };
    // (V3) — NAME THE MISSING FIELDS. A WireGuard row stored before `address`
    // was captured fails here on every launch, and "could not be read" pointed
    // the customer at decryption instead of at the one line their .conf is
    // missing. The wire's field names are mapped to the names they have in the
    // file the customer pasted; an unmapped path falls back to the wire name
    // rather than being dropped.
    const missing = [
      ...new Set(
        parsed.error.issues
          .map((issue) => issue.path[0])
          .filter((seg): seg is string => typeof seg === 'string')
          .map((seg) => WIRE_FIELD_CONFIG_NAME[seg] ?? seg),
      ),
    ];
    return {
      config: null,
      reason: 'config_incomplete',
      detail:
        missing.length > 0
          ? `This VPN’s stored configuration is incomplete (missing: ${missing.join(', ')}). Open the proxy, paste the configuration again and save it.`
          : 'This VPN’s stored configuration is incomplete. Open the proxy, paste the configuration again and save it.',
    };
  }
}
