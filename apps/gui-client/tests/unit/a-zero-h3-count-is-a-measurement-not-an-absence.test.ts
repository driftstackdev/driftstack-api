// (q) Item 11 residual — `h3_connection_count === 0` is a MEASUREMENT.
//
// The store projects `frame.h3ConnectionCount ?? null` (never `?? 0`) so that a
// zero stays "this session has carried no HTTP/3 connection yet" and an absent
// key stays "nothing measured" (session-capability-report-store.ts). The desktop
// then threw the distinction away: `parseH3Observation` returns null for a zero
// (correctly — a zero is no evidence the PROXY carries QUIC, so the ledger must
// stamp nothing), and the session parser only surfaced a count THROUGH that
// observation, so the zero never reached the readout and rendered as the absent
// state. This pins the split: the ledger still ignores a zero; the readout and
// the parser keep it.
//
// Mutations, each named against the diff:
//   * session-h3-observation.ts `h3ReadoutState`: delete the `count === 0 →
//     'none-yet'` line → the CRITICAL state arm reds ('not-observed' ≠ 'none-yet');
//   * agent-session-control.ts `capabilityReportOf`: revert
//     `...(h3Count !== undefined ? …)` to the old `h3?.count` spread → the
//     CRITICAL parser arm reds (no `h3_connection_count` key on the report);
//   * session-h3-observation.ts `parseH3Count`: coerce absent to 0 (`?? 0`) →
//     the VACUITY arms red (an absent key must add no key, no state).
//
// Controls fail in the direction the real failure goes: a report WITHOUT the
// count stays byte-identical to before (no 'none-yet' from nothing), and the
// ledger vacuity control in a-live-h3-observation-reaches-the-proxy-cache
// (parseH3Observation({h3_connection_count: 0}) === null) is unchanged.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/settings', () => ({
  loadSettings: vi.fn().mockResolvedValue({ apiKey: 'ds_test', baseUrl: 'https://api.test' }),
  loadBaseUrl: vi.fn().mockResolvedValue('https://api.test'),
}));

import {
  h3ReadoutState,
  parseH3Count,
  parseH3Observation,
} from '../../src/lib/session-h3-observation';
import { getAgentSession } from '../../src/lib/agent-session-control';

const TS = '2026-09-11T09:01:58.747Z';

const mockFetch = vi.fn();
global.fetch = mockFetch;
function ok(body: unknown): unknown {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('parseH3Count — a finite count crosses, a zero included; absence adds nothing', () => {
  it('CRITICAL a zero is returned as 0, not dropped', () => {
    expect(parseH3Count({ h3_connection_count: 0 })).toBe(0);
  });

  it('a positive count is returned as-is', () => {
    expect(parseH3Count({ h3_connection_count: 4 })).toBe(4);
  });

  it('VACUITY CONTROL — absent, null, NaN, a string, an array or a non-object → undefined (never 0)', () => {
    expect(parseH3Count({})).toBeUndefined();
    expect(parseH3Count({ h3_connection_count: null })).toBeUndefined();
    expect(parseH3Count({ h3_connection_count: Number.NaN })).toBeUndefined();
    expect(parseH3Count({ h3_connection_count: '0' })).toBeUndefined();
    expect(parseH3Count([])).toBeUndefined();
    expect(parseH3Count(null)).toBeUndefined();
    expect(parseH3Count('x')).toBeUndefined();
  });
});

describe('h3ReadoutState — the three states the cockpit readout can be in', () => {
  it('CRITICAL a measured zero without the flag is "none-yet" — not the absent state', () => {
    expect(h3ReadoutState({ h3_connection_count: 0 })).toBe('none-yet');
  });

  it('the latched flag, or a positive count, is "observed"', () => {
    expect(h3ReadoutState({ h3_connection_observed: true })).toBe('observed');
    expect(h3ReadoutState({ h3_connection_count: 2 })).toBe('observed');
    // Latched = "ever": a stale zero beside the flag does not demote it.
    expect(h3ReadoutState({ h3_connection_observed: true, h3_connection_count: 0 })).toBe(
      'observed',
    );
  });

  it('VACUITY CONTROL — no report, or a report with neither field, is "not-observed" (never "none-yet")', () => {
    expect(h3ReadoutState(null)).toBe('not-observed');
    expect(h3ReadoutState({})).toBe('not-observed');
  });

  it('CONTROL — the ledger side is unchanged: a zero is still NOT an observation the proxy cache may stamp', () => {
    expect(parseH3Observation({ h3_connection_count: 0 })).toBeNull();
  });
});

describe('getAgentSession — the session-control parser keeps a measured zero', () => {
  it('CRITICAL a report with `h3_connection_count: 0` and no flag surfaces the zero, and no observed flag', async () => {
    mockFetch.mockResolvedValue(
      ok({
        mode: 'manual',
        status: 'active',
        capability_report: {
          manual_input_available: true,
          streaming_state: 'live',
          egress_state: 'live',
          h3_connection_observed: null,
          h3_connection_count: 0,
          timestamp: TS,
        },
      }),
    );
    const report = (await getAgentSession('agt_1')).capabilityReport;
    expect(report).toEqual({
      manual_input_available: true,
      streaming_state: 'live',
      egress_state: 'live',
      h3_connection_count: 0,
    });
    expect(report !== undefined && 'h3_connection_observed' in report).toBe(false);
    expect(h3ReadoutState(report ?? null)).toBe('none-yet');
  });

  it('VACUITY CONTROL — a report with `h3_connection_count: null` (older harness / never measured) adds no key and reads "not-observed"', async () => {
    mockFetch.mockResolvedValue(
      ok({
        mode: 'manual',
        status: 'active',
        capability_report: {
          manual_input_available: true,
          streaming_state: 'live',
          egress_state: 'live',
          h3_connection_observed: null,
          h3_connection_count: null,
          timestamp: TS,
        },
      }),
    );
    const report = (await getAgentSession('agt_1')).capabilityReport;
    expect(report).toEqual({
      manual_input_available: true,
      streaming_state: 'live',
      egress_state: 'live',
    });
    expect(h3ReadoutState(report ?? null)).toBe('not-observed');
  });
});
