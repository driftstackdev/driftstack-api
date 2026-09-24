// Profile schemas (V-081). A profile is a persistent customer-defined
// identity slot — sessions are created against profiles to share
// browser state (cookies / localStorage / IndexedDB) across runs.
//
// The control plane stores only the profile metadata; per-profile
// browser state lives in the WebKit driver layer.

import { z } from 'zod';
import { Iso8601Schema, PrefixedId, SelectableArchetypeIdSchema } from './common.js';
import { OpenVpnProxyConfigSchema, WireGuardProxyConfigSchema } from './egress.js';

export const ProfileIdSchema = PrefixedId('prof');

/*
 * V-1489 — what a caller may SEND for a profile id, which is broader than what
 * the API returns.
 *
 * `ProfileIdSchema` above is the canonical emitted form: `prof_<uuid>`,
 * lowercase. The accepted INPUT set has always been wider — `parseProfileId` in
 * the server strips an optional `prof_` and accepts a bare uuid, case-insensitively
 * on the hex, for backward compatibility with the historical bare-uuid contract.
 *
 * That contract lived only in server code, so `CreateSessionRequestSchema` below
 * could not express it and published `profile_id` as an unconstrained string.
 * Declaring it here rather than in the server is what lets the schema — and
 * therefore the document — carry it, without a second copy of the regex.
 *
 * Explicit `[0-9a-fA-F]` rather than an `/i` flag: the flag has no JSON Schema
 * expression, so a pattern published from it would advertise a lowercase-only
 * contract the server does not enforce.
 */
/** The uuid body of a profile id, with or without the `prof_` prefix. */
export const PROFILE_UUID_BODY =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
export const PROFILE_ID_INPUT_RE = new RegExp(`^(?:prof_)?${PROFILE_UUID_BODY}$`);
export const ProfileIdInputSchema = z
  .string()
  .regex(PROFILE_ID_INPUT_RE, { message: 'must be "prof_<uuid>" or a bare uuid' });
export type ProfileId = z.infer<typeof ProfileIdSchema>;

export const ProfileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,118}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/, {
    message:
      'name must start and end with alphanumeric; allowed inner chars: letters, digits, space, underscore, hyphen, dot',
  });

// Profile organization metadata (folders + tags). Backend half of the
// GUI's profiles-meta organization surface — caps mirror the client
// store (apps/gui-client/src/lib/profiles-meta.ts: folder ≤32 chars,
// ≤12 tags ≤24 chars each) so a value the GUI accepts is never rejected
// server-side. Tags are an exact-set replace on update (no merge
// semantics at the API layer); duplicates are rejected rather than
// silently dropped so callers learn about their bug.
export const ProfileFolderSchema = z.string().trim().min(1).max(32);
export const ProfileTagSchema = z.string().trim().min(1).max(24);
export const ProfileTagsSchema = z
  .array(ProfileTagSchema)
  .max(12)
  .refine((tags) => new Set(tags).size === tags.length, {
    message: 'tags must be unique',
  });

// Account-level organization TAXONOMY (2026-06-16, per-account org-sync phase 3)
// — the empty folders (+icons) and tags a customer defines in the GUI rail
// before assigning them to a profile, synced per-account. Generous caps so the
// rail stays usable while bounding payload: ≤200 folders, ≤200 tags.
export const AccountOrganizationFolderSchema = z.object({
  name: ProfileFolderSchema,
  icon: z.string().max(16).optional(),
});
export const AccountOrganizationSchema = z.object({
  folders: z
    .array(AccountOrganizationFolderSchema)
    .max(200)
    .default([])
    .refine((f) => new Set(f.map((x) => x.name)).size === f.length, {
      message: 'folder names must be unique',
    }),
  tags: z
    .array(ProfileTagSchema)
    .max(200)
    .default([])
    .refine((t) => new Set(t).size === t.length, { message: 'tags must be unique' }),
});
export type AccountOrganization = z.infer<typeof AccountOrganizationSchema>;

// ARC A — per-account customer proxies. A customer registers their own
// SOCKS5/HTTP proxies so a session can be dispatched through one. The password
// is WRITE-ONLY: accepted on create/update, wrapped server-side under the
// account TMK, and NEVER returned — responses expose `has_password` instead.
// OVPN/WG arc — socks5/http (transport proxies) + openvpn/wireguard (VPN
// proxies). The discriminator reuses this one column; the VPN config rides the
// optional `openvpn`/`wireguard` blocks below (validated against the scheme by
// the route). host/port stay the (display) endpoint for ALL schemes — the GUI
// fills them from the parsed wg0.conf/.ovpn endpoint (lib/parse-wireguard,
// lib/parse-openvpn).
export const AccountProxySchemeSchema = z.enum(['socks5', 'http', 'openvpn', 'wireguard']);

// AccountProxyInputSchema / AccountProxyUpdateSchema are z.discriminatedUnion's
// on `scheme` — mirroring egress.ts's `ProxyConfigSchema` (discriminated on
// `type`). Previously these were flat z.object()s with `scheme` a plain enum
// and BOTH `openvpn`/`wireguard` always `.optional()` — nothing at the TYPE
// level stopped a caller from constructing `{ scheme: 'wireguard' }` with no
// `wireguard` block; the route (buildVpnSecretAndConfig in account-me.ts)
// caught it at runtime with a 400, but the SDK types gave zero compile-time
// signal. Now `scheme: 'openvpn'` requires the `openvpn` block (and likewise
// for `wireguard`) at the TYPE level — a caller gets a compile error instead
// of a runtime 400.
//
// Every branch is `.strict()`: a stray `openvpn`/`wireguard` block on the
// WRONG scheme (e.g. `{ scheme: 'socks5', wireguard: {...} }`) is rejected at
// the schema layer (previously a route-level runtime check re-inspecting
// `parsed.data` after the fact — same 400 outcome, caught earlier).
//
// `scheme` has NO default here (mirrors `ProxyConfigSchema`'s `type`, which is
// always explicit in every branch) — the pre-V1 ergonomic default (an omitted
// `scheme` on CREATE means socks5) is preserved at the WIRE level by the
// create route, which fills it into the raw body before parsing (see
// account-me.ts) so existing callers who omit `scheme` are unaffected.
const AccountProxyCreateCommonShape = {
  label: z.string().min(1).max(80),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).nullable().default(null),
  // Write-only — wrapped server-side, never echoed back.
  password: z.string().max(1024).nullable().default(null),
};

export const AccountProxyInputSchema = z.discriminatedUnion('scheme', [
  z.object({ scheme: z.literal('socks5'), ...AccountProxyCreateCommonShape }).strict(),
  z.object({ scheme: z.literal('http'), ...AccountProxyCreateCommonShape }).strict(),
  z
    .object({
      scheme: z.literal('openvpn'),
      ...AccountProxyCreateCommonShape,
      // Secret-bearing (config_blob/password) — write-only, wrapped under the
      // account TMK, NEVER echoed back.
      openvpn: OpenVpnProxyConfigSchema,
    })
    .strict(),
  z
    .object({
      scheme: z.literal('wireguard'),
      ...AccountProxyCreateCommonShape,
      // Secret-bearing (private_key) — write-only, wrapped under the account
      // TMK, NEVER echoed back.
      wireguard: WireGuardProxyConfigSchema,
    })
    .strict(),
]);
export type AccountProxyInput = z.infer<typeof AccountProxyInputSchema>;
// Create-body shape (the INPUT side of the schema): the defaulted fields
// (username / password) are optional for callers. SDKs accept this. `scheme`
// itself is required at the type level (see note above re: the wire-level
// default living in the route, not the schema).
export type AccountProxyCreate = z.input<typeof AccountProxyInputSchema>;

// PUT body. `password` omitted = keep existing, `password: null` = clear,
// `password: "..."` = set (no defaults, so the omit-vs-null distinction the
// handler relies on is preserved). Every field besides `scheme` is optional
// (a partial update); `scheme` is either OMITTED ENTIRELY (the last union
// branch below — patch non-VPN fields without touching the scheme/VPN
// config) or present with its matching VPN block required, same as create —
// a caller can't re-point a proxy at `scheme: 'wireguard'` without supplying
// a `wireguard` block, even on update.
const AccountProxyUpdateCommonShape = {
  label: z.string().min(1).max(80).optional(),
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().max(255).nullable().optional(),
  password: z.string().max(1024).nullable().optional(),
};

export const AccountProxyUpdateSchema = z.union([
  z.object({ scheme: z.literal('socks5'), ...AccountProxyUpdateCommonShape }).strict(),
  z.object({ scheme: z.literal('http'), ...AccountProxyUpdateCommonShape }).strict(),
  z
    .object({
      scheme: z.literal('openvpn'),
      ...AccountProxyUpdateCommonShape,
      openvpn: OpenVpnProxyConfigSchema,
    })
    .strict(),
  z
    .object({
      scheme: z.literal('wireguard'),
      ...AccountProxyUpdateCommonShape,
      wireguard: WireGuardProxyConfigSchema,
    })
    .strict(),
  // scheme UNCHANGED — the common partial-update fields only. `scheme` must
  // be the literal `undefined` (i.e. the key is omitted) so a request like
  // `{ scheme: 'wireguard' }` (no matching block) fails closed against THIS
  // branch too, instead of silently falling through and dropping `scheme`.
  z.object({ ...AccountProxyUpdateCommonShape, scheme: z.undefined().optional() }).strict(),
]);
export type AccountProxyUpdate = z.infer<typeof AccountProxyUpdateSchema>;

/*
 * (p) 2026-09-16 — the control plane's passive OS fingerprint of a proxy's own
 * TCP stack, as it crosses the wire. ONE declaration, used by BOTH the /test
 * reply (which has carried exactly this shape since N-2) and the /proxies list
 * (which carries the STORED reading since this item), so a client needs one
 * parser and the two surfaces cannot drift into two dialects of one reading.
 *
 * ⛔ `single_host_vantage` / `web_port_vantage` are REQUIRED, and they are what a
 * client's match / mismatch CLAIM rests on (see the desktop client's
 * `osFingerprintVerdict`). A reading that does not state them must read as FALSE
 * — the cautious value — never as "unstated, so assume it describes the path a
 * website gets". A row measured before those fields existed is normalised to
 * false where it is read, not defaulted to true here.
 */
/**
 * What a proxy's own network stack looks like from the outside — the
 * operating system a remote server would infer from it. The same shape is
 * returned by the proxy /test reply and carried on each saved proxy, so one
 * parser reads both.
 *
 * `single_host_vantage` and `web_port_vantage` say whether the reading was
 * taken over the same path a website's traffic takes. Read a missing or
 * false value as "this reading does not describe that path", never as an
 * assurance that it does.
 *
 * `direct_reading` and `website_like_reading` are the SAME two facts under
 * their customer names — added 2026-09-21 beside the originals, which stay
 * exactly as they are (`apps/gui-client` reads them by these names today).
 * `direct_reading` mirrors `single_host_vantage`: true only when the address
 * dialled, the address that answered, and the address your traffic exits
 * from are one machine, so nothing sat between what was read and what a
 * website would see. `website_like_reading` mirrors `web_port_vantage`: true
 * when the reading was taken the way a real website connection is — a
 * literal address on the standard secure-web port, not a name that could
 * route to shared infrastructure. Optional so an older server, or a reading
 * stored before these existed, keeps parsing — every surface that carries
 * this shape populates them now (`POST …/proxies/:id/test` and the saved
 * proxy list alike — see `customer-safe-proxy-test-vocabulary.ts` in the
 * server).
 */
export const AccountProxyOsFingerprintSchema = z.object({
  os: z.enum(['macos-or-ios', 'windows', 'linux', 'bsd', 'unknown']),
  confidence: z.enum(['high', 'medium', 'low', 'none']),
  reason: z.string(),
  observed_ip: z.string(),
  observed_via: z.enum(['proxy_host', 'exit_ip']),
  single_host_vantage: z.boolean(),
  web_port_vantage: z.boolean(),
  direct_reading: z.boolean().optional(),
  website_like_reading: z.boolean().optional(),
});
export type AccountProxyOsFingerprint = z.infer<typeof AccountProxyOsFingerprintSchema>;

export const AccountProxyMetadataSchema = z.object({
  id: z.string(),
  label: z.string(),
  scheme: AccountProxySchemeSchema,
  host: z.string(),
  port: z.number().int(),
  username: z.string().nullable(),
  has_password: z.boolean(),
  // True when a VPN secret (openvpn config_blob / wireguard private_key) is
  // stored. Write-only like the password — the secret itself is never returned.
  has_secret: z.boolean(),
  // T-6 — the QUIC verdict a real browsing session measured through this proxy:
  // 'h3' (HTTP/3 really carried), 'h2-only' (a session ran but HTTP/3 did not),
  // or null (never measured). null is NOT a default and NOT the same as
  // 'h2-only': the client keeps the QUIC mark inferred (never green) until a
  // real 'h3' lands here.
  quic_measured: z.enum(['h3', 'h2-only']).nullable(),
  // When quic_measured was recorded (ISO 8601), or null when never measured.
  quic_measured_at: z.string().nullable(),
  // What a proxy TEST last measured about QUIC and UDP through this proxy, and
  // when (ISO 8601). Separate from `quic_measured` on purpose: that is what a
  // live browsing session negotiated, these are what a Test's own check found,
  // and the two can honestly disagree.
  // THREE states, and a client must keep them three: `true` = measured working,
  // `false` = measured NOT working (a real negative — do not re-test it on a
  // schedule), `null` = never measured (the only state that means "missing").
  // Age a reading by its `_at` stamp; a value never arrives without one.
  // Optional so a client built against an older server keeps parsing.
  quic_probe: z.boolean().nullable().optional(),
  quic_probe_at: z.string().nullable().optional(),
  udp_probe: z.boolean().nullable().optional(),
  udp_probe_at: z.string().nullable().optional(),
  // (d) B5 — the last exit identity observed THROUGH this proxy, by a live
  // session ('session') or by the fleet-vantage Test ('probe'); latest wins.
  // For an OpenVPN / WireGuard row this is the ONLY source of its location and
  // timezone short of running a test. null = never observed (NOT a default:
  // a client must not paint a location nobody measured). `observed_at` is when
  // it was recorded (ISO 8601), or null. Optional so a client built against an
  // older server keeps parsing.
  exit_observed: z
    .object({
      ip: z.string(),
      country: z.string().nullable(),
      timezone: z.string().nullable(),
      observed_via: z.enum(['session', 'probe']),
      observed_at: z.string().nullable(),
    })
    .nullable()
    .optional(),
  // (i) I7 — when a fleet-vantage test found the tunnel DOWN while
  // `exit_observed` was set (ISO 8601): the stored exit is what was last SEEN,
  // this is when it was CONTRADICTED. A client adopting `exit_observed` must
  // refuse an observation dated at or before it — that is how a Mac that never
  // ran the failing test agrees with the one that did. Cleared (null) by the
  // next exit observation, session or probe. null = never contradicted.
  // Optional so a client built against an older server keeps parsing.
  exit_superseded_at: z.string().nullable().optional(),
  // (p) 2026-09-16 — the LAST OS fingerprint the control plane observed for this
  // proxy's own stack, and WHEN. The reading has been written by the /:id/test
  // route and stored (migration 0119) since N-2, and read back by nothing the
  // customer could see: a proxy checked on one Mac showed no reading on a second
  // one, or after a reinstall — the owner's "we are not saving the OS fingerprint
  // of already checked proxies". This is its route out.
  // null = NEVER MEASURED. Not a default, and not "no OS".
  // `os_fingerprint_at` (ISO 8601) is what a client must AGE it by: this is a
  // stored reading, not something the request measured, and a reading a client
  // cannot date must be treated as stale rather than as current. Optional so a
  // client built against an older server keeps parsing.
  os_fingerprint: AccountProxyOsFingerprintSchema.nullable().optional(),
  os_fingerprint_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AccountProxyMetadata = z.infer<typeof AccountProxyMetadataSchema>;

export const AccountProxyListSchema = z.object({
  data: z.array(AccountProxyMetadataSchema),
});
export type AccountProxyList = z.infer<typeof AccountProxyListSchema>;

// ARC A slice 4b — server-side proxy connection test. A TCP-reachability probe
// to the proxy host:port (the SSRF host-guard runs first); `ok:true` carries the
// handshake latency, `ok:false` a human-readable reason. (SOCKS5 auth-level
// verification is a future enhancement — this confirms the port is reachable.)
export const AccountProxyTestResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    latency_ms: z.number().int().nonnegative(),
    // T-6 — the QUIC verdict a real session measured through this proxy (see
    // AccountProxyMetadata). Carried on every ok:true result so the client can
    // render a confirmed QUIC mark instead of one inferred from UDP support;
    // null when never measured.
    quic_measured: z.enum(['h3', 'h2-only']).nullable().optional(),
    quic_measured_at: z.string().nullable().optional(),
    // The proxy's STORED Test readings for QUIC and UDP (see AccountProxyMetadata),
    // as they stand after this test: a fleet-vantage test that measured a leg has
    // already stored it, so the value and its date are this test's own; a test
    // that measured neither carries what the row held. true / false are readings,
    // null = never measured. Dated by `_at`, never by the reply time.
    quic_probe: z.boolean().nullable().optional(),
    quic_probe_at: z.string().nullable().optional(),
    udp_probe: z.boolean().nullable().optional(),
    udp_probe_at: z.string().nullable().optional(),
    // (o) 2026-09-11 — WHY this result carries no OS fingerprint. Absence alone
    // was indistinguishable across three unlike causes, and the desktop client
    // rendered ALL of them as "press Test again" — advice that can never produce
    // a value on the first two:
    //   `not_available_for_vpn`  an openvpn/wireguard proxy has no single
    //                            address of its own to read a stack from. No
    //                            retry can help.
    //   `not_captured`           the reading was attempted and produced
    //                            nothing this time. Retrying may help.
    //   `not_offered_here`       this deployment does not take this reading
    //                            at all. No retry can help.
    // Absent on a result that DID observe one, and absent from an older server —
    // optional + nullable so an older client keeps parsing and a newer client
    // reads absence as "no cause reported", never as a cause.
    //
    // ⛔ RENAMED 2026-09-21 from `vpn_tunnel` / `not_observed` / `observer_off` —
    // the old names described OUR mechanism (an open-socket "observer"); the new
    // ones describe what the customer gets. See
    // `customer-safe-proxy-test-vocabulary.ts` for the map and the parity guard
    // that holds every documented copy to it
    // (`tests/unit/a-public-proxy-test-result-cannot-ship-undocumented.test.ts`).
    os_fingerprint_unavailable: z
      .enum(['not_available_for_vpn', 'not_captured', 'not_offered_here'])
      .nullable()
      .optional(),
    // (V-219) The fingerprint itself, which the route has sent since N-2 and this
    // schema never declared — zod strips unknown keys, so a consumer parsing the
    // reply with it lost the whole object, vantage flags included. Optional: a
    // result that observed nothing, and holds no stored reading either, omits it
    // and says why above. (p) — when this test observed nothing but the ROW holds
    // a reading, that stored one rides here WITH `os_fingerprint_at` and the cause
    // stays beside it; a fresh observation always wins and is dated by the reply.
    os_fingerprint: AccountProxyOsFingerprintSchema.optional(),
    // (p) 2026-09-16 — WHEN the `os_fingerprint` above was measured (ISO 8601),
    // and therefore WHICH reading it is:
    //   absent  — THIS test measured it; the reply's own time dates it (today's
    //             shape, unchanged for every result that observed a SYN).
    //   present — a STORED reading from the row, attached because this test
    //             observed none. It is as old as this says, and a client must age
    //             it by this stamp with the same rule it ages its own readings.
    // A reply that carries a stored reading keeps `os_fingerprint_unavailable`
    // beside it: the cause explains why THIS test produced nothing, and the two
    // together are how a client tells a stored reading from a fresh one. A row
    // whose stored reading cannot be dated is not attached at all — an undatable
    // reading must never arrive looking freshly measured.
    os_fingerprint_at: z.string().nullable().optional(),
    // VPN exit parity — the exit identity the measuring fleet node observed
    // (vantage=fleet only; the only vantage that can see through an OpenVPN /
    // WireGuard tunnel). Present exactly when the node saw an exit IP; the geo
    // fields are null when the node could not resolve them. Absent on a
    // control-plane result and on a probe that reached no exit.
    exit_observed: z
      .object({
        ip: z.string(),
        country: z.string().nullable(),
        timezone: z.string().nullable(),
        region: z.string().nullable(),
        city: z.string().nullable(),
      })
      .optional(),
    // 2026-09-21 — where this result was measured. Present only on a
    // `?check=full` result — absent on the default `?check=quick`, which is
    // always `driftstack` and needs no field to say so. `phone` — a real
    // phone session took the measurement, the same machine `?check=full`
    // dispatches to. `driftstack` — Driftstack itself measured it: the same
    // path `?check=quick` always takes, and the honest fallback when a
    // `?check=full` request could not reach a phone in time.
    //
    // The wire also still sends the original field this mirrors
    // (`measured_from`, values unchanged) for an integration that already
    // reads it. Undocumented from here on and deliberately not part of this
    // type — read `measured_by` instead.
    measured_by: z.enum(['phone', 'driftstack']).optional(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.string(),
    // 2026-09-21 — see `measured_by` on the `ok:true` member above; same
    // field, same rule, present under the same condition.
    measured_by: z.enum(['phone', 'driftstack']).optional(),
    // (d) 2026-09-10 — present when NOTHING RAN, so `ok:false` is not a verdict
    // about the proxy: `live_session` = a fleet-vantage test of a VPN row was
    // REFUSED because a live session holds the tunnel (a second tunnel on a
    // one-connection VPN account drops the session); `config_unresolvable` =
    // the stored row could not be turned into anything runnable (see
    // `ProxyUnresolvableReason` server-side: an unreadable secret, a refused
    // config directive, an unsafe tunnel target, a WireGuard row with no
    // `Address`, a downgraded tier…) — the SAME word the "Why a launch is
    // refused" table already publishes for the identical fact; `check_unavailable`
    // = the full check could not be completed on our side right now (no fleet
    // machine was free, the dispatch timed out, or this deployment does not run
    // full checks — `reason` says which; retrying may help). A client branches
    // on THIS, never on the `reason` prose.
    //
    // ⛔ RENAMED 2026-09-21 — `node_busy`, `node_error` and `no_node` merged
    // into `check_unavailable` (a customer can do exactly one thing about any
    // of the three: try again shortly, or contact support if it persists);
    // `unresolvable` renamed to `config_unresolvable` to match the existing
    // launch-refusal vocabulary. See `customer-safe-proxy-test-vocabulary.ts`
    // and its parity guard.
    not_run: z.enum(['live_session', 'config_unresolvable', 'check_unavailable']).optional(),
    // (d) 2026-09-10 — beside `not_run: 'live_session'` / `'no_node'`: the STORED
    // exit a session observed, surfaced so the client can still show where the
    // tunnel exits. `region`/`city` are null (the stored observation carries neither).
    // (h) `observed_at` dates the OBSERVATION (ISO 8601, null when it predates the
    // column) — a stored exit is not something this reply measured, so a client
    // must date it by this, never by the reply time. Optional so a client built
    // against a newer schema keeps parsing an older server.
    exit_observed: z
      .object({
        ip: z.string(),
        country: z.string().nullable(),
        timezone: z.string().nullable(),
        region: z.string().nullable(),
        city: z.string().nullable(),
        observed_at: z.string().nullable().optional(),
      })
      .optional(),
  }),
]);
export type AccountProxyTestResult = z.infer<typeof AccountProxyTestResultSchema>;

/**
 * A profile's recent navigation, taken from the AI session transcripts on
 * your account.
 *
 * ⛔ This is ACCOUNT ACTIVITY, not the profile's browsing history. A
 * profile's "Clear history" clears the tabs held on the device and nothing
 * else, so these rows are still here afterwards. If you need them gone, use
 * the account data controls rather than clearing the profile.
 */
export const ProfileActivityEntrySchema = z.object({
  /** ISO-8601 time the navigation was planned. */
  at: z.string(),
  /** The destination URL as the agent planned it — path and query included. */
  url: z.string(),
  /** The agent session the navigation belonged to. */
  agent_session_id: z.string(),
});
export type ProfileActivityEntry = z.infer<typeof ProfileActivityEntrySchema>;

export const ProfileActivityResponseSchema = z.object({
  /** Most recent first. Bounded — see `truncated`. */
  data: z.array(ProfileActivityEntrySchema),
  /** How many of the profile's most recent sessions were read to build `data`. */
  sessions_scanned: z.number().int().nonnegative(),
  /**
   * True when either bound was hit: more sessions exist than were scanned, or
   * more navigations than were returned. Older activity is then not shown.
   */
  truncated: z.boolean(),
  /**
   * True when the pages were withheld from you: they come from AI session
   * records, which need the `read:sessions` scope and, in a teammate's
   * workspace, the admin role. `data` is then empty; `sessions_scanned` and
   * `truncated` still describe the profile's activity. Always sent; optional
   * here only so a response from an older server still parses.
   */
  pages_withheld: z.boolean().optional(),
});
export type ProfileActivityResponse = z.infer<typeof ProfileActivityResponseSchema>;

export const ProfileSchema = z.object({
  id: ProfileIdSchema,
  name: z.string(),
  archetype: z.string(),
  description: z.string().nullable(),
  folder: z.string().nullable(),
  tags: z.array(z.string()),
  /**
   * Per-account UI metadata (2026-06-16) — short emoji icon (null = monogram)
   * and a short inline note, synced server-side so they follow the account
   * across machines (was local-only).
   */
  icon: z.string().nullable(),
  note: z.string().nullable(),
  last_used_at: Iso8601Schema.nullable(),
  /**
   * How many bytes this profile's last saved state took, encrypted. `null`
   * until the profile has been saved once. Add these up across your profiles
   * to see what your account is storing; the allowance itself is
   * `TIER_STORAGE_BYTES_CAP`.
   */
  size_bytes: z.number().int().nonnegative().nullable(),
  /** When this profile's state was last saved back. `null` until first saved. */
  last_saved_at: Iso8601Schema.nullable(),
  created_at: Iso8601Schema,
  updated_at: Iso8601Schema,
  /**
   * L4b recycle bin — null for a live profile; the trash timestamp for a
   * soft-deleted one. Only GET /v1/profiles/trash returns rows with this set.
   */
  deleted_at: Iso8601Schema.nullable(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const CreateProfileRequestSchema = z.object({
  name: ProfileNameSchema,
  /**
   * Archetype slug — resolved server-side PER TIER if omitted: `LOCKED_ARCHETYPE_ID`
   * (`iphone17_ios18_7_safari26_4`) on tiers with every device, the newest entitled
   * archetype (an iPhone 13) on the free tier — see `defaultArchetypeIdForTier`.
   * Customers may select any older archetype the live catalog still marks
   * available for behavioural-stability reasons.
   */
  archetype: SelectableArchetypeIdSchema.optional(),
  description: z.string().max(2048).optional(),
  folder: ProfileFolderSchema.optional(),
  tags: ProfileTagsSchema.optional(),
  /** UI metadata — short emoji icon + inline note (synced per-account). */
  icon: z.string().max(16).optional(),
  note: z.string().max(280).optional(),
});
export type CreateProfileRequest = z.infer<typeof CreateProfileRequestSchema>;

export const UpdateProfileRequestSchema = z.object({
  name: ProfileNameSchema.optional(),
  description: z.string().max(2048).nullable().optional(),
  /** `null` clears the folder (back to unfiled). */
  folder: ProfileFolderSchema.nullable().optional(),
  /** Exact-set replace; `[]` clears all tags. */
  tags: ProfileTagsSchema.optional(),
  /** UI metadata — `null`/'' clears it. */
  icon: z.string().max(16).nullable().optional(),
  note: z.string().max(280).nullable().optional(),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

// V-313 — POST /v1/profiles/:id/clone request body. Both fields
// optional: when `name` is omitted the server auto-derives a non-
// conflicting `${source} (copy)` / `(copy 2)` / ... name.
export const CloneProfileRequestSchema = z.object({
  name: ProfileNameSchema.optional(),
});
export type CloneProfileRequest = z.infer<typeof CloneProfileRequestSchema>;

// ───────────────────────────────────────────────────────────────────────────
// V-312 — profile snapshots (immutable point-in-time copies)
// ───────────────────────────────────────────────────────────────────────────

export const ProfileSnapshotSchema = z.object({
  id: z.string(),
  parent_profile_id: z.string().nullable(),
  label: z.string(),
  description: z.string().nullable(),
  parent_archetype: z.string(),
  parent_name: z.string(),
  captured_at: Iso8601Schema,
  created_at: Iso8601Schema,
});
export type ProfileSnapshot = z.infer<typeof ProfileSnapshotSchema>;

export const CaptureSnapshotRequestSchema = z.object({
  label: z.string().trim().min(1).max(120),
  description: z.string().max(2048).optional(),
});
export type CaptureSnapshotRequest = z.infer<typeof CaptureSnapshotRequestSchema>;

export const ListSnapshotsResponseSchema = z.object({
  data: z.array(ProfileSnapshotSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});
export type ListSnapshotsResponse = z.infer<typeof ListSnapshotsResponseSchema>;

export const RestoreSnapshotRequestSchema = z.object({
  name: ProfileNameSchema,
});
export type RestoreSnapshotRequest = z.infer<typeof RestoreSnapshotRequestSchema>;

export const ListProfilesResponseSchema = z.object({
  data: z.array(ProfileSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});
export type ListProfilesResponse = z.infer<typeof ListProfilesResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// V-480 — profile import / export. Metadata-only round-trip; per-profile
// browser state (cookies / localStorage / IndexedDB) lives driver-side and
// is out of scope for v1. The envelope is versioned so a future v2 that
// extends to driver state stays backward-compatible: callers reject
// envelopes whose `version` they don't understand.
// ───────────────────────────────────────────────────────────────────────────

export const PROFILE_EXPORT_ENVELOPE_VERSION = 1 as const;

// Import re-validates these with the SAME bounds the create path enforces
// (ProfileNameSchema, selectable archetype, description <=2048) — a hand-crafted
// import envelope must not store name/archetype/description that POST /v1/profiles
// would reject. Exports of retained legacy profiles remain readable, but import
// deliberately refuses them after their pinned id leaves the selectable catalog.
const ProfileExportPayloadSchema = z.object({
  name: ProfileNameSchema,
  archetype: SelectableArchetypeIdSchema,
  description: z.string().max(2048).nullable(),
});
export type ProfileExportPayload = z.infer<typeof ProfileExportPayloadSchema>;

export const ProfileExportEnvelopeSchema = z.object({
  version: z.literal(PROFILE_EXPORT_ENVELOPE_VERSION),
  exported_at: Iso8601Schema,
  /**
   * Source profile id at export time. Informational only — the import
   * path always mints a fresh id; this lets customers trace
   * "where did this exported file come from" when reviewing the JSON.
   */
  source_profile_id: ProfileIdSchema,
  /**
   * Source account id at export time. Same informational role as
   * `source_profile_id`. Importing into a different account is
   * permitted and common (transfer between teammate accounts via the
   * file).
   */
  source_account_id: z.string(),
  profile: ProfileExportPayloadSchema,
});
export type ProfileExportEnvelope = z.infer<typeof ProfileExportEnvelopeSchema>;

export const ProfileImportRequestSchema = z.object({
  envelope: ProfileExportEnvelopeSchema,
  /**
   * Optional override — let the customer rename on import without
   * editing the file. Skipped when omitted; the file's `profile.name`
   * is used.
   */
  name_override: ProfileNameSchema.optional(),
});
export type ProfileImportRequest = z.infer<typeof ProfileImportRequestSchema>;
