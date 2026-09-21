// The declared-vs-measured build report (A3 2026-09-19 ~18:45Z / ~19:10Z).
//
// The device team added two MEASURED keys because the DECLARED ones beside them
// were caught lying: `harnessVersion` named a commit the running binary was not
// built from, and `webkitForkBuild` names a checkout 20 commits behind the real
// build. Every assertion below is about a contradiction the declared value alone
// could not expose — and, just as important, about the contradictions this
// function must REFUSE to invent when it has nothing to compare.

import { describe, expect, it } from 'vitest';
import {
  computeFleetBuildDrift,
  decodeHarnessBinarySha256,
  decodeWebkitFrameworkSha256,
  FLEET_BUILD_DRIFT_DETAIL_MAX_LENGTH,
} from '../../src/services/fleet-build-drift.js';

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
const C = 'cccccccccccc';
const D = 'dddddddddddd';

function fw(wc: string, wk: string, jsc: string): string {
  return `wc:${wc},wk:${wk},jsc:${jsc}`;
}

describe('decodeHarnessBinarySha256', () => {
  it('reads a 12-lowercase-hex prefix as measured', () => {
    expect(decodeHarnessBinarySha256('88d2d0da2f01')).toEqual({
      state: 'measured',
      sha256: '88d2d0da2f01',
    });
  });

  it('CRITICAL absent and unreadable are DIFFERENT answers', () => {
    // The whole of finding (c) rests on this: a key that never arrived cannot be
    // told apart from an old build, and a key that arrived malformed can.
    expect(decodeHarnessBinarySha256(undefined)).toEqual({ state: 'absent' });
    expect(decodeHarnessBinarySha256(null)).toEqual({ state: 'absent' });
    expect(decodeHarnessBinarySha256('not-a-digest')).toEqual({
      state: 'unreadable',
      raw: 'not-a-digest',
    });
  });

  it('CRITICAL never throws, and never trusts a value it cannot compare', () => {
    // A decode that threw would take the beat's cpu/memory/session counts with it.
    for (const raw of [
      '',
      'AAAAAAAAAAAA',
      'aaaaaaaaaaa',
      'aaaaaaaaaaaaa',
      ' aaaaaaaaaaaa',
      'sha256:aaaaaaaaaaaa',
    ]) {
      const decoded = decodeHarnessBinarySha256(raw);
      expect(decoded.state, `${JSON.stringify(raw)} must not be trusted`).toBe('unreadable');
    }
  });

  it('NEGATIVE CONTROL — uppercase is not the same digest as lowercase', () => {
    // `cut -c1-12` of `shasum` is lowercase. Accepting uppercase would let one
    // build read as two, which is a FABRICATED drift finding.
    expect(decodeHarnessBinarySha256('AAAAAAAAAAAA').state).toBe('unreadable');
  });
});

describe('decodeWebkitFrameworkSha256', () => {
  it('splits the three parts, and `absent` is a measurement', () => {
    expect(decodeWebkitFrameworkSha256(fw(A, B, 'absent'))).toEqual({
      state: 'measured',
      parts: {
        wc: { state: 'measured', sha256: A },
        wk: { state: 'measured', sha256: B },
        jsc: { state: 'missing' },
      },
    });
  });

  it('CRITICAL one bad part makes the WHOLE value unreadable', () => {
    // A partly-parsed triple compares EQUAL on the parts that survived, and
    // equality on a subset of the evidence is how a drift report goes quiet.
    const raw = `wc:${A},wk:zzzzzzzzzzzz,jsc:${C}`;
    expect(decodeWebkitFrameworkSha256(raw)).toEqual({ state: 'unreadable', raw });
  });

  it('NEGATIVE CONTROL — wrong key, wrong order, wrong arity are all refused', () => {
    expect(decodeWebkitFrameworkSha256(`webcore:${A},wk:${B},jsc:${C}`).state).toBe('unreadable');
    expect(decodeWebkitFrameworkSha256(`wk:${A},wc:${B},jsc:${C}`).state).toBe('unreadable');
    expect(decodeWebkitFrameworkSha256(`wc:${A},wk:${B}`).state).toBe('unreadable');
    expect(decodeWebkitFrameworkSha256(`wc:${A},wk:${B},jsc:${C},x:${D}`).state).toBe('unreadable');
    expect(decodeWebkitFrameworkSha256(`wc${A},wk:${B},jsc:${C}`).state).toBe('unreadable');
    expect(decodeWebkitFrameworkSha256(undefined).state).toBe('absent');
  });

  it('NEGATIVE CONTROL — a value with an extra colon is refused, not truncated', () => {
    expect(decodeWebkitFrameworkSha256(`wc:${A}:x,wk:${B},jsc:${C}`).state).toBe('unreadable');
  });
});

describe('(a) two devices declaring one harnessVersion and running two binaries', () => {
  it('CRITICAL is flagged, and names every device in the group', () => {
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', declaredHarnessVersion: 'v9', harnessBinarySha256: A },
        { deviceId: 'n2', declaredHarnessVersion: 'v9', harnessBinarySha256: B },
      ],
    });
    const finding = drift.findings.find((f) => f.code === 'harness_binary_drift');
    expect(finding, 'the contradiction the declared field cannot reveal').toBeDefined();
    expect(finding?.declaredValue).toBe('v9');
    expect(finding?.deviceIds).toEqual(['n1', 'n2']);
    expect(finding?.detail).toContain(A);
    expect(finding?.detail).toContain(B);
    expect(drift.devices.every((d) => d.flags.includes('harness_binary_drift'))).toBe(true);
  });

  it('NEGATIVE CONTROL — the same binary under the same declared version is NOT drift', () => {
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', declaredHarnessVersion: 'v9', harnessBinarySha256: A },
        { deviceId: 'n2', declaredHarnessVersion: 'v9', harnessBinarySha256: A },
      ],
    });
    expect(drift.findings.filter((f) => f.code === 'harness_binary_drift')).toEqual([]);
  });

  it('NEGATIVE CONTROL — different declared versions with different binaries is the NORMAL case', () => {
    // Two devices on two builds is a fleet mid-rollout, not a contradiction.
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', declaredHarnessVersion: 'v9', harnessBinarySha256: A },
        { deviceId: 'n2', declaredHarnessVersion: 'v10', harnessBinarySha256: B },
      ],
    });
    expect(drift.findings.filter((f) => f.code === 'harness_binary_drift')).toEqual([]);
  });

  it('CRITICAL a device with no measured digest is NOT counted as disagreeing', () => {
    // It is raised under (c) instead. Folding "we were told nothing" into "these
    // two disagree" would report the report's own blind spot as drift.
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', declaredHarnessVersion: 'v9', harnessBinarySha256: A },
        { deviceId: 'n2', declaredHarnessVersion: 'v9' },
      ],
    });
    expect(drift.findings.filter((f) => f.code === 'harness_binary_drift')).toEqual([]);
    expect(drift.findings.some((f) => f.code === 'measured_digest_missing')).toBe(true);
  });
});

describe('(b) one declared webkitForkBuild, different measured frameworks', () => {
  it('CRITICAL names WHICH framework drifted and leaves the matching ones out', () => {
    // A3's actual finding: the box's JavaScriptCore was five days older than its
    // WebCore. One combined digest could only have said "something moved".
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) },
        { deviceId: 'n2', webkitFrameworkSha256: fw(A, B, D) },
      ],
      sessions: [
        { sessionId: 's1', deviceId: 'n1', declaredWebkitForkBuild: 'fork-7' },
        { sessionId: 's2', deviceId: 'n2', declaredWebkitForkBuild: 'fork-7' },
      ],
    });
    const finding = drift.findings.find((f) => f.code === 'webkit_framework_drift');
    expect(finding?.frameworks, 'only JavaScriptCore moved').toEqual(['jsc']);
    expect(finding?.detail).toContain('JavaScriptCore');
    expect(finding?.detail).not.toContain('WebCore');
    expect(finding?.declaredValue).toBe('fork-7');
  });

  it('CRITICAL a framework MISSING on one device and present on another is drift', () => {
    // `absent` is a measurement, so it must compare UNEQUAL to a digest rather
    // than collapsing into "nothing to compare".
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) },
        { deviceId: 'n2', webkitFrameworkSha256: fw(A, B, 'absent') },
      ],
      sessions: [
        { sessionId: 's1', deviceId: 'n1', declaredWebkitForkBuild: 'fork-7' },
        { sessionId: 's2', deviceId: 'n2', declaredWebkitForkBuild: 'fork-7' },
      ],
    });
    expect(drift.findings.find((f) => f.code === 'webkit_framework_drift')?.frameworks).toEqual([
      'jsc',
    ]);
  });

  it('NEGATIVE CONTROL — identical frameworks under one fork build is NOT drift', () => {
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) },
        { deviceId: 'n2', webkitFrameworkSha256: fw(A, B, C) },
      ],
      sessions: [
        { sessionId: 's1', deviceId: 'n1', declaredWebkitForkBuild: 'fork-7' },
        { sessionId: 's2', deviceId: 'n2', declaredWebkitForkBuild: 'fork-7' },
      ],
    });
    expect(drift.findings.filter((f) => f.code === 'webkit_framework_drift')).toEqual([]);
  });

  it('a device with no capability report has no declared fork build to group by', () => {
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) },
        { deviceId: 'n2', webkitFrameworkSha256: fw(A, B, D) },
      ],
    });
    expect(drift.findings).toEqual([]);
    expect(drift.devices[0]?.declaredWebkitForkBuild).toBeNull();
  });

  it('the LATEST capability report decides a device’s declared fork build', () => {
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) }],
      sessions: [
        {
          sessionId: 's-old',
          deviceId: 'n1',
          declaredWebkitForkBuild: 'fork-6',
          observedAt: '2026-09-19T10:00:00.000Z',
        },
        {
          sessionId: 's-new',
          deviceId: 'n1',
          declaredWebkitForkBuild: 'fork-7',
          observedAt: '2026-09-19T11:00:00.000Z',
        },
      ],
    });
    expect(drift.devices[0]?.declaredWebkitForkBuild).toBe('fork-7');
  });
});

describe('(c) a declared version with no measured digest to check it against', () => {
  it('CRITICAL says what the data CANNOT tell apart', () => {
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', declaredHarnessVersion: 'v9' }],
    });
    const finding = drift.findings.find((f) => f.code === 'measured_digest_missing');
    expect(finding?.deviceIds).toEqual(['n1']);
    // The device omits the key when the file could not be read AND when the build
    // predates the key. Naming one of them would be a claim from no evidence.
    expect(finding?.detail).toContain('cannot tell');
    expect(finding?.detail).toContain('before the key existed');
  });

  it('CRITICAL an UNREADABLE value is reported as its own, distinguishable thing', () => {
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', declaredHarnessVersion: 'v9', harnessBinarySha256: 'garbage' }],
    });
    const finding = drift.findings.find((f) => f.code === 'measured_digest_missing');
    expect(finding?.detail).toContain('not a digest');
    expect(finding?.detail).toContain('garbage');
    expect(finding?.detail, 'this case IS distinguishable — do not hedge it').not.toContain(
      'cannot tell',
    );
  });

  it('covers the framework digest too, under its own declared field', () => {
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1' }],
      sessions: [{ sessionId: 's1', deviceId: 'n1', declaredWebkitForkBuild: 'fork-7' }],
    });
    const finding = drift.findings.find(
      (f) => f.code === 'measured_digest_missing' && f.declaredField === 'webkitForkBuild',
    );
    expect(finding?.declaredValue).toBe('fork-7');
  });

  it('NEGATIVE CONTROL — a measured digest raises nothing, and neither does a device that declares nothing', () => {
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', declaredHarnessVersion: 'v9', harnessBinarySha256: A },
        { deviceId: 'n2', harnessBinarySha256: B },
        // An empty declared string is not a declaration.
        { deviceId: 'n3', declaredHarnessVersion: '   ' },
      ],
    });
    expect(drift.findings).toEqual([]);
  });
});

describe('(d) a session whose frameworks differ from its device’s current heartbeat', () => {
  it('CRITICAL is flagged as a redeploy under a live session, naming the framework', () => {
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, D) }],
      sessions: [
        {
          sessionId: 'agt_live',
          deviceId: 'n1',
          declaredWebkitForkBuild: 'fork-7',
          webkitFrameworkSha256: fw(A, B, C),
        },
      ],
    });
    const finding = drift.findings.find((f) => f.code === 'session_framework_drift');
    expect(finding?.sessionIds).toEqual(['agt_live']);
    expect(finding?.deviceIds).toEqual(['n1']);
    expect(finding?.frameworks).toEqual(['jsc']);
    expect(finding?.detail).toContain('redeployed under a live session');
    expect(drift.devices[0]?.flags).toContain('session_framework_drift');
  });

  it('NEGATIVE CONTROL — a session matching its device is NOT flagged', () => {
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) }],
      sessions: [{ sessionId: 'agt_live', deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) }],
    });
    expect(drift.findings.filter((f) => f.code === 'session_framework_drift')).toEqual([]);
  });

  it('CRITICAL an absent or unreadable value on either side invents NO verdict', () => {
    // A gap in the evidence is not a disagreement. Reporting it as one would put
    // a redeploy verdict on a device nobody measured.
    const noSessionValue = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) }],
      sessions: [{ sessionId: 'agt_live', deviceId: 'n1' }],
    });
    const unreadableSession = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) }],
      sessions: [{ sessionId: 'agt_live', deviceId: 'n1', webkitFrameworkSha256: 'nonsense' }],
    });
    const noDeviceValue = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1' }],
      sessions: [{ sessionId: 'agt_live', deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) }],
    });
    for (const drift of [noSessionValue, unreadableSession, noDeviceValue]) {
      expect(drift.findings.filter((f) => f.code === 'session_framework_drift')).toEqual([]);
    }
  });

  it('a session whose device is not in the fleet snapshot is dropped, never re-attributed', () => {
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) }],
      sessions: [{ sessionId: 'agt_live', deviceId: 'gone', webkitFrameworkSha256: fw(D, D, D) }],
    });
    expect(drift.findings).toEqual([]);
  });
});

describe('the report is pure and deterministic', () => {
  it('CRITICAL the same snapshot gives byte-identical output, in a stable order', () => {
    // Two operators reading one fleet must get one answer; an order that depended
    // on Map insertion would make a diff of two reports unreadable.
    const input = {
      devices: [
        { deviceId: 'n2', declaredHarnessVersion: 'v9', harnessBinarySha256: B },
        { deviceId: 'n1', declaredHarnessVersion: 'v9', harnessBinarySha256: A },
      ],
      sessions: [
        { sessionId: 's2', deviceId: 'n2', webkitFrameworkSha256: fw(A, B, C) },
        { sessionId: 's1', deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) },
      ],
    };
    const first = JSON.stringify(computeFleetBuildDrift(input));
    const second = JSON.stringify(computeFleetBuildDrift(input));
    expect(first).toBe(second);
    expect(computeFleetBuildDrift(input).devices.map((d) => d.deviceId)).toEqual(['n1', 'n2']);
  });

  it('an empty fleet produces an empty report, not an error', () => {
    expect(computeFleetBuildDrift({ devices: [] })).toEqual({ devices: [], findings: [] });
  });
});

// ── REVIEW FIXES (2026-09-20) ───────────────────────────────────────────
//
// Three defects found by reading the rendered output rather than the code, all
// three invisible to a small fleet and all three worse the more drift there is.

describe('a finding never renders an internal comparison key', () => {
  it("CRITICAL a MISSING framework reads as the device's own word, not the `!missing` sentinel", () => {
    // `!missing` exists so a framework that is not at the spawn path cannot
    // compare equal to a hashed one, and the `!` is chosen precisely because no
    // digest can contain it. It was reaching the operator's screen verbatim —
    // and contradicting the Fleet cell beside it, which prints `absent`.
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', webkitFrameworkSha256: fw('absent', B, C) },
        { deviceId: 'n2', webkitFrameworkSha256: fw(A, B, C) },
      ],
      sessions: [
        { sessionId: 's1', deviceId: 'n1', declaredWebkitForkBuild: 'fork-7' },
        { sessionId: 's2', deviceId: 'n2', declaredWebkitForkBuild: 'fork-7' },
      ],
    });
    const finding = drift.findings.find((f) => f.code === 'webkit_framework_drift');
    expect(finding?.detail).toContain('WebCore (absent vs aaaaaaaaaaaa)');
    for (const f of drift.findings) expect(f.detail).not.toContain('!missing');
  });

  it('CRITICAL the same holds for the session-vs-device finding', () => {
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw('absent', B, C) }],
      sessions: [{ sessionId: 'agt_live', deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) }],
    });
    const finding = drift.findings.find((f) => f.code === 'session_framework_drift');
    expect(finding?.detail).toContain('device absent');
    expect(finding?.detail).not.toContain('!missing');
  });

  it('NEGATIVE CONTROL — a MISSING framework still compares UNEQUAL to a hashed one', () => {
    // The display change must not have collapsed the two into one string: a
    // device whose WebCore is gone and one whose WebCore hashes to something are
    // a real disagreement, and renaming the sentinel must not silence it.
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', webkitFrameworkSha256: fw('absent', B, C) },
        { deviceId: 'n2', webkitFrameworkSha256: fw(A, B, C) },
      ],
      sessions: [
        { sessionId: 's1', deviceId: 'n1', declaredWebkitForkBuild: 'fork-7' },
        { sessionId: 's2', deviceId: 'n2', declaredWebkitForkBuild: 'fork-7' },
      ],
    });
    expect(drift.findings.some((f) => f.code === 'webkit_framework_drift')).toBe(true);
    // …and two devices that are BOTH missing the same framework still agree.
    const agree = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', webkitFrameworkSha256: fw('absent', B, C) },
        { deviceId: 'n2', webkitFrameworkSha256: fw('absent', B, C) },
      ],
      sessions: [
        { sessionId: 's1', deviceId: 'n1', declaredWebkitForkBuild: 'fork-7' },
        { sessionId: 's2', deviceId: 'n2', declaredWebkitForkBuild: 'fork-7' },
      ],
    });
    expect(agree.findings).toEqual([]);
  });
});

describe("a finding's detail is bounded, whatever the fleet does", () => {
  // ⛔ THIS IS AN AVAILABILITY ARM, NOT A COSMETIC ONE. The admin panel validates
  // every field of this payload before rendering ANY of it, and a `detail` over
  // its bound throws — which fails the whole Fleet page load, table included. So
  // an unbounded detail meant the drift report took down the page it lives on at
  // exactly the moment the most devices disagreed. Measured before the fix: 100
  // devices → 4,987 characters, over the panel's 4,096 bound. 99 rendered fine.
  function fleetOf(count: number) {
    const devices = Array.from({ length: count }, (_, i) => {
      const hex = i.toString(16).padStart(12, '0');
      return {
        deviceId: `n${i}`,
        declaredHarnessVersion: 'v9',
        harnessBinarySha256: hex,
        webkitFrameworkSha256: fw(hex, (i + 1000).toString(16).padStart(12, '0'), C),
      };
    });
    return {
      devices,
      sessions: devices.map((d, i) => ({
        sessionId: `s${i}`,
        deviceId: d.deviceId,
        declaredWebkitForkBuild: 'fork-7',
        webkitFrameworkSha256: d.webkitFrameworkSha256,
      })),
    };
  }

  it('CRITICAL 300 devices, all disagreeing, still produce details the panel accepts', () => {
    const drift = computeFleetBuildDrift(fleetOf(300));
    expect(drift.findings.length).toBeGreaterThan(0);
    for (const finding of drift.findings) {
      expect(finding.detail.length).toBeLessThanOrEqual(FLEET_BUILD_DRIFT_DETAIL_MAX_LENGTH);
      // The panel's own bound, which this must stay under by construction.
      expect(finding.detail.length).toBeLessThanOrEqual(4096);
    }
  });

  it('CRITICAL a truncated enumeration SAYS it is truncated — it never reads as the whole list', () => {
    // A clipped list that looks complete is worse than a long one: an operator
    // counts the digests it names and concludes the fleet has that many builds.
    const drift = computeFleetBuildDrift(fleetOf(40));
    const binary = drift.findings.find((f) => f.code === 'harness_binary_drift');
    expect(binary?.detail).toContain('40 different binaries');
    expect(binary?.detail).toMatch(/and \d+ more/);
  });

  it('NEGATIVE CONTROL — a small fleet is NOT truncated and lists every digest', () => {
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', declaredHarnessVersion: 'v9', harnessBinarySha256: A },
        { deviceId: 'n2', declaredHarnessVersion: 'v9', harnessBinarySha256: B },
        { deviceId: 'n3', declaredHarnessVersion: 'v9', harnessBinarySha256: C },
      ],
    });
    const binary = drift.findings.find((f) => f.code === 'harness_binary_drift');
    expect(binary?.detail).toContain(A);
    expect(binary?.detail).toContain(B);
    expect(binary?.detail).toContain(C);
    expect(binary?.detail).not.toContain('more');
  });
});

describe('finding order does not move when the fleet merely beats', () => {
  it("CRITICAL (c) is sorted by device, not left in the caller's row order", () => {
    // The caller is the fleet route, whose listActive() orders by lastSeenAt
    // DESC — an order that changes with every heartbeat. Without a sort the
    // operator's findings list reshuffles between two refreshes that found
    // exactly the same drift, which reads as movement where there is none.
    const devices = [
      { deviceId: 'n3', declaredHarnessVersion: 'v9' },
      { deviceId: 'n1', declaredHarnessVersion: 'v9' },
      { deviceId: 'n2', declaredHarnessVersion: 'v9' },
    ];
    const forward = computeFleetBuildDrift({ devices });
    const reversed = computeFleetBuildDrift({ devices: [...devices].reverse() });
    expect(forward.findings.map((f) => f.deviceIds[0])).toEqual(['n1', 'n2', 'n3']);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });
});
