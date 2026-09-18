// Histograms on the in-process metrics registry.
//
// They exist for one reason: "far too slow" is a complaint about a
// distribution, and `histogram_quantile` can only answer it if the exposition
// is exactly right. A histogram that renders per-bucket counts instead of
// cumulative ones, or omits `+Inf`, still scrapes cleanly — and every quantile
// computed from it is quietly wrong. So this pins the wire shape, not just the
// arithmetic.

import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../../src/services/metrics-registry.js';

function registry(): MetricsRegistry {
  const r = new MetricsRegistry();
  r.registerHistogram('t_seconds', 'A test histogram.', [0.5, 1, 5], ['outcome']);
  return r;
}

describe('MetricsRegistry histograms', () => {
  it('renders CUMULATIVE buckets, a +Inf bucket equal to the count, then _sum and _count', () => {
    const r = registry();
    for (const v of [0.2, 0.7, 0.9, 3, 60]) r.observe('t_seconds', v, { outcome: 'ok' });
    const lines = r.render().split('\n');
    expect(lines).toContain('# TYPE t_seconds histogram');
    expect(lines).toContain('t_seconds_bucket{outcome="ok",le="0.5"} 1');
    // 0.2, 0.7, 0.9 — cumulative, not the 2 that landed in this bucket alone.
    expect(lines).toContain('t_seconds_bucket{outcome="ok",le="1"} 3');
    expect(lines).toContain('t_seconds_bucket{outcome="ok",le="5"} 4');
    // 60 is above every bound: it appears ONLY in +Inf.
    expect(lines).toContain('t_seconds_bucket{outcome="ok",le="+Inf"} 5');
    expect(lines).toContain('t_seconds_count{outcome="ok"} 5');
    expect(lines.find((l) => l.startsWith('t_seconds_sum{outcome="ok"}'))).toBe(
      `t_seconds_sum{outcome="ok"} ${(0.2 + 0.7 + 0.9 + 3 + 60).toString()}`,
    );
  });

  it('a value exactly on a bound belongs to that bound (le is inclusive)', () => {
    const r = registry();
    r.observe('t_seconds', 1, { outcome: 'ok' });
    expect(r.getHistogram('t_seconds', { outcome: 'ok' }).cumulative).toEqual([0, 1, 1]);
  });

  it('keeps one series per label value', () => {
    const r = registry();
    r.observe('t_seconds', 0.1, { outcome: 'ok' });
    r.observe('t_seconds', 0.1, { outcome: 'failed' });
    r.observe('t_seconds', 0.1, { outcome: 'failed' });
    expect(r.getHistogram('t_seconds', { outcome: 'ok' }).count).toBe(1);
    expect(r.getHistogram('t_seconds', { outcome: 'failed' }).count).toBe(2);
  });

  it('renders an unlabelled histogram with le as its only label', () => {
    const r = new MetricsRegistry();
    r.registerHistogram('bare_seconds', 'No labels.', [1]);
    r.observe('bare_seconds', 0.5);
    const out = r.render();
    expect(out).toContain('bare_seconds_bucket{le="1"} 1');
    expect(out).toContain('bare_seconds_bucket{le="+Inf"} 1');
    expect(out).toContain('bare_seconds_count 1');
  });

  it('DROPS a non-finite or negative observation instead of poisoning _sum for the life of the process', () => {
    const r = registry();
    r.observe('t_seconds', Number.NaN, { outcome: 'ok' });
    r.observe('t_seconds', Number.POSITIVE_INFINITY, { outcome: 'ok' });
    r.observe('t_seconds', -1, { outcome: 'ok' });
    expect(r.getHistogram('t_seconds', { outcome: 'ok' })).toEqual({
      count: 0,
      sum: 0,
      cumulative: [0, 0, 0],
    });
  });

  it('refuses buckets that are empty, unsorted, duplicated or non-finite', () => {
    const r = new MetricsRegistry();
    expect(() => r.registerHistogram('a', 'h', [])).toThrow(/at least one bucket/);
    expect(() => r.registerHistogram('b', 'h', [1, 0.5])).toThrow(/strictly ascending/);
    expect(() => r.registerHistogram('c', 'h', [1, 1])).toThrow(/strictly ascending/);
    expect(() => r.registerHistogram('d', 'h', [1, Number.POSITIVE_INFINITY])).toThrow(
      /strictly ascending/,
    );
  });

  it('reserves the le label and refuses a duplicate name across kinds', () => {
    const r = new MetricsRegistry();
    expect(() => r.registerHistogram('a', 'h', [1], ['le'])).toThrow(/reserved/);
    r.registerCounter('dup', 'h');
    expect(() => r.registerHistogram('dup', 'h', [1])).toThrow(/already registered/);
  });

  it('observe on a counter, and inc on a histogram, both throw rather than silently record nothing', () => {
    const r = registry();
    r.registerCounter('c_total', 'h');
    expect(() => r.observe('c_total', 1)).toThrow(/Histogram not registered/);
    expect(() => r.inc('t_seconds')).toThrow(/Counter not registered/);
    expect(() => r.observe('missing', 1)).toThrow(/Histogram not registered/);
  });
});
