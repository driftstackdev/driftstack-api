// V-785 — a pair-mode session parked before a restart can still time out after it.
//
// `docs/api/agent-sessions.md` tells customers: "A parked `takeover-pending`
// session returns to `ai-driving` after 30s without a client heartbeat." The
// three SDK quickstarts repeat it. That revert is fired by the 5s
// `PairModeHeartbeatSweep`, which walks `PairModeHeartbeatTracker.findStaleSessions()`.
//
// The tracker is a process-local `Map`, rebuilt empty on every boot, while
// `pair_mode_state` is a persisted JSONB column. So the parked state survived a
// restart and the only thing that could clear it did not. Worse, the session
// could not re-register itself: the input-event route 409s on
// `takeover-pending | takeover-queued | handback-pending | handback-queued`
// BEFORE it reaches `recordHeartbeat`, and per V-757 nothing emits
// `takeover-grant`, so there was no forward exit either. The only remaining
// outcome was the orphan reaper closing the session on its wall-clock lifetime
// cap — recovery by eventual death.
//
// This is deliberately asserted through a REAL boot rather than by calling the
// seed helper directly. A unit test of the repo query proves the rows can be
// found; it cannot prove bootstrap asks for them, and "the wiring exists" is
// exactly the claim a content-parity pin makes and cannot keep (see V-784).
//
// Note what is NOT asserted: that the sweep then fires. That needs 30s of wall
// clock and belongs to the sweep's own unit tests, which already cover it. The
// property this file owns is the one a restart broke — the parked session is
// VISIBLE to the sweep again.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProductionDeps } from '../../src/lib/bootstrap.js';
import { loadConfig } from '../../src/lib/config.js';
import { createTestLogger } from '../../src/lib/logger.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededAccountIds: string[] = [];

beforeAll(async () => {
  it('CRITICAL the service was reachable, so a green here is not "no service"', () => {
    // Without this, every arm below early-returns against a dead service and the
    // file reports PASSED — a green meaning "nothing was tested".
    expect(dbReachable, 'the integration dependency was unreachable').toBeTruthy();
  });

  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 2 });
  try {
    await client`SELECT 1 FROM agent_sessions LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client !== null && seededAccountIds.length > 0) {
    await client`DELETE FROM accounts WHERE id = ANY(${seededAccountIds})`.catch(() => {});
  }
  await client?.end({ timeout: 2 }).catch(() => {});
});

describe('a pair-mode session parked before a restart is visible to the sweep after it', () => {
  it('CRITICAL a real boot seeds the heartbeat tracker from the parked sessions in the database. Without it the tracker starts empty, the 5s sweep walks only what the tracker knows, and a session parked in takeover-pending is invisible to the one mechanism that could revert it — while the input-event route 409s on that state before reaching recordHeartbeat, so the session cannot re-register itself either. The documented 30s revert simply never happens and the session stays parked until the orphan reaper closes it.', async () => {
    if (!dbReachable || client === null) {
      expect(dbReachable, 'Postgres unreachable — restart recovery not verified').toBe(false);
      return;
    }

    const accountId = randomUUID();
    seededAccountIds.push(accountId);
    await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`v785-${accountId}@test.local`})`;

    const parkedId = `agt_${randomUUID()}`;
    const restingId = `agt_${randomUUID()}`;
    const closedId = `agt_${randomUUID()}`;

    // Parked: exactly the state the docs promise reverts after 30s.
    await client`
      INSERT INTO agent_sessions (id, account_id, status, mode, token_budget_total, token_budget_remaining, pair_mode_state)
      VALUES (${parkedId}, ${accountId}, 'active', 'pair', 1000, 1000,
              ${client.json({ kind: 'takeover-pending', requestedByClientId: 'cli_v785', requestedAt: '2026-08-15T00:00:00.000Z' })})
    `;
    // Resting: ai-driving needs no heartbeat and must NOT be seeded, or every
    // ordinary pair session would be handed a countdown it never asked for.
    await client`
      INSERT INTO agent_sessions (id, account_id, status, mode, token_budget_total, token_budget_remaining, pair_mode_state)
      VALUES (${restingId}, ${accountId}, 'active', 'pair', 1000, 1000, ${client.json({ kind: 'ai-driving' })})
    `;
    // Closed: parked at the moment it closed. A closed session has nothing to
    // revert to, and seeding it would make the sweep do work on a dead row.
    await client`
      INSERT INTO agent_sessions (id, account_id, status, mode, token_budget_total, token_budget_remaining, pair_mode_state, closed_at, closed_reason)
      VALUES (${closedId}, ${accountId}, 'closed', 'pair', 1000, 1000,
              ${client.json({ kind: 'takeover-pending', requestedByClientId: 'cli_v785', requestedAt: '2026-08-15T00:00:00.000Z' })},
              now(), 'test')
    `;

    const boot = await createProductionDeps(loadConfig(), createTestLogger());
    try {
      const tracker = boot.deps.pairModeHeartbeatTracker;
      expect(tracker, 'the tracker is wired into AppDeps').toBeDefined();

      expect(
        tracker?.getLastHeartbeatAt(parkedId),
        'the parked session is known to the tracker, so findStaleSessions can reach it',
      ).not.toBeNull();
      expect(
        tracker?.getLastHeartbeatAt(restingId),
        'an ai-driving session is NOT seeded — it is at rest, not waiting on anyone',
      ).toBeNull();
      expect(
        tracker?.getLastHeartbeatAt(closedId),
        'a closed session is NOT seeded — there is nothing left to revert',
      ).toBeNull();

      // The seed timestamp is the boot, not the original park: a client that is
      // still connected gets the ordinary grace window to send input, and one
      // that is gone times out 30s from boot rather than immediately. Seeding
      // with the original requestedAt would revert every parked session on the
      // very first sweep tick after a deploy, including live ones.
      const seededAt = tracker?.getLastHeartbeatAt(parkedId);
      expect(seededAt, 'seeded').not.toBeNull();
      expect(
        seededAt !== null && seededAt !== undefined
          ? seededAt.getTime() > Date.parse('2026-08-15T00:00:00.000Z')
          : false,
        'seeded at boot time, not at the moment the session was originally parked',
      ).toBe(true);
    } finally {
      await boot.teardown();
    }
  }, 120_000);
});
