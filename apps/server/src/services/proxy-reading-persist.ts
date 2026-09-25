// ITEM 4 — THE RULES FOR WRITING A MEASURED READING ONTO A SAVED PROXY ROW.
//
// `account_proxies` carries two readings that are measured on one machine and
// read on every other one: `os_fingerprint` (migration 0119) and `exit_observed`
// (0120, with the contradiction stamp `exit_superseded_at` from 0122) — and,
// since 0124, what a Test measured about QUIC and UDP (`quic_probe`, `udp_probe`;
// rules 1 and 4 apply to them, 2 and 3 are about the exit alone). Four
// rules govern every write to them. The first three exist because the columns
// mean "the last thing anyone OBSERVED", not "the current state"; the fourth
// because the row can MOVE between the measurement and the write:
//
//   1. A MISS WRITES NOTHING. Absence is not a measurement. A probe that could
//      not read the proxy's SYN, or an echo that came back without an exit, must
//      leave the column exactly as it was — never null it, never coerce the miss
//      into a placeholder value. Drizzle drops `undefined` keys, so the
//      helpers below return `null` (no update at all) rather than an object with
//      undefined members: "no update" and "update to undefined" read the same in
//      an `update()` call and only one of them is honest.
//   2. NEVER DOWNGRADE GEO. A vantage that reports the exit IP without country or
//      timezone is not evidence that the geo is gone — a node that predates the
//      `exit_*` keys sends the ip alone. Writing `{country: null}` over a live
//      session's observation of the SAME exit erases a real reading with a gap in
//      someone else's frame.
//   3. A CONTRADICTION OLDER THAN AN OBSERVATION IS SPENT. Any exit write clears
//      `exit_superseded_at`, because the stamp says "a verdict since found this
//      exit down" and a fresh observation postdates it.
//
//   4. A READING MAY ONLY BE WRITTEN WHILE THE ROW STILL CARRIES THE IDENTITY IT
//      WAS MEASURED THROUGH. Every writer here reads the row, then spends up to
//      ~18 seconds on the wire; a PUT in that window can repoint the row at a
//      different machine, and `proxyReadingsInvalidatedByEdit` clears these
//      columns in the same statement that moves it. A write that lands after
//      that restores a reading of the OLD machine, stamped AFTER the move — and
//      no tie-break can catch it, because the invalidation NULLS the timestamps
//      and rule 4's absence is exactly what a null stored timestamp yields to
//      (nothing). So the decision is not "is ours older", it is "is this still
//      the same proxy" — see `readingWasTakenThroughCurrentIdentity`.
//
// ⛔ WHY THIS FILE EXISTS AT ALL. These rules were written once, as closures
// inside the `/v1/account/me/proxies/:id/test` handler (routes/account-me.ts —
// `persistOsFingerprintIfObserved`, and the `wouldDowngrade` / `stampUpdates`
// block on the fleet branch). The background freshness refresher writes the same
// two columns from a different vantage, and a second copy of a three-rule policy
// is a policy that agrees with itself only until somebody edits one copy. So the
// decisions live here as PURE functions — no repo, no logger, no I/O — which is
// also what makes each rule directly assertable instead of reachable only through
// an HTTP request with a stubbed probe.
//
// ⚠️ The route has NOT been switched over for rules 1-3. account-me.ts is being
// edited concurrently by another change (ITEM 1-3, the route OUT for the stored
// reading), and rewriting its persist closures underneath that work would be a
// merge hazard for no behavioural gain — the route's copy is correct today.
// Rule 4 is the exception and has NO second copy: `persistOsFingerprintIfObserved`
// in the route imports `readingWasTakenThroughCurrentIdentity` from here, because
// a fence that two writers spell differently is a fence one of them lacks.
// `a-background-refresh-obeys-the-routes-persist-rules.test.ts` pins the route's
// copy to rule 1 so the two cannot silently diverge in the meantime, and its
// failure message names this module as the place to delegate to.
//
// ⚠️ ONE RULE HERE IS NEW, and it is opt-in so the route's behaviour is
// unchanged byte for byte: `yieldToReadingsAfter`. A background probe holds the
// proxy for up to 18 seconds (a 12s connectivity budget then a 6s observer
// tunnel), and the customer can press Test in the middle of that. Both dial the
// same proxy and both come back with a real reading, but ours was taken FIRST and
// would land SECOND, stamping an older observation with a newer date. Passing the
// moment our probe began makes us stand down when the row already holds something
// observed after it: the customer's own Test wins, which is the correct tie-break
// — they are watching that result.

import type { AccountProxyRow, AccountProxyRowUpdates } from '../db/account-proxies-repo.js';

/** The structured OS measurement as it is stored (the column takes the whole
 *  object; only `{os, confidence}` ever crosses to a customer). */
export type ObservedOsFingerprint = NonNullable<AccountProxyRow['osFingerprint']>;

/** An observed exit identity, before it is narrowed to the stored shape. */
export interface ObservedExitIdentity {
  ip: string;
  country: string | null;
  timezone: string | null;
}

/** The row fields the decisions below read. A `Pick`, not the whole row, so a
 *  caller cannot accidentally make a decision depend on a field these rules do
 *  not consider. */
export type ProxyReadingRowView = Pick<
  AccountProxyRow,
  'osFingerprintAt' | 'exitObserved' | 'exitObservedAt' | 'exitSupersededAt'
>;

/**
 * Rule 1 for the OS fingerprint: the update to apply, or null for "write
 * nothing".
 *
 * `observed` is undefined for every non-measurement — the three
 * `os_fingerprint_unavailable` causes the /test reply carries are exactly that,
 * and a CAUSE must never touch the stored column.
 */
export function osFingerprintUpdates(args: {
  observed: ObservedOsFingerprint | undefined;
  at: Date;
  row: Pick<ProxyReadingRowView, 'osFingerprintAt'>;
  /** Stand down when the stored reading was taken after this instant — see the
   *  header. Omitted by the interactive route, which is never the loser. */
  yieldToReadingsAfter?: Date;
}): AccountProxyRowUpdates | null {
  if (args.observed === undefined) return null;
  if (yieldsToNewerReading(args.row.osFingerprintAt, args.yieldToReadingsAfter)) return null;
  return { osFingerprint: args.observed, osFingerprintAt: args.at };
}

/**
 * Rules 1-3 for the exit identity: the update to apply, or null.
 *
 * `incoming` is undefined when nothing was observed — which INCLUDES a verdict
 * that came back with an address that is not this proxy's exit (a leak verdict
 * carries the measuring machine's own address). Deciding that is the caller's
 * job; by the time it reaches here, a present `incoming` means "this is the exit
 * the world sees through this proxy".
 */
export function exitObservationUpdates(args: {
  incoming: ObservedExitIdentity | undefined;
  observedVia: 'session' | 'probe';
  at: Date;
  row: ProxyReadingRowView;
  yieldToReadingsAfter?: Date;
}): AccountProxyRowUpdates | null {
  if (args.incoming === undefined) return null;
  if (yieldsToNewerReading(args.row.exitObservedAt, args.yieldToReadingsAfter)) return null;
  const incomingHasGeo = args.incoming.country !== null || args.incoming.timezone !== null;
  const existing = args.row.exitObserved ?? null;
  const wouldDowngrade =
    !incomingHasGeo &&
    existing !== null &&
    existing.ip === args.incoming.ip &&
    (existing.country !== null || existing.timezone !== null);
  if (wouldDowngrade) {
    // The observation still happened and it still says the exit is up, so rule 3
    // applies even though rule 2 refuses the write itself. Nothing else moves.
    return args.row.exitSupersededAt !== null ? { exitSupersededAt: null } : null;
  }
  return {
    exitObserved: {
      ip: args.incoming.ip,
      country: args.incoming.country,
      timezone: args.incoming.timezone,
      observed_via: args.observedVia,
    },
    exitObservedAt: args.at,
    exitSupersededAt: null,
  };
}

/** The two capability legs a Test can measure, each either a READING or absent.
 *  `undefined` is the only spelling of "not measured" — there is no null here, so
 *  a caller cannot hand over a three-state wire value without first deciding
 *  which of its states are measurements. */
export interface MeasuredProbeCapabilities {
  quic?: boolean;
  udp?: boolean;
}

/**
 * Rule 1 for the QUIC / UDP readings of a proxy Test (migration 0124): the
 * update to apply, or null for "write nothing".
 *
 * ⛔ A MEASURED `false` IS A READING AND IS WRITTEN AS `false`. That is the point
 * of the columns: a stored negative is what lets anything tell "this proxy does
 * not relay QUIC" from "nobody has looked", and only the second may be re-probed
 * on a schedule. The mirror image holds just as hard — an `undefined` leg (the
 * node skipped it, the frame reached no verdict, a VPN row's asserted literal)
 * writes NOTHING for that leg and leaves whatever an earlier Test stored.
 *
 * The legs are independent: a Test that measured UDP and skipped QUIC moves the
 * UDP pair only. Each reading moves WITH its own date, never without it — a
 * reading that cannot be dated cannot be aged, and the route refuses to serve one.
 *
 * Which wire states count as "measured" is NOT decided here. The route already
 * owns that decision for the reply (`capabilityReadingsForReply`), and the stored
 * reading must be the one the customer was just shown, so the caller passes that
 * function's answer rather than this file growing a second reading of the frame.
 */
export function probeCapabilityUpdates(args: {
  measured: MeasuredProbeCapabilities;
  at: Date;
  row: Pick<AccountProxyRow, 'quicProbeAt' | 'udpProbeAt'>;
  /** Stand down, per leg, when the stored reading was taken after this instant —
   *  see the header. Omitted by the interactive route, which is never the loser. */
  yieldToReadingsAfter?: Date;
}): AccountProxyRowUpdates | null {
  const quic =
    args.measured.quic !== undefined &&
    !yieldsToNewerReading(args.row.quicProbeAt, args.yieldToReadingsAfter)
      ? ({ quicProbe: args.measured.quic, quicProbeAt: args.at } satisfies AccountProxyRowUpdates)
      : null;
  const udp =
    args.measured.udp !== undefined &&
    !yieldsToNewerReading(args.row.udpProbeAt, args.yieldToReadingsAfter)
      ? ({ udpProbe: args.measured.udp, udpProbeAt: args.at } satisfies AccountProxyRowUpdates)
      : null;
  if (quic === null && udp === null) return null;
  return { ...(quic ?? {}), ...(udp ?? {}) };
}

/**
 * The `reason` a STORED OS reading carries.
 *
 * ⛔ THIS IS A CUSTOMER-FACING SENTENCE, not the probe's diagnostic string. The
 * column is jsonb and the /proxies list parses whatever it holds through the
 * PUBLISHED `AccountProxyOsFingerprintSchema`, `reason` included — so whatever a
 * writer puts here is read by a person. The probe's own `reason` ("ttl 64, mss
 * 1460, …") is a triage note and must never land in that field; it is already in
 * the server log beside the observation.
 *
 * ⚠️ SECOND COPY OF ONE SENTENCE PAIR. `routes/account-me.ts` has
 * `customerOsFingerprintReason` with the same two branches, and a customer must
 * not be able to tell which vantage measured their proxy by reading two different
 * sentences. Pinned by
 * `a-background-refresh-obeys-the-routes-persist-rules.test.ts`, which reads both
 * literals out of the two sources and requires them to be identical — the route's
 * copy cannot be edited without this one going red.
 */
export function customerOsFingerprintReason(os: string): string {
  return os === 'unknown'
    ? 'The operating system could not be determined from this connection.'
    : 'Based on how this proxy responds to a network connection.';
}

/** True when the row already holds a reading taken strictly after `since` — so
 *  ours is the older measurement and must not overwrite it. A row with no stored
 *  reading, or a caller that passed no instant, never yields. */
function yieldsToNewerReading(storedAt: Date | null, since: Date | undefined): boolean {
  if (since === undefined || storedAt === null) return false;
  return storedAt.getTime() > since.getTime();
}

/** The row fields a reading is measured THROUGH — the machine dialled and the
 *  credential it was dialled with (for a VPN row, the tunnel material). A `Pick`,
 *  so a caller cannot make this decision depend on a field the probe never used. */
export type ProxyProbedIdentity = Pick<
  AccountProxyRow,
  'scheme' | 'host' | 'port' | 'username' | 'wrappedPassword' | 'wrappedSecret'
>;

/**
 * Rule 4 — may a reading taken through `probed` be written onto `current`?
 *
 * Both writers of these columns (the interactive /:id/test route and the
 * background freshness sweep) read the row, dial for up to ~18 seconds, and then
 * write. A customer PUT inside that window can have repointed the row — see the
 * header. Comparing the identity is the only check that survives the
 * invalidation, which nulls every timestamp a staleness tie-break would read.
 *
 * ⚠️ `wrappedPassword` is compared as the stored ENVELOPE, not as a plaintext:
 * this decision holds no master key. The envelope is AEAD over a random nonce,
 * so a re-wrap of the SAME password (the desktop client resubmits one on every
 * launch) reads as a change here and costs that proxy one refresh cycle. That is
 * the cheap direction — the expensive one is writing an exit identity measured
 * under a credential the row no longer has.
 *
 * ⚠️ `wrappedSecret` is compared the same way, and for the same reason. A VPN
 * row's `host`/`port` are a display address: a WireGuard key rotation or an
 * OpenVPN account switch keeps both and still lands the tunnel on a different
 * machine — `proxyReadingsInvalidatedByEdit` clears every reading for it — so
 * without this column that edit is invisible here. Every PUT that carries a VPN
 * block re-wraps the secret, so any change of tunnel material moves the envelope;
 * a resubmission of the SAME material does too, at the same one-cycle cost.
 *
 * ⚠️ THESE SIX COLUMNS ARE SPELLED A SECOND TIME, in SQL:
 * `storeProbeReadingsIfSameIdentity` (db/account-proxies-repo.ts) carries them in
 * its WHERE, because for the QUIC/UDP readings a check made BEFORE the write
 * still leaves a window a PUT can land in, and what slips through can be a stored
 * `false` about the new address. A column added here must be added there;
 * `a-probe-reading-is-only-written-onto-the-identity-it-was-measured-through.test.ts`
 * moves each of the six in turn against real Postgres and requires the write to
 * be declined.
 */
export function readingWasTakenThroughCurrentIdentity(
  probed: ProxyProbedIdentity,
  current: ProxyProbedIdentity,
): boolean {
  return (
    probed.scheme === current.scheme &&
    probed.host === current.host &&
    probed.port === current.port &&
    probed.username === current.username &&
    probed.wrappedPassword === current.wrappedPassword &&
    probed.wrappedSecret === current.wrappedSecret
  );
}
