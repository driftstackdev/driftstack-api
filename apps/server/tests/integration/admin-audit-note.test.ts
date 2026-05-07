// V-281 — integration tests for the audit-only customer-support
// tooling endpoints:
//   POST /v1/admin/accounts/:id/audit-note
//   POST /v1/admin/accounts/:id/refund-record
//
// Both are audit-only — no side effect on account state, no Stripe
// call, no money movement. Each writes BOTH an admin_audit_log row
// (admin-side) AND an account_audit_log row (customer-side, surfaces
// in /v1/account/audit-log).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

const accId = (fixture: TestAppFixture): string => `acc_${fixture.accountId}`;

describe('POST /v1/admin/accounts/:id/audit-note', () => {
  it('201 records the note in BOTH admin + customer audit logs', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/audit-note`,
      headers: auth(fx),
      payload: { note: 'Customer requested rate-limit override; will follow up tomorrow.' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ ok: true }>().ok).toBe(true);

    const adminRows = fx.adminAuditRepo.getAll();
    expect(adminRows).toHaveLength(1);
    expect(adminRows[0]?.action).toBe('audit_note.added');
    expect(adminRows[0]?.result).toBe('success');
    expect(adminRows[0]?.targetAccountId).toBe(fx.accountId);

    const accountRows = fx.accountAuditRepo.getAll();
    expect(accountRows).toHaveLength(1);
    expect(accountRows[0]?.action).toBe('admin.support_note');
    expect(accountRows[0]?.actorType).toBe('staff');
    expect(accountRows[0]?.payload).toEqual({
      note: 'Customer requested rate-limit override; will follow up tomorrow.',
    });
  });

  it('400 when note is empty', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/audit-note`,
      headers: auth(fx),
      payload: { note: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when note exceeds 2000 chars', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/audit-note`,
      headers: auth(fx),
      payload: { note: 'a'.repeat(2001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 without driftstack_internal_admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/audit-note`,
      headers: auth(fx),
      payload: { note: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /v1/admin/accounts/:id/refund-record', () => {
  it('201 records the refund — audit-only, NO Stripe call', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/refund-record`,
      headers: auth(fx),
      payload: {
        external_reference: 'ch_3PXXXXXXXXXXXXXXXXX',
        amount_cents: 7900,
        currency: 'USD',
        reason: 'Trial pack purchase refunded; customer reported sessions never spawned.',
      },
    });
    expect(res.statusCode).toBe(201);

    const adminRows = fx.adminAuditRepo.getAll();
    expect(adminRows).toHaveLength(1);
    expect(adminRows[0]?.action).toBe('refund.recorded');
    expect(adminRows[0]?.result).toBe('success');
    const inputPayload = adminRows[0]?.inputPayload as Record<string, unknown> | undefined;
    expect(inputPayload?.external_reference).toBe('ch_3PXXXXXXXXXXXXXXXXX');
    expect(inputPayload?.amount_cents).toBe(7900);

    const accountRows = fx.accountAuditRepo.getAll();
    expect(accountRows).toHaveLength(1);
    expect(accountRows[0]?.action).toBe('admin.refund_recorded');
    expect(accountRows[0]?.actorType).toBe('staff');
    expect(accountRows[0]?.targetResourceId).toBe('ch_3PXXXXXXXXXXXXXXXXX');
    const accPayload = accountRows[0]?.payload as Record<string, unknown> | undefined;
    expect(accPayload?.amount_cents).toBe(7900);
    expect(accPayload?.currency).toBe('USD');
  });

  it('defaults currency to USD when omitted', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/refund-record`,
      headers: auth(fx),
      payload: {
        external_reference: 'ch_test',
        amount_cents: 299,
        reason: 'Trial pack double-charge',
      },
    });
    expect(res.statusCode).toBe(201);
    const accountRows = fx.accountAuditRepo.getAll();
    const payload = accountRows[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.currency).toBe('USD');
  });

  it('400 when external_reference is too short', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/refund-record`,
      headers: auth(fx),
      payload: {
        external_reference: 'ch',
        amount_cents: 299,
        reason: 'too-short ref',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when amount_cents is non-positive', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/refund-record`,
      headers: auth(fx),
      payload: {
        external_reference: 'ch_test',
        amount_cents: 0,
        reason: 'zero amount',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when reason is empty', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/refund-record`,
      headers: auth(fx),
      payload: {
        external_reference: 'ch_test',
        amount_cents: 100,
        reason: '',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 without driftstack_internal_admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/refund-record`,
      headers: auth(fx),
      payload: {
        external_reference: 'ch_test',
        amount_cents: 100,
        reason: 'unauthorized attempt',
      },
    });
    expect(res.statusCode).toBe(403);
  });
});
