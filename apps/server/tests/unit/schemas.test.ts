// Public API schema contract tests. Verifies the Zod schemas in
// @driftstack/api-types parse and reject inputs as expected. These tests
// are the safety net against accidental breaking changes to the public
// contract — adding required fields, narrowing enums, etc.

import { describe, expect, it } from 'vitest';
import {
  AccountIdSchema,
  ApiKeyScopeSchema,
  CaptureRequestSchema,
  CreateApiKeyRequestSchema,
  CreateSessionRequestSchema,
  InteractActionSchema,
  InteractRequestSchema,
  NavigateRequestSchema,
  PaginationQuerySchema,
  ProblemSchema,
  PROBLEM_TYPES,
  SessionIdSchema,
  SessionSchema,
  UsagePeriodSummarySchema,
  WaitConditionSchema,
} from '@driftstack/api-types';

describe('PrefixedId schemas', () => {
  it('accepts a properly prefixed UUID', () => {
    const ok = AccountIdSchema.safeParse('acc_a3f8e2d4-1b9c-4e7a-9f5d-8c3b2a1e0d4f');
    expect(ok.success).toBe(true);
  });

  it('rejects wrong prefix', () => {
    const r = AccountIdSchema.safeParse('ses_a3f8e2d4-1b9c-4e7a-9f5d-8c3b2a1e0d4f');
    expect(r.success).toBe(false);
  });

  it('rejects bare UUID without prefix', () => {
    const r = SessionIdSchema.safeParse('a3f8e2d4-1b9c-4e7a-9f5d-8c3b2a1e0d4f');
    expect(r.success).toBe(false);
  });

  it('rejects malformed UUID body', () => {
    const r = SessionIdSchema.safeParse('ses_not-a-uuid');
    expect(r.success).toBe(false);
  });
});

describe('PaginationQuerySchema', () => {
  it('coerces string limit and applies default', () => {
    const r = PaginationQuerySchema.parse({ limit: '20' });
    expect(r.limit).toBe(20);
    expect(r.cursor).toBeUndefined();
  });

  it('clamps to max', () => {
    const r = PaginationQuerySchema.safeParse({ limit: 200 });
    expect(r.success).toBe(false);
  });

  it('default 50 when limit missing', () => {
    expect(PaginationQuerySchema.parse({}).limit).toBe(50);
  });
});

describe('ProblemSchema (RFC 7807)', () => {
  it('accepts a minimal problem', () => {
    const r = ProblemSchema.safeParse({
      type: PROBLEM_TYPES.NotFound,
      title: 'Not Found',
      status: 404,
    });
    expect(r.success).toBe(true);
  });

  it('rejects out-of-range status', () => {
    const r = ProblemSchema.safeParse({
      type: PROBLEM_TYPES.NotFound,
      title: 'x',
      status: 999,
    });
    expect(r.success).toBe(false);
  });

  it('preserves extension members via passthrough', () => {
    const r = ProblemSchema.parse({
      type: PROBLEM_TYPES.RateLimited,
      title: 'Rate limited',
      status: 429,
      retry_after_seconds: 30,
    });
    expect(r.retry_after_seconds).toBe(30);
  });
});

describe('CreateSessionRequestSchema', () => {
  it('accepts an empty body (all fields optional)', () => {
    const r = CreateSessionRequestSchema.parse({});
    expect(r).toEqual({});
  });

  it('accepts label + metadata', () => {
    const r = CreateSessionRequestSchema.parse({
      label: 'demo',
      metadata: { customer_run_id: 'abc' },
    });
    expect(r.label).toBe('demo');
    expect(r.metadata).toEqual({ customer_run_id: 'abc' });
  });

  it('rejects archetype with uppercase', () => {
    const r = CreateSessionRequestSchema.safeParse({ archetype: 'iPhone16Pro' });
    expect(r.success).toBe(false);
  });
});

describe('NavigateRequestSchema', () => {
  it('defaults wait_until to load', () => {
    const r = NavigateRequestSchema.parse({ url: 'https://example.com' });
    expect(r.wait_until).toBe('load');
  });

  it('rejects timeout below floor', () => {
    const r = NavigateRequestSchema.safeParse({ url: 'https://example.com', timeout_ms: 500 });
    expect(r.success).toBe(false);
  });

  it('rejects non-URL', () => {
    const r = NavigateRequestSchema.safeParse({ url: 'not a url' });
    expect(r.success).toBe(false);
  });
});

describe('InteractActionSchema (discriminated union)', () => {
  it('parses tap', () => {
    const r = InteractActionSchema.parse({ kind: 'tap', selector: '#button' });
    expect(r.kind).toBe('tap');
  });

  it('parses type with delay', () => {
    const r = InteractActionSchema.parse({
      kind: 'type',
      selector: '#email',
      text: 'foo@bar.com',
      delay_ms: 50,
    });
    expect(r.kind).toBe('type');
  });

  it('rejects type with text over limit', () => {
    const r = InteractActionSchema.safeParse({
      kind: 'type',
      selector: '#x',
      text: 'a'.repeat(10_001),
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown kind', () => {
    const r = InteractActionSchema.safeParse({ kind: 'fly', selector: '#x' });
    expect(r.success).toBe(false);
  });

  it('parses scroll with defaults', () => {
    const r = InteractActionSchema.parse({ kind: 'scroll' });
    expect(r).toEqual({ kind: 'scroll', delta_x: 0, delta_y: 0 });
  });
});

describe('InteractRequestSchema', () => {
  it('wraps an action', () => {
    const r = InteractRequestSchema.parse({
      action: { kind: 'press', key: 'Enter' },
    });
    expect(r.action.kind).toBe('press');
  });
});

describe('WaitConditionSchema', () => {
  it('parses each kind', () => {
    expect(WaitConditionSchema.parse({ kind: 'selector', selector: '#x' }).kind).toBe('selector');
    expect(WaitConditionSchema.parse({ kind: 'time', ms: 500 }).kind).toBe('time');
    expect(WaitConditionSchema.parse({ kind: 'url_matches', pattern: '.*example.*' }).kind).toBe(
      'url_matches',
    );
  });
});

describe('CaptureRequestSchema', () => {
  it('defaults full_page false', () => {
    const r = CaptureRequestSchema.parse({ kind: 'screenshot' });
    expect(r.full_page).toBe(false);
  });

  it('rejects unsupported kind', () => {
    const r = CaptureRequestSchema.safeParse({ kind: 'video' });
    expect(r.success).toBe(false);
  });
});

describe('CreateApiKeyRequestSchema', () => {
  it('requires at least one scope', () => {
    const r = CreateApiKeyRequestSchema.safeParse({ name: 'x', scopes: [] });
    expect(r.success).toBe(false);
  });

  it('accepts read+write+admin', () => {
    const r = CreateApiKeyRequestSchema.parse({
      name: 'admin-key',
      scopes: ['read', 'write', 'admin'],
    });
    expect(r.scopes).toEqual(['read', 'write', 'admin']);
  });
});

describe('ApiKeyScopeSchema enum', () => {
  it('rejects unknown scope', () => {
    const r = ApiKeyScopeSchema.safeParse('superadmin');
    expect(r.success).toBe(false);
  });
});

describe('SessionSchema', () => {
  it('accepts a complete session', () => {
    const now = '2026-05-02T09:15:00Z';
    const r = SessionSchema.parse({
      id: 'ses_a3f8e2d4-1b9c-4e7a-9f5d-8c3b2a1e0d4f',
      account_id: 'acc_b1c2d3e4-1111-2222-3333-444455556666',
      api_key_id: 'key_c1c2d3e4-1111-2222-3333-444455556666',
      status: 'ready',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      label: null,
      metadata: null,
      created_at: now,
      updated_at: now,
      last_state_at: null,
      destroyed_at: null,
    });
    expect(r.status).toBe('ready');
  });
});

describe('UsagePeriodSummarySchema', () => {
  it('accepts a sparse totals/quotas record', () => {
    const r = UsagePeriodSummarySchema.parse({
      period_start: '2026-05-01T00:00:00Z',
      period_end: '2026-06-01T00:00:00Z',
      tier: 'api_builder',
      totals: { navigate: 12, interact: 4 },
      quotas: { navigate: 1000, interact: null },
    });
    expect(r.totals.navigate).toBe(12);
    expect(r.quotas.interact).toBeNull();
  });
});
