// DEV-ONLY sample data for the customer dashboard.
//
// Answers the dashboard's API reads with a believable account so every
// signed-in page can be looked at without a running API: `astro dev` with
// DASHBOARD_DEV_FIXTURES=1 serves these through dev-fixtures/integration.mjs,
// and screenshot scripts can answer the same requests from the same table.
//
// Nothing under src/ imports this file, and the Vite plugin that serves it
// applies to `astro dev` only, so a production `astro build` contains none
// of it (tests/unit/the-dashboard-sample-data-never-reaches-a-production-build.test.ts).
// Every value is invented; the email addresses use the reserved example.com
// domain.

export const DEV_FIXTURE_PREFIX = '/__dev-fixture-api';
export const DEV_FIXTURE_TOKEN = 'dev-fixture-session';

const OWNER_ID = 'acc_4f2d9c1e-7b3a-4e8f-9a21-6c5d0e8b7f13';

const me = {
  id: OWNER_ID,
  email: 'alex.rivera@example.com',
  name: 'Alex Rivera',
  slug: 'alex-rivera',
  region: 'eu',
  timezone: 'Europe/Berlin',
  tier: 'team_manual',
  avatar_url: null,
  email_verified: true,
  has_password: true,
  concurrent_session_active: 2,
  concurrent_session_cap: 5,
  profile_count: 14,
  profile_cap: 50,
  teams: [],
  created_at: '2026-03-02T09:14:00.000Z',
};

const apiKeys = [
  {
    id: 'key_01J8Q4Z6R2M7',
    name: 'production-server',
    key_prefix: 'ds_live_7Hq2',
    scopes: ['write'],
    created_at: '2026-06-11T08:30:00.000Z',
    last_used_at: '2026-09-24T17:02:00.000Z',
    expires_at: null,
    revoked_at: null,
  },
  {
    id: 'key_01J8Q4Z6R2M8',
    name: 'monitoring',
    key_prefix: 'ds_live_Lm9x',
    scopes: ['read'],
    created_at: '2026-07-19T12:00:00.000Z',
    last_used_at: '2026-09-25T06:40:00.000Z',
    expires_at: null,
    revoked_at: null,
  },
  {
    id: 'key_01J8Q4Z6R2M9',
    name: 'staging-bot',
    key_prefix: 'ds_live_P3aa',
    scopes: ['account_owner'],
    created_at: '2026-04-02T10:00:00.000Z',
    last_used_at: '2026-08-01T10:00:00.000Z',
    expires_at: null,
    revoked_at: '2026-08-14T10:00:00.000Z',
  },
];

const sessions = [
  {
    id: 'ses_8c1f0a2b9d',
    status: 'busy',
    archetype: 'iphone15_ios18_7_safari26_3',
    created_at: '2026-09-25T08:12:00.000Z',
  },
  {
    id: 'ses_3e7d51c0aa',
    status: 'ready',
    archetype: 'iphone13_ios18_7_safari26_4',
    created_at: '2026-09-25T07:48:00.000Z',
  },
  {
    id: 'ses_0b9a44e1f2',
    status: 'destroyed',
    archetype: 'iphone13_ios18_6_safari18_6',
    created_at: '2026-09-23T15:00:00.000Z',
  },
];

function seriesBuckets(days) {
  const out = [];
  const end = Date.UTC(2026, 8, 25);
  const shape = [42, 55, 38, 71, 64, 12, 8, 80, 92, 77, 68, 95, 40, 58];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    const v = shape[(days - 1 - i) % shape.length];
    out.push({
      date: d,
      totals: {
        session_minute: v * 6,
        navigate: v * 11,
        interact: v * 23,
        state_capture: Math.round(v / 3),
        screenshot_capture: Math.round(v / 2),
      },
    });
  }
  return out;
}

const usageSummary = {
  period_start: '2026-09-01T00:00:00.000Z',
  period_end: '2026-10-01T00:00:00.000Z',
  tier: 'team_manual',
  totals: {
    session_minute: 8_730,
    navigate: 15_402,
    interact: 32_118,
    state_capture: 812,
    screenshot_capture: 1_204,
  },
};

const billing = {
  subscription: {
    tier: 'team_manual',
    status: 'active',
    current_period_start: '2026-09-01T00:00:00.000Z',
    current_period_end: '2026-10-01T00:00:00.000Z',
    cancel_at_period_end: false,
    canceled_at: null,
  },
};

const cryptoOrders = {
  orders: [
    {
      order_id: 'ord_5K2V9QX1',
      product: 'solo_manual',
      price_cents: 2900,
      price_currency: 'USD',
      status: 'paid',
      created_at: '2026-05-04T11:20:00.000Z',
    },
  ],
};

const teamMembers = [
  {
    id: 'tm_01J9A2B3C4',
    member_email: 'sam.okafor@example.com',
    role: 'admin',
    accepted_at: '2026-06-02T09:00:00.000Z',
  },
  {
    id: 'tm_01J9A2B3C5',
    member_email: 'priya.nair@example.com',
    role: 'member',
    accepted_at: '2026-07-15T14:30:00.000Z',
  },
];

const teamInvites = [
  {
    id: 'inv_01J9Z7Y6X5',
    invitee_email: 'jordan.lee@example.com',
    role: 'member',
    created_at: '2026-09-22T10:00:00.000Z',
    expires_at: '2026-09-29T10:00:00.000Z',
  },
];

const webhooks = [
  {
    id: 'whk_01J7M2N3P4',
    url: 'https://hooks.example.com/driftstack/sessions',
    description: 'Session results for the reporting pipeline',
    events: ['session.completed', 'session.failed'],
    active: true,
    created_at: '2026-06-20T09:00:00.000Z',
    consecutive_failures: 0,
    last_success_at: '2026-09-25T07:55:00.000Z',
    last_failure_at: null,
    rotation_grace_expires_at: null,
    delivery_counts: { delivered: 1284, failed: 3, dlq: 0 },
  },
  {
    id: 'whk_01J7M2N3P5',
    url: 'https://staging.example.com/webhooks/driftstack',
    description: null,
    events: ['session.challenge_detected', 'session.profile_save_failed'],
    active: false,
    created_at: '2026-08-03T16:40:00.000Z',
    consecutive_failures: 4,
    last_success_at: '2026-09-18T12:00:00.000Z',
    last_failure_at: '2026-09-24T12:00:00.000Z',
    rotation_grace_expires_at: null,
    delivery_counts: { delivered: 212, failed: 9, dlq: 2 },
  },
];

const auditLog = [
  {
    id: 'aud_1',
    action: 'api_key.created',
    actor_type: 'customer',
    target_resource_id: 'key_01J8Q4Z6R2M8',
    timestamp: '2026-09-24T16:10:00.000Z',
    payload: null,
  },
  {
    id: 'aud_2',
    action: 'team.invite_sent',
    actor_type: 'customer',
    target_resource_id: 'inv_01J9Z7Y6X5',
    timestamp: '2026-09-22T10:00:00.000Z',
    payload: null,
  },
  {
    id: 'aud_3',
    action: 'webhook.updated',
    actor_type: 'customer',
    target_resource_id: 'whk_01J7M2N3P5',
    timestamp: '2026-09-18T12:04:00.000Z',
    payload: null,
  },
  {
    id: 'aud_4',
    action: 'account.mfa_enrolled',
    actor_type: 'customer',
    target_resource_id: null,
    timestamp: '2026-09-02T08:21:00.000Z',
    payload: null,
  },
  {
    id: 'aud_5',
    action: 'api_key.revoked',
    actor_type: 'customer',
    target_resource_id: 'key_01J8Q4Z6R2M9',
    timestamp: '2026-08-14T10:00:00.000Z',
    payload: null,
  },
];

const webSessions = [
  {
    id: 'ws_1',
    os: 'macOS',
    browser: 'Safari',
    current: true,
    created_at: '2026-09-25T07:30:00.000Z',
    last_used_at: '2026-09-25T09:10:00.000Z',
    expires_at: '2026-10-25T07:30:00.000Z',
  },
  {
    id: 'ws_2',
    os: 'iOS',
    browser: 'Safari',
    current: false,
    created_at: '2026-09-20T18:00:00.000Z',
    last_used_at: '2026-09-23T21:15:00.000Z',
    expires_at: '2026-10-20T18:00:00.000Z',
  },
];

const oauthLinks = [
  {
    provider: 'google',
    provider_email: 'alex.rivera@example.com',
    linked_at: '2026-03-02T09:14:00.000Z',
  },
];

const mfa = {
  enrolled: true,
  enrolled_at: '2026-09-02T08:21:00.000Z',
  last_used_at: '2026-09-25T07:30:00.000Z',
  unused_recovery_codes: 8,
};

const rateLimits = {
  buckets: [
    { bucket_key: 'sessions.create', capacity: 60, refill_per_second: 1, source: 'plan' },
    { bucket_key: 'api.read', capacity: 1200, refill_per_second: 20, source: 'plan' },
    {
      bucket_key: 'api.write',
      capacity: 600,
      refill_per_second: 10,
      source: 'override',
      override_expires_at: '2026-10-31T00:00:00.000Z',
    },
  ],
};

const bundledLlmSettings = {
  consent: true,
  cap_cents: 2000,
  used_this_month_cents: 640,
  remaining_cents: 1360,
  month_started_at: '2026-09-01T00:00:00.000Z',
};

/**
 * The answer for one request, or null when the table has none (the caller
 * then answers 404). `pathname` is the API path after any prefix, e.g.
 * `/v1/account/me`; `search` includes the leading `?` or is empty.
 */
export function fixtureResponse(method, pathname, search = '') {
  const m = String(method || 'GET').toUpperCase();
  const p = pathname.replace(/\/+$/, '');
  const ok = (body) => ({ status: 200, body });
  if (m === 'OPTIONS') return { status: 204, body: null };
  if (m !== 'GET') {
    // Writes are accepted and change nothing, so a click in the preview
    // never reaches a real account.
    if (p === '/v1/auth/logout') return { status: 204, body: null };
    return { status: 204, body: null };
  }
  switch (p) {
    case '/v1/account/me':
      return ok(me);
    case '/v1/api-keys':
      return ok({ data: apiKeys });
    case '/v1/sessions':
      return ok({ data: sessions });
    case '/v1/billing':
      return ok(billing);
    case '/v1/billing/crypto-orders':
      return ok(cryptoOrders);
    case '/v1/usage':
      return ok(usageSummary);
    case '/v1/usage/series': {
      const days = Number(new URLSearchParams(search).get('days')) || 30;
      return ok({
        from_date: seriesBuckets(days)[0].date,
        to_date: '2026-09-25',
        buckets: seriesBuckets(days),
      });
    }
    case '/v1/team/members':
      return ok({ data: teamMembers });
    case '/v1/team/invites':
      return ok({ data: teamInvites });
    case '/v1/status':
      return ok({ overall_status: 'operational', recent_incidents: [] });
    case '/v1/webhooks':
      return ok({ data: webhooks });
    case '/v1/account/audit-log':
      return ok({ data: auditLog, next_cursor: null });
    case '/v1/account/web-sessions':
      return ok({ data: webSessions });
    case '/v1/account/me/oauth-links':
      return ok({ data: oauthLinks });
    case '/v1/account/mfa':
      return ok(mfa);
    case '/v1/account/rate-limits':
      return ok(rateLimits);
    case '/v1/account/email-preferences':
      return ok({ data: [] });
    case '/v1/account/me/bundled-llm-settings':
      return ok(bundledLlmSettings);
    case '/v1/account/me/bundled-llm-status':
      return ok(bundledLlmSettings);
    case '/v1/account/me/byok-anthropic-key':
      return ok({ has_key: false });
    case '/v1/legal/required':
      return ok({ data: [] });
    case '/v1/admin/audit-log':
      return { status: 403, body: { detail: 'forbidden' } };
    case '/v1/account/me/notifications':
      return { status: 204, body: null };
    default:
      if (/^\/v1\/webhooks\/[^/]+\/deliveries$/.test(p)) return ok({ data: [], next_cursor: null });
      return null;
  }
}
