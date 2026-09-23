// A staff action on a customer's credentials is recorded as staff, and announced
// the way any other one is — whichever credential the staff member used.
//
// Three defects from the identity-shape audit, all on the customer's own
// "Recent activity" log and webhook feed:
//
//   · finding 2 — terminating an account reclaims its credentials, including the
//     keys a team member minted on the OWNER's account. The reclaim reused the
//     customer revoke body, which hardcoded `actor_type: "customer"` and the
//     caller's ids, so the owner's log said one of their own team revoked the key
//     and named Driftstack's internal staff account and key. The webhook-endpoint
//     reclaim did the same.
//   · finding 3 — the staff force-revoke (`POST /v1/admin/api-keys/:id/revoke`)
//     wrote the key directly: no `api_key.revoked` webhook (which
//     webhooks/events.md promises "regardless of who initiated the revocation
//     (… or Driftstack staff)") and nothing on the customer's log.
//   · finding 4 — a staff support note or refund record published
//     `actor_key_id: key_<staff key>` when staff used an API key, and null when
//     they used the admin panel; audit-log.md says it is null for staff events.
//
// Runs through the whole app on a freshly migrated database of its own. Every
// staff arm runs twice: signed in to the admin panel (a web session) and with a
// staff API key.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { buildLegalCatalog } from '../../src/services/legal-catalog.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  adminCreditsHarness,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import {
  accountAuditRows,
  buildRealApp,
  seedAccount,
  seedApiKey,
  seedWebSession,
  send,
  type LegalCatalog,
  type RealApp,
  type SeededKey,
} from './_helpers/real-app-with-signed-in-identities.js';

const ISOLATED_DB_NAME = 'driftstack_iso_identity_staff_actions';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const OWNER_EMAIL = `owner-${randomUUID()}@driftstack.test`;

let client: postgres.Sql | null = null;
let database: Database | null = null;
let harness: AdminCreditsHarness | null = null;
let app: RealApp | null = null;
let catalog: LegalCatalog | null = null;

/** The staff member: the owner, who is always on the staff list. */
let staffAccountId = '';
let staffKey: SeededKey | null = null;
let staffBrowser = '';

function sql(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function theApp(): RealApp {
  if (app === null) throw new Error('the app was not built');
  return app;
}
function legal(): LegalCatalog {
  if (catalog === null) throw new Error('legal catalog not built');
  return catalog;
}

type Credential = 'a web session' | 'an API key';
function staffBearer(credential: Credential): string {
  return credential === 'a web session' ? staffBrowser : (staffKey?.plaintext ?? '');
}

/** A customer with an ordinary key and a webhook endpoint subscribed to `api_key.revoked`. */
async function customerWithWebhook(): Promise<{
  accountId: string;
  key: SeededKey;
  endpointId: string;
}> {
  const accountId = await seedAccount(sql(), `customer-${randomUUID()}@example.test`, legal());
  const key = await seedApiKey(sql(), accountId, { scopes: ['read', 'write', 'account_owner'] });
  const created = await send(theApp(), key.plaintext, 'POST', '/v1/webhooks', {
    url: 'https://hooks.example.test/driftstack',
    events: ['api_key.revoked'],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const [endpoint] = await sql()<Array<{ id: string }>>`
    SELECT id::text FROM webhook_endpoints WHERE account_id = ${accountId}::uuid ORDER BY created_at, id`;
  if (endpoint === undefined) throw new Error('the webhook endpoint was not created');
  return { accountId, key, endpointId: endpoint.id };
}

async function revokedDeliveries(endpointId: string): Promise<string[]> {
  const rows = await sql()<Array<{ api_key_id: string }>>`
    SELECT payload->'data'->>'api_key_id' AS api_key_id
      FROM webhook_deliveries
     WHERE webhook_id = ${endpointId}::uuid AND event_type = 'api_key.revoked'
     ORDER BY created_at, id`;
  return rows.map((r) => r.api_key_id);
}

/** What a staff row on the customer's log must carry, whichever credential staff used. */
function expectStaffRow(
  row: Awaited<ReturnType<typeof accountAuditRows>>[number] | undefined,
): void {
  expect(row, 'no row was written').toBeDefined();
  expect(row?.actor_type).toBe('staff');
  expect(row?.actor_account_id).toBe(staffAccountId);
  expect(row?.actor_key_id, 'a staff row names no key').toBeNull();
  expect(row?.actor_web_session_id, 'nor a staff sign-in').toBeNull();
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 6);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 6 });
  harness = adminCreditsHarness(opened.url);
  catalog = buildLegalCatalog({ repoRoot: REPO_ROOT });
  staffAccountId = await seedAccount(sql(), OWNER_EMAIL, catalog);
  staffKey = await seedApiKey(sql(), staffAccountId, {
    scopes: ['read', 'write', 'driftstack_internal_admin'],
    name: 'staff key',
  });
  staffBrowser = (await seedWebSession(sql(), staffAccountId)).token;
  app = await buildRealApp(database, harness, catalog, {
    staffEmails: new Set(),
    ownerEmail: OWNER_EMAIL,
  });
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await harness?.base.database.close().catch(() => {});
  await database?.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!RUN_DB_TESTS)(
  'a staff action on a customer’s credentials is recorded as staff and announced like any other',
  () => {
    it('the staff member authenticates as staff both ways — otherwise every arm below would be measuring a 403', async () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      for (const credential of ['a web session', 'an API key'] as const) {
        const listed = await send(theApp(), staffBearer(credential), 'GET', '/v1/admin/accounts');
        expect(listed.status, credential).toBe(200);
      }
    });

    describe.each(['a web session', 'an API key'] as const)('staff using %s', (credential) => {
      it('CRITICAL terminating a team member revokes the key they minted on the owner’s account, and the OWNER’s log records it as staff, naming no key — not as one of their own team', async () => {
        const owner = await customerWithWebhook();
        const memberId = await seedAccount(sql(), `member-${randomUUID()}@example.test`, legal());
        const memberMinted = await seedApiKey(sql(), owner.accountId, {
          scopes: ['read', 'write'],
          name: 'minted by a member',
          createdByAccountId: memberId,
        });

        const res = await send(
          theApp(),
          staffBearer(credential),
          'POST',
          `/v1/admin/accounts/acc_${memberId}/delete`,
          { reason: 'identity-shape audit, finding 2' },
        );
        expect(res.status, JSON.stringify(res.body)).toBe(200);

        const [key] = await sql()<Array<{ revoked_at: Date | null }>>`
          SELECT revoked_at FROM api_keys WHERE id = ${memberMinted.id}::uuid`;
        expect(key?.revoked_at, 'the reclaim did not run').not.toBeNull();
        const rows = (await accountAuditRows(sql(), owner.accountId, 'api_key.revoked')).filter(
          (r) => r.target_resource_id === `key_${memberMinted.id}`,
        );
        expect(rows).toHaveLength(1);
        expectStaffRow(rows[0]);

        const listed = await send(
          theApp(),
          owner.key.plaintext,
          'GET',
          '/v1/account/audit-log?action=api_key.revoked',
        );
        expect(listed.status).toBe(200);
        const published = (
          listed.body as {
            data: Array<{ target_resource_id: string; actor_type: string; actor_key_id: unknown }>;
          }
        ).data.filter((e) => e.target_resource_id === `key_${memberMinted.id}`);
        expect(published.map((e) => [e.actor_type, e.actor_key_id])).toEqual([['staff', null]]);
      });

      it('CRITICAL terminating an account records the reclaim of its own keys, sign-ins and webhook endpoints as staff', async () => {
        const doomed = await customerWithWebhook();
        const browser = await seedWebSession(sql(), doomed.accountId);
        const res = await send(
          theApp(),
          staffBearer(credential),
          'POST',
          `/v1/admin/accounts/acc_${doomed.accountId}/delete`,
          {},
        );
        expect(res.status, JSON.stringify(res.body)).toBe(200);

        const keyRows = (await accountAuditRows(sql(), doomed.accountId, 'api_key.revoked')).filter(
          (r) => r.target_resource_id === `key_${doomed.key.id}`,
        );
        expect(keyRows).toHaveLength(1);
        expectStaffRow(keyRows[0]);
        const endpointRows = (
          await accountAuditRows(sql(), doomed.accountId, 'webhook_endpoint.deleted')
        ).filter((r) => r.target_resource_id === `webhook_endpoint_${doomed.endpointId}`);
        expect(endpointRows).toHaveLength(1);
        expectStaffRow(endpointRows[0]);
        const [signIn] = await sql()<Array<{ revoked_at: Date | null }>>`
          SELECT revoked_at FROM web_sessions WHERE id = ${browser.id}::uuid`;
        expect(signIn?.revoked_at, 'the sign-in was not reclaimed').not.toBeNull();
        const signOutRows = (
          await accountAuditRows(sql(), doomed.accountId, 'account.logout')
        ).filter((r) => r.payload?.revoked_via === 'admin_account_deletion');
        expect(signOutRows).toHaveLength(1);
        expectStaffRow(signOutRows[0]);
      });

      it('CRITICAL a staff force-revoke answers 200, sends the customer the api_key.revoked webhook, and leaves a staff row on their log; revoking it again is idempotent and announces nothing twice', async () => {
        const customer = await customerWithWebhook();
        const target = await seedApiKey(sql(), customer.accountId, {
          scopes: ['read'],
          name: 'the key staff revoke',
        });

        const res = await send(
          theApp(),
          staffBearer(credential),
          'POST',
          `/v1/admin/api-keys/key_${target.id}/revoke`,
          { reason: 'identity-shape audit, finding 3' },
        );
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect((res.body as { id: string }).id).toBe(`key_${target.id}`);
        expect((await send(theApp(), target.plaintext, 'GET', '/v1/whoami')).status).toBe(401);

        expect(await revokedDeliveries(customer.endpointId)).toEqual([`key_${target.id}`]);
        const rows = (await accountAuditRows(sql(), customer.accountId, 'api_key.revoked')).filter(
          (r) => r.target_resource_id === `key_${target.id}`,
        );
        expect(rows).toHaveLength(1);
        expectStaffRow(rows[0]);

        // The staff-side audit trail is unchanged: it still names the staff credential.
        const [adminRow] = await sql()<Array<{ result: string; target_account_id: string | null }>>`
          SELECT result, target_account_id::text AS target_account_id FROM admin_audit_log
           WHERE action::text = 'api_key.revoked_by_admin' AND target_resource_id = ${target.id}
           ORDER BY timestamp, id`;
        expect(adminRow?.result).toBe('success');
        expect(adminRow?.target_account_id).toBe(customer.accountId);

        const again = await send(
          theApp(),
          staffBearer(credential),
          'POST',
          `/v1/admin/api-keys/key_${target.id}/revoke`,
          {},
        );
        expect(again.status, JSON.stringify(again.body)).toBe(200);
        expect(await revokedDeliveries(customer.endpointId)).toEqual([`key_${target.id}`]);
        expect(
          (await accountAuditRows(sql(), customer.accountId, 'api_key.revoked')).filter(
            (r) => r.target_resource_id === `key_${target.id}`,
          ),
        ).toHaveLength(1);
      });

      it('a force-revoke of a key that does not exist is a 404 and announces nothing', async () => {
        const res = await send(
          theApp(),
          staffBearer(credential),
          'POST',
          `/v1/admin/api-keys/key_${randomUUID()}/revoke`,
          {},
        );
        expect(res.status, JSON.stringify(res.body)).toBe(404);
      });

      it('CRITICAL a support note and a refund record publish actor_key_id null on the customer’s log, and store no staff key', async () => {
        const customer = await customerWithWebhook();
        const note = await send(
          theApp(),
          staffBearer(credential),
          'POST',
          `/v1/admin/accounts/acc_${customer.accountId}/audit-note`,
          { note: 'identity-shape audit, finding 4' },
        );
        expect(note.status, JSON.stringify(note.body)).toBe(201);
        const refund = await send(
          theApp(),
          staffBearer(credential),
          'POST',
          `/v1/admin/accounts/acc_${customer.accountId}/refund-record`,
          {
            external_reference: `re_${randomUUID().replace(/-/g, '')}`,
            amount_cents: 500,
            reason: 'identity-shape audit, finding 4',
          },
        );
        expect(refund.status, JSON.stringify(refund.body)).toBe(201);

        for (const action of ['admin.support_note', 'admin.refund_recorded']) {
          const rows = await accountAuditRows(sql(), customer.accountId, action);
          expect(rows, action).toHaveLength(1);
          expectStaffRow(rows[0]);
          const listed = await send(
            theApp(),
            customer.key.plaintext,
            'GET',
            `/v1/account/audit-log?action=${action}`,
          );
          expect(listed.status).toBe(200);
          const data = (
            listed.body as { data: Array<{ actor_type: string; actor_key_id: unknown }> }
          ).data;
          expect(
            data.map((e) => [e.actor_type, e.actor_key_id]),
            action,
          ).toEqual([['staff', null]]);
        }
      });
    });

    it('a staff row written before the fix, still naming the staff key, reads back with actor_key_id null in the list and the JSON export, and an empty cell in the CSV export', async () => {
      const customer = await customerWithWebhook();
      await sql()`
        INSERT INTO account_audit_log (account_id, actor_type, actor_account_id, actor_key_id, action, payload)
        VALUES (${customer.accountId}::uuid, 'staff', ${staffAccountId}::uuid, ${staffKey?.id ?? ''}::uuid,
                'admin.support_note', ${sql().json({ note: 'written before the fix' })})`;
      const listed = await send(
        theApp(),
        customer.key.plaintext,
        'GET',
        '/v1/account/audit-log?action=admin.support_note',
      );
      expect(listed.status).toBe(200);
      expect(
        (listed.body as { data: Array<{ actor_key_id: unknown }> }).data.map((e) => e.actor_key_id),
      ).toEqual([null]);
      const exported = await send(
        theApp(),
        customer.key.plaintext,
        'GET',
        '/v1/account/audit-log/export?format=json',
      );
      expect(exported.status).toBe(200);
      const entries = (exported.body as { data: Array<{ action: string; actor_key_id: unknown }> })
        .data;
      expect(
        entries.filter((e) => e.action === 'admin.support_note').map((e) => e.actor_key_id),
      ).toEqual([null]);

      const csv = await theApp().inject({
        method: 'GET',
        url: '/v1/account/audit-log/export?format=csv',
        headers: { authorization: `Bearer ${customer.key.plaintext}` },
      });
      expect(csv.statusCode).toBe(200);
      const [header, ...lines] = csv.body.trim().split('\n');
      const keyColumn = (header ?? '').split(',').indexOf('actor_key_id');
      expect(keyColumn, 'the CSV names its actor_key_id column').toBeGreaterThan(-1);
      const noteLines = lines.filter((l) => l.includes('admin.support_note'));
      expect(noteLines).toHaveLength(1);
      // The first columns are plain values (no quoting), so a comma split reaches the cell.
      expect(noteLines[0]?.split(',')[keyColumn], 'the actor_key_id cell').toBe('');
      expect(csv.body).not.toContain(`key_${staffKey?.id ?? 'unset'}`);
    });
  },
);
