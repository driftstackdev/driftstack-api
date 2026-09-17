// ARC A — account_proxies repo (storage layer for per-account customer proxies).
//
// Thin DB layer, mirroring DrizzleProfilesRepo: it stores/returns
// `wrappedPassword`/`wrappedSecret` as opaque versioned envelopes. Every
// read/mutation is OWNER-SCOPED (filtered by
// accountId) so one account can never read/update/delete another's proxy — the
// same cross-account isolation the profile DEK relies on.

import { verifyBootEncryptionKey } from '../lib/boot-key-verification.js';
import { and, asc, count, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from './client.js';
import { accountProxies } from './schema.js';
import {
  ACCOUNT_PROXY_SECRET_V2_PREFIX,
  convertAccountProxySecretToV2,
  readAccountProxySecret,
  type AccountProxySecretSlot,
} from '../lib/account-proxy-secret-encryption.js';

const MAX_PROXY_SECRET_MIGRATION_BATCH = 500;

/** Full row incl. the wrapped password (opaque). Internal — the API never
 *  returns `wrappedPassword`; the service maps to a metadata view. */
export interface AccountProxyRow {
  id: string;
  accountId: string;
  label: string;
  scheme: string;
  host: string;
  port: number;
  username: string | null;
  /** Record/slot-bound v2 envelope, or null. Opaque at the repository boundary. */
  wrappedPassword: string | null;
  /** OVPN/WG record/slot-bound secret (config_blob / private_key), or null. */
  wrappedSecret: string | null;
  /** OVPN/WG: non-secret structured fields. `{}` for socks5/http rows. */
  config: Record<string, unknown>;
  /**
   * T-6 (migration 0116) — the last QUIC verdict a real browsing session
   * measured through this proxy: 'h3' (HTTP/3 carried), 'h2-only' (session ran
   * but HTTP/3 did not), or null (never measured). Null is distinct from
   * 'h2-only': the client keeps the QUIC mark inferred until a real 'h3' lands.
   */
  quicMeasured: string | null;
  /** When {@link quicMeasured} was recorded, or null when never measured. */
  quicMeasuredAt: Date | null;
  /**
   * N-2 (migration 0119) — the last passive TCP/IP OS fingerprint the control
   * plane observed for this proxy's own stack: the full structured measurement,
   * or null (never measured). Null is NOT "no OS" — it is NOT OBSERVED, so a
   * reader must render "measuring…", never a placeholder OS.
   */
  osFingerprint: {
    os: string;
    confidence: string;
    reason: string;
    observed_ip: string;
    observed_via: 'proxy_host' | 'exit_ip';
    /**
     * (V-219) The two vantage flags the /:id/test route has written into this
     * jsonb since they existed — the column takes the whole measurement object
     * — while this type listed neither, so a reader could not see the fields a
     * match / mismatch CLAIM rests on. OPTIONAL because a reading persisted
     * before V-219 has neither, and absent must be read as FALSE (the cautious
     * value), never as "unstated, so assume it describes the path a website
     * gets". Declared, not introduced: no migration — jsonb already holds them.
     */
    single_host_vantage?: boolean;
    web_port_vantage?: boolean;
  } | null;
  /** When {@link osFingerprint} was recorded, or null when never measured. */
  osFingerprintAt: Date | null;
  /** VPN parity (migration 0120) — the last exit identity a live session observed through
   *  this proxy (the ONLY source of a VPN proxy's location/timezone), or null when never
   *  observed. Written by the capabilityReport relay ('session') and by the
   *  fleet-vantage proxy Test ('probe'), latest wins. */
  exitObserved: {
    ip: string;
    country: string | null;
    timezone: string | null;
    observed_via: 'session' | 'probe';
  } | null;
  /** When {@link exitObserved} was recorded, or null when never observed. */
  exitObservedAt: Date | null;
  /** (i) I7 (migration 0122) — when a fleet verdict found the tunnel DOWN while
   *  {@link exitObserved} was set (the stored exit was contradicted), or null when
   *  never contradicted / cleared by a later exit observation. The exit is kept;
   *  this dates the contradiction so a list consumer can refuse to adopt an
   *  observation dated at or before it. */
  exitSupersededAt: Date | null;
  /**
   * (migration 0124) — whether QUIC relayed through this proxy when a Test last
   * MEASURED it, or null when no Test ever has. ⛔ Null is not false: a stored
   * `false` is a genuine negative, and null is "never measured" — the distinction
   * is the reason the column exists.
   *
   * ⛔ Not {@link quicMeasured}. That is what a LIVE SESSION negotiated ('h3' |
   * 'h2-only'); this is what a Test's relay check found. They can honestly
   * disagree, so neither is ever written from the other.
   */
  quicProbe: boolean | null;
  /** When {@link quicProbe} was measured, or null when never measured. */
  quicProbeAt: Date | null;
  /** (migration 0124) — whether the proxy carried UDP when a Test last MEASURED
   *  it, or null when no Test ever has. Same null-is-not-false rule as
   *  {@link quicProbe}; a VPN row's asserted literal is never stored here. */
  udpProbe: boolean | null;
  /** When {@link udpProbe} was measured, or null when never measured. */
  udpProbeAt: Date | null;
  /**
   * ITEM 4 (migration 0123) — when the BACKGROUND freshness refresher last
   * ATTEMPTED this row, success or failure, or null when it never has (= due
   * now). Both the cooldown clock and the claim: {@link
   * AccountProxiesRepo.claimDueForFreshnessRefresh} stamps it in the same
   * statement that locks the row.
   *
   * ⛔ Not `updatedAt`. A customer relabel bumps that, and an unrelated edit
   * must never schedule a dial through their proxy.
   */
  freshnessAttemptedAt: Date | null;
  /**
   * ITEM 4 (migration 0123) — consecutive BACKGROUND probe failures; 0 after any
   * success. Nothing customer-facing reads it. Its only purpose is to tell one
   * transient miss apart from a SUSTAINED run, so a single failed background
   * probe can leave every customer-visible field untouched.
   */
  freshnessConsecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewAccountProxyRow {
  /** Stable UUID allocated before credential encryption. */
  id: string;
  label: string;
  scheme: string;
  host: string;
  port: number;
  username: string | null;
  wrappedPassword: string | null;
  /** Optional — VPN secret payload; defaults to null (socks5/http rows). */
  wrappedSecret?: string | null;
  /** Optional — non-secret VPN fields; defaults to `{}` (socks5/http rows). */
  config?: Record<string, unknown>;
}

export interface AccountProxyRowUpdates {
  label?: string;
  scheme?: string;
  host?: string;
  port?: number;
  username?: string | null;
  wrappedPassword?: string | null;
  wrappedSecret?: string | null;
  config?: Record<string, unknown>;
  /** T-6 — the measured QUIC verdict ('h3' | 'h2-only'), back-filled by the
   *  live capabilityReport relay. */
  quicMeasured?: string | null;
  /** T-6 — timestamp the QUIC verdict was measured. */
  quicMeasuredAt?: Date | null;
  /** N-2 — the passive OS fingerprint the /:id/test route observed, persisted
   *  ONLY when a SYN was observed (a miss writes nothing). */
  osFingerprint?: {
    os: string;
    confidence: string;
    reason: string;
    observed_ip: string;
    observed_via: 'proxy_host' | 'exit_ip';
    /** (V-219) Written since the flags existed; see {@link AccountProxyRow}. */
    single_host_vantage?: boolean;
    web_port_vantage?: boolean;
  } | null;
  /** N-2 — timestamp the OS fingerprint was observed. */
  osFingerprintAt?: Date | null;
  /** VPN parity — the observed exit identity (relay back-fill 'session' or the
   *  fleet-vantage Test 'probe'; latest wins). */
  exitObserved?: {
    ip: string;
    country: string | null;
    timezone: string | null;
    observed_via: 'session' | 'probe';
  } | null;
  exitObservedAt?: Date | null;
  /** (i) I7 — set by the fleet-vantage Test when its verdict contradicts the
   *  stored exit; cleared (null) by every exit write (relay or probe). */
  exitSupersededAt?: Date | null;
  /** (0124) — the QUIC relay reading a fleet-vantage Test measured, true OR
   *  false. Written ONLY for a measured leg (a skipped leg writes nothing); null
   *  only from an edit that repoints the row. Each reading moves with its date. */
  quicProbe?: boolean | null;
  quicProbeAt?: Date | null;
  /** (0124) — the UDP reading a fleet-vantage Test measured; same rules. */
  udpProbe?: boolean | null;
  udpProbeAt?: Date | null;
  /** ITEM 4 — reset to 0 by the background refresher on a successful probe. The
   *  INCREMENT is not expressible here (it must read-modify-write atomically);
   *  see {@link AccountProxiesRepo.recordFreshnessFailure}. */
  freshnessConsecutiveFailures?: number;
  /** ITEM 2 — nulled by an edit that repoints the row, which makes it DUE on the
   *  next sweep tick. A repointed proxy must not inherit the cooldown (and the
   *  failure backoff, up to 24h) earned by the address it no longer has, or the
   *  columns the edit just cleared stay blank for a day. Ordinarily written only
   *  by {@link AccountProxiesRepo.claimDueForFreshnessRefresh}, inside the claim. */
  freshnessAttemptedAt?: Date | null;
}

/** (0124) — the four Test-reading keys of {@link AccountProxyRowUpdates}, which
 *  is the shape `probeCapabilityUpdates` already returns: the caller hands its
 *  answer over unchanged rather than re-spelling which legs were measured. */
export type ProbeReadingsToStore = Pick<
  AccountProxyRowUpdates,
  'quicProbe' | 'quicProbeAt' | 'udpProbe' | 'udpProbeAt'
>;

/** One leg of {@link ProbeReadingsToStore}: the measured value and its date, or
 *  null when the leg was not measured. Throws on half a leg — a value that
 *  cannot be dated cannot be aged, and a date with no value is not a reading;
 *  quietly skipping either would store less than the caller believes it stored.
 *  A `null` VALUE is refused for the same reason: only an edit that repoints
 *  the row clears these columns, and it does that through `update`. */
function probeLegToStore(
  leg: 'quic' | 'udp',
  value: boolean | null | undefined,
  at: Date | null | undefined,
): { value: boolean; atIso: string } | null {
  if (value === undefined && at === undefined) return null;
  if (typeof value !== 'boolean' || !(at instanceof Date)) {
    throw new Error(`A ${leg} probe reading must be stored as a boolean with its date.`);
  }
  return { value, atIso: at.toISOString() };
}

export interface AccountProxiesRepo {
  list(accountId: string): Promise<AccountProxyRow[]>;
  findById(args: { id: string; accountId: string }): Promise<AccountProxyRow | null>;
  create(accountId: string, input: NewAccountProxyRow): Promise<AccountProxyRow>;
  createIfUnderLimit(
    accountId: string,
    input: NewAccountProxyRow,
    limit: number,
  ): Promise<AccountProxyRow | null>;
  update(args: {
    id: string;
    accountId: string;
    expectedScheme?: string;
    updates: AccountProxyRowUpdates;
  }): Promise<AccountProxyRow | null>;
  /**
   * (0124) — store a Test's QUIC / UDP readings, but ONLY onto a row that still
   * carries the identity they were measured through. Returns the row as it stands
   * AFTER the statement, or null when nothing matched: the row is gone, belongs to
   * another account, or was repointed while the test ran.
   *
   * ⛔ WHY THIS IS NOT `findById` + `update`. A Test reads the row, spends seconds
   * on the wire, then writes. Checking the identity in one statement and writing
   * in the next leaves a window between them, and a PUT landing in it moves the
   * row AND nulls these columns — after which the generic `update` (which matches
   * on id + account alone) puts the old endpoint's reading onto the new one. The
   * worst case is a stored `false`: it tells every consumer not to look again,
   * about a machine nobody has measured. So the identity is part of the WHERE, and
   * the database decides the race rather than the caller.
   *
   * `probedIdentity` is the same six columns
   * `readingWasTakenThroughCurrentIdentity` (services/proxy-reading-persist.ts)
   * compares — a fence two writers spell differently is a fence one of them
   * lacks. `username`, `wrappedPassword` and `wrappedSecret` are nullable, so they
   * are matched null-safely: a plain `=` against NULL is never true and would
   * decline every write onto a proxy that has no credential.
   *
   * A leg is written only with its date, and only when the row does not already
   * hold a reading of that leg measured LATER: two Tests of one proxy can finish
   * out of order, and the row must end on the newer MEASUREMENT, not the later
   * write. A leg absent from `readings` is left exactly as it was.
   */
  storeProbeReadingsIfSameIdentity(args: {
    id: string;
    accountId: string;
    probedIdentity: Pick<
      AccountProxyRow,
      'scheme' | 'host' | 'port' | 'username' | 'wrappedPassword' | 'wrappedSecret'
    >;
    readings: ProbeReadingsToStore;
  }): Promise<AccountProxyRow | null>;
  /** Returns true if a row was removed; false if no owned row matched. */
  delete(args: { id: string; accountId: string }): Promise<boolean>;
  /**
   * ITEM 4 — CLAIM the next proxy the background refresher should re-probe, or
   * null when nothing is due. THE ONLY CROSS-ACCOUNT READ IN THIS REPO: every
   * other method is owner-scoped because it serves a request made by the owner,
   * and this one serves a sweep that has no owner. Everything it hands back is
   * still written back through the owner-scoped methods (the caller passes the
   * row's own `accountId`), so no cross-account WRITE becomes possible.
   *
   * Claim, not read: the row's `freshness_attempted_at` is stamped with `now`
   * inside the same statement that selects it `FOR UPDATE SKIP LOCKED`. Two
   * consequences, and both are the point:
   *   * a second worker ticking at the same moment skips the locked row and,
   *     once this one commits, no longer sees it as due — so one proxy is
   *     probed once, never twice, without any lock outside the database;
   *   * a tick that dies mid-probe has already recorded the attempt, so a
   *     failing proxy is not re-dialled on the very next tick.
   *
   * Due = (never attempted, or attempted longer ago than
   * `refreshIntervalMs * min(consecutiveFailures + 1, maxBackoffSteps)` — a
   * linear backoff so a proxy that is simply switched off is dialled once per
   * capped window instead of every interval forever) AND its stored exit is
   * older than `refreshIntervalMs`.
   *
   * That second condition is the one that keeps the sweep off a proxy somebody
   * else is already keeping current: a live session's relay and the customer's
   * own Test both write `exit_observed_at`, and a reading taken an hour ago by
   * either of them is exactly as fresh as one this sweep would take now. The
   * point is a CURRENT reading, not a reading of our own.
   *
   * ⚠️ The EXIT is the freshness signal and the OS fingerprint deliberately is
   * not, which means a row whose exit a live session keeps refreshing can carry
   * an older fingerprint. That is the honest trade, not an oversight: the exit
   * is what moves (providers rotate them), a proxy's own TCP stack is not, and
   * `os_fingerprint_at` is written ONLY by a probe — so using it as the signal
   * would leave every row permanently due and this clause would do nothing at
   * all. Every reading is stored with its own date, so a consumer can always
   * say how old the one it is reading is.
   *
   * The claim also RESETS `freshness_consecutive_failures` when the stored exit
   * was observed since our previous attempt — see the CASE in the statement. The
   * streak the condemn threshold counts must be failures that nothing
   * contradicted, not merely failures with no success OF OURS in between.
   *
   * EXCLUDED, in SQL rather than by the caller (same discipline as
   * `listOpenByAccount`'s closed-row filter — a caller that trusts the contract
   * cannot forget the check):
   *   * proxies belonging to an account that is not `active`. Deletion is SOFT
   *     and the retention purge nulls the secrets rather than the rows, so a
   *     deleted customer's proxies would otherwise stay claimable forever — and
   *     credential-less, so the dial would be unauthenticated. See the join.
   *   * VPN schemes. Bringing an OpenVPN/WireGuard tunnel up needs a fleet node;
   *     the control plane cannot do it, so a VPN row is not refreshable here at
   *     all. The predicate is a literal `IN ('socks5','http')` so it matches
   *     migration 0123's partial index (a parameterised list would not).
   *   * a proxy a LIVE agent session is using. Dialling it would add a
   *     connection to the customer's proxy while their session is browsing
   *     through it, and it is unnecessary: a live session's capabilityReport
   *     relay is already writing `exit_observed` for that row, which is fresher
   *     than anything this sweep could measure.
   */
  claimDueForFreshnessRefresh(args: {
    now: Date;
    refreshIntervalMs: number;
    maxBackoffSteps: number;
  }): Promise<AccountProxyRow | null>;
  /**
   * ITEM 4 — record that a background probe FAILED, atomically.
   *
   * Increments `freshness_consecutive_failures` and, ONLY when that new count
   * reaches `condemnAfterFailures` and the row still carries an uncontradicted
   * stored exit, dates the contradiction in `exit_superseded_at`. Below the
   * threshold NOTHING customer-visible moves — not the exit, not the
   * fingerprint, not even `updated_at` (this is raw SQL and deliberately does
   * not touch it), which is the webhooks precedent: one transient failure is
   * not a verdict about the customer's proxy.
   *
   * Returns the post-write counter and stamp, or null when no owned row matched.
   */
  recordFreshnessFailure(args: {
    id: string;
    accountId: string;
    at: Date;
    condemnAfterFailures: number;
    /**
     * The instant OUR dial began. The contradiction stamp is NOT written when the
     * row already holds an exit observed after it — a customer pressing Test
     * mid-sweep succeeds at t+5s while our probe fails at t+30s, and stamping
     * then would condemn their fresh reading with our older evidence. It is the
     * condemn-side twin of `yieldToReadingsAfter` on the success path.
     */
    probeStartedAt: Date;
  }): Promise<{ consecutiveFailures: number; exitSupersededAt: Date | null } | null>;
  migrateSecretEnvelopes(
    masterKey: Buffer,
    limit?: number,
  ): Promise<{ scanned: number; converted: number; remaining: number }>;
}

function wrappersAreV2(): SQL {
  return sql`(
    (${accountProxies.wrappedPassword} IS NULL OR ${accountProxies.wrappedPassword} LIKE ${`${ACCOUNT_PROXY_SECRET_V2_PREFIX}%`})
    AND (${accountProxies.wrappedSecret} IS NULL OR ${accountProxies.wrappedSecret} LIKE ${`${ACCOUNT_PROXY_SECRET_V2_PREFIX}%`})
    AND (${accountProxies.wrappedSecret} IS NULL OR ${accountProxies.scheme} IN ('openvpn', 'wireguard'))
  )`;
}

function wrappersAreNotV2(): SQL {
  return sql`NOT (${wrappersAreV2()})`;
}

function vpnSecretSlot(scheme: string): AccountProxySecretSlot {
  if (scheme === 'openvpn') return 'openvpn-config';
  if (scheme === 'wireguard') return 'wireguard-private-key';
  throw new Error(`Account proxy scheme ${scheme} cannot carry wrapped_secret.`);
}

function rowWrappersAreV2(row: {
  scheme: string;
  wrappedPassword: string | null;
  wrappedSecret: string | null;
}): boolean {
  return (
    (row.wrappedPassword === null ||
      row.wrappedPassword.startsWith(ACCOUNT_PROXY_SECRET_V2_PREFIX)) &&
    (row.wrappedSecret === null || row.wrappedSecret.startsWith(ACCOUNT_PROXY_SECRET_V2_PREFIX)) &&
    (row.wrappedSecret === null || row.scheme === 'openvpn' || row.scheme === 'wireguard')
  );
}

function validateLimit(name: string, limit: number, maximum?: number): void {
  if (!Number.isInteger(limit) || limit < 1 || (maximum !== undefined && limit > maximum)) {
    throw new Error(
      maximum === undefined
        ? `${name} must be a positive integer.`
        : `${name} must be an integer from 1 to ${maximum.toString()}.`,
    );
  }
}

function toRow(r: typeof accountProxies.$inferSelect): AccountProxyRow {
  return {
    id: r.id,
    accountId: r.accountId,
    label: r.label,
    scheme: r.scheme,
    host: r.host,
    port: r.port,
    username: r.username,
    wrappedPassword: r.wrappedPassword,
    wrappedSecret: r.wrappedSecret,
    config: r.config,
    quicMeasured: r.quicMeasured,
    quicMeasuredAt: r.quicMeasuredAt,
    osFingerprint: r.osFingerprint,
    osFingerprintAt: r.osFingerprintAt,
    exitObserved: r.exitObserved,
    exitObservedAt: r.exitObservedAt,
    exitSupersededAt: r.exitSupersededAt,
    quicProbe: r.quicProbe,
    quicProbeAt: r.quicProbeAt,
    udpProbe: r.udpProbe,
    udpProbeAt: r.udpProbeAt,
    freshnessAttemptedAt: r.freshnessAttemptedAt,
    freshnessConsecutiveFailures: r.freshnessConsecutiveFailures,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * The same row out of a RAW `db.execute()` result.
 *
 * ⛔ Not interchangeable with {@link toRow}. Raw rows arrive snake_cased and
 * BYPASS Drizzle's column-schema decoders, so postgres-js hands back timestamptz
 * as an ISO STRING in the production driver configuration (the exact trap
 * `scheduled-jobs-repo`'s `parseClaimedRunAt` documents). A `Date` typed field
 * holding a string type-checks fine and only fails at the first `.getTime()`,
 * which is why the conversion is centralised here rather than at the call site.
 */
function parseRawTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (parsed === null || !Number.isFinite(parsed.getTime())) {
    throw new TypeError('account_proxies returned an invalid timestamp');
  }
  return parsed;
}

function requireRawTimestamp(value: unknown, column: string): Date {
  const parsed = parseRawTimestamp(value);
  if (parsed === null) {
    throw new TypeError(`account_proxies.${column} returned null for a NOT NULL column`);
  }
  return parsed;
}

function toRowFromRaw(r: Record<string, unknown>): AccountProxyRow {
  return {
    id: r.id as string,
    accountId: r.account_id as string,
    label: r.label as string,
    scheme: r.scheme as string,
    host: r.host as string,
    port: Number(r.port),
    username: (r.username as string | null) ?? null,
    wrappedPassword: (r.wrapped_password as string | null) ?? null,
    wrappedSecret: (r.wrapped_secret as string | null) ?? null,
    config: (r.config as Record<string, unknown> | null) ?? {},
    quicMeasured: (r.quic_measured as string | null) ?? null,
    quicMeasuredAt: parseRawTimestamp(r.quic_measured_at),
    osFingerprint: (r.os_fingerprint as AccountProxyRow['osFingerprint']) ?? null,
    osFingerprintAt: parseRawTimestamp(r.os_fingerprint_at),
    exitObserved: (r.exit_observed as AccountProxyRow['exitObserved']) ?? null,
    exitObservedAt: parseRawTimestamp(r.exit_observed_at),
    exitSupersededAt: parseRawTimestamp(r.exit_superseded_at),
    // ⛔ `typeof … === 'boolean'`, never `?? false` and never `Boolean(…)`: null is
    // "never measured" and must survive the raw path as null. Coercing it would
    // turn every unmeasured row the claim returns into a measured negative.
    quicProbe: typeof r.quic_probe === 'boolean' ? r.quic_probe : null,
    quicProbeAt: parseRawTimestamp(r.quic_probe_at),
    udpProbe: typeof r.udp_probe === 'boolean' ? r.udp_probe : null,
    udpProbeAt: parseRawTimestamp(r.udp_probe_at),
    freshnessAttemptedAt: parseRawTimestamp(r.freshness_attempted_at),
    freshnessConsecutiveFailures: Number(r.freshness_consecutive_failures ?? 0),
    createdAt: requireRawTimestamp(r.created_at, 'created_at'),
    updatedAt: requireRawTimestamp(r.updated_at, 'updated_at'),
  };
}

/** Rows out of a raw `db.execute()`, which the driver returns either as an array
 *  or as `{ rows }` depending on the adapter. Same normalisation as
 *  `scheduled-jobs-repo.claimDue`. */
function rawRows(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown[] }).rows ?? (result as unknown[]);
  return rows as Array<Record<string, unknown>>;
}

export class DrizzleAccountProxiesRepo implements AccountProxiesRepo {
  constructor(private readonly database: Database) {}

  async list(accountId: string): Promise<AccountProxyRow[]> {
    const rows = await this.database.db
      .select()
      .from(accountProxies)
      .where(eq(accountProxies.accountId, accountId))
      .orderBy(asc(accountProxies.createdAt));
    return rows.map(toRow);
  }

  async findById(args: { id: string; accountId: string }): Promise<AccountProxyRow | null> {
    const rows = await this.database.db
      .select()
      .from(accountProxies)
      .where(and(eq(accountProxies.id, args.id), eq(accountProxies.accountId, args.accountId)))
      .limit(1);
    const row = rows[0];
    return row ? toRow(row) : null;
  }

  async create(accountId: string, input: NewAccountProxyRow): Promise<AccountProxyRow> {
    const rows = await this.database.db
      .insert(accountProxies)
      .values({
        id: input.id,
        accountId,
        label: input.label,
        scheme: input.scheme,
        host: input.host,
        port: input.port,
        username: input.username,
        wrappedPassword: input.wrappedPassword,
        wrappedSecret: input.wrappedSecret ?? null,
        config: input.config ?? {},
      })
      .returning();
    // insert-returning always yields the inserted row.
    return toRow(rows[0]!);
  }

  async createIfUnderLimit(
    accountId: string,
    input: NewAccountProxyRow,
    limit: number,
  ): Promise<AccountProxyRow | null> {
    validateLimit('Account proxy limit', limit);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`account-proxy-create:${accountId}`}))`,
      );
      const [countRow] = await tx
        .select({ value: count() })
        .from(accountProxies)
        .where(eq(accountProxies.accountId, accountId));
      if ((countRow?.value ?? 0) >= limit) return null;
      const [row] = await tx
        .insert(accountProxies)
        .values({
          id: input.id,
          accountId,
          label: input.label,
          scheme: input.scheme,
          host: input.host,
          port: input.port,
          username: input.username,
          wrappedPassword: input.wrappedPassword,
          wrappedSecret: input.wrappedSecret ?? null,
          config: input.config ?? {},
        })
        .returning();
      if (!row) throw new Error('Account proxy capped insert returned no row.');
      return toRow(row);
    });
  }

  async update(args: {
    id: string;
    accountId: string;
    expectedScheme?: string;
    updates: AccountProxyRowUpdates;
  }): Promise<AccountProxyRow | null> {
    const rows = await this.database.db
      .update(accountProxies)
      .set({ ...args.updates, updatedAt: new Date() })
      // Owner-scoped: a cross-account id simply matches no row → null.
      .where(
        and(
          eq(accountProxies.id, args.id),
          eq(accountProxies.accountId, args.accountId),
          ...(args.expectedScheme !== undefined
            ? [eq(accountProxies.scheme, args.expectedScheme)]
            : []),
        ),
      )
      .returning();
    const row = rows[0];
    return row ? toRow(row) : null;
  }

  async storeProbeReadingsIfSameIdentity(args: {
    id: string;
    accountId: string;
    probedIdentity: Pick<
      AccountProxyRow,
      'scheme' | 'host' | 'port' | 'username' | 'wrappedPassword' | 'wrappedSecret'
    >;
    readings: ProbeReadingsToStore;
  }): Promise<AccountProxyRow | null> {
    const quic = probeLegToStore('quic', args.readings.quicProbe, args.readings.quicProbeAt);
    const udp = probeLegToStore('udp', args.readings.udpProbe, args.readings.udpProbeAt);
    // ONE statement, so the identity check and the write cannot be separated by a
    // concurrent PUT — see the interface. Raw SQL because the generic `update`
    // cannot express either half: the identity predicate, or "keep the stored leg
    // when it was measured later" (a CASE over the PRE-update row, which is what
    // an UPDATE's SET reads — so both CASEs of a leg see the same stored date and
    // a value can never move without its date).
    //
    // An unmeasured leg is passed as NULL and its CASE falls through to the
    // stored value: the column is named in the SET list but not changed.
    //
    // Dates are pre-serialised to ISO strings for the reason recorded on
    // `claimDueForFreshnessRefresh`. The booleans are passed as BOOLEANS — the
    // `::boolean` cast makes the driver serialise the parameter as one, and it
    // would turn the string 'true' into false.
    //
    // `updated_at` moves as it does for every other write a customer's own Test
    // makes through `update` (the OS reading, the exit) — but only when a leg
    // LANDS. A statement whose every leg stood down to a later measurement
    // matched the row and changed nothing, and a change stamp that moves on a
    // write that changed nothing is a false record.
    //
    // ⚠️ No backticks inside the template below — it is a tagged template
    // literal, and one would terminate it mid-statement.
    const quicValue = quic?.value ?? null;
    const quicAtIso = quic?.atIso ?? null;
    const udpValue = udp?.value ?? null;
    const udpAtIso = udp?.atIso ?? null;
    const nowIso = new Date().toISOString();
    const result = await this.database.db.execute(sql`
      UPDATE account_proxies p
         SET quic_probe = CASE
               WHEN ${quicAtIso}::timestamptz IS NOT NULL
                AND (p.quic_probe_at IS NULL OR p.quic_probe_at <= ${quicAtIso}::timestamptz)
               THEN ${quicValue}::boolean
               ELSE p.quic_probe
             END,
             quic_probe_at = CASE
               WHEN ${quicAtIso}::timestamptz IS NOT NULL
                AND (p.quic_probe_at IS NULL OR p.quic_probe_at <= ${quicAtIso}::timestamptz)
               THEN ${quicAtIso}::timestamptz
               ELSE p.quic_probe_at
             END,
             udp_probe = CASE
               WHEN ${udpAtIso}::timestamptz IS NOT NULL
                AND (p.udp_probe_at IS NULL OR p.udp_probe_at <= ${udpAtIso}::timestamptz)
               THEN ${udpValue}::boolean
               ELSE p.udp_probe
             END,
             udp_probe_at = CASE
               WHEN ${udpAtIso}::timestamptz IS NOT NULL
                AND (p.udp_probe_at IS NULL OR p.udp_probe_at <= ${udpAtIso}::timestamptz)
               THEN ${udpAtIso}::timestamptz
               ELSE p.udp_probe_at
             END,
             updated_at = CASE
               WHEN (${quicAtIso}::timestamptz IS NOT NULL
                     AND (p.quic_probe_at IS NULL OR p.quic_probe_at <= ${quicAtIso}::timestamptz))
                 OR (${udpAtIso}::timestamptz IS NOT NULL
                     AND (p.udp_probe_at IS NULL OR p.udp_probe_at <= ${udpAtIso}::timestamptz))
               THEN ${nowIso}::timestamptz
               ELSE p.updated_at
             END
       WHERE p.id = ${args.id}::uuid
         AND p.account_id = ${args.accountId}::uuid
         -- The identity the reading was measured through. NULL-safe on the three
         -- nullable columns: a plain = against NULL is never true.
         AND p.scheme = ${args.probedIdentity.scheme}::text
         AND p.host = ${args.probedIdentity.host}::text
         AND p.port = ${args.probedIdentity.port}::int
         AND p.username IS NOT DISTINCT FROM ${args.probedIdentity.username}::text
         AND p.wrapped_password IS NOT DISTINCT FROM ${args.probedIdentity.wrappedPassword}::text
         AND p.wrapped_secret IS NOT DISTINCT FROM ${args.probedIdentity.wrappedSecret}::text
       RETURNING p.*;
    `);
    const row = rawRows(result)[0];
    return row === undefined ? null : toRowFromRaw(row);
  }

  async delete(args: { id: string; accountId: string }): Promise<boolean> {
    const rows = await this.database.db
      .delete(accountProxies)
      .where(and(eq(accountProxies.id, args.id), eq(accountProxies.accountId, args.accountId)))
      .returning({ id: accountProxies.id });
    return rows.length > 0;
  }

  async claimDueForFreshnessRefresh(args: {
    now: Date;
    refreshIntervalMs: number;
    maxBackoffSteps: number;
  }): Promise<AccountProxyRow | null> {
    // CTE + UPDATE ... FROM ... RETURNING, exactly the shape
    // `scheduled-jobs-repo.claimDue` uses, and for the same reason: the SELECT
    // locks its row with FOR UPDATE SKIP LOCKED and the UPDATE stamps the attempt,
    // so the claim and the bookkeeping are ONE statement. A concurrent worker
    // skips the locked row rather than blocking on it, and after this commits the
    // row is no longer due — a proxy cannot be probed twice in one window.
    //
    // Dates are pre-serialised to ISO strings: drizzle-orm's `construct(client)`
    // replaces postgres-js's timestamp serialisers with a no-op, so a raw `sql`
    // template that passes a Date through crashes in postgres-js's Bind step
    // (see `scheduled-jobs-repo.claimDue`'s note, which this inherits).
    //
    // ⛔ THE `JOIN accounts … a.status = 'active'` BELOW IS LOAD-BEARING, AND IT
    // IS A PRIVACY CONTROL, NOT A TIDINESS ONE. Account deletion is SOFT and the
    // retention purge nulls the SECRETS, not the rows (`clearProxySecretsForAccount`
    // below — "Nulls the SECRETS, not the rows"), so a deleted customer's
    // `account_proxies` rows survive indefinitely. Without this join they stay
    // claimable forever: the sweep dials an ex-customer's provider four times a
    // day and keeps writing NEW measurements (`exit_observed`, `os_fingerprint`)
    // onto the row of somebody who asked to be erased. And after that purge
    // `wrapped_password IS NULL`, which `resolveProbeDescriptor` cannot tell from
    // "no password configured" — so each of those dials is made UNAUTHENTICATED.
    // Suspended accounts are excluded for the smaller reason: we do not spend a
    // customer's bandwidth while their service is off.
    //
    // In SQL rather than resolved by the caller, the same discipline
    // `findDeletedAccountIdsWithProxySecretsBefore` records: a caller that trusts
    // the contract cannot forget the check. The status is a LITERAL so the
    // planner keeps the index on `accounts(id)`.
    //
    // ⛔ THE STREAK IS BROKEN BY ANYBODY'S OBSERVATION, NOT ONLY BY OUR OWN
    // SUCCESS — the `freshness_consecutive_failures = CASE …` in the UPDATE.
    // That counter used to be reset only by this sweep's own successful probe, so
    // the three failures the condemn threshold requires need not have been
    // consecutive IN TIME and need not have been uncontradicted: background
    // failures on day 1 and day 2 leave the counter at 2, the customer then uses
    // the proxy for a month (a live session's relay keeps `exit_observed_at`
    // fresh, so the row is never due and is never re-probed), they stop, and the
    // first background blip six hours later is the THIRD failure — stamping
    // `exit_superseded_at`, which `routes/account-me.ts` and
    // `routes/agent-sessions.ts` then use to suppress the stored exit. One
    // transient miss flipping customer-visible state is the exact outcome the
    // threshold exists to prevent.
    //
    // Evaluated HERE because this is the only statement that can still see both
    // timestamps: an UPDATE's SET reads the PRE-update row, so
    // `p.freshness_attempted_at` on the right-hand side is still our PREVIOUS
    // attempt. `exit_observed_at > freshness_attempted_at` therefore means exactly
    // "somebody observed this exit up since the last time we dialled" — a fact no
    // later statement could reconstruct, because the line beside it overwrites the
    // value it is compared against.
    //
    // ⚠️ No backticks inside the template below — it is a tagged template
    // literal, and one would terminate it mid-statement.
    const nowIso = args.now.toISOString();
    const intervalSeconds = args.refreshIntervalMs / 1000;
    const result = await this.database.db.execute(sql`
      WITH due AS (
        SELECT p.id
          FROM account_proxies p
          -- The account must still be a customer: deletion is SOFT and the
          -- retention purge keeps the rows, so without this the sweep dials an
          -- erased customer's provider forever, unauthenticated. See above.
          JOIN accounts a
            ON a.id = p.account_id
           AND a.status = 'active'
         WHERE p.scheme IN ('socks5', 'http')
           AND (
                 p.freshness_attempted_at IS NULL
              OR p.freshness_attempted_at <= ${nowIso}::timestamptz - make_interval(
                   secs => ${intervalSeconds}::double precision
                           * LEAST(GREATEST(p.freshness_consecutive_failures, 0) + 1,
                                   ${args.maxBackoffSteps}::int)
                 )
               )
           AND (
                 p.exit_observed_at IS NULL
              OR p.exit_observed_at <= ${nowIso}::timestamptz - make_interval(
                   secs => ${intervalSeconds}::double precision
                 )
               )
           AND NOT EXISTS (
                 SELECT 1
                   FROM agent_sessions s
                  WHERE s.proxy_id = p.id
                    AND s.status <> 'closed'
               )
         ORDER BY p.freshness_attempted_at ASC NULLS FIRST
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE account_proxies p
         SET freshness_attempted_at = ${nowIso}::timestamptz,
             -- The streak is broken by ANYBODY's observation, not only by our own
             -- success, and it can only be evaluated here. See the block comment
             -- above the statement.
             freshness_consecutive_failures = CASE
               WHEN p.exit_observed_at IS NOT NULL
                AND (
                      p.freshness_attempted_at IS NULL
                   OR p.exit_observed_at > p.freshness_attempted_at
                    )
               THEN 0
               ELSE p.freshness_consecutive_failures
             END
        FROM due
       WHERE p.id = due.id
       RETURNING p.*;
    `);
    const row = rawRows(result)[0];
    return row === undefined ? null : toRowFromRaw(row);
  }

  async recordFreshnessFailure(args: {
    id: string;
    accountId: string;
    at: Date;
    condemnAfterFailures: number;
    probeStartedAt: Date;
  }): Promise<{ consecutiveFailures: number; exitSupersededAt: Date | null } | null> {
    // One statement so the read-modify-write of the counter cannot interleave,
    // and OWNER-SCOPED (id + account_id) like every other write here even though
    // the caller reached this row through the cross-account claim.
    //
    // `updated_at` is deliberately NOT in the SET list. A failed background probe
    // must be invisible to everything the customer can see, and `updated_at` is
    // on the metadata view; bumping it would report an edit that never happened.
    const atIso = args.at.toISOString();
    // ⛔ THE CONDEMN SIDE OF `yieldToReadingsAfter`. The SUCCESS path stands down
    // when the row already holds a reading taken after our dial began; the
    // CONDEMN path must too, and used not to. Our dial holds the proxy for up to
    // ~30 seconds and the customer can press Test in the middle of it: their
    // probe succeeds at t+5s and writes a verified exit, ours fails at t+30s and
    // would stamp `exit_superseded_at` POSTDATING their observation — condemning
    // the reading they are watching, with our older evidence. routes/account-me.ts
    // then returns `null` for the stored exit and routes/agent-sessions.ts
    // refuses to project it into the live cockpit, so this is customer-visible.
    // "Do not fight the customer pressing Test" is the whole rule.
    const probeStartedIso = args.probeStartedAt.toISOString();
    const result = await this.database.db.execute(sql`
      UPDATE account_proxies p
         SET freshness_consecutive_failures = p.freshness_consecutive_failures + 1,
             exit_superseded_at = CASE
               WHEN p.freshness_consecutive_failures + 1 >= ${args.condemnAfterFailures}::int
                AND p.exit_observed IS NOT NULL
                AND p.exit_superseded_at IS NULL
                AND (
                      p.exit_observed_at IS NULL
                   OR p.exit_observed_at <= ${probeStartedIso}::timestamptz
                    )
               THEN ${atIso}::timestamptz
               ELSE p.exit_superseded_at
             END
       WHERE p.id = ${args.id}::uuid
         AND p.account_id = ${args.accountId}::uuid
       RETURNING p.freshness_consecutive_failures, p.exit_superseded_at;
    `);
    const row = rawRows(result)[0];
    if (row === undefined) return null;
    return {
      consecutiveFailures: Number(row.freshness_consecutive_failures),
      exitSupersededAt: parseRawTimestamp(row.exit_superseded_at),
    };
  }

  /**
   * Retention purge — account ids whose account is terminated past `cutoff`
   * and that still hold a wrapped proxy secret.
   *
   * The account predicate is deliberately in SQL rather than resolved by the
   * caller: this query is the only thing standing between a live account and a
   * credential wipe, so the `status = 'deleted'` and `deleted_at < cutoff`
   * conditions sit in the same statement as the delete target. A caller that
   * passed the wrong id list could not widen it.
   */
  async findDeletedAccountIdsWithProxySecretsBefore(
    cutoff: Date,
    maxPerTick = 500,
  ): Promise<string[]> {
    const rows = await this.database.client<Array<{ account_id: string }>>`
      SELECT DISTINCT p.account_id
      FROM account_proxies p
      JOIN accounts a ON a.id = p.account_id
      WHERE a.status = 'deleted'
        AND a.deleted_at IS NOT NULL
        AND a.deleted_at < ${cutoff.toISOString()}::timestamptz
        AND (p.wrapped_password IS NOT NULL OR p.wrapped_secret IS NOT NULL)
      LIMIT ${maxPerTick}`;
    return rows.map((r) => r.account_id);
  }

  /**
   * Null the wrapped secret columns for every proxy row on this account.
   *
   * Nulls the SECRETS, not the rows: privacy-policy.md §3.5 commits to erasing
   * the credential, and the surrounding non-secret connection metadata is
   * covered by a different retention line. Keeping the blast radius to exactly
   * the two columns the promise names means this can never remove more than it
   * was asked to.
   *
   * The `status = 'deleted'` predicate is repeated HERE as well as in the
   * candidate query. It is not redundant: the candidate list is computed on one
   * tick and consumed in a loop, so an account reinstated in between would
   * otherwise have its credentials wiped by a decision that was already stale.
   */
  async clearProxySecretsForAccount(accountId: string): Promise<number> {
    const rows = await this.database.client<Array<{ id: string }>>`
      UPDATE account_proxies p
      SET wrapped_password = NULL, wrapped_secret = NULL
      FROM accounts a
      WHERE a.id = p.account_id
        AND p.account_id = ${accountId}::uuid
        AND a.status = 'deleted'
        AND (p.wrapped_password IS NOT NULL OR p.wrapped_secret IS NOT NULL)
      RETURNING p.id`;
    return rows.length;
  }

  async migrateSecretEnvelopes(
    masterKey: Buffer,
    limit = MAX_PROXY_SECRET_MIGRATION_BATCH,
  ): Promise<{ scanned: number; converted: number; remaining: number }> {
    validateLimit('Account proxy secret migration limit', limit, MAX_PROXY_SECRET_MIGRATION_BATCH);

    // Authenticate one already-bound tuple even after every legacy row drains.
    const [v2Probe] = await this.database.db
      .select({
        id: accountProxies.id,
        accountId: accountProxies.accountId,
        scheme: accountProxies.scheme,
        wrappedPassword: accountProxies.wrappedPassword,
        wrappedSecret: accountProxies.wrappedSecret,
      })
      .from(accountProxies)
      .where(
        and(
          wrappersAreV2(),
          sql`(${accountProxies.wrappedPassword} IS NOT NULL OR ${accountProxies.wrappedSecret} IS NOT NULL)`,
        ),
      )
      .orderBy(asc(accountProxies.id))
      .limit(1);
    if (v2Probe !== undefined) {
      const probeWrappedPassword = v2Probe.wrappedPassword;
      const probeWrappedSecret = v2Probe.wrappedSecret;
      verifyBootEncryptionKey('Account proxy credentials', 'PROFILE_MASTER_KEY', () => {
        if (probeWrappedPassword !== null) {
          readAccountProxySecret(
            masterKey,
            { accountId: v2Probe.accountId, proxyId: v2Probe.id, slot: 'password' },
            probeWrappedPassword,
          );
        }
        if (probeWrappedSecret !== null) {
          readAccountProxySecret(
            masterKey,
            {
              accountId: v2Probe.accountId,
              proxyId: v2Probe.id,
              slot: vpnSecretSlot(v2Probe.scheme),
            },
            probeWrappedSecret,
          );
        }
      });
    }

    const rows = await this.database.db
      .select({
        id: accountProxies.id,
        accountId: accountProxies.accountId,
        scheme: accountProxies.scheme,
        wrappedPassword: accountProxies.wrappedPassword,
        wrappedSecret: accountProxies.wrappedSecret,
      })
      .from(accountProxies)
      .where(wrappersAreNotV2())
      .orderBy(asc(accountProxies.id))
      .limit(limit);

    // Map the complete page before the first maintenance write.
    const prepared = rows.map((row) => ({
      row,
      wrappedPassword:
        row.wrappedPassword === null
          ? null
          : convertAccountProxySecretToV2(
              masterKey,
              { accountId: row.accountId, proxyId: row.id, slot: 'password' },
              row.wrappedPassword,
            ),
      wrappedSecret:
        row.wrappedSecret === null
          ? null
          : convertAccountProxySecretToV2(
              masterKey,
              {
                accountId: row.accountId,
                proxyId: row.id,
                slot: vpnSecretSlot(row.scheme),
              },
              row.wrappedSecret,
            ),
    }));

    let converted = 0;
    for (const { row, wrappedPassword, wrappedSecret } of prepared) {
      const updated = await this.database.db
        .update(accountProxies)
        .set({ wrappedPassword, wrappedSecret })
        .where(
          and(
            eq(accountProxies.id, row.id),
            eq(accountProxies.accountId, row.accountId),
            eq(accountProxies.scheme, row.scheme),
            sql`${accountProxies.wrappedPassword} IS NOT DISTINCT FROM ${row.wrappedPassword}`,
            sql`${accountProxies.wrappedSecret} IS NOT DISTINCT FROM ${row.wrappedSecret}`,
          ),
        )
        .returning({ id: accountProxies.id });
      if (updated.length === 1) converted += 1;
    }

    const [remainingRow] = await this.database.db
      .select({ value: count() })
      .from(accountProxies)
      .where(wrappersAreNotV2());
    return { scanned: rows.length, converted, remaining: remainingRow?.value ?? 0 };
  }
}

/** In-memory double — same owner-scoping invariants, for unit tests + the
 *  in-memory app stack. IDs are preallocated by callers before encryption. */
export class InMemoryAccountProxiesRepo implements AccountProxiesRepo {
  private readonly rows = new Map<string, AccountProxyRow>();

  list(accountId: string): Promise<AccountProxyRow[]> {
    const out = [...this.rows.values()]
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({ ...r }));
    return Promise.resolve(out);
  }

  findById(args: { id: string; accountId: string }): Promise<AccountProxyRow | null> {
    const r = this.rows.get(args.id);
    return Promise.resolve(r && r.accountId === args.accountId ? { ...r } : null);
  }

  create(accountId: string, input: NewAccountProxyRow): Promise<AccountProxyRow> {
    if (this.rows.has(input.id)) throw new Error('Account proxy id already exists.');
    const now = new Date();
    const row: AccountProxyRow = {
      id: input.id,
      accountId,
      label: input.label,
      scheme: input.scheme,
      host: input.host,
      port: input.port,
      username: input.username,
      wrappedPassword: input.wrappedPassword,
      wrappedSecret: input.wrappedSecret ?? null,
      config: input.config ?? {},
      quicMeasured: null,
      quicMeasuredAt: null,
      osFingerprint: null,
      osFingerprintAt: null,
      exitObserved: null,
      exitObservedAt: null,
      exitSupersededAt: null,
      quicProbe: null,
      quicProbeAt: null,
      udpProbe: null,
      udpProbeAt: null,
      freshnessAttemptedAt: null,
      freshnessConsecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return Promise.resolve({ ...row });
  }

  createIfUnderLimit(
    accountId: string,
    input: NewAccountProxyRow,
    limit: number,
  ): Promise<AccountProxyRow | null> {
    validateLimit('Account proxy limit', limit);
    const accountRows = [...this.rows.values()].filter((row) => row.accountId === accountId);
    if (accountRows.length >= limit) return Promise.resolve(null);
    return this.create(accountId, input);
  }

  update(args: {
    id: string;
    accountId: string;
    expectedScheme?: string;
    updates: AccountProxyRowUpdates;
  }): Promise<AccountProxyRow | null> {
    const r = this.rows.get(args.id);
    if (
      !r ||
      r.accountId !== args.accountId ||
      (args.expectedScheme !== undefined && r.scheme !== args.expectedScheme)
    ) {
      return Promise.resolve(null);
    }
    const next: AccountProxyRow = { ...r, ...args.updates, updatedAt: new Date() };
    this.rows.set(next.id, next);
    return Promise.resolve({ ...next });
  }

  storeProbeReadingsIfSameIdentity(args: {
    id: string;
    accountId: string;
    probedIdentity: Pick<
      AccountProxyRow,
      'scheme' | 'host' | 'port' | 'username' | 'wrappedPassword' | 'wrappedSecret'
    >;
    readings: ProbeReadingsToStore;
  }): Promise<AccountProxyRow | null> {
    const quic = probeLegToStore('quic', args.readings.quicProbe, args.readings.quicProbeAt);
    const udp = probeLegToStore('udp', args.readings.udpProbe, args.readings.udpProbeAt);
    // Check and write in one synchronous step — the double's equivalent of the
    // Drizzle repo's single statement: nothing can run between them.
    const r = this.rows.get(args.id);
    const probed = args.probedIdentity;
    if (
      !r ||
      r.accountId !== args.accountId ||
      r.scheme !== probed.scheme ||
      r.host !== probed.host ||
      r.port !== probed.port ||
      r.username !== probed.username ||
      r.wrappedPassword !== probed.wrappedPassword ||
      r.wrappedSecret !== probed.wrappedSecret
    ) {
      return Promise.resolve(null);
    }
    // A leg lands unless the row already holds one measured LATER — same rule,
    // per leg, as the statement's CASE.
    const lands = (storedAt: Date | null, atIso: string): boolean =>
      storedAt === null || storedAt.getTime() <= new Date(atIso).getTime();
    const quicLands = quic !== null && lands(r.quicProbeAt, quic.atIso);
    const udpLands = udp !== null && lands(r.udpProbeAt, udp.atIso);
    const next: AccountProxyRow = {
      ...r,
      ...(quic !== null && quicLands
        ? { quicProbe: quic.value, quicProbeAt: new Date(quic.atIso) }
        : {}),
      ...(udp !== null && udpLands ? { udpProbe: udp.value, udpProbeAt: new Date(udp.atIso) } : {}),
      // Only a write that changed something moves the change stamp — as the
      // statement's own CASE.
      ...(quicLands || udpLands ? { updatedAt: new Date() } : {}),
    };
    this.rows.set(next.id, next);
    return Promise.resolve({ ...next });
  }

  delete(args: { id: string; accountId: string }): Promise<boolean> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId) return Promise.resolve(false);
    this.rows.delete(args.id);
    return Promise.resolve(true);
  }

  /**
   * ITEM 4 — the double's stand-in for the Drizzle claim's `NOT EXISTS (SELECT 1
   * FROM agent_sessions …)`. There is no session table in memory, so the set of
   * proxies a live session is holding is injected instead.
   *
   * It lives HERE rather than in each test's own filter for the reason the
   * repo's `listOpenByAccount` double records: the exclusion is the repository's
   * contract, so a caller that trusts it must be unable to forget it, and the
   * arm proving "a busy proxy is not dialled" must exercise the same code path
   * production does rather than a condition the test wrote itself.
   */
  setLiveSessionProxyIds(ids: Iterable<string>): void {
    this.liveSessionProxyIds = new Set(ids);
  }

  private liveSessionProxyIds = new Set<string>();

  /**
   * ITEM 4 — the double's stand-in for the Drizzle claim's
   * `JOIN accounts a ON … a.status = 'active'`. There is no `accounts` table in
   * memory, so the non-active accounts are injected instead.
   *
   * Unknown accounts read as `active`, matching production: `account_proxies`
   * has a foreign key to `accounts`, so a proxy row without an account row
   * cannot exist. (The SQL join also excludes that impossible case; the double
   * does not, and the difference is unreachable.)
   */
  setNonActiveAccountIds(ids: Iterable<string>): void {
    this.nonActiveAccountIds = new Set(ids);
  }

  private nonActiveAccountIds = new Set<string>();

  claimDueForFreshnessRefresh(args: {
    now: Date;
    refreshIntervalMs: number;
    maxBackoffSteps: number;
  }): Promise<AccountProxyRow | null> {
    // Mirror of the Drizzle predicate, clause for clause: an ACTIVE account's
    // rows only, refreshable schemes only, the linear failure backoff, a stored
    // exit older than the refresh interval, no proxy a live session holds, oldest
    // attempt first (never-attempted rows first), one row, and the claim STAMPS
    // the attempt — which is what makes a second caller in the same tick get a
    // different row rather than the same one twice. The claim also breaks a
    // failure streak that somebody else's observation has contradicted.
    const candidates = [...this.rows.values()]
      .filter((r) => !this.nonActiveAccountIds.has(r.accountId))
      .filter((r) => r.scheme === 'socks5' || r.scheme === 'http')
      .filter((r) => !this.liveSessionProxyIds.has(r.id))
      .filter(
        (r) =>
          r.exitObservedAt === null ||
          r.exitObservedAt.getTime() <= args.now.getTime() - args.refreshIntervalMs,
      )
      .filter((r) => {
        if (r.freshnessAttemptedAt === null) return true;
        const steps = Math.min(
          Math.max(r.freshnessConsecutiveFailures, 0) + 1,
          args.maxBackoffSteps,
        );
        return (
          r.freshnessAttemptedAt.getTime() <= args.now.getTime() - args.refreshIntervalMs * steps
        );
      })
      .sort((a, b) => {
        const at = a.freshnessAttemptedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
        const bt = b.freshnessAttemptedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
        if (at !== bt) return at - bt;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    const claimed = candidates[0];
    if (claimed === undefined) return Promise.resolve(null);
    // Mirrors the SQL's `freshness_consecutive_failures = CASE …`, and reads the
    // PRE-claim `freshnessAttemptedAt` for the same reason the SET's right-hand
    // side does: after the line below that value is gone, so "somebody observed
    // this exit up since the last time we dialled" is only answerable here.
    const contradictedSinceLastAttempt =
      claimed.exitObservedAt !== null &&
      (claimed.freshnessAttemptedAt === null ||
        claimed.exitObservedAt.getTime() > claimed.freshnessAttemptedAt.getTime());
    const next: AccountProxyRow = {
      ...claimed,
      freshnessAttemptedAt: args.now,
      freshnessConsecutiveFailures: contradictedSinceLastAttempt
        ? 0
        : claimed.freshnessConsecutiveFailures,
    };
    this.rows.set(next.id, next);
    return Promise.resolve({ ...next });
  }

  recordFreshnessFailure(args: {
    id: string;
    accountId: string;
    at: Date;
    condemnAfterFailures: number;
    probeStartedAt: Date;
  }): Promise<{ consecutiveFailures: number; exitSupersededAt: Date | null } | null> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId) return Promise.resolve(null);
    const consecutiveFailures = r.freshnessConsecutiveFailures + 1;
    // Mirrors the SQL's condemn-side `yieldToReadingsAfter`: an exit observed
    // after our dial began is newer evidence than our failure, so it is not
    // contradicted by it. See the interface doc.
    const yieldsToNewerObservation =
      r.exitObservedAt !== null && r.exitObservedAt.getTime() > args.probeStartedAt.getTime();
    const exitSupersededAt =
      consecutiveFailures >= args.condemnAfterFailures &&
      r.exitObserved !== null &&
      r.exitSupersededAt === null &&
      !yieldsToNewerObservation
        ? args.at
        : r.exitSupersededAt;
    // `updatedAt` is untouched here, exactly as the SQL leaves it out of its SET
    // list: a failed background probe must move nothing a customer can see.
    const next: AccountProxyRow = { ...r, freshnessConsecutiveFailures: consecutiveFailures };
    next.exitSupersededAt = exitSupersededAt;
    this.rows.set(next.id, next);
    return Promise.resolve({ consecutiveFailures, exitSupersededAt });
  }

  migrateSecretEnvelopes(
    masterKey: Buffer,
    limit = MAX_PROXY_SECRET_MIGRATION_BATCH,
  ): Promise<{ scanned: number; converted: number; remaining: number }> {
    validateLimit('Account proxy secret migration limit', limit, MAX_PROXY_SECRET_MIGRATION_BATCH);
    const sortedRows = [...this.rows.values()].sort((a, b) => a.id.localeCompare(b.id));
    const v2Probe = sortedRows.find(
      (row) =>
        rowWrappersAreV2(row) && (row.wrappedPassword !== null || row.wrappedSecret !== null),
    );
    if (v2Probe !== undefined) {
      if (v2Probe.wrappedPassword !== null) {
        readAccountProxySecret(
          masterKey,
          { accountId: v2Probe.accountId, proxyId: v2Probe.id, slot: 'password' },
          v2Probe.wrappedPassword,
        );
      }
      if (v2Probe.wrappedSecret !== null) {
        readAccountProxySecret(
          masterKey,
          {
            accountId: v2Probe.accountId,
            proxyId: v2Probe.id,
            slot: vpnSecretSlot(v2Probe.scheme),
          },
          v2Probe.wrappedSecret,
        );
      }
    }
    const legacy = sortedRows.filter((row) => !rowWrappersAreV2(row)).slice(0, limit);
    const prepared = legacy.map((row) => ({
      row,
      wrappedPassword:
        row.wrappedPassword === null
          ? null
          : convertAccountProxySecretToV2(
              masterKey,
              { accountId: row.accountId, proxyId: row.id, slot: 'password' },
              row.wrappedPassword,
            ),
      wrappedSecret:
        row.wrappedSecret === null
          ? null
          : convertAccountProxySecretToV2(
              masterKey,
              {
                accountId: row.accountId,
                proxyId: row.id,
                slot: vpnSecretSlot(row.scheme),
              },
              row.wrappedSecret,
            ),
    }));
    for (const value of prepared) {
      this.rows.set(value.row.id, {
        ...value.row,
        wrappedPassword: value.wrappedPassword,
        wrappedSecret: value.wrappedSecret,
      });
    }
    const remaining = [...this.rows.values()].filter((row) => !rowWrappersAreV2(row)).length;
    return Promise.resolve({ scanned: legacy.length, converted: legacy.length, remaining });
  }
}
