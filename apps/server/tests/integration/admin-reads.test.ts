// Integration tests for the admin read-only endpoints:
// GET /v1/admin/accounts/:id/usage and GET /v1/admin/audit-log.

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

describe('GET /v1/admin/accounts/:id/usage', () => {
  it('200 returns the period summary for the target account', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/accounts/acc_${fx.accountId}/usage`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.account_id).toBe(`acc_${fx.accountId}`);
    expect(body.tier).toBe('api_builder');
    expect(body.totals).toEqual({
      session_minute: 0,
      navigate: 0,
      interact: 0,
      wait: 0,
      state_capture: 0,
      screenshot_capture: 0,
    });
    // Period boundaries are full ISO strings.
    expect(typeof body.period_start).toBe('string');
    expect(typeof body.period_end).toBe('string');
  });

  it('uses the TARGET account tier (not the caller tier) for quotas', async () => {
    // Caller tier doesn't matter — the admin endpoint reflects the TARGET. This
    // now uses two distinct accounts so the claim is literally exercised: a
    // paid staff caller reads a separate `free` account. (It previously pointed
    // a free fixture at itself, which since `3202fdb17` cannot even reach the
    // admin surface — an ordinary key on Free is refused at the customer-API
    // boundary, and Free's desktop credential is barred from /v1/admin.)
    fx = await buildTestApp({ tier: 'api_builder' });
    const target = await seedAdditionalAccount(fx, { tier: 'free' });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/accounts/acc_${target.accountId}/usage`,
      headers: auth(fx),
    });
    const body = res.json<{ tier: string; quotas: Record<string, number | null> }>();
    expect(body.tier).toBe('free');
    // Per ADR-004 all paid tiers + free are unmetered for the
    // operation-count meters; quota values are `null` (no per-meter
    // cap). Trial-pack hours metering is via accounts.free_credit_cents,
    // independent of TIER_QUOTAS.
    expect(body.quotas.navigate).toBeNull();
  });

  it('403 without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/accounts/acc_${fx.accountId}/usage`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });

  it('404 unknown account', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/accounts/acc_00000000-0000-4000-8000-000000000999/usage',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
  });

  it('does NOT write an audit row (reads are not audited)', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/accounts/acc_${fx.accountId}/usage`,
      headers: auth(fx),
    });
    expect(fx.adminAuditRepo.getAll()).toHaveLength(0);
  });
});

describe('GET /v1/admin/audit-log', () => {
  // We seed the audit-log directly via the in-memory repo rather than
  // by performing mutations via HTTP. The single-account fixture can't
  // suspend itself and then keep calling admin endpoints (the auth-
  // boundary 403 fires before the route runs) — so we'd lose
  // the third row anyway. Direct seeding keeps the read-endpoint
  // contract under test without the cross-cutting auth complication.
  async function seedThreeAuditRows(fixture: TestAppFixture): Promise<void> {
    await fixture.adminAuditRepo.insert({
      adminAccountId: fixture.accountId,
      adminKeyId: fixture.apiKeyId,
      action: 'account.tier_changed',
      targetAccountId: fixture.accountId,
      inputPayload: { tier: 'api_scale' },
      result: 'success',
    });
    await new Promise((r) => setTimeout(r, 5));
    await fixture.adminAuditRepo.insert({
      adminAccountId: fixture.accountId,
      adminKeyId: fixture.apiKeyId,
      action: 'account.suspended',
      targetAccountId: fixture.accountId,
      result: 'success',
    });
    await new Promise((r) => setTimeout(r, 5));
    await fixture.adminAuditRepo.insert({
      adminAccountId: fixture.accountId,
      adminKeyId: fixture.apiKeyId,
      action: 'account.unsuspended',
      targetAccountId: fixture.accountId,
      result: 'success',
    });
  }

  it('200 returns the audit log ordered by timestamp DESC', async () => {
    fx = await buildTestApp();
    await seedThreeAuditRows(fx);

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ action: string; admin_account_id: string }>;
      next_cursor: string | null;
    }>();
    expect(body.data).toHaveLength(3);
    // Most-recent first: unsuspend, suspend, tier_changed.
    expect(body.data[0]?.action).toBe('account.unsuspended');
    expect(body.data[1]?.action).toBe('account.suspended');
    expect(body.data[2]?.action).toBe('account.tier_changed');
    // admin_account_id is prefixed.
    expect(body.data[0]?.admin_account_id).toBe(`acc_${fx.accountId}`);
  });

  it('400 on a malformed cursor (not a uuid) rather than a 500 from the uuid keyset lookup', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log?cursor=not-a-uuid',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(400);
  });

  // Sibling of the malformed-cursor arm above, same failure mode from a
  // different parameter. `from`/`to` are parsed into Dates and handed to
  // `gte(adminAuditLog.timestamp, ...)`. Against a real Postgres,
  // `0000-01-01T00:00:00.000Z` fails that comparison outright -- "date/time
  // field value out of range" -- so before the shared Iso8601Schema carried a
  // floor, this query string produced a 500. There is no year zero; the value
  // cannot be legitimate, so it belongs in the 400 bucket with the bad cursor.
  it.each([
    ['from', '/v1/admin/audit-log?from=0000-01-01T00:00:00.000Z'],
    ['to', '/v1/admin/audit-log?to=0000-01-01T00:00:00.000Z'],
    ['from (year one)', '/v1/admin/audit-log?from=0001-01-01T00:00:00Z'],
  ])(
    '400 on a %s timestamp Postgres cannot store, rather than a 500 from the comparison',
    async (_label, url) => {
      fx = await buildTestApp();
      const res = await fx.app.inject({ method: 'GET', url, headers: auth(fx) });
      expect(res.statusCode, `${url} did not come back as a 400`).toBe(400);
    },
  );

  it('an ordinary from/to window is still accepted', async () => {
    // Without this the arm above would pass if the filter stopped working.
    fx = await buildTestApp();
    await seedThreeAuditRows(fx);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown[] }>().data.length).toBeGreaterThan(0);
  });

  it('filters by action', async () => {
    fx = await buildTestApp();
    await seedThreeAuditRows(fx);

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log?action=account.suspended',
      headers: auth(fx),
    });
    const body = res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(1);
  });

  it('filters by target_id (accepts both prefixed and raw uuid)', async () => {
    fx = await buildTestApp();
    await seedThreeAuditRows(fx);

    // Prefixed.
    const r1 = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/audit-log?target_id=acc_${fx.accountId}`,
      headers: auth(fx),
    });
    expect(r1.json<{ data: unknown[] }>().data).toHaveLength(3);

    // Raw uuid.
    const r2 = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/audit-log?target_id=${fx.accountId}`,
      headers: auth(fx),
    });
    expect(r2.json<{ data: unknown[] }>().data).toHaveLength(3);
  });

  it('respects limit + cursor', async () => {
    fx = await buildTestApp();
    await seedThreeAuditRows(fx);

    const r1 = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log?limit=2',
      headers: auth(fx),
    });
    const p1 = r1.json<{ data: unknown[]; next_cursor: string | null }>();
    expect(p1.data).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();

    const r2 = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/audit-log?limit=2&cursor=${encodeURIComponent(p1.next_cursor ?? '')}`,
      headers: auth(fx),
    });
    const p2 = r2.json<{ data: unknown[]; next_cursor: string | null }>();
    expect(p2.data).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
  });

  it('400 for malformed admin_id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log?admin_id=not-an-id',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });

  it('does NOT write an audit row for the read itself', async () => {
    fx = await buildTestApp();
    await seedThreeAuditRows(fx);
    const before = fx.adminAuditRepo.getAll().length;
    await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log',
      headers: auth(fx),
    });
    expect(fx.adminAuditRepo.getAll().length).toBe(before);
  });
});
