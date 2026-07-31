// V-285 — E2E coverage for V-281 customer-support tooling against real
// Postgres + Redis.
//
// Why e2e (vs the existing 10 integration tests in
// admin-audit-note.test.ts):
//   - Catches the V-281 Drizzle enum migration (`audit_note.added` +
//     `refund.recorded`) actually applied against real Postgres. The
//     in-memory repo doesn't enforce the pgEnum constraint, so an
//     un-migrated DB would 500 here but pass the integration suite.
//   - Verifies the dual-write pattern (admin_audit_log +
//     account_audit_log rows in lockstep) survives transactional
//     boundaries.
//   - Confirms the customer-visible audit row is readable via the
//     customer-side `GET /v1/account/audit-log` route — i.e. the
//     staff-recorded note actually surfaces on the customer's audit
//     timeline, not just the admin one.

import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test.beforeEach(async () => {
  await server.resetState();
});

interface AuditLogEntry {
  id: string;
  action: string;
  actor_type: string;
  target_resource_id?: string | null;
  payload?: Record<string, unknown> | null;
}

test('admin support-note: dual-write reaches customer audit slice', async ({ request }) => {
  const admin = await seedAccount(server.client, {
    tier: 'api_builder',
    // The staff scope, explicitly. seedAccount defaults to the legacy `admin`
    // customer alias, which by design NEVER satisfies a staff gate — so
    // without this the ADMIN's own call 403s and the dual-write under test is
    // never reached.
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  // Free target reads its OWN audit log, which is free-desktop allowlisted —
  // but only for a device-provenance credential. An ordinary free key is
  // refused at auth before the dual-write under test is ever reached.
  const target = await seedAccount(server.client, {
    tier: 'free',
    provenance: 'cli_device',
  });

  // 1. Admin records a support note.
  const noteRes = await request.post(
    `${server.baseUrl}/v1/admin/accounts/acc_${target.accountId}/audit-note`,
    {
      headers: authHeader(admin.plaintext),
      data: { note: 'Customer reached out via support@; flagged for billing followup tomorrow.' },
    },
  );
  expect(noteRes.status()).toBe(201);
  const noteBody = (await noteRes.json()) as { ok: boolean };
  expect(noteBody.ok).toBe(true);

  // 2. The customer's own audit log surfaces the note (action=admin.support_note).
  const customerAudit = await request.get(`${server.baseUrl}/v1/account/audit-log`, {
    headers: authHeader(target.plaintext),
  });
  expect(customerAudit.status()).toBe(200);
  const body = (await customerAudit.json()) as { data: AuditLogEntry[] };
  const noteRow = body.data.find((r) => r.action === 'admin.support_note');
  expect(noteRow).toBeTruthy();
  expect(noteRow?.actor_type).toBe('staff');
  expect(noteRow?.payload?.note).toBe(
    'Customer reached out via support@; flagged for billing followup tomorrow.',
  );
});

test('admin refund-record: dual-write + Stripe ref preserved on target_resource_id', async ({
  request,
}) => {
  const admin = await seedAccount(server.client, {
    tier: 'api_builder',
    // The staff scope, explicitly. seedAccount defaults to the legacy `admin`
    // customer alias, which by design NEVER satisfies a staff gate — so
    // without this the ADMIN's own call 403s and the dual-write under test is
    // never reached.
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  // Free target reads its OWN audit log, which is free-desktop allowlisted —
  // but only for a device-provenance credential. An ordinary free key is
  // refused at auth before the dual-write under test is ever reached.
  const target = await seedAccount(server.client, {
    tier: 'free',
    provenance: 'cli_device',
  });

  // 1. Admin records a refund (audit-only — no Stripe call).
  const refundRes = await request.post(
    `${server.baseUrl}/v1/admin/accounts/acc_${target.accountId}/refund-record`,
    {
      headers: authHeader(admin.plaintext),
      data: {
        external_reference: 'ch_3PWEXAMPLE123',
        amount_cents: 299,
        currency: 'USD',
        reason: 'Trial pack double-charge; refunded via Stripe dashboard.',
      },
    },
  );
  expect(refundRes.status()).toBe(201);

  // 2. Customer audit slice surfaces the refund with Stripe ref + amount.
  const customerAudit = await request.get(`${server.baseUrl}/v1/account/audit-log`, {
    headers: authHeader(target.plaintext),
  });
  expect(customerAudit.status()).toBe(200);
  const body = (await customerAudit.json()) as { data: AuditLogEntry[] };
  const refundRow = body.data.find((r) => r.action === 'admin.refund_recorded');
  expect(refundRow).toBeTruthy();
  expect(refundRow?.actor_type).toBe('staff');
  expect(refundRow?.target_resource_id).toBe('ch_3PWEXAMPLE123');
  expect(refundRow?.payload?.amount_cents).toBe(299);
  expect(refundRow?.payload?.currency).toBe('USD');
  expect(refundRow?.payload?.reason).toBe(
    'Trial pack double-charge; refunded via Stripe dashboard.',
  );
});

test('admin support-note: 403 when caller lacks driftstack_internal_admin scope', async ({
  request,
}) => {
  // Default admin fixture seeds 'admin' compat scope which DOES satisfy
  // driftstack_internal_admin. Seed a non-admin account to verify the
  // 403 path against the live scope-check.
  const customer = await seedAccount(server.client, {
    tier: 'api_builder',
    scopes: ['read', 'write'],
  });
  // Free target reads its OWN audit log, which is free-desktop allowlisted —
  // but only for a device-provenance credential. An ordinary free key is
  // refused at auth before the dual-write under test is ever reached.
  const target = await seedAccount(server.client, {
    tier: 'free',
    provenance: 'cli_device',
  });

  const res = await request.post(
    `${server.baseUrl}/v1/admin/accounts/acc_${target.accountId}/audit-note`,
    {
      headers: authHeader(customer.plaintext),
      data: { note: 'unauthorized attempt' },
    },
  );
  expect(res.status()).toBe(403);
});
