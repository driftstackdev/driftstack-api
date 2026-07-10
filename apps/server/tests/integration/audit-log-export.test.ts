// V-297 — audit-log export tests.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

async function seedEntry(
  fixture: TestAppFixture,
  action: 'api_key.minted' | 'api_key.revoked' | 'session.created',
): Promise<void> {
  await fixture.accountAuditRepo.insert({
    accountId: fixture.accountId,
    actorType: 'customer',
    actorAccountId: fixture.accountId,
    actorKeyId: fixture.apiKeyId,
    action,
    targetResourceId: `tgt_${action}`,
    payload: { sample: 'data' },
  });
}

describe('GET /v1/account/audit-log/export', () => {
  it('200 returns JSON envelope with all entries', async () => {
    fx = await buildTestApp();
    await seedEntry(fx, 'api_key.minted');
    await seedEntry(fx, 'session.created');

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log/export?format=json',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="driftstack-audit-log-/,
    );
    expect(res.headers['x-driftstack-export-truncated']).toBe('false');

    const body = res.json<{
      generated_at: string;
      account_id: string;
      row_count: number;
      truncated: boolean;
      data: { action: string }[];
    }>();
    expect(body.row_count).toBeGreaterThanOrEqual(2);
    expect(body.truncated).toBe(false);
    expect(body.data.some((d) => d.action === 'api_key.minted')).toBe(true);
    expect(body.data.some((d) => d.action === 'session.created')).toBe(true);
  });

  it('200 returns CSV when format=csv', async () => {
    fx = await buildTestApp();
    await seedEntry(fx, 'api_key.minted');

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log/export?format=csv',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/\.csv"$/);
    const csv = res.body;
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'timestamp,action,actor_type,actor_account_id,actor_key_id,target_resource_id,ip_address,user_agent,payload',
    );
    // At least one data row beyond the header.
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((l) => l.includes('api_key.minted'))).toBe(true);
  });

  it('CSV escapes commas, quotes, and newlines per RFC 4180', async () => {
    fx = await buildTestApp();
    await fx.accountAuditRepo.insert({
      accountId: fx.accountId,
      actorType: 'customer',
      actorAccountId: fx.accountId,
      actorKeyId: fx.apiKeyId,
      action: 'api_key.minted',
      targetResourceId: 'key_with,comma',
      payload: { note: 'has "quotes" inside' },
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log/export?format=csv',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const csv = res.body;
    // Comma in target_resource_id triggers quoting.
    expect(csv).toContain('"key_with,comma"');
    // The JSON payload `{"note":"has \"quotes\" inside"}` becomes
    // `"{""note"":""has \""quotes\"" inside""}"` after CSV-quoting:
    // outer JSON quotes are doubled, the JSON's own backslash-escaped
    // inner quotes get their `\"` re-doubled to `\""` per RFC 4180.
    expect(csv).toContain('\\""quotes\\""');
  });

  it('CSV neutralises formula injection (CWE-1236) in client-controlled fields', async () => {
    fx = await buildTestApp();
    // user_agent is attacker-controlled (a request header) and flows
    // verbatim into the audit log; a leading '=' would be evaluated as a
    // formula when the export is opened in a spreadsheet.
    await fx.accountAuditRepo.insert({
      accountId: fx.accountId,
      actorType: 'customer',
      actorAccountId: fx.accountId,
      actorKeyId: fx.apiKeyId,
      action: 'api_key.minted',
      userAgent: '=SUM(1+1)',
      payload: null,
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log/export?format=csv',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const csv = res.body;
    // Prefixed with an apostrophe so a spreadsheet treats it as text.
    expect(csv).toContain("'=SUM(1+1)");
    // The raw formula must never appear at a cell boundary.
    expect(csv).not.toMatch(/(^|,)=SUM\(1\+1\)/);
  });

  it('defaults to JSON when format query is missing', async () => {
    fx = await buildTestApp();
    await seedEntry(fx, 'api_key.minted');

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log/export',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('400 on invalid format', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log/export?format=xml',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('account-scoped: only returns the calling account audit entries', async () => {
    fx = await buildTestApp();
    // Seed an entry for the calling account and one for a different account.
    await seedEntry(fx, 'api_key.minted');
    await fx.accountAuditRepo.insert({
      accountId: '00000000-0000-4000-8000-000000000999',
      actorType: 'customer',
      actorAccountId: '00000000-0000-4000-8000-000000000999',
      actorKeyId: '00000000-0000-4000-8000-000000000888',
      action: 'session.created',
      targetResourceId: 'should_not_appear',
      payload: null,
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log/export?format=json',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<{ data: { target_resource_id: string | null }[] }>();
    expect(body.data.some((d) => d.target_resource_id === 'should_not_appear')).toBe(false);
  });

  // #122 — read:audit floor on the EXPORT route. It walks the same
  // AccountAuditService.list() that the read endpoint gates (read:audit),
  // so the scope contract holds identically: (a) broad `read` passes,
  // (b) granular read:audit passes, (c) a different-resource granular
  // scope (read:sessions) is blocked 403.
  const exportJson = (fxArg: TestAppFixture) =>
    fxArg.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log/export?format=json',
      headers: { authorization: `Bearer ${fxArg.plaintext}` },
    });

  it('403 for a cross-resource granular key (read:sessions does NOT satisfy read:audit)', async () => {
    fx = await buildTestApp({ scopes: ['read:sessions'] });
    const res = await exportJson(fx);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('read:audit');
  });

  it('200 for a granular read:audit key, a broad read key, and an account_owner key', async () => {
    fx = await buildTestApp({ scopes: ['read:audit'] });
    expect((await exportJson(fx)).statusCode).toBe(200);
    await fx.cleanup();
    fx = await buildTestApp({ scopes: ['read'] });
    expect((await exportJson(fx)).statusCode).toBe(200);
    await fx.cleanup();
    fx = await buildTestApp({ scopes: ['account_owner'] });
    expect((await exportJson(fx)).statusCode).toBe(200);
  });
});
