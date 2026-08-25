/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// Wave 29-400 §8.4 — Drizzle-backed end-to-end test for the
// /v1/internal/atlas-priority/* surface. Lint disables apply only to
// the .json()-result `any` accesses inherent to Fastify inject responses.
//
// Drizzle-path coverage per Meta-issue #3 from the 2026-05-19 scheduled-
// jobs incident (in-memory-repo integration tests never exercised the
// real Drizzle code path; this test exists explicitly to NOT repeat that
// gap). Runs against real Postgres via DATABASE_URL — CI's build-test
// service container, or local dev with docker-compose up postgres. Skips
// gracefully when DATABASE_URL is unreachable.
//
// Test plan:
//   - POST probe-signature with full attribution → row exists with
//     status='emitted', deduped=false.
//   - Re-POST same op_seq_sha + archetype within 5 min → deduped=true,
//     same event_id.
//   - POST event-status chain: emitted → bs_in_flight → bs_succeeded →
//     atlas_appended. Each transition reflected in row + 200 response.
//   - POST event-status with invalid transition (e.g. atlas_appended →
//     emitted) → 400 BadRequest.
//   - POST event-status with unknown event_id → 404 NotFound.
//   - GET queue with status filter → correct subset.
//   - GET event/:id → row + lifecycle timeline.
//   - All 4 routes reject missing/wrong Authorization → 401.

import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAtlasPriorityEventsRepo } from '../../src/db/atlas-priority-events-repo.js';
import { InternalFleetAuth } from '../../src/lib/internal-fleet-auth.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';
import { registerInternalAtlasPriorityRoutes } from '../../src/routes/internal-atlas-priority.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const TEST_TOKEN = 'test-internal-fleet-token-' + Date.now();
const AUTH = `Bearer ${TEST_TOKEN}`;

// Test bodies short-circuit on `if (!app) return` — `app` is null until
// beforeAll succeeds on both the connection probe AND the schema-presence
// probe, so the same flag handles both "no DB" and "schema not migrated"
// fallthroughs.
let client: ReturnType<typeof postgres> | null = null;
let app: FastifyInstance | null = null;
let repo: DrizzleAtlasPriorityEventsRepo | null = null;

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM atlas_priority_events LIMIT 0`;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  // `drizzle(client)` (no { schema }) — runtime works against real PG;
  // tests timed out with the schema-typed variant for reasons not
  // root-caused yet (separate followup). Cast through `unknown` to
  // satisfy the test typecheck against the schema-typed Database.db.
  const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  repo = new DrizzleAtlasPriorityEventsRepo({ client, db, close: async () => {} });
  const auth = new InternalFleetAuth({ internalToken: TEST_TOKEN });
  const rateLimitStore = new MemoryRateLimitStore();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerInternalAtlasPriorityRoutes(app, { repo, auth, rateLimitStore });
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (client) {
    // Clean up the rows this suite inserted. probePayload() seeds
    // every row's customer_id with a `cust-test-<unique>` prefix so
    // we can scoped-delete without touching real customer data.
    await client`DELETE FROM atlas_priority_events WHERE customer_id LIKE 'cust-test-%'`.catch(
      () => {},
    );
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  '/v1/internal/atlas-priority/* (Drizzle-backed end-to-end)',
  () => {
    // V-1328 — every arm here opens with `if (!app) return;`, and `app` stays
    // null whenever the probe or the table check failed. That made an
    // unreachable database indistinguishable from a passing run, in CI too:
    // pointed at a dead port with CI set, this file reported green.
    it('CRITICAL the app was built against a real database, so a green run here is not "no database". Every arm below returns early when it was not.', () => {
      if (!process.env.CI && app === null) return;
      expect(
        app,
        `could not build against ${DB_URL} — no arm below exercised anything`,
      ).not.toBeNull();
      // V-1668 — the clamp arm below bails on `!client || !repo`, not on
      // `!app`, so asserting `app` alone left it able to report PASSED with the
      // database down. `an-integration-test-cannot-pass-without-its-database`
      // caught exactly that, on the arm I had just added.
      expect(client, `no client against ${DB_URL} — the clamp arm asserted nothing`).not.toBeNull();
      expect(repo, `no repo against ${DB_URL} — the clamp arm asserted nothing`).not.toBeNull();
    });

    it("CRITICAL listRecent clamps limit into [1, 1000]. This clamp had NO coverage of any kind: neutralising it left the ENTIRE suite green — 3212 files, 31,944 tests — while the four sibling page-clamps each failed between one and four files under the same treatment. The route in front carries a Zod .min(1).max(1000), so this is defence-in-depth: a caller reaching the repo directly would pull the customer's whole event table.", async () => {
      if (!client || !repo) return;
      const customerId = `clamp-${randomUUID()}`;
      try {
        // 1001 rows so the upper clamp has something to clamp. One statement.
        await client`
          INSERT INTO atlas_priority_events
            (op_seq_sha, op_seq_bytes_b64, canvas_w, canvas_h, archetype_id,
             session_id, customer_id, page_url, status)
          SELECT ${customerId} || '-' || i, 'b64', 100, 100, 'arch', 'sess',
                 ${customerId}, 'https://example.test/', 'emitted'
          FROM generate_series(1, 1001) AS g(i)`;

        const oversized = await repo.listRecent({ customerId, limit: 5000 });
        expect(oversized.length, 'an oversized limit is clamped to 1000').toBe(1000);

        // The lower half of the same expression, which a Math.min-only clamp
        // would not provide: a zero or negative limit must still return a row
        // rather than an empty page (or a Postgres error on LIMIT -1).
        const zero = await repo.listRecent({ customerId, limit: 0 });
        expect(zero.length, 'a zero limit is raised to 1').toBe(1);
      } finally {
        await client`DELETE FROM atlas_priority_events WHERE customer_id = ${customerId}`;
      }
    });

    it('rejects missing Authorization with 401', async () => {
      if (!app) return;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/atlas-priority/probe-signature',
        payload: probePayload(),
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects wrong bearer with 401', async () => {
      if (!app) return;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/atlas-priority/probe-signature',
        headers: { authorization: 'Bearer wrong-token-xyz' },
        payload: probePayload(),
      });
      expect(res.statusCode).toBe(401);
    });

    it('POST probe-signature inserts new event with status=emitted, deduped=false', async () => {
      if (!app) return;
      const payload = probePayload();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/atlas-priority/probe-signature',
        headers: { authorization: AUTH },
        payload,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.event_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.status).toBe('emitted');
      expect(body.deduped).toBe(false);
    });

    it('POST probe-signature with same op_seq_sha+archetype within 5 min → deduped=true, same event_id', async () => {
      if (!app) return;
      const payload = probePayload();
      const first = await app.inject({
        method: 'POST',
        url: '/v1/internal/atlas-priority/probe-signature',
        headers: { authorization: AUTH },
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/v1/internal/atlas-priority/probe-signature',
        headers: { authorization: AUTH },
        payload,
      });
      expect(second.statusCode).toBe(200);
      const firstBody = first.json();
      const secondBody = second.json();
      expect(secondBody.deduped).toBe(true);
      expect(secondBody.event_id).toBe(firstBody.event_id);
    });

    it('POST event-status chain: emitted → bs_in_flight → bs_succeeded → atlas_appended', async () => {
      if (!app) return;
      const payload = probePayload();
      const probeRes = await app.inject({
        method: 'POST',
        url: '/v1/internal/atlas-priority/probe-signature',
        headers: { authorization: AUTH },
        payload,
      });
      const eventId = probeRes.json().event_id;

      const transitions = ['bs_in_flight', 'bs_succeeded', 'atlas_appended'] as const;
      let last;
      for (const newStatus of transitions) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/internal/atlas-priority/event-status',
          headers: { authorization: AUTH },
          payload: {
            event_id: eventId,
            new_status: newStatus,
            bs_session_id: newStatus === 'bs_in_flight' ? 'bs-test-session-1' : undefined,
            atlas_entry_hash:
              newStatus === 'atlas_appended' ? 'sha256:0123456789abcdef' : undefined,
            atlas_version: newStatus === 'atlas_appended' ? 'v583k-test' : undefined,
          },
        });
        expect(res.statusCode).toBe(200);
        last = res.json();
        expect(last.status).toBe(newStatus);
      }
      expect(last?.status).toBe('atlas_appended');
    });

    it('POST event-status with invalid transition → 400 BadRequest', async () => {
      if (!app) return;
      const probeRes = await app.inject({
        method: 'POST',
        url: '/v1/internal/atlas-priority/probe-signature',
        headers: { authorization: AUTH },
        payload: probePayload(),
      });
      const eventId = probeRes.json().event_id;
      // Skip ahead: emitted → atlas_appended is NOT an allowed edge.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/atlas-priority/event-status',
        headers: { authorization: AUTH },
        payload: { event_id: eventId, new_status: 'atlas_appended' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST event-status with unknown event_id → 404 NotFound', async () => {
      if (!app) return;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/atlas-priority/event-status',
        headers: { authorization: AUTH },
        payload: {
          event_id: '00000000-0000-4000-8000-000000000000',
          new_status: 'bs_in_flight',
        },
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET queue returns events list + stats', async () => {
      if (!app) return;
      const res = await app.inject({
        method: 'GET',
        url: '/v1/internal/atlas-priority/queue?limit=5',
        headers: { authorization: AUTH },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.length).toBeLessThanOrEqual(5);
      expect(typeof body.total_count).toBe('number');
      expect(body.stats).toBeDefined();
      expect(typeof body.stats.queueDepth).toBe('number');
    });

    it('GET event/:id returns full event + lifecycle timeline', async () => {
      if (!app) return;
      const probeRes = await app.inject({
        method: 'POST',
        url: '/v1/internal/atlas-priority/probe-signature',
        headers: { authorization: AUTH },
        payload: probePayload(),
      });
      const eventId = probeRes.json().event_id;
      await app.inject({
        method: 'POST',
        url: '/v1/internal/atlas-priority/event-status',
        headers: { authorization: AUTH },
        payload: { event_id: eventId, new_status: 'bs_in_flight' },
      });
      const detail = await app.inject({
        method: 'GET',
        url: `/v1/internal/atlas-priority/event/${eventId}`,
        headers: { authorization: AUTH },
      });
      expect(detail.statusCode).toBe(200);
      const body = detail.json();
      expect(body.event.id).toBe(eventId);
      expect(body.event.status).toBe('bs_in_flight');
      expect(Array.isArray(body.timeline)).toBe(true);
      expect(body.timeline[0]?.event).toBe('emitted');
    });

    it('GET event/:id with unknown id → 404 NotFound', async () => {
      if (!app) return;
      const res = await app.inject({
        method: 'GET',
        url: '/v1/internal/atlas-priority/event/00000000-0000-4000-8000-000000000000',
        headers: { authorization: AUTH },
      });
      expect(res.statusCode).toBe(404);
    });
  },
);

let counter = 0;
function probePayload() {
  counter += 1;
  const unique = `${Date.now()}-${counter}`;
  return {
    op_seq_sha: `test-op-seq-sha-${unique}`,
    op_seq_bytes_b64: 'dGVzdC1ieXRlcw==',
    canvas_w: 320,
    canvas_h: 240,
    mime: 'image/png',
    archetype_id: 'iphone17_ios18_7_safari26_4',
    last_fill_text: 'driftstack-test-fill',
    mac_len: 8,
    session_id: `sess-test-${unique}`,
    customer_id: `cust-test-${unique}`,
    page_url: 'https://example.com/test-path',
  };
}
