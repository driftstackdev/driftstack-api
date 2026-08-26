import { describe, expect, it } from 'vitest';
import {
  dedupComparisons,
  expandCaptureMatrix,
  groupComparisonsByCategory,
  summarizeComparisons,
  type CaptureMatrixSpec,
  type FingerprintComparison,
} from '../src/index.js';

const BASELINE = { iosVersion: '18.7', safariVersion: '26.4' };
const TARGET = { iosVersion: '18.8', safariVersion: '26.5' };

function mkComparison(overrides: Partial<FingerprintComparison> = {}): FingerprintComparison {
  return {
    surfaceId: 'webgl.G3.renderer',
    outcome: 'match',
    baselineValue: 'Apple M2',
    recapturedValue: 'Apple M2',
    notes: null,
    ...overrides,
  };
}

describe('V-533.A expandCaptureMatrix', () => {
  it('fans out into one TriggerRecaptureOpts per archetype', () => {
    const spec: CaptureMatrixSpec = {
      archetypeIds: ['iphone16_18_7', 'iphone15_18_7', 'iphone14_18_7'],
      baselineVersion: BASELINE,
      targetVersion: TARGET,
      trigger: 'ios_version_bump',
    };
    const expanded = expandCaptureMatrix(spec);
    expect(expanded).toHaveLength(3);
    for (let i = 0; i < expanded.length; i += 1) {
      expect(expanded[i]!.archetypeId).toBe(spec.archetypeIds[i]);
      expect(expanded[i]!.trigger).toBe('ios_version_bump');
      expect(expanded[i]!.baselineVersion).toEqual(BASELINE);
      expect(expanded[i]!.targetVersion).toEqual(TARGET);
    }
  });

  it('attaches the reason uniformly when provided', () => {
    const expanded = expandCaptureMatrix({
      archetypeIds: ['a', 'b'],
      baselineVersion: BASELINE,
      targetVersion: TARGET,
      trigger: 'manual_request',
      reason: 'release notes 2026-08-01',
    });
    for (const opts of expanded) {
      expect(opts.reason).toBe('release notes 2026-08-01');
    }
  });

  it('omits reason when not provided', () => {
    const expanded = expandCaptureMatrix({
      archetypeIds: ['a'],
      baselineVersion: BASELINE,
      targetVersion: TARGET,
      trigger: 'baseline_drift_detected',
    });
    expect(expanded[0]!.reason).toBeUndefined();
  });

  it('rejects empty archetypeIds', () => {
    expect(() =>
      expandCaptureMatrix({
        archetypeIds: [],
        baselineVersion: BASELINE,
        targetVersion: TARGET,
        trigger: 'manual_request',
      }),
    ).toThrow(/at least 1 entry/);
  });

  it('preserves archetype order in the output', () => {
    const archetypeIds = ['z', 'm', 'a'];
    const expanded = expandCaptureMatrix({
      archetypeIds,
      baselineVersion: BASELINE,
      targetVersion: TARGET,
      trigger: 'manual_request',
    });
    expect(expanded.map((o) => o.archetypeId)).toEqual(archetypeIds);
  });
});

describe('V-533.A dedupComparisons', () => {
  it('returns the input unchanged when no duplicates', () => {
    const a = mkComparison({ surfaceId: 'webgl.G3.renderer' });
    const b = mkComparison({ surfaceId: 'webgl.G3.vendor' });
    const c = mkComparison({ surfaceId: 'canvas.C1.fingerprint', outcome: 'diff' });
    expect(dedupComparisons([a, b, c])).toEqual([a, b, c]);
  });

  it('collapses two identical comparisons to one', () => {
    const a = mkComparison({ surfaceId: 'webgl.G3.renderer' });
    expect(dedupComparisons([a, a])).toEqual([a]);
  });

  it('keeps comparisons that differ only in outcome', () => {
    const a = mkComparison({ surfaceId: 'webgl.G3.renderer', outcome: 'match' });
    const b = mkComparison({ surfaceId: 'webgl.G3.renderer', outcome: 'diff' });
    expect(dedupComparisons([a, b])).toHaveLength(2);
  });

  it('keeps comparisons that differ only in recapturedValue', () => {
    const a = mkComparison({ recapturedValue: 'Apple M2' });
    const b = mkComparison({ recapturedValue: 'Apple M3' });
    expect(dedupComparisons([a, b])).toHaveLength(2);
  });

  it('drops differences in `notes` field — semantic outcome wins', () => {
    const a = mkComparison({ notes: 'first note' });
    const b = mkComparison({ notes: 'second note' });
    const out = dedupComparisons([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.notes).toBe('first note'); // first wins
  });

  it('handles a long list with many duplicates', () => {
    const list: FingerprintComparison[] = [];
    for (let i = 0; i < 100; i += 1) {
      list.push(mkComparison({ surfaceId: `surf-${i % 10}.x` }));
    }
    const deduped = dedupComparisons(list);
    expect(deduped).toHaveLength(10); // 10 unique surface ids
  });

  it('is stable wrt input order', () => {
    const a = mkComparison({ surfaceId: 'a.x' });
    const b = mkComparison({ surfaceId: 'b.x' });
    expect(dedupComparisons([a, b, a, b]).map((c) => c.surfaceId)).toEqual(['a.x', 'b.x']);
    expect(dedupComparisons([b, a, b, a]).map((c) => c.surfaceId)).toEqual(['b.x', 'a.x']);
  });
});

describe('V-533.A groupComparisonsByCategory', () => {
  it('groups by file-121 category prefix before the first dot', () => {
    const a = mkComparison({ surfaceId: 'webgl.G3.renderer' });
    const b = mkComparison({ surfaceId: 'webgl.G3.vendor' });
    const c = mkComparison({ surfaceId: 'canvas.C1.fingerprint' });
    const grouped = groupComparisonsByCategory([a, b, c]);
    expect(Object.keys(grouped).sort()).toEqual(['canvas', 'webgl']);
    expect(grouped.webgl).toHaveLength(2);
    expect(grouped.canvas).toHaveLength(1);
  });

  it('treats surfaceId with no dot as its own category', () => {
    const a = mkComparison({ surfaceId: 'standalone' });
    const grouped = groupComparisonsByCategory([a]);
    expect(grouped.standalone).toHaveLength(1);
  });

  it('returns an empty object for an empty list', () => {
    expect(groupComparisonsByCategory([])).toEqual({});
  });
});

describe('V-533.A summarizeComparisons', () => {
  it('counts each outcome type accurately', () => {
    const list: FingerprintComparison[] = [
      mkComparison({ outcome: 'match' }),
      mkComparison({ outcome: 'match', surfaceId: 'a' }),
      mkComparison({ outcome: 'diff', surfaceId: 'b' }),
      mkComparison({ outcome: 'capture_error', surfaceId: 'c' }),
      mkComparison({ outcome: 'new_surface', surfaceId: 'd' }),
      mkComparison({ outcome: 'missing_surface', surfaceId: 'e' }),
    ];
    const summary = summarizeComparisons(list);
    expect(summary.total).toBe(6);
    expect(summary.matchCount).toBe(2);
    expect(summary.diffCount).toBe(1);
    expect(summary.errorCount).toBe(1);
    expect(summary.newSurfaceCount).toBe(1);
    expect(summary.missingSurfaceCount).toBe(1);
  });

  it('zero counts on empty list', () => {
    const summary = summarizeComparisons([]);
    expect(summary.total).toBe(0);
    expect(summary.matchCount).toBe(0);
    expect(summary.diffCount).toBe(0);
    expect(summary.errorCount).toBe(0);
    expect(summary.newSurfaceCount).toBe(0);
    expect(summary.missingSurfaceCount).toBe(0);
  });
});
