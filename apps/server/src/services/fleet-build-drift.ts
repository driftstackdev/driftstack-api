// Build drift between what a device DECLARES it is running and what it MEASURED.
//
// The device team (A3, 2026-09-19 ~18:45Z and ~19:10Z) added two measured keys
// to the harness frames because the declared ones beside them were observed
// lying:
//
//   • `harnessVersion` is typed into the node's env at deploy time. A3 observed
//     it naming a commit the running binary was not built from. `harnessBinarySha256`
//     is a sha256 prefix of the bytes actually executing, so it cannot go stale.
//   • `webkitForkBuild` names a checkout A3 measured at 20 commits behind the
//     real build. `webkitFrameworkSha256` is measured at the spawn path, per
//     framework, so it says WHICH of the three moved — A3 found the box's
//     JavaScriptCore five days older than its WebCore, which one combined digest
//     could only have reported as "something changed".
//
// ⛔ A DECLARED VALUE IS NEVER THE SUBJECT OF A VERDICT HERE. Nothing in this
// file decides that a declared string is wrong: it cannot, because there is no
// second opinion on what a commit id ought to mean. What it can do — and the
// only thing it does — is find devices that AGREE on a declared value and
// DISAGREE on the measurement, which is a contradiction no reading of the
// declared field can explain away.
//
// ⛔ EVERYTHING HERE IS PURE. No clock, no I/O, no store. The caller assembles
// the inputs; this decides. That is deliberate: the whole point of the drift
// report is that two operators looking at the same fleet snapshot get the same
// answer, and a function that reads a clock or a map cannot promise that.

/** The three frameworks the device reports, in the exact order it sends them. */
export const WEBKIT_FRAMEWORK_KEYS = ['wc', 'wk', 'jsc'] as const;
export type WebkitFrameworkKey = (typeof WEBKIT_FRAMEWORK_KEYS)[number];

/** Operator-facing names for the three parts. Internal vocabulary; operator surface. */
export const WEBKIT_FRAMEWORK_LABELS: Readonly<Record<WebkitFrameworkKey, string>> = {
  wc: 'WebCore',
  wk: 'WebKit',
  jsc: 'JavaScriptCore',
};

/** The literal the device sends for a framework that is not at the spawn path. */
export const WEBKIT_FRAMEWORK_MISSING_LITERAL = 'absent';

/**
 * ⛔ STATUS TOKENS ARE THE DEVICE SPEAKING, NOT MALFORMED INPUT.
 *
 * The device team (2026-09-21) sends these in the SAME fields as a digest,
 * because the fields already exist and their protocol is additive. They are the
 * device saying WHY it has no digest to give:
 *   • `unreadable` — there was a file and it could not be read.
 *   • `nopath`     — there was no path to read in the first place.
 *
 * Before this, both arrived as "a value that is not a digest" and were hedged
 * with the same two-way sentence as a key that never arrived at all. They are
 * evidence, and a finding may now name them.
 *
 * ⛔ THE TOKEN `unreadable` AND THE CLASSIFICATION "COULD NOT PARSE" ARE TWO
 * DIFFERENT FACTS AND MUST NEVER SHARE A NAME. The token is the DEVICE's report
 * about its OWN file — specific, and actionable at the device. "Could not parse"
 * is OUR verdict about a value we did not expect at all, which could equally be
 * a device bug, a truncated frame or a value from a future protocol. That is why
 * the state below is `unreadable-value` and never `unreadable`: anywhere the
 * bare word `unreadable` appears in this file it is the device's word, always.
 */
export const HARNESS_BINARY_STATUS_TOKENS = ['unreadable', 'nopath'] as const;
export type HarnessBinaryStatusToken = (typeof HARNESS_BINARY_STATUS_TOKENS)[number];

/**
 * Per-part status tokens inside the framework triple.
 *
 * `absent` is NOT one of these: it is a MEASUREMENT (the device looked and the
 * framework is not there) and stays a readable part that compares unequal to a
 * digest. `unreadable` is the device failing to look, which is comparable to
 * nothing.
 */
export const WEBKIT_FRAMEWORK_STATUS_TOKENS = ['unreadable'] as const;
export type WebkitFrameworkStatusToken = (typeof WEBKIT_FRAMEWORK_STATUS_TOKENS)[number];

/**
 * ⛔ TWELVE LOWERCASE HEX, ANCHORED, AND NOTHING ELSE. The device produces these
 * with `shasum -a 256 <file> | cut -c1-12`, so uppercase, a full 64-char digest,
 * a `sha256:` prefix or a trailing newline are all values this repo did not ask
 * for — and a digest comparison is only sound if both sides were produced the
 * same way. A loose test here would let `ABC…` and `abc…` read as two different
 * builds of the same binary, which is a fabricated drift finding.
 */
const SHA256_PREFIX_12 = /^[0-9a-f]{12}$/;

/** How many hex characters of the sha256 the device actually sends. */
export const SHA256_PREFIX_LENGTH = 12;

/**
 * ⛔ SAID OUT LOUD IN EVERY COMPARISON FINDING, because an operator reading
 * "different binaries (aaaaaaaaaaaa, bbbbbbbbbbbb)" cannot otherwise tell
 * whether these are whole digests. They are 12 hex characters — 48 bits — of a
 * sha256, and every verdict here is a comparison of PREFIXES. Two prefixes that
 * differ prove the files differ; two that match are strong evidence and not a
 * proof, and a finding that does not say which of those it is invites the
 * stronger reading.
 */
const DIGEST_PREFIX_SENTENCE =
  `Each digest is the first ${SHA256_PREFIX_LENGTH} hex characters of the file's sha256, and the ` +
  `comparison is of those prefixes.`;

/**
 * A measured digest as it arrived, classified. FOUR answers, never three.
 *
 * ⛔ NO TWO OF THESE MAY EVER BE MERGED.
 *   • `absent` — the key was not on the frame at all. A harness built before the
 *     key existed sends nothing, and so does one that failed before it could
 *     produce a status. Those two are INDISTINGUISHABLE from here, and
 *     `describeMissingDigest` below says exactly that rather than guessing. This
 *     is the only state that still hedges, and it hedges because it must.
 *   • `device-status` — the key was there and carried a token the device
 *     documented (`unreadable`, `nopath`). The device TOLD us why there is no
 *     digest; a finding names the reason and hedges nothing. Never compared.
 *   • `unreadable-value` — the key was there and its value is neither a digest
 *     nor a token we know. Something is wrong we cannot name, so the raw text is
 *     kept for the operator. Never compared, never trusted.
 *   • `measured` — twelve lowercase hex. The only state anything is compared on.
 */
export type MeasuredDigest =
  | { readonly state: 'absent' }
  | { readonly state: 'device-status'; readonly status: HarnessBinaryStatusToken }
  | { readonly state: 'unreadable-value'; readonly raw: string }
  | { readonly state: 'measured'; readonly sha256: string };

/**
 * One framework inside a readable `wc:…,wk:…,jsc:…` string. `missing` is the
 * device's own `absent` literal — it MEASURED that the framework is not at the
 * spawn path, which is a finding, not a gap in our data. That is why it is a
 * state of a READABLE value rather than a sibling of `MeasuredDigest.absent`.
 */
export type FrameworkDigest =
  | { readonly state: 'missing' }
  | { readonly state: 'measured'; readonly sha256: string };

/**
 * ⛔ A PER-PART STATUS TOKEN TAKES THE WHOLE TRIPLE OUT OF EVERY COMPARISON, and
 * `device-status` names WHICH parts carried it.
 *
 * It could not be a `FrameworkDigest` state instead, because then two devices
 * whose JavaScriptCore is unreadable would have to either compare EQUAL (a
 * fabricated agreement between two devices nobody measured) or compare UNEQUAL
 * to a hashed one (a fabricated drift finding). Neither is a thing we know. The
 * device told us it could not look; the honest answer is that this device is
 * outside the comparison, and finding (c) says why in the device's own words.
 *
 * Keeping the affected keys is what makes the report actionable: "the device
 * could not read JavaScriptCore" sends an operator to one file.
 */
export type MeasuredFrameworks =
  | { readonly state: 'absent' }
  | {
      readonly state: 'device-status';
      readonly status: WebkitFrameworkStatusToken;
      /** Which frameworks carried the token, in `WEBKIT_FRAMEWORK_KEYS` order. */
      readonly frameworks: readonly WebkitFrameworkKey[];
    }
  | { readonly state: 'unreadable-value'; readonly raw: string }
  | {
      readonly state: 'measured';
      readonly parts: Readonly<Record<WebkitFrameworkKey, FrameworkDigest>>;
    };

/**
 * Classify a `harnessBinarySha256` value. Never throws: a value that is not a
 * digest is RECORDED as unreadable, which is the whole contract — a decode that
 * threw would take the heartbeat's cpu, memory and session counts down with it,
 * and a decode that returned `absent` would report a broken device as an old one.
 */
export function decodeHarnessBinarySha256(raw: string | undefined | null): MeasuredDigest {
  if (raw === undefined || raw === null) return { state: 'absent' };
  if (SHA256_PREFIX_12.test(raw)) return { state: 'measured', sha256: raw };
  // ⛔ BY NAME, AND ONLY BY NAME. A token is recognised because the device team
  // documented that exact word, not because the value "looks like a status" —
  // a prefix or case-insensitive match here would silently promote a device bug
  // ("UNREADABLE\n", "no-path") into a confident finding about its filesystem.
  const status = HARNESS_BINARY_STATUS_TOKENS.find((token) => token === raw);
  if (status !== undefined) return { state: 'device-status', status };
  return { state: 'unreadable-value', raw };
}

/**
 * Classify a `webkitFrameworkSha256` value: `wc:<12hex>,wk:<12hex>,jsc:<12hex>`,
 * with the literal `absent` allowed per part.
 *
 * ⛔ THE WHOLE STRING FAILS TOGETHER, ON PURPOSE. A partly-parsed value — two
 * good parts and one we could not read — would be a digest triple that compares
 * EQUAL to another device on the parts that survived, and equality on a subset
 * of the evidence is exactly how a drift report goes quiet about real drift. If
 * any part, key, order or separator is not what the device documented, the value
 * is unreadable and is compared against nothing.
 */
export function decodeWebkitFrameworkSha256(raw: string | undefined | null): MeasuredFrameworks {
  if (raw === undefined || raw === null) return { state: 'absent' };
  const segments = raw.split(',');
  if (segments.length !== WEBKIT_FRAMEWORK_KEYS.length) return { state: 'unreadable-value', raw };
  const parts: Partial<Record<WebkitFrameworkKey, FrameworkDigest>> = {};
  // Collected in `WEBKIT_FRAMEWORK_KEYS` order because the loop runs in it —
  // the report must not reorder with the device's segment order.
  const statusParts: WebkitFrameworkKey[] = [];
  for (let index = 0; index < WEBKIT_FRAMEWORK_KEYS.length; index += 1) {
    const expectedKey = WEBKIT_FRAMEWORK_KEYS[index] as WebkitFrameworkKey;
    const segment = segments[index] as string;
    // `indexOf`, not `split(':')`: a value containing a colon must be REJECTED
    // rather than silently truncated to its first field.
    const separator = segment.indexOf(':');
    if (separator === -1) return { state: 'unreadable-value', raw };
    if (segment.slice(0, separator) !== expectedKey) return { state: 'unreadable-value', raw };
    const value = segment.slice(separator + 1);
    if (value === WEBKIT_FRAMEWORK_MISSING_LITERAL) {
      parts[expectedKey] = { state: 'missing' };
      continue;
    }
    if (WEBKIT_FRAMEWORK_STATUS_TOKENS.some((token) => token === value)) {
      statusParts.push(expectedKey);
      continue;
    }
    if (!SHA256_PREFIX_12.test(value)) return { state: 'unreadable-value', raw };
    parts[expectedKey] = { state: 'measured', sha256: value };
  }
  if (statusParts.length > 0) {
    // One part the device could not read makes the whole triple uncomparable —
    // the same "fails together" rule as a malformed part, for the same reason.
    // What is DIFFERENT is that we now know why, and can say so.
    return { state: 'device-status', status: 'unreadable', frameworks: statusParts };
  }
  return {
    state: 'measured',
    parts: parts as Readonly<Record<WebkitFrameworkKey, FrameworkDigest>>,
  };
}

/**
 * The comparable identity of one framework part: its digest, or the sentinel for
 * "the device measured this framework as not present".
 *
 * The sentinel is prefixed so it can never collide with a 12-hex digest — a
 * device whose WebKit is missing and one whose WebKit hashes to something must
 * compare UNEQUAL, and they would compare equal if "missing" were the empty string.
 */
const FRAMEWORK_MISSING_IDENTITY = '!missing';

function frameworkIdentity(part: FrameworkDigest): string {
  return part.state === 'missing' ? FRAMEWORK_MISSING_IDENTITY : part.sha256;
}

/**
 * The same value, for a HUMAN.
 *
 * ⛔ `!missing` IS A COMPARISON KEY AND WAS NEVER MEANT TO BE READ. It exists so
 * a missing framework cannot compare equal to a hashed one, and the `!` is there
 * precisely because no digest can contain it — which is exactly what makes it
 * unreadable as English. It reached the operator surface verbatim
 * ("WebCore (!missing vs aaaaaaaaaaaa)"), where it also CONTRADICTED the Fleet
 * page's own cell beside it, which renders the device's own word for the same
 * fact. One fact must not have two spellings on one screen, so the detail text
 * uses the device's literal and the comparison keeps the sentinel.
 */
function frameworkDisplay(identity: string): string {
  return identity === FRAMEWORK_MISSING_IDENTITY ? WEBKIT_FRAMEWORK_MISSING_LITERAL : identity;
}

export type FleetBuildDriftCode =
  /** (a) Same declared `harnessVersion`, different measured binary digests. */
  | 'harness_binary_drift'
  /** (b) Same declared `webkitForkBuild`, different measured framework digests. */
  | 'webkit_framework_drift'
  /** (c) A device declares a version but has no measured digest to check it against. */
  | 'measured_digest_missing'
  /**
   * (d) A live session's frameworks differ from its device's current heartbeat,
   * and the two observations are far enough apart that the device's 300 s cache
   * cannot explain it. NAMES THREE POSSIBLE CAUSES AND ASSERTS NONE: it used to
   * assert a redeploy, which was one of three readings of the same evidence.
   */
  | 'session_framework_drift';

export interface FleetBuildDriftFinding {
  readonly code: FleetBuildDriftCode;
  /** Which declared field this finding is about. */
  readonly declaredField: 'harnessVersion' | 'webkitForkBuild';
  /** The declared value the devices agree on (null when the finding is not a group). */
  readonly declaredValue: string | null;
  /** Every device the finding names, sorted. */
  readonly deviceIds: readonly string[];
  /** Every session the finding names, sorted. Empty for device-only findings. */
  readonly sessionIds: readonly string[];
  /** Which frameworks differ. Empty when the finding is not per-framework. */
  readonly frameworks: readonly WebkitFrameworkKey[];
  /** One sentence an operator can act on. Says what the data cannot tell, too. */
  readonly detail: string;
}

export interface FleetBuildDriftDeviceInput {
  /** Stable operator identity for the device — the fleet row id the panel keys on. */
  readonly deviceId: string;
  /** `harnessVersion` from the latest heartbeat. */
  readonly declaredHarnessVersion?: string | null;
  /** Raw `harnessBinarySha256` from the latest heartbeat. */
  readonly harnessBinarySha256?: string | null;
  /** Raw `webkitFrameworkSha256` from the latest heartbeat — what the NEXT session loads. */
  readonly webkitFrameworkSha256?: string | null;
  /**
   * The heartbeat's OWN timestamp (`beatAt`), ISO, as the device stamped it.
   *
   * ⛔ THE DEVICE'S CLOCK, NOT THE CONTROL PLANE'S RECEIPT TIME. It is compared
   * against a capability report's `timestamp`, which the same device stamped
   * from the same clock; pairing one device clock against a control-plane
   * arrival time would fold network and queue delay into a measurement whose
   * whole job is to decide whether a five-minute cache can explain a gap.
   *
   * Absent (an older snapshot, or no beat yet) means finding (d) has no time
   * basis for this device and does not fire. That is deliberate: see below.
   */
  readonly heartbeatAt?: string | null;
}

export interface FleetBuildDriftSessionInput {
  readonly sessionId: string;
  /** The device that reported this session's capability report. */
  readonly deviceId: string;
  /** `webkitForkBuild` from this session's capability report. */
  readonly declaredWebkitForkBuild?: string | null;
  /** Raw `webkitFrameworkSha256` — what THIS session was spawned from. */
  readonly webkitFrameworkSha256?: string | null;
  /**
   * The capability report's own timestamp (the device's clock).
   *
   * Two jobs, and they are separate: it picks a device's LATEST declaration, and
   * it is one half of finding (d)'s time basis. Absent, the declaration still
   * sorts (below every report that has one) but (d) does not fire.
   */
  readonly observedAt?: string | null;
}

export interface FleetBuildDriftDevice {
  readonly deviceId: string;
  readonly declaredHarnessVersion: string | null;
  readonly harnessBinary: MeasuredDigest;
  readonly frameworks: MeasuredFrameworks;
  /**
   * The declared fork build from this device's LATEST capability report.
   *
   * ⚠️ IT IS SESSION-SCOPED AND THE MEASUREMENT BESIDE IT IS NOT. `webkitForkBuild`
   * only ever rides a capability report, so the newest one a device sent is the
   * only declaration available for it — and a device redeployed since then keeps
   * showing the old declaration while its heartbeat digest has already moved.
   * That is not a defect in this pairing; it is the drift, and `session_framework_drift`
   * is what names it.
   */
  readonly declaredWebkitForkBuild: string | null;
  /** The codes of every finding this device appears in, sorted. */
  readonly flags: readonly FleetBuildDriftCode[];
}

export interface FleetBuildDrift {
  readonly devices: readonly FleetBuildDriftDevice[];
  readonly findings: readonly FleetBuildDriftFinding[];
}

/**
 * ⛔ (C) THE PER-DEVICE REDEPLOY NOTE IS NOT IMPLEMENTED, AND THAT IS THE ANSWER.
 *
 * The note asked for is: "frameworks redeployed; daemon still running the
 * earlier binary until it restarts". It is a real and useful fact — the device
 * team confirmed (2026-09-21) that `harnessBinarySha256` is hashed ONCE per
 * daemon process and cached for its lifetime, while the heartbeat's
 * `webkitFrameworkSha256` is refreshed within 300 s, so after a redeploy without
 * a restart the two legitimately describe different deploys.
 *
 * Saying it needs TWO observations of ONE device: a framework digest that
 * CHANGED beside a binary digest that did NOT. The control plane holds one.
 *
 * MEASURED 2026-09-21, not assumed:
 *   • `fleet_nodes.last_heartbeat` is a single jsonb column, overwritten whole
 *     by `DrizzleFleetNodesRepo.recordHeartbeat` on every beat (migration 0083).
 *     The previous value does not survive the next beat, and there is no
 *     heartbeat-history table anywhere in `apps/server/src/db/migrations`.
 *   • `SessionCapabilityReportStore` is an in-memory `Map` keyed by session id.
 *     It carries framework digests and never the harness binary digest, so it
 *     cannot supply the "and the binary did NOT change" half at all.
 *
 * A note written from one sample would fire on any device whose heartbeat
 * frameworks differ from some session's — which is exactly the unfounded
 * redeploy claim finding (d) was just narrowed to stop making. So this file
 * claims nothing, the Fleet page labels the two fields for what they are
 * instead, and the requirement below is recorded where the next reader is.
 */
export const FLEET_BUILD_DRIFT_REDEPLOY_NOTE_REQUIRES =
  'a stored previous value per device: the last harnessBinarySha256 and webkitFrameworkSha256 ' +
  'with the time each was first seen at its current value. The control plane keeps one ' +
  'overwritten heartbeat row per device, so it cannot see either field change.';

/** A declared value is only a group key when it actually says something. */
function declared(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * What an operator can and cannot conclude from a missing measurement.
 *
 * ⛔ THIS IS THE HONEST HALF OF FINDING (c). The device omits the key when it is
 * nil, and it is nil only when the executable could not be read — but a harness
 * built before the key existed also sends nothing at all. From the control plane
 * those two frames are byte-identical, so naming one of them would be a claim
 * made from no evidence. A value that arrived and did not parse IS
 * distinguishable, and is reported as its own thing.
 */
function describeMissingDigest(
  digest: MeasuredDigest | MeasuredFrameworks,
  what: string,
  /** The file the digest is OF, for the status sentence: "its executable". */
  subject: string,
  declaredField: string,
  declaredValue: string,
): string {
  if (digest.state === 'device-status') {
    // The device named the reason, so this sentence names it too. No hedge: the
    // two-way "we cannot tell an old build from a failure" below exists only for
    // a key that never arrived, and reusing it here would throw away the one
    // piece of evidence this whole token exists to carry.
    const named =
      'frameworks' in digest
        ? digest.frameworks.map((key) => WEBKIT_FRAMEWORK_LABELS[key]).join(', ')
        : subject;
    const reason = digest.status === 'nopath' ? `had no path to read` : `could not read`;
    return (
      `declares ${declaredField} ${declaredValue} and the device reports it ${reason} ${named}, ` +
      `so the declared value cannot be checked. That is the device's own status, not a value this ` +
      `control plane failed to parse`
    );
  }
  if (digest.state === 'unreadable-value') {
    return (
      `declares ${declaredField} ${declaredValue} and sent a ${what} value that is not a digest ` +
      `and not a status the device documented (${JSON.stringify(digest.raw)}); it is recorded as ` +
      `an unreadable value and compared against nothing`
    );
  }
  return (
    `declares ${declaredField} ${declaredValue} but sent no ${what}, so the declared value cannot ` +
    `be checked. The data cannot tell whether this is a harness built before the key existed or a ` +
    `running one that could not read the file: the device omits the key in both cases`
  );
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/**
 * The device re-hashes its frameworks on a file-stat change or every 300 s
 * (device team, 2026-09-21), so ANY framework digest we hold — on a heartbeat
 * or in a capability report — can be up to one lifetime old at the moment it
 * was stamped.
 */
export const WEBKIT_FRAMEWORK_CACHE_LIFETIME_MS = 300_000;

/**
 * ⛔ TWO CACHE LIFETIMES, AND THE SECOND ONE IS NOT PADDING.
 *
 * A session's framework value and its device's are each drawn from that 300 s
 * cache, so each is somewhere in a 300 s window ending at its own timestamp. Two
 * such windows can still overlap when the timestamps are up to 300 s apart —
 * which means a disagreement between them is fully explained by cache skew and
 * says nothing about the device. Only past 600 s are the two windows certainly
 * disjoint, and only then does the disagreement describe the world rather than
 * our sampling.
 *
 * Before this gate, finding (d) fired on ANY difference and asserted a redeploy.
 * Every session spawned in the five minutes around a legitimate refresh was a
 * false positive wearing a confident cause.
 */
export const SESSION_FRAMEWORK_DRIFT_MIN_GAP_MS = 2 * WEBKIT_FRAMEWORK_CACHE_LIFETIME_MS;

/**
 * ⛔ AN EXPLICIT ZONE, OR IT IS NOT A TIME BASIS.
 *
 * `Date.parse` reads an ISO date-time carrying NO offset as the parsing
 * PROCESS's local time (ES2015+), and a date-only string as UTC. So a pair where
 * one side ends in `Z` and the other does not is silently shifted by the
 * SERVER's UTC offset — up to 14 hours — and that is exactly how a 600-second
 * gate fabricates a gap and hangs three confident causes off it. It is not
 * hypothetical: the frame schema bounds `timestamp` as `z.string().min(1).max(64)`
 * and never validates its shape, so the two sides really can be spelled
 * differently.
 *
 * The whole reason finding (d) pairs `beatAt` with a report's `timestamp` is
 * that ONE device clock stamped both. A value whose zone this control plane had
 * to guess is not that value, so it is no time basis at all.
 */
const TIMESTAMP_WITH_EXPLICIT_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * An ISO timestamp as epoch ms, or null when there is no usable time.
 *
 * ⛔ NULL, NEVER 0 OR NaN. This feeds a "is the gap bigger than 600 s" test, and
 * a `Date.parse` NaN propagated into that comparison makes it false — which
 * reads as "recent enough, do not fire" and is the RIGHT answer by accident for
 * the wrong reason. The caller must be able to tell "no time basis" from "a time
 * basis that says no", because only the first is a gap in our data.
 */
function epochMs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const trimmed = iso.trim();
  if (trimmed === '' || !TIMESTAMP_WITH_EXPLICIT_ZONE.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * ⛔ A FINDING'S `detail` IS BOUNDED, AND THE BOUND IS PART OF THE CONTRACT.
 *
 * The admin panel validates every field of this payload before it renders any of
 * it, and a field that fails its bound throws — which does not degrade the drift
 * section, it fails the WHOLE Fleet page load, table included. So a detail string
 * that grows with the fleet is not a cosmetic problem: the drift report would
 * take down the page it lives on at exactly the moment the most devices disagree.
 *
 * Measured before this bound existed: 100 devices sharing one declared value,
 * each with a different digest, produced a 4,987-character detail and the panel's
 * 4,096 bound rejected the response. That is a cliff, not a gradient — 99 devices
 * rendered fine.
 *
 * Two defences, because the enumeration cap is arithmetic and the clamp is
 * structural: `listDigests` keeps the ENUMERATION short and honest ("and N
 * more" — never a silent truncation that reads as a complete list), and
 * `clampDetail` guarantees the bound for any sentence anyone writes here later.
 */
export const FLEET_BUILD_DRIFT_DETAIL_MAX_LENGTH = 2048;
/** How many distinct digests a sentence enumerates before it counts the rest. */
const MAX_ENUMERATED_DIGESTS = 6;

function listDigests(values: readonly string[], separator: string): string {
  if (values.length <= MAX_ENUMERATED_DIGESTS) return values.join(separator);
  const shown = values.slice(0, MAX_ENUMERATED_DIGESTS).join(separator);
  return `${shown}${separator}and ${values.length - MAX_ENUMERATED_DIGESTS} more`;
}

function clampDetail(detail: string): string {
  if (detail.length <= FLEET_BUILD_DRIFT_DETAIL_MAX_LENGTH) return detail;
  // The ellipsis is load-bearing: a clamped sentence must never read as a
  // complete one, or an operator counts the devices it names and believes it.
  return `${detail.slice(0, FLEET_BUILD_DRIFT_DETAIL_MAX_LENGTH - 1)}…`;
}

/**
 * The whole drift verdict for one fleet snapshot: four findings, one function,
 * no side effects.
 *
 * ⛔ A DEVICE WITH NOTHING TO COMPARE PRODUCES NO COMPARISON FINDING. Findings
 * (a), (b) and (d) are only ever raised between two MEASURED values. A device
 * whose digest is absent or unreadable is excluded from those groups and raised
 * under (c) instead, because "these two devices disagree" and "one of these
 * devices told us nothing" are different problems with different fixes, and
 * folding the second into the first is how a fleet report starts reporting its
 * own blind spots as drift.
 */
export function computeFleetBuildDrift(input: {
  readonly devices: readonly FleetBuildDriftDeviceInput[];
  readonly sessions?: readonly FleetBuildDriftSessionInput[];
}): FleetBuildDrift {
  const sessions = input.sessions ?? [];
  const findings: FleetBuildDriftFinding[] = [];
  const flagsByDevice = new Map<string, Set<FleetBuildDriftCode>>();

  const decoded = input.devices.map((device) => ({
    deviceId: device.deviceId,
    declaredHarnessVersion: declared(device.declaredHarnessVersion),
    harnessBinary: decodeHarnessBinarySha256(device.harnessBinarySha256),
    frameworks: decodeWebkitFrameworkSha256(device.webkitFrameworkSha256),
    heartbeatAtMs: epochMs(device.heartbeatAt),
  }));

  function flag(deviceId: string, code: FleetBuildDriftCode): void {
    const existing = flagsByDevice.get(deviceId);
    if (existing === undefined) flagsByDevice.set(deviceId, new Set([code]));
    else existing.add(code);
  }

  // The latest capability report per device decides that device's declared fork
  // build. Ties on the timestamp break on the session id so two operators reading
  // the same snapshot get the same answer; a report with no timestamp sorts below
  // every report that has one, rather than winning by arrival order.
  const latestReportByDevice = new Map<string, FleetBuildDriftSessionInput>();
  for (const session of sessions) {
    const incumbent = latestReportByDevice.get(session.deviceId);
    if (incumbent === undefined) {
      latestReportByDevice.set(session.deviceId, session);
      continue;
    }
    const a = session.observedAt ?? '';
    const b = incumbent.observedAt ?? '';
    if (a > b || (a === b && session.sessionId > incumbent.sessionId)) {
      latestReportByDevice.set(session.deviceId, session);
    }
  }
  const declaredForkBuildByDevice = new Map<string, string | null>();
  for (const device of decoded) {
    declaredForkBuildByDevice.set(
      device.deviceId,
      declared(latestReportByDevice.get(device.deviceId)?.declaredWebkitForkBuild),
    );
  }

  // ── (a) same declared harnessVersion, different measured binaries ──────
  const byHarnessVersion = new Map<string, typeof decoded>();
  for (const device of decoded) {
    if (device.declaredHarnessVersion === null) continue;
    const group = byHarnessVersion.get(device.declaredHarnessVersion);
    if (group === undefined) byHarnessVersion.set(device.declaredHarnessVersion, [device]);
    else group.push(device);
  }
  for (const declaredValue of sorted(byHarnessVersion.keys())) {
    const group = byHarnessVersion.get(declaredValue) as typeof decoded;
    const measured = group.filter((device) => device.harnessBinary.state === 'measured');
    const distinct = new Set(
      measured.map((device) =>
        device.harnessBinary.state === 'measured' ? device.harnessBinary.sha256 : '',
      ),
    );
    if (distinct.size < 2) continue;
    const deviceIds = sorted(measured.map((device) => device.deviceId));
    for (const deviceId of deviceIds) flag(deviceId, 'harness_binary_drift');
    findings.push({
      code: 'harness_binary_drift',
      declaredField: 'harnessVersion',
      declaredValue,
      deviceIds,
      sessionIds: [],
      frameworks: [],
      detail:
        `${deviceIds.length} devices declare harnessVersion ${declaredValue} but are running ` +
        `${distinct.size} different binaries (${listDigests(sorted(distinct), ', ')}). The declared value ` +
        `cannot be right for all of them. ${DIGEST_PREFIX_SENTENCE}`,
    });
  }

  // ── (b) same declared webkitForkBuild, different measured frameworks ───
  const byForkBuild = new Map<string, typeof decoded>();
  for (const device of decoded) {
    const forkBuild = declaredForkBuildByDevice.get(device.deviceId) ?? null;
    if (forkBuild === null) continue;
    const group = byForkBuild.get(forkBuild);
    if (group === undefined) byForkBuild.set(forkBuild, [device]);
    else group.push(device);
  }
  for (const declaredValue of sorted(byForkBuild.keys())) {
    const group = byForkBuild.get(declaredValue) as typeof decoded;
    const measured = group.filter((device) => device.frameworks.state === 'measured');
    if (measured.length < 2) continue;
    const differing: WebkitFrameworkKey[] = [];
    const perFramework = new Map<WebkitFrameworkKey, string[]>();
    for (const key of WEBKIT_FRAMEWORK_KEYS) {
      const identities = measured.map((device) =>
        device.frameworks.state === 'measured'
          ? frameworkIdentity(device.frameworks.parts[key])
          : '',
      );
      const distinct = new Set(identities);
      if (distinct.size >= 2) {
        differing.push(key);
        perFramework.set(key, sorted(distinct));
      }
    }
    if (differing.length === 0) continue;
    const deviceIds = sorted(measured.map((device) => device.deviceId));
    for (const deviceId of deviceIds) flag(deviceId, 'webkit_framework_drift');
    // ⛔ "THE OTHER FRAMEWORKS MATCH" IS A CLAIM, AND WITH ALL THREE DIFFERING
    // THERE IS NO OTHER FRAMEWORK FOR IT TO BE TRUE OF. An operator reads it as
    // "only part of the checkout moved" and goes looking for the part that did
    // not — a trip that does not exist. Said only when there is a remainder.
    const allFrameworksDiffer = differing.length === WEBKIT_FRAMEWORK_KEYS.length;
    const scopeSentence = allFrameworksDiffer
      ? `All three frameworks differ, so the declared value describes none of them.`
      : `The other frameworks match, so the declared value is wrong about exactly these.`;
    const named = differing
      .map(
        (key) =>
          `${WEBKIT_FRAMEWORK_LABELS[key]} (${listDigests(
            (perFramework.get(key) as string[]).map(frameworkDisplay),
            ' vs ',
          )})`,
      )
      .join('; ');
    findings.push({
      code: 'webkit_framework_drift',
      declaredField: 'webkitForkBuild',
      declaredValue,
      deviceIds,
      sessionIds: [],
      frameworks: differing,
      detail:
        `${deviceIds.length} devices declare webkitForkBuild ${declaredValue} but their measured ` +
        `frameworks differ: ${named}. ${scopeSentence} ${DIGEST_PREFIX_SENTENCE}`,
    });
  }

  // ── (c) a declared version with no measured digest to check it against ─
  //
  // ⛔ SORTED BEFORE IT IS PUBLISHED, like (a), (b) and (d). This is the one
  // finding raised per-device rather than per-group, so without a sort it comes
  // out in the caller's device order — and the caller is the fleet route, whose
  // `listActive()` orders by `lastSeenAt DESC`. That order changes with every
  // heartbeat, so the operator's findings list would reshuffle between two
  // refreshes that found exactly the same drift, which reads as movement where
  // there is none.
  const missingFindings: FleetBuildDriftFinding[] = [];
  for (const device of decoded) {
    if (device.declaredHarnessVersion !== null && device.harnessBinary.state !== 'measured') {
      flag(device.deviceId, 'measured_digest_missing');
      missingFindings.push({
        code: 'measured_digest_missing',
        declaredField: 'harnessVersion',
        declaredValue: device.declaredHarnessVersion,
        deviceIds: [device.deviceId],
        sessionIds: [],
        frameworks: [],
        detail: `${device.deviceId} ${describeMissingDigest(
          device.harnessBinary,
          'harness binary digest',
          'its executable',
          'harnessVersion',
          device.declaredHarnessVersion,
        )}.`,
      });
    }
    const forkBuild = declaredForkBuildByDevice.get(device.deviceId) ?? null;
    if (forkBuild !== null && device.frameworks.state !== 'measured') {
      flag(device.deviceId, 'measured_digest_missing');
      missingFindings.push({
        code: 'measured_digest_missing',
        declaredField: 'webkitForkBuild',
        declaredValue: forkBuild,
        deviceIds: [device.deviceId],
        sessionIds: [],
        frameworks: [],
        detail: `${device.deviceId} ${describeMissingDigest(
          device.frameworks,
          'framework digest',
          'its frameworks',
          'webkitForkBuild',
          forkBuild,
        )}.`,
      });
    }
  }
  missingFindings.sort(
    (a, b) =>
      (a.deviceIds[0] as string).localeCompare(b.deviceIds[0] as string) ||
      a.declaredField.localeCompare(b.declaredField),
  );
  findings.push(...missingFindings);

  // ── (d) a session's frameworks vs its device's current heartbeat ───────
  const deviceById = new Map(decoded.map((device) => [device.deviceId, device]));
  const sessionFindings: FleetBuildDriftFinding[] = [];
  for (const session of sessions) {
    const device = deviceById.get(session.deviceId);
    if (device === undefined) continue;
    const sessionFrameworks = decodeWebkitFrameworkSha256(session.webkitFrameworkSha256);
    // Only measured-against-measured. An absent, status-bearing or unparsable
    // value on either side is a gap in the evidence, not a disagreement, and
    // reporting it as one would put a verdict on a device nobody measured.
    if (sessionFrameworks.state !== 'measured' || device.frameworks.state !== 'measured') continue;
    // ⛔ NO TIME BASIS, NO FINDING. Both halves of this comparison come out of a
    // 300 s cache, so without both timestamps there is no way to tell a real
    // disagreement from two samples taken inside one refresh window — and a
    // finding that cannot tell those apart is a coin flip with a cause attached.
    const sessionAtMs = epochMs(session.observedAt);
    if (device.heartbeatAtMs === null || sessionAtMs === null) continue;
    const gapMs = Math.abs(device.heartbeatAtMs - sessionAtMs);
    // Absolute, not signed: a heartbeat stamped BEFORE the report separates the
    // two observations just as much as one stamped after, and the question this
    // gate asks is only whether the sampling windows can overlap.
    if (gapMs <= SESSION_FRAMEWORK_DRIFT_MIN_GAP_MS) continue;
    const differing: WebkitFrameworkKey[] = [];
    const named: string[] = [];
    for (const key of WEBKIT_FRAMEWORK_KEYS) {
      const inSession = frameworkIdentity(sessionFrameworks.parts[key]);
      const onDevice = frameworkIdentity(device.frameworks.parts[key]);
      if (inSession === onDevice) continue;
      differing.push(key);
      named.push(
        `${WEBKIT_FRAMEWORK_LABELS[key]} (session ${frameworkDisplay(inSession)}, ` +
          `device ${frameworkDisplay(onDevice)})`,
      );
    }
    if (differing.length === 0) continue;
    flag(device.deviceId, 'session_framework_drift');
    // ⛔ THE DECLARED FORK BUILD IS OPTIONAL ON A CAPABILITY REPORT, so the
    // closing sentence cannot presume one. It used to say "this session's
    // declared webkitForkBuild cannot describe both…" on a session that declared
    // nothing at all — a verdict on a field that never arrived.
    const declaredForkBuild = declared(session.declaredWebkitForkBuild);
    sessionFindings.push({
      code: 'session_framework_drift',
      declaredField: 'webkitForkBuild',
      declaredValue: declaredForkBuild,
      deviceIds: [device.deviceId],
      sessionIds: [session.sessionId],
      frameworks: differing,
      // ⛔ CAUSE 1 SAYS "BETWEEN THE TWO OBSERVATIONS", NEVER "AFTER THIS
      // SESSION WAS SPAWNED". The gate is an ABSOLUTE distance, so this finding
      // also fires when the heartbeat is the OLDER of the two — and there the
      // replacement happened BEFORE the session was spawned. The old wording
      // named an order the data does not establish, and named the wrong one on
      // half the arms it fires for.
      detail:
        `session ${session.sessionId} reports frameworks its device ${device.deviceId} does not: ` +
        `${named.join('; ')}. The two observations are ${Math.round(gapMs / 1000)} seconds apart, ` +
        `longer than the two ${WEBKIT_FRAMEWORK_CACHE_LIFETIME_MS / 1000}-second caches they are ` +
        `drawn from, so refresh timing alone does not explain it. Three things can, and this ` +
        `report cannot tell them apart: the device's frameworks on disk were replaced between the ` +
        `two observations; this session resolves its framework path differently from the ` +
        `device (an override), so the two were never the same file; or one of the two timestamps ` +
        `is wrong and the gap is not real. ${
          declaredForkBuild === null
            ? `This session declared no webkitForkBuild, so there is no declared build here to ` +
              `check either measurement against.`
            : `Whichever it is, this session's declared webkitForkBuild cannot describe both what ` +
              `it runs and what the device would load next.`
        }`,
    });
  }
  sessionFindings.sort((a, b) =>
    (a.sessionIds[0] as string).localeCompare(b.sessionIds[0] as string),
  );
  findings.push(...sessionFindings);

  const devices: FleetBuildDriftDevice[] = decoded
    .map((device) => ({
      deviceId: device.deviceId,
      declaredHarnessVersion: device.declaredHarnessVersion,
      harnessBinary: device.harnessBinary,
      frameworks: device.frameworks,
      declaredWebkitForkBuild: declaredForkBuildByDevice.get(device.deviceId) ?? null,
      flags: sorted(flagsByDevice.get(device.deviceId) ?? []) as FleetBuildDriftCode[],
    }))
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));

  // The structural half of the detail bound: applied ONCE, at the only exit, so
  // it cannot be forgotten by whoever adds the fifth finding.
  const bounded = findings.map((finding) =>
    finding.detail.length <= FLEET_BUILD_DRIFT_DETAIL_MAX_LENGTH
      ? finding
      : { ...finding, detail: clampDetail(finding.detail) },
  );

  return { devices, findings: bounded };
}
