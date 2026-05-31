import { describe, expect, it } from 'vitest';
import { scheduleRecaptureBatch } from '../src/scheduler.js';
import type { IosVersionTransition, RecaptureRun, RecaptureStatus } from '../src/types.js';

const TRANSITION: IosVersionTransition = {
  fromIosVersion: '18.7',
  toIosVersion: '18.8',
  detectedAtMs: 1_000,
  source: 'release-notes',
};

function makeRun(opts: {
  archetypeId: string;
  targetIos: string;
  status?: RecaptureStatus;
  matchCount?: number;
  diffCount?: number;
  errorCount?: number;
}): RecaptureRun {
  return {
    id: `run-${opts.archetypeId}`,
    trigger: 'ios_version_bump',
    archetypeId: opts.archetypeId,
    baselineVersion: { iosVersion: '18.7', safariVersion: '26.4' },
    targetVersion: { iosVersion: opts.targetIos, safariVersion: '26.4' },
    status: opts.status ?? 'completed',
    comparisons: [],
    matchCount: opts.matchCount ?? 0,
    diffCount: opts.diffCount ?? 0,
    errorCount: opts.errorCount ?? 0,
    newSurfaceCount: 0,
    missingSurfaceCount: 0,
    startedAtMs: 100,
    completedAtMs: 200,
    createdAtMs: 50,
  };
}

describe('V-533.C scheduleRecaptureBatch — basic priority assignment', () => {
  it('archetype with no run history → HIGH', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      archetypeHistory: [{ archetypeId: 'arch1', latestRun: null }],
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.priority).toBe('high');
    expect(result.entries[0]?.reason).toContain('never captured');
  });

  it('archetype with prior run on older version → HIGH', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      archetypeHistory: [
        {
          archetypeId: 'arch1',
          latestRun: makeRun({
            archetypeId: 'arch1',
            targetIos: '18.7',
            matchCount: 100,
          }),
        },
      ],
    });
    expect(result.entries[0]?.priority).toBe('high');
    expect(result.entries[0]?.reason).toContain('not yet captured against 18.8');
  });

  it('archetype with healthy run on target version → MEDIUM', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      archetypeHistory: [
        {
          archetypeId: 'arch1',
          latestRun: makeRun({
            archetypeId: 'arch1',
            targetIos: '18.8',
            matchCount: 100,
            diffCount: 1,
          }),
        },
      ],
    });
    expect(result.entries[0]?.priority).toBe('medium');
    expect(result.entries[0]?.reason).toContain('healthy');
  });

  it('archetype with drifting prior run on target → LOW', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      archetypeHistory: [
        {
          archetypeId: 'arch1',
          latestRun: makeRun({
            archetypeId: 'arch1',
            targetIos: '18.8',
            matchCount: 60,
            diffCount: 40,
          }),
        },
      ],
    });
    expect(result.entries[0]?.priority).toBe('low');
    expect(result.entries[0]?.reason).toContain('drift');
  });

  it('archetype with high error-rate prior run on target → LOW', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      archetypeHistory: [
        {
          archetypeId: 'arch1',
          latestRun: makeRun({
            archetypeId: 'arch1',
            targetIos: '18.8',
            matchCount: 50,
            errorCount: 50,
          }),
        },
      ],
    });
    expect(result.entries[0]?.priority).toBe('low');
    expect(result.entries[0]?.reason).toContain('error rate');
  });

  it('archetype with failed prior run on target → HIGH (retry)', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      archetypeHistory: [
        {
          archetypeId: 'arch1',
          latestRun: makeRun({
            archetypeId: 'arch1',
            targetIos: '18.8',
            status: 'failed',
            matchCount: 95,
            diffCount: 5,
          }),
        },
      ],
    });
    expect(result.entries[0]?.priority).toBe('high');
    expect(result.entries[0]?.reason).toContain('retry');
  });

  // Regression (2026-05-31): a failed/cancelled run with FEW/ZERO matches
  // must still be HIGH retry. Pre-fix the `matchRate < driftingThreshold`
  // branch ran before the status check, so a typical failed run (low match
  // count → matchRate 0) was mis-scheduled LOW "drift suspected" instead of
  // retried; only a failed run with matchRate >= threshold (the test above)
  // reached the HIGH path.
  it('failed prior run on target with ZERO counts → HIGH (retry), not LOW drift', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      archetypeHistory: [
        {
          archetypeId: 'arch1',
          latestRun: makeRun({
            archetypeId: 'arch1',
            targetIos: '18.8',
            status: 'failed',
            matchCount: 0,
            diffCount: 0,
            errorCount: 0,
          }),
        },
      ],
    });
    expect(result.entries[0]?.priority).toBe('high');
    expect(result.entries[0]?.reason).toContain('retry');
  });

  it('cancelled prior run on target with low matches → HIGH (retry), not LOW drift', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      archetypeHistory: [
        {
          archetypeId: 'arch1',
          latestRun: makeRun({
            archetypeId: 'arch1',
            targetIos: '18.8',
            status: 'cancelled',
            matchCount: 3,
            diffCount: 7,
            errorCount: 0,
          }),
        },
      ],
    });
    expect(result.entries[0]?.priority).toBe('high');
    expect(result.entries[0]?.reason).toContain('retry');
  });
});

describe('V-533.C scheduleRecaptureBatch — skip behaviour', () => {
  it('SKIPs archetypes with in_progress run on the target version', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      archetypeHistory: [
        {
          archetypeId: 'arch1',
          latestRun: makeRun({
            archetypeId: 'arch1',
            targetIos: '18.8',
            status: 'in_progress',
          }),
        },
      ],
    });
    expect(result.entries).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain('in_progress');
  });

  it('SKIPs archetypes with queued run on the target version', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      archetypeHistory: [
        {
          archetypeId: 'arch1',
          latestRun: makeRun({
            archetypeId: 'arch1',
            targetIos: '18.8',
            status: 'queued',
          }),
        },
      ],
    });
    expect(result.entries).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });
});

describe('V-533.C scheduleRecaptureBatch — ordering', () => {
  it('sorts entries by priority: HIGH → MEDIUM → LOW', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      archetypeHistory: [
        // healthy on target → MEDIUM
        {
          archetypeId: 'arch-medium',
          latestRun: makeRun({
            archetypeId: 'arch-medium',
            targetIos: '18.8',
            matchCount: 100,
          }),
        },
        // never captured → HIGH
        { archetypeId: 'arch-high-1', latestRun: null },
        // drifting on target → LOW
        {
          archetypeId: 'arch-low',
          latestRun: makeRun({
            archetypeId: 'arch-low',
            targetIos: '18.8',
            matchCount: 50,
            diffCount: 50,
          }),
        },
        // prior version → HIGH
        {
          archetypeId: 'arch-high-2',
          latestRun: makeRun({
            archetypeId: 'arch-high-2',
            targetIos: '18.7',
            matchCount: 100,
          }),
        },
      ],
    });
    const priorities = result.entries.map((e) => e.priority);
    expect(priorities).toEqual(['high', 'high', 'medium', 'low']);
  });

  it('preserves input order within a priority tier (stable sort)', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      archetypeHistory: [
        { archetypeId: 'a', latestRun: null },
        { archetypeId: 'b', latestRun: null },
        { archetypeId: 'c', latestRun: null },
      ],
    });
    expect(result.entries.map((e) => e.archetypeId)).toEqual(['a', 'b', 'c']);
  });
});

describe('V-533.C scheduleRecaptureBatch — triggerOpts payload', () => {
  it('triggerOpts carries the correct (baseline, target) version pair', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.5',
      archetypeHistory: [
        {
          archetypeId: 'arch1',
          latestRun: makeRun({
            archetypeId: 'arch1',
            targetIos: '18.7',
          }),
        },
      ],
    });
    const t = result.entries[0]?.triggerOpts;
    expect(t?.trigger).toBe('ios_version_bump');
    expect(t?.archetypeId).toBe('arch1');
    expect(t?.targetVersion).toEqual({ iosVersion: '18.8', safariVersion: '26.5' });
    expect(t?.baselineVersion.iosVersion).toBe('18.7');
  });
});

describe('V-533.C scheduleRecaptureBatch — threshold overrides', () => {
  it('honors a custom driftingThreshold', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      driftingThreshold: 0.8,
      archetypeHistory: [
        {
          archetypeId: 'arch1',
          latestRun: makeRun({
            archetypeId: 'arch1',
            targetIos: '18.8',
            matchCount: 85,
            diffCount: 15,
          }),
        },
      ],
    });
    // 85% < 95% default → would be LOW; with 0.8 threshold, 85% > 80%
    // → not drifting, healthy completed run → MEDIUM.
    expect(result.entries[0]?.priority).toBe('medium');
  });

  it('honors a custom erroringThreshold', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      erroringThreshold: 0.1,
      archetypeHistory: [
        {
          archetypeId: 'arch1',
          latestRun: makeRun({
            archetypeId: 'arch1',
            targetIos: '18.8',
            matchCount: 85,
            errorCount: 15,
          }),
        },
      ],
    });
    // errorRate 15% > 10% → LOW (erroring).
    expect(result.entries[0]?.priority).toBe('low');
    expect(result.entries[0]?.reason).toContain('error rate');
  });
});

describe('V-533.C scheduleRecaptureBatch — empty input', () => {
  it('returns empty entries + skipped for empty archetypeHistory', () => {
    const result = scheduleRecaptureBatch({
      transition: TRANSITION,
      targetSafariVersion: '26.4',
      archetypeHistory: [],
    });
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
