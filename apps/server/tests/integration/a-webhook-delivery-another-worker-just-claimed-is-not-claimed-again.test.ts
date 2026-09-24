// A webhook delivery another worker has just claimed is not claimed a second time.
//
// Webhooks audit #6 (2026-09-24, LOW, latent). `claim` ranks due rows in a window
// function and, because PostgreSQL forbids FOR UPDATE next to one, takes its
// locks in a separate step: `WHERE id IN (SELECT id FROM fair) FOR UPDATE SKIP
// LOCKED`. The ranking reads the statement's snapshot. So a row another worker
// claims and COMMITS after that snapshot is taken, but before this statement
// reaches it, is no longer locked — SKIP LOCKED does not skip it — and on the
// lock PostgreSQL re-checks only the locking step's own WHERE, which said
// nothing about status. The row is claimed twice, and the customer receives the
// same event twice. The audit's run: `W1 committed X at 49 ms | W2 claim finished
// at 87 ms | W2 also returned X: true`.
//
// The locking step now repeats the due/stale predicate, so the re-check on the
// row's committed version sees `in_flight` (and fresh) and drops it.
//
// Latent because production runs one poller that never overlaps itself; the
// claim's comment promised the multi-instance guarantee anyway.
//
// Making the interleaving happen: W1 updates X to in_flight in an open
// transaction, W2 starts its claim (its snapshot sees X pending), and W1 commits
// as soon as pg_stat_activity shows W2's claim running — while its ranking over
// 200k due rows is still under way. The arm REFUSES to report either way unless
// the commit really did land inside W2's claim, since otherwise it proves nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openWebhookDeliveryDb, type WebhookDeliveryDb } from './_helpers/webhook-delivery-db.js';

const ISOLATED_DB_NAME = 'driftstack_iso_webhook_claim_race';
const ENDPOINTS = 400;
const ROWS_PER_ENDPOINT = 500;

let fx: WebhookDeliveryDb | null = null;
let target = '';

beforeAll(async () => {
  fx = await openWebhookDeliveryDb(ISOLATED_DB_NAME);
  if (fx === null) return;
  await fx.wipe();
  const db = fx.client;
  const account = await fx.seedAccount();
  // Raw rows: the claim reads only webhook_deliveries (and the endpoints' pause
  // state), never a secret, so the endpoints need not carry real envelopes.
  await db`
    INSERT INTO webhook_endpoints (id, account_id, url, secret, secret_prefix, events)
    SELECT gen_random_uuid(), ${account}, 'https://hooks.test.local/race', 'x', 'whsec_race',
           ARRAY['session.completed']::webhook_event_type[]
    FROM generate_series(1, ${ENDPOINTS})`;
  await db`
    INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, status, attempts, next_attempt_at)
    SELECT e.id, gen_random_uuid(), 'session.completed', '{}'::jsonb, 'pending', 0,
           now() - interval '1 hour' + (g * interval '1 millisecond')
    FROM webhook_endpoints e CROSS JOIN generate_series(1, ${ROWS_PER_ENDPOINT}) AS g
    WHERE e.account_id = ${account}`;
  // X — the oldest due row in the table, so any claim ranks it first.
  target = randomUUID();
  await db`
    INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, attempts, next_attempt_at)
    SELECT ${target}, id, gen_random_uuid(), 'session.completed', '{}'::jsonb, 'pending', 0,
           now() - interval '1 day'
    FROM webhook_endpoints WHERE account_id = ${account} ORDER BY id LIMIT 1`;
  await db`ANALYZE webhook_deliveries`;
}, 120_000);

afterAll(async () => {
  await fx?.wipe();
  await fx?.close();
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'a webhook delivery another worker has just claimed is not claimed again',
  () => {
    it('CRITICAL the isolated database was reached', () => {
      expect(fx, `could not create or reach ${ISOLATED_DB_NAME}`).not.toBeNull();
    });

    it('CRITICAL W1 commits X to in_flight while W2 is still inside its claim: W2 does not return X', async () => {
      const db = fx!;
      const w1 = await db.client.reserve();
      try {
        await w1`BEGIN`;
        const locked = await w1`
          UPDATE webhook_deliveries SET status = 'in_flight', updated_at = now()
          WHERE id = ${target} AND status = 'pending'
          RETURNING id`;
        expect(locked.length, 'W1 claimed X').toBe(1);

        const t0 = Date.now();
        let w2FinishedAt = 0;
        const w2 = db.repo.claim({ batchSize: 25, now: new Date() }).then((rows) => {
          w2FinishedAt = Date.now() - t0;
          return rows;
        });
        // Commit only once W2's claim is executing (its snapshot taken), and
        // while its ranking over every due row is still running. Nothing else in
        // this database runs a statement at that moment — W1 is idle in its
        // transaction — so any other active backend here IS W2. (Not matched on
        // the query text: pg_stat_activity keeps only its first 1 kB, and the
        // claim opens with long comments.)
        let w2Running = false;
        for (let i = 0; i < 2_000 && !w2Running; i += 1) {
          const [row] = await db.client<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND state = 'active'
              AND pid <> pg_backend_pid()`;
          w2Running = (row?.n ?? 0) > 0;
        }
        expect(w2Running, 'W2 never showed up as a running claim').toBe(true);
        await new Promise((r) => setTimeout(r, 2));
        await w1`COMMIT`;
        const w1CommittedAt = Date.now() - t0;
        const returned = await w2;

        const timeline = `W1 committed X at ${String(w1CommittedAt)} ms | W2 claim finished at ${String(w2FinishedAt)} ms | W2 returned ${String(returned.length)} rows`;
        expect(
          w1CommittedAt < w2FinishedAt,
          `the race did not happen, so this run proves nothing: ${timeline}`,
        ).toBe(true);
        expect(returned.length, timeline).toBeGreaterThan(0);
        expect(
          returned.some((r) => r.id === target),
          `W2 claimed a delivery W1 had already claimed and committed: ${timeline}`,
        ).toBe(false);
      } finally {
        await w1`ROLLBACK`.catch(() => undefined);
        w1.release();
      }
    });
  },
);
