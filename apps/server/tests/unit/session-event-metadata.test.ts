import { describe, expect, it } from 'vitest';
import {
  DriverError,
  DriverNotIntegratedError,
  SessionTimeoutError,
} from '../../src/lib/errors.js';
import {
  classifySessionFailure,
  projectSessionEventMetadata,
  projectSessionFailedData,
  SESSION_EVENT_TYPES,
  sessionFailureCopy,
} from '../../src/lib/session-event-metadata.js';

const SENTINEL = 'PRIVATE_SENTINEL_7f0d9a';

describe('projectSessionEventMetadata', () => {
  const rawCases = [
    {
      type: 'created',
      payload: {
        archetype: 'iphone17_ios18_7_safari26_4',
        purpose: 'production_customer',
        driver_session_id: `driver_${SENTINEL}`,
      },
      expected: {
        archetype: 'iphone17_ios18_7_safari26_4',
        purpose: 'production_customer',
      },
    },
    {
      type: 'navigated',
      payload: {
        url: `https://user:${SENTINEL}@customer.example/private/${SENTINEL}?token=${SENTINEL}#${SENTINEL}`,
        final_url: `https://customer.example/final/${SENTINEL}?q=${SENTINEL}`,
        status: 201,
      },
      expected: {
        requested_origin: 'https://customer.example',
        final_origin: 'https://customer.example',
        status: 201,
      },
    },
    {
      type: 'interacted',
      payload: {
        action: {
          kind: 'type',
          selector: `#${SENTINEL}`,
          text: SENTINEL,
          delay_ms: 35,
          sensitive: true,
          extension: SENTINEL,
        },
      },
      expected: { action_kind: 'type', sensitive: true, delay_ms: 35 },
    },
    {
      type: 'gui_input',
      payload: {
        action: {
          kind: 'type_focused',
          text: SENTINEL,
          x: 123,
          y: 456,
          delay_ms: 20,
        },
      },
      expected: { action_kind: 'type_focused', delay_ms: 20 },
    },
    {
      type: 'waited',
      payload: {
        condition: { kind: 'url_matches', pattern: `.*${SENTINEL}.*` },
        satisfied: true,
      },
      expected: { condition_kind: 'url_matches', satisfied: true },
    },
    {
      type: 'state_captured',
      payload: {
        url: `https://user:${SENTINEL}@state.example/private?token=${SENTINEL}`,
        title: SENTINEL,
        cookies: [{ value: SENTINEL }],
        local_storage: { secret: SENTINEL },
      },
      expected: { source: 'page_state', origin: 'https://state.example' },
    },
    {
      type: 'screenshot_captured',
      payload: { kind: 'screenshot', byte_size: 4096, data: SENTINEL },
      expected: { kind: 'screenshot', byte_size: 4096 },
    },
    {
      type: 'destroyed',
      payload: {
        auto_destroyed: true,
        reason: `operator ${SENTINEL}`,
        max_session_minutes: 20,
      },
      expected: {
        reason_code: 'duration_limit',
        auto_destroyed: true,
        by_admin: false,
        max_session_minutes: 20,
      },
    },
    {
      type: 'errored',
      payload: {
        operation: 'navigate',
        error_name: 'DriverError',
        error_message: SENTINEL,
        raw: SENTINEL,
      },
      expected: { operation: 'navigate', failure_class: 'driver_error' },
    },
  ] as const;

  it('covers every event type with only closed metadata and no sentinel', () => {
    expect(rawCases.map((entry) => entry.type)).toEqual(SESSION_EVENT_TYPES);
    for (const entry of rawCases) {
      const projected = projectSessionEventMetadata({
        type: entry.type,
        payload: entry.payload,
        durationMs: 17,
      });
      expect(projected.payload).toEqual(entry.expected);
      expect(projected.durationMs).toBe(17);
      expect(JSON.stringify(projected)).not.toContain(SENTINEL);
    }
  });

  it('is idempotent over every canonical event output', () => {
    for (const entry of rawCases) {
      const once = projectSessionEventMetadata({
        type: entry.type,
        payload: entry.payload,
        durationMs: 17,
      });
      const twice = projectSessionEventMetadata(once);
      expect(twice).toEqual(once);
    }
  });

  it('does not mutate deeply frozen input', () => {
    const action = Object.freeze({
      kind: 'type',
      selector: `#${SENTINEL}`,
      text: SENTINEL,
      sensitive: true,
    });
    const payload = Object.freeze({ action });
    const before = JSON.stringify(payload);
    expect(() =>
      projectSessionEventMetadata({ type: 'interacted', payload, durationMs: 1 }),
    ).not.toThrow();
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('fails closed for malformed known payloads and rejects unknown event types', () => {
    for (const type of SESSION_EVENT_TYPES) {
      const projected = projectSessionEventMetadata({
        type,
        payload: { arbitrary: SENTINEL, nested: { secret: SENTINEL } },
        durationMs: Number.POSITIVE_INFINITY,
      });
      expect(projected.durationMs).toBeNull();
      expect(JSON.stringify(projected)).not.toContain(SENTINEL);
    }
    expect(() =>
      projectSessionEventMetadata({ type: 'future_secret_event', payload: { value: SENTINEL } }),
    ).toThrow('Unknown session event type.');
  });

  it('fails closed for hostile getters without retaining or rethrowing their diagnostics', () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error(SENTINEL);
        },
      },
    );
    expect(
      projectSessionEventMetadata({ type: 'interacted', payload: hostile, durationMs: 5 }),
    ).toEqual({
      type: 'interacted',
      payload: { action_kind: 'unknown' },
      durationMs: null,
    });
    expect(projectSessionFailedData(hostile)).toEqual({
      operation: 'unknown',
      error_name: 'UnknownError',
      error_message: 'The session operation failed.',
    });
  });

  it('recognizes canonical capture, wait and destroy metadata on a second pass', () => {
    expect(
      projectSessionEventMetadata({
        type: 'state_captured',
        payload: { source: 'capture', kind: 'dom_snapshot', byte_size: 123 },
      }).payload,
    ).toEqual({ source: 'capture', kind: 'dom_snapshot', byte_size: 123 });
    expect(
      projectSessionEventMetadata({
        type: 'waited',
        payload: { condition_kind: 'time', wait_ms: 500, satisfied: false },
      }).payload,
    ).toEqual({ condition_kind: 'time', satisfied: false, wait_ms: 500 });
    expect(
      projectSessionEventMetadata({
        type: 'destroyed',
        payload: {
          reason_code: 'admin_forced',
          auto_destroyed: false,
          by_admin: true,
          max_session_minutes: null,
        },
      }).payload,
    ).toEqual({
      reason_code: 'admin_forced',
      auto_destroyed: false,
      by_admin: true,
      max_session_minutes: null,
    });
    expect(
      projectSessionEventMetadata({
        type: 'destroyed',
        payload: { auto_destroyed: true, reason: 'account suspended' },
      }).payload,
    ).toEqual({
      reason_code: 'account_suspended',
      auto_destroyed: true,
      by_admin: false,
      max_session_minutes: null,
    });
  });
});

describe('closed session failure metadata', () => {
  it('classifies only the closed runtime classes and emits fixed copy', () => {
    expect(classifySessionFailure(new SessionTimeoutError(1000))).toBe('session_timeout');
    expect(classifySessionFailure(new DriverError(SENTINEL))).toBe('driver_error');
    expect(classifySessionFailure(new DriverNotIntegratedError())).toBe('driver_unavailable');
    expect(classifySessionFailure(new Error(SENTINEL))).toBe('unknown');
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error(SENTINEL);
        },
      },
    );
    expect(classifySessionFailure(hostile)).toBe('unknown');
    expect(sessionFailureCopy('driver_error')).toEqual({
      error_name: 'DriverError',
      error_message: 'The browser operation failed.',
    });
  });

  it('projects arbitrary session.failed input without retaining extensions or raw copy', () => {
    const projected = projectSessionFailedData({
      session_id: 'ses_00000000-0000-4000-8000-000000000001',
      duration_ms: 1234,
      operation: 'login',
      error_name: 'DriverError',
      error_message: SENTINEL,
      selector: SENTINEL,
      nested: { secret: SENTINEL },
    });
    expect(projected).toEqual({
      session_id: 'ses_00000000-0000-4000-8000-000000000001',
      duration_ms: 1234,
      operation: 'login',
      error_name: 'DriverError',
      error_message: 'The browser operation failed.',
    });
    expect(JSON.stringify(projected)).not.toContain(SENTINEL);
    expect(projectSessionFailedData(projected)).toEqual(projected);
  });

  it('uses a fixed unknown fallback for malformed failure data', () => {
    expect(
      projectSessionFailedData({
        session_id: `ses_${SENTINEL}`,
        error_message: SENTINEL,
      }),
    ).toEqual({
      operation: 'unknown',
      error_name: 'UnknownError',
      error_message: 'The session operation failed.',
    });
  });
});
