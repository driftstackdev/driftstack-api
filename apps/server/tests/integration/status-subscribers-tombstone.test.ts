// V-295c3-tombstone — admin endpoints + 90d purge tests.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const headers = { 'content-type': 'application/json' };

function ipFor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) hash = (hash * 31 + email.charCodeAt(i)) | 0;
  return `198.51.100.${(Math.abs(hash) % 254) + 1}`;
}

async function subscribeAndConfirm(fixture: TestAppFixture, email: string): Promise<string> {
  const ip = ipFor(email);
  await fixture.app.inject({
    method: 'POST',
    url: '/v1/status/subscribe',
    headers,
    remoteAddress: ip,
    payload: { email },
  });
  const last = fixture.emailSends[fixture.emailSends.length - 1]!;
  const token = new URL(last.vars.confirmLink as string).searchParams.get('token');
  await fixture.app.inject({
    method: 'GET',
    url: `/v1/status/subscribe/confirm?token=${encodeURIComponent(token!)}`,
    remoteAddress: ip,
  });
  // Return the row id by querying the in-memory repo.
  const row = fixture.statusSubscribersRepo.getAll().find((r) => r.email === email);
  if (!row) throw new Error(`subscriber ${email} not found in test repo`);
  return row.id;
}

describe('GET /v1/admin/status-subscribers', () => {
  it('200 returns paginated list of all subscribers', async () => {
    fx = await buildTestApp();
    await subscribeAndConfirm(fx, 'a@example.test');
    await subscribeAndConfirm(fx, 'b@example.test');

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/status-subscribers',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { id: string; email: string; confirmed_at: string | null }[];
    }>();
    expect(body.data).toHaveLength(2);
    expect(body.data.every((s) => s.id.startsWith('sub_'))).toBe(true);
    expect(body.data.every((s) => s.confirmed_at !== null)).toBe(true);
  });

  it('403 without driftstack_internal_admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/status-subscribers',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('respects limit + offset query params', async () => {
    fx = await buildTestApp();
    await subscribeAndConfirm(fx, 'a@example.test');
    await subscribeAndConfirm(fx, 'b@example.test');
    await subscribeAndConfirm(fx, 'c@example.test');

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/status-subscribers?limit=1&offset=1',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(1);
  });
});

describe('POST /v1/admin/status-subscribers/:id/force-unsubscribe', () => {
  it('200 marks unsubscribed + writes admin_audit_log row', async () => {
    fx = await buildTestApp();
    const id = await subscribeAndConfirm(fx, 'a@example.test');

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/status-subscribers/sub_${id}/force-unsubscribe`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);

    const row = fx.statusSubscribersRepo.getAll()[0]!;
    expect(row.unsubscribedAt).not.toBeNull();

    expect(
      fx.adminAuditRepo.getAll().some((r) => r.action === 'status_subscriber.force_unsubscribed'),
    ).toBe(true);
  });

  it('400 on malformed id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/status-subscribers/not-an-id/force-unsubscribe',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('StatusSubscribersService.processPurge', () => {
  it('NULLs email column for rows where unsubscribed_at < now - 90d', async () => {
    fx = await buildTestApp();
    await subscribeAndConfirm(fx, 'a@example.test');
    await subscribeAndConfirm(fx, 'b@example.test');

    // Manually shift one row's unsubscribed_at to 100 days ago.
    const rows = fx.statusSubscribersRepo.getAll();
    const aRow = rows.find((r) => r.email === 'a@example.test')!;
    aRow.unsubscribedAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);

    // Recent unsubscribe (10 days ago) should NOT be purged.
    const bRow = rows.find((r) => r.email === 'b@example.test')!;
    bRow.unsubscribedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    const result = await fx.statusSubscribersService.processPurge(new Date());
    expect(result.purged).toHaveLength(1);
    expect(result.purged[0]!.email).toBe('a@example.test');

    // Old row's email is now NULL; row persists.
    expect(aRow.email).toBeNull();
    expect(aRow.unsubscribeTokenHash).toBeNull();
    // Recent row untouched.
    expect(bRow.email).toBe('b@example.test');
  });

  it('does NOT touch active subscribers (unsubscribed_at IS NULL)', async () => {
    fx = await buildTestApp();
    await subscribeAndConfirm(fx, 'a@example.test');

    const result = await fx.statusSubscribersService.processPurge(new Date());
    expect(result.purged).toHaveLength(0);
    expect(fx.statusSubscribersRepo.getAll()[0]!.email).toBe('a@example.test');
  });

  it('idempotent — second purge after first finds zero candidates', async () => {
    fx = await buildTestApp();
    await subscribeAndConfirm(fx, 'a@example.test');
    fx.statusSubscribersRepo.getAll()[0]!.unsubscribedAt = new Date(
      Date.now() - 100 * 24 * 60 * 60 * 1000,
    );

    const first = await fx.statusSubscribersService.processPurge(new Date());
    expect(first.purged).toHaveLength(1);

    const second = await fx.statusSubscribersService.processPurge(new Date());
    expect(second.purged).toHaveLength(0);
  });
});
