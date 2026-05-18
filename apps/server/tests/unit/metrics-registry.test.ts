// Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — MetricsRegistry unit tests.

import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../../src/services/metrics-registry.js';

describe('Arc 4 Wave 2.B sub-slice 8.18 MetricsRegistry', () => {
  it('renders counter with no labels', () => {
    const r = new MetricsRegistry();
    r.registerCounter('driftstack_test_total', 'A test counter');
    r.inc('driftstack_test_total');
    r.inc('driftstack_test_total');
    const out = r.render();
    expect(out).toContain('# HELP driftstack_test_total A test counter');
    expect(out).toContain('# TYPE driftstack_test_total counter');
    expect(out).toContain('driftstack_test_total 2');
  });

  it('renders counter with labels in stable label order', () => {
    const r = new MetricsRegistry();
    r.registerCounter('driftstack_pair_mode_transition_total', 'Pair mode transitions', [
      'from',
      'to',
    ]);
    r.inc('driftstack_pair_mode_transition_total', { from: 'ai-driving', to: 'takeover-pending' });
    r.inc('driftstack_pair_mode_transition_total', {
      from: 'takeover-pending',
      to: 'human-driving',
    });
    r.inc('driftstack_pair_mode_transition_total', { from: 'ai-driving', to: 'takeover-pending' });
    const out = r.render();
    expect(out).toContain(
      'driftstack_pair_mode_transition_total{from="ai-driving",to="takeover-pending"} 2',
    );
    expect(out).toContain(
      'driftstack_pair_mode_transition_total{from="takeover-pending",to="human-driving"} 1',
    );
  });

  it('rejects negative counter deltas', () => {
    const r = new MetricsRegistry();
    r.registerCounter('driftstack_test_total', 'A test counter');
    expect(() => r.inc('driftstack_test_total', undefined, -1)).toThrow(/non-negative/);
  });

  it('rejects unregistered counter inc', () => {
    const r = new MetricsRegistry();
    expect(() => r.inc('driftstack_not_registered_total')).toThrow(/not registered/);
  });

  it('rejects duplicate metric registration', () => {
    const r = new MetricsRegistry();
    r.registerCounter('driftstack_test_total', 'A test counter');
    expect(() => r.registerCounter('driftstack_test_total', 'dupe')).toThrow(/already registered/);
  });

  it('rejects invalid Prometheus metric names', () => {
    const r = new MetricsRegistry();
    expect(() => r.registerCounter('1invalid-name', 'help')).toThrow(/Invalid Prometheus metric/);
  });

  it('rejects invalid label names', () => {
    const r = new MetricsRegistry();
    expect(() => r.registerCounter('driftstack_x_total', 'help', ['1-bad'])).toThrow(
      /Invalid Prometheus label/,
    );
  });

  it('escapes special characters in label values', () => {
    const r = new MetricsRegistry();
    r.registerCounter('driftstack_test_total', 'help', ['msg']);
    r.inc('driftstack_test_total', { msg: 'hello "world"\nline2\\back' });
    const out = r.render();
    expect(out).toContain('msg="hello \\"world\\"\\nline2\\\\back"');
  });

  it('gauge can be set + re-set to a new value', () => {
    const r = new MetricsRegistry();
    r.registerGauge('driftstack_active', 'Active count');
    r.setGauge('driftstack_active', 5);
    r.setGauge('driftstack_active', 3);
    const out = r.render();
    expect(out).toContain('# TYPE driftstack_active gauge');
    expect(out).toContain('driftstack_active 3');
  });

  it('getValue helper returns 0 for unset, accurate count after inc', () => {
    const r = new MetricsRegistry();
    r.registerCounter('driftstack_x_total', 'h', ['l']);
    expect(r.getValue('driftstack_x_total', { l: 'a' })).toBe(0);
    r.inc('driftstack_x_total', { l: 'a' });
    r.inc('driftstack_x_total', { l: 'a' });
    expect(r.getValue('driftstack_x_total', { l: 'a' })).toBe(2);
    expect(r.getValue('driftstack_x_total', { l: 'b' })).toBe(0);
  });

  it('render output ends with trailing newline', () => {
    const r = new MetricsRegistry();
    r.registerCounter('driftstack_x_total', 'h');
    r.inc('driftstack_x_total');
    expect(r.render().endsWith('\n')).toBe(true);
  });
});
