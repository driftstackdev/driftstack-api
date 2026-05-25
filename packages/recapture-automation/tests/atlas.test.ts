import { describe, expect, it } from 'vitest';
import { buildAtlas, classifyOutcomes } from '../src/atlas.js';
import type { FingerprintComparison, RecaptureRun } from '../src/types.js';

function makeRun(opts: {
  id: string;
  archetypeId: string;
  baselineIos: string;
  targetIos: string;
  baselineSafari?: string;
  targetSafari?: string;
  status?: RecaptureRun['status'];
  completedAtMs?: number;
  comparisons: readonly FingerprintComparison[];
}): RecaptureRun {
  const matchCount = opts.comparisons.filter((c) => c.outcome === 'match').length;
  const diffCount = opts.comparisons.filter((c) => c.outcome === 'diff').length;
  const errorCount = opts.comparisons.filter((c) => c.outcome === 'capture_error').length;
  const newSurfaceCount = opts.comparisons.filter((c) => c.outcome === 'new_surface').length;
  const missingSurfaceCount = opts.comparisons.filter(
    (c) => c.outcome === 'missing_surface',
  ).length;
  return {
    id: opts.id,
    trigger: 'ios_version_bump',
    archetypeId: opts.archetypeId,
    baselineVersion: {
      iosVersion: opts.baselineIos,
      safariVersion: opts.baselineSafari ?? '26.4',
    },
    targetVersion: {
      iosVersion: opts.targetIos,
      safariVersion: opts.targetSafari ?? '26.4',
    },
    status: opts.status ?? 'completed',
    comparisons: opts.comparisons,
    matchCount,
    diffCount,
    errorCount,
    newSurfaceCount,
    missingSurfaceCount,
    startedAtMs: 100,
    completedAtMs: opts.completedAtMs ?? 200,
    createdAtMs: 50,
  };
}

describe('V-533.B buildAtlas — basic aggregation', () => {
  it('returns empty atlas for empty runs', () => {
    const atlas = buildAtlas({ runs: [], generatedAtMs: 1 });
    expect(atlas.runCount).toBe(0);
    expect(atlas.archetypeCount).toBe(0);
    expect(atlas.stabilityByArchetype).toEqual({});
    expect(atlas.snapshots).toEqual({});
    expect(atlas.transitions).toEqual([]);
  });

  it('skips non-completed runs', () => {
    const atlas = buildAtlas({
      runs: [
        makeRun({
          id: 'r1',
          archetypeId: 'arch1',
          baselineIos: '18.7',
          targetIos: '18.8',
          status: 'in_progress',
          comparisons: [
            {
              surfaceId: 'webgl.G3',
              outcome: 'match',
              baselineValue: 'v',
              recapturedValue: 'v',
              notes: null,
            },
          ],
        }),
        makeRun({
          id: 'r2',
          archetypeId: 'arch1',
          baselineIos: '18.7',
          targetIos: '18.8',
          status: 'failed',
          comparisons: [],
        }),
      ],
      generatedAtMs: 1,
    });
    expect(atlas.runCount).toBe(0);
    expect(atlas.archetypeCount).toBe(0);
  });

  it('counts completed runs only', () => {
    const atlas = buildAtlas({
      runs: [
        makeRun({
          id: 'r1',
          archetypeId: 'arch1',
          baselineIos: '18.7',
          targetIos: '18.8',
          comparisons: [
            {
              surfaceId: 's1',
              outcome: 'match',
              baselineValue: 'v',
              recapturedValue: 'v',
              notes: null,
            },
          ],
        }),
        makeRun({
          id: 'r2',
          archetypeId: 'arch2',
          baselineIos: '18.7',
          targetIos: '18.8',
          comparisons: [
            {
              surfaceId: 's2',
              outcome: 'diff',
              baselineValue: 'a',
              recapturedValue: 'b',
              notes: null,
            },
          ],
        }),
      ],
      generatedAtMs: 1,
    });
    expect(atlas.runCount).toBe(2);
    expect(atlas.archetypeCount).toBe(2);
  });
});

describe('V-533.B buildAtlas — surface classification', () => {
  it("classifies 100%-match surfaces as 'stable'", () => {
    const runs: RecaptureRun[] = [];
    for (let i = 0; i < 5; i += 1) {
      runs.push(
        makeRun({
          id: `r${String(i)}`,
          archetypeId: 'arch1',
          baselineIos: '18.7',
          targetIos: '18.8',
          completedAtMs: 100 + i,
          comparisons: [
            {
              surfaceId: 's1',
              outcome: 'match',
              baselineValue: 'v',
              recapturedValue: 'v',
              notes: null,
            },
          ],
        }),
      );
    }
    const atlas = buildAtlas({ runs, generatedAtMs: 1 });
    const entries = atlas.stabilityByArchetype['arch1'];
    expect(entries).toBeDefined();
    expect(entries?.[0]?.classification).toBe('stable');
    expect(entries?.[0]?.matchRate).toBe(1);
  });

  it("classifies high-diff surfaces as 'drifting'", () => {
    const runs: RecaptureRun[] = [];
    for (let i = 0; i < 10; i += 1) {
      runs.push(
        makeRun({
          id: `r${String(i)}`,
          archetypeId: 'arch1',
          baselineIos: '18.7',
          targetIos: '18.8',
          completedAtMs: 100 + i,
          comparisons: [
            {
              surfaceId: 's1',
              outcome: 'diff',
              baselineValue: 'a',
              recapturedValue: 'b',
              notes: null,
            },
          ],
        }),
      );
    }
    const atlas = buildAtlas({ runs, generatedAtMs: 1 });
    const entries = atlas.stabilityByArchetype['arch1'];
    expect(entries?.[0]?.classification).toBe('drifting');
  });

  it("classifies high-error surfaces as 'erroring'", () => {
    const runs: RecaptureRun[] = [];
    for (let i = 0; i < 10; i += 1) {
      runs.push(
        makeRun({
          id: `r${String(i)}`,
          archetypeId: 'arch1',
          baselineIos: '18.7',
          targetIos: '18.8',
          completedAtMs: 100 + i,
          comparisons: [
            {
              surfaceId: 's1',
              outcome: i < 8 ? 'capture_error' : 'match',
              baselineValue: 'v',
              recapturedValue: i < 8 ? null : 'v',
              notes: null,
            },
          ],
        }),
      );
    }
    const atlas = buildAtlas({ runs, generatedAtMs: 1 });
    const entries = atlas.stabilityByArchetype['arch1'];
    expect(entries?.[0]?.classification).toBe('erroring');
  });

  it("classifies mixed-signal surfaces as 'volatile'", () => {
    const runs: RecaptureRun[] = [];
    // 1 match, 1 diff, 1 new_surface, 1 missing_surface — no clear winner.
    runs.push(
      makeRun({
        id: 'r1',
        archetypeId: 'arch1',
        baselineIos: '18.7',
        targetIos: '18.8',
        completedAtMs: 100,
        comparisons: [
          {
            surfaceId: 's1',
            outcome: 'match',
            baselineValue: 'v',
            recapturedValue: 'v',
            notes: null,
          },
          {
            surfaceId: 's1',
            outcome: 'diff',
            baselineValue: 'a',
            recapturedValue: 'b',
            notes: null,
          },
          {
            surfaceId: 's1',
            outcome: 'new_surface',
            baselineValue: null,
            recapturedValue: 'c',
            notes: null,
          },
          {
            surfaceId: 's1',
            outcome: 'missing_surface',
            baselineValue: 'd',
            recapturedValue: null,
            notes: null,
          },
        ],
      }),
    );
    const atlas = buildAtlas({ runs, generatedAtMs: 1 });
    const entries = atlas.stabilityByArchetype['arch1'];
    expect(entries?.[0]?.classification).toBe('volatile');
  });

  it('sorts stability entries by surfaceId', () => {
    const atlas = buildAtlas({
      runs: [
        makeRun({
          id: 'r1',
          archetypeId: 'arch1',
          baselineIos: '18.7',
          targetIos: '18.8',
          comparisons: [
            {
              surfaceId: 'z.surface',
              outcome: 'match',
              baselineValue: 'v',
              recapturedValue: 'v',
              notes: null,
            },
            {
              surfaceId: 'a.surface',
              outcome: 'match',
              baselineValue: 'v',
              recapturedValue: 'v',
              notes: null,
            },
            {
              surfaceId: 'm.surface',
              outcome: 'match',
              baselineValue: 'v',
              recapturedValue: 'v',
              notes: null,
            },
          ],
        }),
      ],
      generatedAtMs: 1,
    });
    const ids = (atlas.stabilityByArchetype['arch1'] ?? []).map((e) => e.surfaceId);
    expect(ids).toEqual(['a.surface', 'm.surface', 'z.surface']);
  });
});

describe('V-533.B buildAtlas — version-transition impact', () => {
  it('aggregates diff + error + match counts per transition', () => {
    const atlas = buildAtlas({
      runs: [
        makeRun({
          id: 'r1',
          archetypeId: 'arch1',
          baselineIos: '18.7',
          targetIos: '18.8',
          comparisons: [
            {
              surfaceId: 's1',
              outcome: 'match',
              baselineValue: 'v',
              recapturedValue: 'v',
              notes: null,
            },
            {
              surfaceId: 's2',
              outcome: 'diff',
              baselineValue: 'a',
              recapturedValue: 'b',
              notes: null,
            },
          ],
        }),
        makeRun({
          id: 'r2',
          archetypeId: 'arch2',
          baselineIos: '18.7',
          targetIos: '18.8',
          comparisons: [
            {
              surfaceId: 's1',
              outcome: 'capture_error',
              baselineValue: 'v',
              recapturedValue: null,
              notes: null,
            },
          ],
        }),
      ],
      generatedAtMs: 1,
    });
    expect(atlas.transitions).toHaveLength(1);
    expect(atlas.transitions[0]).toMatchObject({
      fromIosVersion: '18.7',
      toIosVersion: '18.8',
      runCount: 2,
      totalDiffCount: 1,
      totalErrorCount: 1,
      totalMatchCount: 1,
    });
  });

  it('separates distinct transitions', () => {
    const atlas = buildAtlas({
      runs: [
        makeRun({
          id: 'r1',
          archetypeId: 'arch1',
          baselineIos: '18.7',
          targetIos: '18.8',
          comparisons: [],
        }),
        makeRun({
          id: 'r2',
          archetypeId: 'arch1',
          baselineIos: '18.8',
          targetIos: '18.9',
          comparisons: [],
        }),
      ],
      generatedAtMs: 1,
    });
    expect(atlas.transitions).toHaveLength(2);
    expect(atlas.transitions[0]?.fromIosVersion).toBe('18.7');
    expect(atlas.transitions[1]?.fromIosVersion).toBe('18.8');
  });
});

describe('V-533.B buildAtlas — snapshots', () => {
  it('builds per-(archetype, version) snapshot keyed correctly', () => {
    const atlas = buildAtlas({
      runs: [
        makeRun({
          id: 'r1',
          archetypeId: 'arch1',
          baselineIos: '18.7',
          targetIos: '18.8',
          targetSafari: '26.5',
          comparisons: [
            {
              surfaceId: 's1',
              outcome: 'match',
              baselineValue: 'v',
              recapturedValue: 'v',
              notes: null,
            },
          ],
        }),
      ],
      generatedAtMs: 1,
    });
    const key = 'arch1@18.8+26.5';
    expect(atlas.snapshots[key]).toBeDefined();
    expect(atlas.snapshots[key]?.surfaces['s1']?.value).toBe('v');
  });

  it('most-recent value wins for the same (archetype, version, surface)', () => {
    const atlas = buildAtlas({
      runs: [
        makeRun({
          id: 'r1',
          archetypeId: 'arch1',
          baselineIos: '18.7',
          targetIos: '18.8',
          completedAtMs: 100,
          comparisons: [
            {
              surfaceId: 's1',
              outcome: 'match',
              baselineValue: 'v1',
              recapturedValue: 'v1',
              notes: null,
            },
          ],
        }),
        makeRun({
          id: 'r2',
          archetypeId: 'arch1',
          baselineIos: '18.7',
          targetIos: '18.8',
          completedAtMs: 200,
          comparisons: [
            {
              surfaceId: 's1',
              outcome: 'match',
              baselineValue: 'v2',
              recapturedValue: 'v2',
              notes: null,
            },
          ],
        }),
      ],
      generatedAtMs: 1,
    });
    expect(atlas.snapshots['arch1@18.8+26.4']?.surfaces['s1']?.value).toBe('v2');
  });

  it('skips capture_error + missing_surface outcomes', () => {
    const atlas = buildAtlas({
      runs: [
        makeRun({
          id: 'r1',
          archetypeId: 'arch1',
          baselineIos: '18.7',
          targetIos: '18.8',
          completedAtMs: 100,
          comparisons: [
            {
              surfaceId: 's1',
              outcome: 'match',
              baselineValue: 'v',
              recapturedValue: 'v',
              notes: null,
            },
            {
              surfaceId: 's2',
              outcome: 'capture_error',
              baselineValue: 'v',
              recapturedValue: null,
              notes: null,
            },
            {
              surfaceId: 's3',
              outcome: 'missing_surface',
              baselineValue: 'v',
              recapturedValue: null,
              notes: null,
            },
          ],
        }),
      ],
      generatedAtMs: 1,
    });
    const surfaces = atlas.snapshots['arch1@18.8+26.4']?.surfaces;
    expect(Object.keys(surfaces ?? {})).toEqual(['s1']);
  });
});

describe('V-533.B classifyOutcomes — direct point-query helper', () => {
  it('handles zero counts as volatile', () => {
    expect(
      classifyOutcomes({ match: 0, diff: 0, capture_error: 0, new_surface: 0, missing_surface: 0 }),
    ).toBe('volatile');
  });

  it('matches buildAtlas classification for a stable surface', () => {
    expect(
      classifyOutcomes({
        match: 19,
        diff: 1,
        capture_error: 0,
        new_surface: 0,
        missing_surface: 0,
      }),
    ).toBe('stable');
  });

  it('matches buildAtlas classification for an erroring surface', () => {
    expect(
      classifyOutcomes({ match: 1, diff: 1, capture_error: 4, new_surface: 0, missing_surface: 0 }),
    ).toBe('erroring');
  });

  it("classifies a missing-dominant surface as 'volatile', not 'drifting'", () => {
    // diff (3) beats capture_error (0) and new_surface (0), but missing_surface
    // (5) dominates the gap — drift does NOT account for it, so it's volatile.
    expect(
      classifyOutcomes({ match: 0, diff: 3, capture_error: 0, new_surface: 0, missing_surface: 5 }),
    ).toBe('volatile');
  });

  it("classifies a truly diff-dominant surface as 'drifting' (diff beats every other non-match)", () => {
    expect(
      classifyOutcomes({ match: 0, diff: 6, capture_error: 1, new_surface: 1, missing_surface: 2 }),
    ).toBe('drifting');
  });
});
