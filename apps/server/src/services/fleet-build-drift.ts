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
 * ⛔ TWELVE LOWERCASE HEX, ANCHORED, AND NOTHING ELSE. The device produces these
 * with `shasum -a 256 <file> | cut -c1-12`, so uppercase, a full 64-char digest,
 * a `sha256:` prefix or a trailing newline are all values this repo did not ask
 * for — and a digest comparison is only sound if both sides were produced the
 * same way. A loose test here would let `ABC…` and `abc…` read as two different
 * builds of the same binary, which is a fabricated drift finding.
 */
const SHA256_PREFIX_12 = /^[0-9a-f]{12}$/;

/**
 * A measured digest as it arrived, classified.
 *
 * ⛔ `absent` AND `unreadable` ARE NOT THE SAME ANSWER and must never be merged.
 *   • `absent` — the key was not on the frame. The producer omits it when nil,
 *     and nil means the file could not be read; but a harness built before the
 *     key existed also sends nothing. Those two are INDISTINGUISHABLE from here,
 *     and `describeMissingDigest` below says exactly that rather than guessing.
 *   • `unreadable` — the key WAS there and its value is not a digest this repo
 *     can compare. That is a third, distinguishable state: something is wrong at
 *     the device, we know it, and the raw text is kept so an operator can see
 *     what arrived. It is never compared and never trusted.
 */
export type MeasuredDigest =
  | { readonly state: 'absent' }
  | { readonly state: 'unreadable'; readonly raw: string }
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

export type MeasuredFrameworks =
  | { readonly state: 'absent' }
  | { readonly state: 'unreadable'; readonly raw: string }
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
  return { state: 'unreadable', raw };
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
  if (segments.length !== WEBKIT_FRAMEWORK_KEYS.length) return { state: 'unreadable', raw };
  const parts: Partial<Record<WebkitFrameworkKey, FrameworkDigest>> = {};
  for (let index = 0; index < WEBKIT_FRAMEWORK_KEYS.length; index += 1) {
    const expectedKey = WEBKIT_FRAMEWORK_KEYS[index] as WebkitFrameworkKey;
    const segment = segments[index] as string;
    // `indexOf`, not `split(':')`: a value containing a colon must be REJECTED
    // rather than silently truncated to its first field.
    const separator = segment.indexOf(':');
    if (separator === -1) return { state: 'unreadable', raw };
    if (segment.slice(0, separator) !== expectedKey) return { state: 'unreadable', raw };
    const value = segment.slice(separator + 1);
    if (value === WEBKIT_FRAMEWORK_MISSING_LITERAL) {
      parts[expectedKey] = { state: 'missing' };
      continue;
    }
    if (!SHA256_PREFIX_12.test(value)) return { state: 'unreadable', raw };
    parts[expectedKey] = { state: 'measured', sha256: value };
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
  /** (d) A live session's frameworks differ from its device's current heartbeat. */
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
}

export interface FleetBuildDriftSessionInput {
  readonly sessionId: string;
  /** The device that reported this session's capability report. */
  readonly deviceId: string;
  /** `webkitForkBuild` from this session's capability report. */
  readonly declaredWebkitForkBuild?: string | null;
  /** Raw `webkitFrameworkSha256` — what THIS session was spawned from. */
  readonly webkitFrameworkSha256?: string | null;
  /** The report's own timestamp, used only to pick a device's latest declaration. */
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
  declaredField: string,
  declaredValue: string,
): string {
  if (digest.state === 'unreadable') {
    return (
      `declares ${declaredField} ${declaredValue} and sent a ${what} value that is not a digest ` +
      `(${JSON.stringify(digest.raw)}); it is recorded as unreadable and compared against nothing`
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
        `cannot be right for all of them.`,
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
        `frameworks differ: ${named}. The other frameworks match, so the declared value is wrong ` +
        `about exactly these.`,
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
    // Only measured-against-measured. An absent or unreadable value on either
    // side is a gap in the evidence, not a disagreement, and reporting it as one
    // would put a redeploy verdict on a device nobody measured.
    if (sessionFrameworks.state !== 'measured' || device.frameworks.state !== 'measured') continue;
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
    sessionFindings.push({
      code: 'session_framework_drift',
      declaredField: 'webkitForkBuild',
      declaredValue: declared(session.declaredWebkitForkBuild),
      deviceIds: [device.deviceId],
      sessionIds: [session.sessionId],
      frameworks: differing,
      detail:
        `session ${session.sessionId} was spawned from frameworks its device ${device.deviceId} ` +
        `no longer reports: ${named.join('; ')}. The device was redeployed under a live session, ` +
        `so this session's declared webkitForkBuild describes neither what it runs nor what the ` +
        `device would load next.`,
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
