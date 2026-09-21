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
  FLEET_BUILD_DRIFT_REDEPLOY_NOTE_REQUIRES,
  SESSION_FRAMEWORK_DRIFT_MIN_GAP_MS,
  SHA256_PREFIX_LENGTH,
  WEBKIT_FRAMEWORK_CACHE_LIFETIME_MS,
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

  it('CRITICAL absent and unreadable-value are DIFFERENT answers', () => {
    // The whole of finding (c) rests on this: a key that never arrived cannot be
    // told apart from an old build, and a key that arrived malformed can.
    expect(decodeHarnessBinarySha256(undefined)).toEqual({ state: 'absent' });
    expect(decodeHarnessBinarySha256(null)).toEqual({ state: 'absent' });
    expect(decodeHarnessBinarySha256('not-a-digest')).toEqual({
      state: 'unreadable-value',
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
      expect(decoded.state, `${JSON.stringify(raw)} must not be trusted`).toBe('unreadable-value');
    }
  });

  it('NEGATIVE CONTROL — uppercase is not the same digest as lowercase', () => {
    // `cut -c1-12` of `shasum` is lowercase. Accepting uppercase would let one
    // build read as two, which is a FABRICATED drift finding.
    expect(decodeHarnessBinarySha256('AAAAAAAAAAAA').state).toBe('unreadable-value');
  });

  // ── (A) STATUS TOKENS (device team, 2026-09-21) ───────────────────────
  it('CRITICAL the device’s own status tokens are recognised BY NAME', () => {
    // These arrive in the digest field because the protocol is additive. Before
    // this they were "a value that is not a digest" and the finding hedged about
    // them exactly as it hedged about a key that never arrived — throwing away
    // the one piece of evidence the token exists to carry.
    expect(decodeHarnessBinarySha256('unreadable')).toEqual({
      state: 'device-status',
      status: 'unreadable',
    });
    expect(decodeHarnessBinarySha256('nopath')).toEqual({
      state: 'device-status',
      status: 'nopath',
    });
  });

  it('CRITICAL a status token is NOT a measurement and is never compared', () => {
    // If `unreadable` ever became a comparable identity, two devices that both
    // failed to read their executable would agree about a binary neither of them
    // hashed — an agreement invented out of two failures.
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', declaredHarnessVersion: 'v9', harnessBinarySha256: 'unreadable' },
        { deviceId: 'n2', declaredHarnessVersion: 'v9', harnessBinarySha256: 'unreadable' },
        { deviceId: 'n3', declaredHarnessVersion: 'v9', harnessBinarySha256: A },
      ],
    });
    expect(drift.findings.filter((f) => f.code === 'harness_binary_drift')).toEqual([]);
    expect(
      drift.findings.filter((f) => f.code === 'measured_digest_missing').map((f) => f.deviceIds[0]),
    ).toEqual(['n1', 'n2']);
  });

  it('NEGATIVE CONTROL — only the exact tokens count; a near miss stays unreadable-value', () => {
    // A prefix or case-insensitive match would promote a device bug into a
    // confident claim about that device's filesystem.
    for (const near of ['UNREADABLE', 'unreadable\n', 'no-path', 'nopath ', 'unreadablex']) {
      expect(decodeHarnessBinarySha256(near), near).toEqual({
        state: 'unreadable-value',
        raw: near,
      });
    }
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

  it('CRITICAL one bad part makes the WHOLE value an unreadable-value', () => {
    // A partly-parsed triple compares EQUAL on the parts that survived, and
    // equality on a subset of the evidence is how a drift report goes quiet.
    const raw = `wc:${A},wk:zzzzzzzzzzzz,jsc:${C}`;
    expect(decodeWebkitFrameworkSha256(raw)).toEqual({ state: 'unreadable-value', raw });
  });

  it('NEGATIVE CONTROL — wrong key, wrong order, wrong arity are all refused', () => {
    const refused = 'unreadable-value';
    expect(decodeWebkitFrameworkSha256(`webcore:${A},wk:${B},jsc:${C}`).state).toBe(refused);
    expect(decodeWebkitFrameworkSha256(`wk:${A},wc:${B},jsc:${C}`).state).toBe(refused);
    expect(decodeWebkitFrameworkSha256(`wc:${A},wk:${B}`).state).toBe(refused);
    expect(decodeWebkitFrameworkSha256(`wc:${A},wk:${B},jsc:${C},x:${D}`).state).toBe(refused);
    expect(decodeWebkitFrameworkSha256(`wc${A},wk:${B},jsc:${C}`).state).toBe(refused);
    expect(decodeWebkitFrameworkSha256(undefined).state).toBe('absent');
  });

  it('NEGATIVE CONTROL — a value with an extra colon is refused, not truncated', () => {
    expect(decodeWebkitFrameworkSha256(`wc:${A}:x,wk:${B},jsc:${C}`).state).toBe(
      'unreadable-value',
    );
  });

  // ── (A) PER-PART STATUS TOKENS ────────────────────────────────────────
  it('CRITICAL a per-part `unreadable` names WHICH frameworks the device could not read', () => {
    expect(decodeWebkitFrameworkSha256(`wc:unreadable,wk:${B},jsc:unreadable`)).toEqual({
      state: 'device-status',
      status: 'unreadable',
      frameworks: ['wc', 'jsc'],
    });
  });

  it('CRITICAL the named parts follow OUR key order, not the device’s segment order', () => {
    // A report whose framework list reordered with the wire would make a diff of
    // two reports unreadable for a fact that did not change.
    expect(decodeWebkitFrameworkSha256(`wc:unreadable,wk:unreadable,jsc:unreadable`)).toMatchObject(
      { frameworks: ['wc', 'wk', 'jsc'] },
    );
  });

  it('CRITICAL `absent` is still a MEASUREMENT and `unreadable` is still not', () => {
    // The device looked and the framework is not there (comparable) versus the
    // device could not look (comparable to nothing). Collapsing these would let
    // a box that failed to read its WebCore read as a box whose WebCore is gone.
    expect(decodeWebkitFrameworkSha256(fw('absent', B, C)).state).toBe('measured');
    expect(decodeWebkitFrameworkSha256(fw('unreadable', B, C)).state).toBe('device-status');
  });

  it('NEGATIVE CONTROL — a malformed part still wins over a status part', () => {
    // A triple carrying both a token and something we cannot read at all is not
    // "the device told us about one framework"; it is a value to distrust whole.
    expect(decodeWebkitFrameworkSha256(`wc:unreadable,wk:zzz,jsc:${C}`).state).toBe(
      'unreadable-value',
    );
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

  it('CRITICAL with ALL THREE differing it does NOT claim the others match', () => {
    // "The other frameworks match, so the declared value is wrong about exactly
    // these" is a claim, and with every framework differing there is no other
    // framework for it to be true of. An operator reads it as "only part of the
    // checkout moved" and goes looking for the part that did not — a trip that
    // does not exist.
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C) },
        { deviceId: 'n2', webkitFrameworkSha256: fw(B, C, D) },
      ],
      sessions: [
        { sessionId: 's1', deviceId: 'n1', declaredWebkitForkBuild: 'fork-7' },
        { sessionId: 's2', deviceId: 'n2', declaredWebkitForkBuild: 'fork-7' },
      ],
    });
    const finding = drift.findings.find((f) => f.code === 'webkit_framework_drift');
    expect(finding?.frameworks).toEqual(['wc', 'wk', 'jsc']);
    expect(finding?.detail, 'there is no remainder to say this about').not.toContain(
      'other frameworks match',
    );
    expect(finding?.detail).toContain('All three frameworks differ');
    // …and the prefix sentence (E) survives the branch.
    expect(finding?.detail).toContain('prefixes');
  });

  it('NEGATIVE CONTROL — with a remainder it still SAYS the others match', () => {
    // Without this the branch above could be printed unconditionally, and the
    // "only JavaScriptCore moved" case would lose the sentence that tells an
    // operator the rest of the checkout is accounted for.
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
    expect(finding?.detail).toContain('The other frameworks match');
    expect(finding?.detail).not.toContain('All three frameworks differ');
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

  it('CRITICAL an UNREADABLE VALUE is reported as its own, distinguishable thing', () => {
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

  // ── (A) A STATUS TOKEN LETS THE FINDING SAY WHAT HAPPENED ─────────────
  it('CRITICAL a device that could not read its executable is SAID so, not hedged', () => {
    const drift = computeFleetBuildDrift({
      devices: [
        { deviceId: 'n1', declaredHarnessVersion: 'v9', harnessBinarySha256: 'unreadable' },
      ],
    });
    const finding = drift.findings.find((f) => f.code === 'measured_digest_missing');
    expect(finding?.detail).toContain('could not read its executable');
    expect(finding?.detail, 'the device told us; there is nothing to hedge').not.toContain(
      'cannot tell',
    );
    // And it is not confused with a value we merely failed to parse.
    expect(finding?.detail).not.toContain('not a digest');
  });

  it('CRITICAL `nopath` says there was no path, which is a different trip for an operator', () => {
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', declaredHarnessVersion: 'v9', harnessBinarySha256: 'nopath' }],
    });
    const finding = drift.findings.find((f) => f.code === 'measured_digest_missing');
    expect(finding?.detail).toContain('had no path to read its executable');
    expect(finding?.detail).not.toContain('could not read');
  });

  it('CRITICAL an unreadable framework part names the FRAMEWORK, not "the frameworks"', () => {
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: `wc:${A},wk:${B},jsc:unreadable` }],
      sessions: [{ sessionId: 's1', deviceId: 'n1', declaredWebkitForkBuild: 'fork-7' }],
    });
    const finding = drift.findings.find(
      (f) => f.code === 'measured_digest_missing' && f.declaredField === 'webkitForkBuild',
    );
    expect(finding?.detail).toContain('could not read JavaScriptCore');
    expect(finding?.detail).not.toContain('WebCore');
    expect(finding?.detail).not.toContain('cannot tell');
  });

  it('NEGATIVE CONTROL — an OMITTED key keeps the two-way hedge it has always had', () => {
    // The tokens must not have quietly taught the absent case to guess. A build
    // that predates the key and one that failed before it could send a status
    // are still byte-identical from here.
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', declaredHarnessVersion: 'v9' }],
    });
    const finding = drift.findings.find((f) => f.code === 'measured_digest_missing');
    expect(finding?.detail).toContain('cannot tell');
    expect(finding?.detail).toContain('before the key existed');
    expect(finding?.detail).not.toContain('the device reports');
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
  // ⛔ THE DEVICE'S 300-SECOND CACHE IS THE REASON THIS FINDING NEEDS A CLOCK.
  // Device team, 2026-09-21: a session's framework value is set ONCE at spawn
  // from the same 300 s cache the heartbeat reads, so a session and its device
  // can disagree for three reasons that have nothing to do with a redeploy —
  // an override on the session's framework path, a device value up to 5 minutes
  // stale, and a session snapshot that predates its own spawn by up to 5
  // minutes. Two samples inside one refresh window prove none of them.
  const HEARTBEAT_AT = '2026-09-19T19:10:00.000Z';
  /** 15 minutes before the beat — two cache lifetimes clear of it. */
  const OLD_REPORT_AT = '2026-09-19T18:55:00.000Z';
  /** Inside the window: 8 minutes is under the 600 s gate. */
  const RECENT_REPORT_AT = '2026-09-19T19:02:00.000Z';

  function drifting(session: Record<string, unknown>) {
    return computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, D), heartbeatAt: HEARTBEAT_AT }],
      sessions: [
        {
          sessionId: 'agt_live',
          deviceId: 'n1',
          declaredWebkitForkBuild: 'fork-7',
          webkitFrameworkSha256: fw(A, B, C),
          ...session,
        },
      ],
    });
  }

  it('CRITICAL is flagged when the two observations are past two cache lifetimes, naming the framework', () => {
    const drift = drifting({ observedAt: OLD_REPORT_AT });
    const finding = drift.findings.find((f) => f.code === 'session_framework_drift');
    expect(finding?.sessionIds).toEqual(['agt_live']);
    expect(finding?.deviceIds).toEqual(['n1']);
    expect(finding?.frameworks).toEqual(['jsc']);
    expect(drift.devices[0]?.flags).toContain('session_framework_drift');
  });

  it('CRITICAL the detail names THREE causes and asserts none of them', () => {
    // It used to say "The device was redeployed under a live session" — one
    // reading of evidence that fits three, stated as fact and badged as fact.
    const finding = drifting({ observedAt: OLD_REPORT_AT }).findings.find(
      (f) => f.code === 'session_framework_drift',
    );
    expect(finding?.detail, 'cause 1 — the frameworks on disk changed').toContain('replaced');
    expect(finding?.detail, 'cause 2 — the session resolves a different path').toContain(
      'an override',
    );
    expect(finding?.detail, 'cause 3 — a timestamp is wrong').toContain('timestamps');
    expect(finding?.detail, 'and it says it cannot choose between them').toContain(
      'cannot tell them apart',
    );
    // The old assertion must be gone, not merely softened somewhere else.
    expect(finding?.detail).not.toContain('was redeployed');
    // It shows the gap it relied on, so an operator can check the reasoning.
    expect(finding?.detail).toContain('900 seconds apart');
  });

  it('CRITICAL NOT flagged when the gap is inside two cache lifetimes', () => {
    // The whole narrowing. Before it, every session spawned in the ten minutes
    // around a legitimate framework refresh was a false positive with a cause.
    expect(
      drifting({ observedAt: RECENT_REPORT_AT }).findings.filter(
        (f) => f.code === 'session_framework_drift',
      ),
    ).toEqual([]);
  });

  it('the gate is exactly TWO device cache lifetimes, not a round number', () => {
    // If the device team changes the 300 s refresh, the threshold has to move
    // with it. Pinning the relation rather than the literal is what makes that
    // one edit instead of two, one of which gets forgotten.
    expect(SESSION_FRAMEWORK_DRIFT_MIN_GAP_MS).toBe(2 * WEBKIT_FRAMEWORK_CACHE_LIFETIME_MS);
    expect(WEBKIT_FRAMEWORK_CACHE_LIFETIME_MS).toBe(300_000);
  });

  it('CRITICAL exactly 600 seconds does NOT fire — the gate is "longer than", not "at least"', () => {
    // At exactly two lifetimes the two 300 s sampling windows still touch, so
    // cache skew is still a complete explanation.
    const exactly = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, D), heartbeatAt: HEARTBEAT_AT }],
      sessions: [
        {
          sessionId: 'agt_live',
          deviceId: 'n1',
          webkitFrameworkSha256: fw(A, B, C),
          observedAt: '2026-09-19T19:00:00.000Z',
        },
      ],
    });
    expect(exactly.findings.filter((f) => f.code === 'session_framework_drift')).toEqual([]);
  });

  it('CRITICAL a MISSING timestamp on either side fires nothing at all', () => {
    // No time basis is not "recent enough". It is no evidence, and the finding
    // that would have been raised carries a cause an operator would act on.
    const noHeartbeatTime = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, D) }],
      sessions: [
        {
          sessionId: 'agt_live',
          deviceId: 'n1',
          webkitFrameworkSha256: fw(A, B, C),
          observedAt: OLD_REPORT_AT,
        },
      ],
    });
    const noReportTime = drifting({});
    const unparsableTime = drifting({ observedAt: 'yesterday' });
    for (const drift of [noHeartbeatTime, noReportTime, unparsableTime]) {
      expect(drift.findings.filter((f) => f.code === 'session_framework_drift')).toEqual([]);
    }
  });

  it('a heartbeat stamped BEFORE the report separates the observations just as much', () => {
    // The gate asks whether the two sampling windows can overlap, which is a
    // question about distance, not order.
    const drift = computeFleetBuildDrift({
      devices: [
        {
          deviceId: 'n1',
          webkitFrameworkSha256: fw(A, B, D),
          heartbeatAt: '2026-09-19T18:00:00.000Z',
        },
      ],
      sessions: [
        {
          sessionId: 'agt_live',
          deviceId: 'n1',
          webkitFrameworkSha256: fw(A, B, C),
          observedAt: '2026-09-19T19:00:00.000Z',
        },
      ],
    });
    expect(drift.findings.filter((f) => f.code === 'session_framework_drift')).toHaveLength(1);
  });

  it('NEGATIVE CONTROL — a session matching its device is NOT flagged, however old', () => {
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C), heartbeatAt: HEARTBEAT_AT }],
      sessions: [
        {
          sessionId: 'agt_live',
          deviceId: 'n1',
          webkitFrameworkSha256: fw(A, B, C),
          observedAt: OLD_REPORT_AT,
        },
      ],
    });
    expect(drift.findings.filter((f) => f.code === 'session_framework_drift')).toEqual([]);
  });

  it('CRITICAL an absent, status-bearing or unparsable value on either side invents NO verdict', () => {
    // A gap in the evidence is not a disagreement. Reporting it as one would put
    // a verdict on a device nobody measured.
    const base = { observedAt: OLD_REPORT_AT };
    const noSessionValue = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C), heartbeatAt: HEARTBEAT_AT }],
      sessions: [{ sessionId: 'agt_live', deviceId: 'n1', ...base }],
    });
    const unparsableSession = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C), heartbeatAt: HEARTBEAT_AT }],
      sessions: [
        { sessionId: 'agt_live', deviceId: 'n1', webkitFrameworkSha256: 'nonsense', ...base },
      ],
    });
    const statusSession = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C), heartbeatAt: HEARTBEAT_AT }],
      sessions: [
        {
          sessionId: 'agt_live',
          deviceId: 'n1',
          webkitFrameworkSha256: `wc:unreadable,wk:${B},jsc:${C}`,
          ...base,
        },
      ],
    });
    const noDeviceValue = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', heartbeatAt: HEARTBEAT_AT }],
      sessions: [
        { sessionId: 'agt_live', deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C), ...base },
      ],
    });
    for (const drift of [noSessionValue, unparsableSession, statusSession, noDeviceValue]) {
      expect(drift.findings.filter((f) => f.code === 'session_framework_drift')).toEqual([]);
    }
  });

  it('CRITICAL the detail names no ORDER of events — the gate is a distance', () => {
    // ⛔ THE HALF OF (d) THAT WAS STILL A CAUSE ASSERTED FROM NO EVIDENCE. The
    // gate is `Math.abs`, so this finding also fires when the HEARTBEAT is the
    // older of the two — and there the frameworks changed BEFORE the session
    // was spawned, the opposite of what the old sentence said. One wording has
    // to be true of both arms, so it names neither order.
    const heartbeatOlder = computeFleetBuildDrift({
      devices: [
        {
          deviceId: 'n1',
          webkitFrameworkSha256: fw(A, B, D),
          heartbeatAt: '2026-09-19T18:00:00.000Z',
        },
      ],
      sessions: [
        {
          sessionId: 'agt_live',
          deviceId: 'n1',
          declaredWebkitForkBuild: 'fork-7',
          webkitFrameworkSha256: fw(A, B, C),
          observedAt: '2026-09-19T19:00:00.000Z',
        },
      ],
    });
    const heartbeatNewer = drifting({ observedAt: OLD_REPORT_AT });
    for (const drift of [heartbeatOlder, heartbeatNewer]) {
      const finding = drift.findings.find((f) => f.code === 'session_framework_drift');
      expect(finding?.detail).toContain('replaced between the two observations');
      expect(finding?.detail, 'an order this report cannot establish').not.toContain(
        'after this session was spawned',
      );
      // The other two causes and the refusal to choose survive both arms.
      expect(finding?.detail).toContain('an override');
      expect(finding?.detail).toContain('cannot tell them apart');
    }
  });

  it('CRITICAL a session that declared NO fork build is not told its declaration is wrong', () => {
    // `webkitForkBuild` is optional on a capability report. The closing sentence
    // used to say "this session's declared webkitForkBuild cannot describe both…"
    // whether or not one had ever arrived — a verdict on a field that is absent.
    const finding = drifting({
      observedAt: OLD_REPORT_AT,
      declaredWebkitForkBuild: undefined,
    }).findings.find((f) => f.code === 'session_framework_drift');
    expect(finding?.declaredValue).toBeNull();
    expect(finding?.detail).toContain('declared no webkitForkBuild');
    expect(finding?.detail).not.toContain("this session's declared webkitForkBuild cannot");
    // NEGATIVE CONTROL — a session that DID declare one still gets that sentence.
    const declaredOne = drifting({ observedAt: OLD_REPORT_AT }).findings.find(
      (f) => f.code === 'session_framework_drift',
    );
    expect(declaredOne?.detail).toContain("this session's declared webkitForkBuild cannot");
    expect(declaredOne?.detail).not.toContain('declared no webkitForkBuild');
  });

  it('CRITICAL a timestamp with NO ZONE is no time basis, not a local-time guess', () => {
    // ⛔ `Date.parse` reads an ISO date-time with no offset as the SERVER's local
    // time and a date-only string as UTC, and the frame schema bounds `timestamp`
    // as a plain string without validating its shape. A pair spelled differently
    // is therefore shifted by this process's UTC offset — up to 14 hours — which
    // is a fabricated gap wearing three confident causes. The pairing is only
    // sound because ONE device clock stamped both; a value whose zone we had to
    // guess is not that value.
    const zoneless = ['2026-09-19T18:55:00.000', '2026-09-19', '19:00:00'];
    for (const stamp of zoneless) {
      expect(
        drifting({ observedAt: stamp }).findings.filter(
          (f) => f.code === 'session_framework_drift',
        ),
        stamp,
      ).toEqual([]);
      const noZoneOnTheBeat = computeFleetBuildDrift({
        devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, D), heartbeatAt: stamp }],
        sessions: [
          {
            sessionId: 'agt_live',
            deviceId: 'n1',
            webkitFrameworkSha256: fw(A, B, C),
            observedAt: OLD_REPORT_AT,
          },
        ],
      });
      expect(
        noZoneOnTheBeat.findings.filter((f) => f.code === 'session_framework_drift'),
        stamp,
      ).toEqual([]);
    }
    // NEGATIVE CONTROL — an explicit NUMERIC offset is a real time basis and
    // still fires, so this is a zone requirement and not a `Z`-only literal.
    const offset = computeFleetBuildDrift({
      devices: [
        {
          deviceId: 'n1',
          webkitFrameworkSha256: fw(A, B, D),
          heartbeatAt: '2026-09-19T21:10:00.000+02:00',
        },
      ],
      sessions: [
        {
          sessionId: 'agt_live',
          deviceId: 'n1',
          webkitFrameworkSha256: fw(A, B, C),
          observedAt: OLD_REPORT_AT,
        },
      ],
    });
    // 21:10+02:00 IS 19:10Z, so the gap is the same 900 seconds as the Z-spelled
    // arm — the offset is honoured, not stripped.
    expect(offset.findings.find((f) => f.code === 'session_framework_drift')?.detail).toContain(
      '900 seconds apart',
    );
  });

  it('a session whose device is not in the fleet snapshot is dropped, never re-attributed', () => {
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', webkitFrameworkSha256: fw(A, B, C), heartbeatAt: HEARTBEAT_AT }],
      sessions: [
        {
          sessionId: 'agt_live',
          deviceId: 'gone',
          webkitFrameworkSha256: fw(D, D, D),
          observedAt: OLD_REPORT_AT,
        },
      ],
    });
    expect(drift.findings).toEqual([]);
  });
});

// ── (C) THE REDEPLOY NOTE THIS REPORT REFUSES TO WRITE ──────────────────
//
// Asked for: a per-device note saying "frameworks redeployed; daemon still
// running the earlier binary until it restarts". It is true of a real situation
// — the daemon hashes its binary once per process, the frameworks refresh within
// 300 s — but saying it about a PARTICULAR device needs two observations of that
// device, and `fleet_nodes.last_heartbeat` is one jsonb column overwritten whole
// by every beat. `SessionCapabilityReportStore` cannot fill the gap either: it
// holds framework digests and never the harness binary digest.
//
// So the note is not written, the Fleet page labels the two fields instead, and
// these arms pin the refusal — because the failure mode of adding it anyway is
// silent: it would fire on every device, always, and look like a working feature.
describe('the report never infers a redeploy from a single snapshot', () => {
  it('CRITICAL no finding asserts that a device was redeployed', () => {
    const drift = computeFleetBuildDrift({
      devices: [
        {
          deviceId: 'n1',
          declaredHarnessVersion: 'v9',
          harnessBinarySha256: A,
          webkitFrameworkSha256: fw(A, B, D),
          heartbeatAt: '2026-09-19T19:10:00.000Z',
        },
      ],
      sessions: [
        {
          sessionId: 'agt_live',
          deviceId: 'n1',
          declaredWebkitForkBuild: 'fork-7',
          webkitFrameworkSha256: fw(A, B, C),
          observedAt: '2026-09-19T18:00:00.000Z',
        },
      ],
    });
    expect(drift.findings.length, 'this input DOES raise (d)').toBeGreaterThan(0);
    for (const finding of drift.findings) {
      expect(finding.detail, finding.code).not.toMatch(/\bwas redeployed\b/);
      expect(finding.detail, finding.code).not.toMatch(/\bdaemon still running\b/);
    }
  });

  it('CRITICAL the missing input is named, so the note cannot be added without it', () => {
    // A greppable statement of the blocker, not a TODO: the next reader learns
    // what data would make the note sound rather than that someone meant to.
    expect(FLEET_BUILD_DRIFT_REDEPLOY_NOTE_REQUIRES).toContain('stored previous value');
    expect(FLEET_BUILD_DRIFT_REDEPLOY_NOTE_REQUIRES).toContain('harnessBinarySha256');
    expect(FLEET_BUILD_DRIFT_REDEPLOY_NOTE_REQUIRES).toContain('first seen');
  });
});

// ── (E) THE DIGESTS ARE PREFIXES AND THE FINDINGS SAY SO ────────────────
describe('a comparison finding says it is comparing 12-character prefixes', () => {
  it('CRITICAL (a) and (b) both name the prefix length and the comparison', () => {
    // 48 bits, not a whole sha256. An operator reading "different binaries
    // (aaaaaaaaaaaa, bbbbbbbbbbbb)" has no way to know that from the digests.
    const drift = computeFleetBuildDrift({
      devices: [
        {
          deviceId: 'n1',
          declaredHarnessVersion: 'v9',
          harnessBinarySha256: A,
          webkitFrameworkSha256: fw(A, B, C),
        },
        {
          deviceId: 'n2',
          declaredHarnessVersion: 'v9',
          harnessBinarySha256: B,
          webkitFrameworkSha256: fw(A, B, D),
        },
      ],
      sessions: [
        { sessionId: 's1', deviceId: 'n1', declaredWebkitForkBuild: 'fork-7' },
        { sessionId: 's2', deviceId: 'n2', declaredWebkitForkBuild: 'fork-7' },
      ],
    });
    const codes = ['harness_binary_drift', 'webkit_framework_drift'];
    for (const code of codes) {
      const finding = drift.findings.find((f) => f.code === code);
      expect(finding, code).toBeDefined();
      expect(finding?.detail, code).toContain(`first ${SHA256_PREFIX_LENGTH} hex characters`);
      expect(finding?.detail, code).toContain('comparison is of those prefixes');
    }
  });

  it('NEGATIVE CONTROL — the sentence does not leak into findings that compare nothing', () => {
    // (c) reports a device with no measurement at all. A prefix sentence there
    // would describe a comparison that did not happen.
    const drift = computeFleetBuildDrift({
      devices: [{ deviceId: 'n1', declaredHarnessVersion: 'v9' }],
    });
    const finding = drift.findings.find((f) => f.code === 'measured_digest_missing');
    expect(finding?.detail).not.toContain('hex characters');
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
      // Timestamps two cache lifetimes apart, because (d) now needs a time basis.
      devices: [
        {
          deviceId: 'n1',
          webkitFrameworkSha256: fw('absent', B, C),
          heartbeatAt: '2026-09-19T19:10:00.000Z',
        },
      ],
      sessions: [
        {
          sessionId: 'agt_live',
          deviceId: 'n1',
          webkitFrameworkSha256: fw(A, B, C),
          observedAt: '2026-09-19T18:55:00.000Z',
        },
      ],
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

  it('CRITICAL the bound covers (c) and (d) too, not only the two group findings', () => {
    // The clamp is applied once at the function's only exit, which is what makes
    // it true of findings nobody has written yet. `fleetOf` above raises only
    // (a) and (b), so without this arm the newest two findings were covered by
    // reasoning rather than by a measurement.
    const long = 'z'.repeat(2000);
    const drift = computeFleetBuildDrift({
      devices: [
        {
          deviceId: `device-${long}`,
          declaredHarnessVersion: `v-${long}`,
          harnessBinarySha256: `garbage-${long}`,
          webkitFrameworkSha256: fw(A, B, D),
          heartbeatAt: '2026-09-19T19:10:00.000Z',
        },
      ],
      sessions: [
        {
          sessionId: `session-${long}`,
          deviceId: `device-${long}`,
          declaredWebkitForkBuild: `fork-${long}`,
          webkitFrameworkSha256: fw(A, B, C),
          observedAt: '2026-09-19T18:55:00.000Z',
        },
      ],
    });
    const codes = drift.findings.map((f) => f.code);
    expect(codes, 'both of the newer findings are exercised').toContain('measured_digest_missing');
    expect(codes).toContain('session_framework_drift');
    for (const finding of drift.findings) {
      expect(finding.detail.length, finding.code).toBeLessThanOrEqual(
        FLEET_BUILD_DRIFT_DETAIL_MAX_LENGTH,
      );
    }
    // A clamped sentence SAYS it was clamped, so an operator never reads a
    // truncated finding as a complete one.
    const clamped = drift.findings.filter(
      (f) => f.detail.length === FLEET_BUILD_DRIFT_DETAIL_MAX_LENGTH,
    );
    expect(clamped.length, 'this input really does overflow').toBeGreaterThan(0);
    for (const finding of clamped) expect(finding.detail.endsWith('…'), finding.code).toBe(true);
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
