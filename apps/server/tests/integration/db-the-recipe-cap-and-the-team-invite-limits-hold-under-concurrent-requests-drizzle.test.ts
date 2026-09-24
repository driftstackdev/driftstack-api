// Security sweep 2026-09-24, findings #6 and #7 — the new caps, against Postgres.
//
// The route tests run on the in-memory doubles, which are sequential and cannot
// race. What makes a cap hold in production is the Drizzle method deciding it
// under a per-account advisory lock, so concurrent requests serialise and the
// loser reads the winner's row. Each arm below fires its requests at once over a
// pool of several connections:
//
//   recipes       one account at its cap minus one, five saves of different
//                 sessions → exactly one lands; five saves of ONE session under
//                 five names → exactly one lands, the others see it.
//   team invites  five invites of one address at once → one is written, the
//                 others are inside the cooldown; a team one short of its
//                 pending cap, five new addresses at once → exactly one lands.
//
// Plus the rules the count itself must get right: an accepted or expired invite
// is not waiting, an exact repeat of a recipe save is the recipe already saved,
// and an invite past its cooldown can be sent again with a fresh token.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';
import { DrizzleRecipesRepo } from '../../src/db/recipes-repo.js';
import { DrizzleTeamMembersRepo } from '../../src/db/team-members-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const KEY = Buffer.alloc(32, 29).toString('base64');
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;

let client: ReturnType<typeof postgres> | null = null;
let recipes: DrizzleRecipesRepo | null = null;
let agentSessions: DrizzleAgentSessionsRepo | null = null;
let team: DrizzleTeamMembersRepo | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM recipes LIMIT 0`;
    await probe`SELECT 1 FROM team_invites LIMIT 0`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  // Several connections, so the concurrent arms race real backends.
  client = postgres(DB_URL, { max: 6 });
  dbReachable = true;
  const handle = { client, db: drizzle(client, { schema }), close: async () => {} };
  recipes = new DrizzleRecipesRepo(handle, { payloadEncryptionKeyBase64: KEY });
  agentSessions = new DrizzleAgentSessionsRepo(handle, {
    transcriptEncryptionKeyBase64: KEY,
  });
  team = new DrizzleTeamMembersRepo(handle);
});

afterAll(async () => {
  if (client && seeded.length > 0) {
    await client`DELETE FROM recipes WHERE account_id = ANY(${client.array(seeded)}::uuid[])`.catch(
      () => undefined,
    );
    await client`DELETE FROM accounts WHERE id = ANY(${client.array(seeded)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await client?.end({ timeout: 2 }).catch(() => undefined);
});

async function seedAccount(): Promise<string> {
  const id = randomUUID();
  await client!`
    INSERT INTO accounts (id, email, status)
    VALUES (${id}, ${`secfix1-${id}@test.local`}, 'active')`;
  seeded.push(id);
  return id;
}

async function newSession(accountId: string): Promise<string> {
  return (await agentSessions!.create({ accountId, tokenBudgetTotal: 1000 })).id;
}

function saveRecipe(
  accountId: string,
  agentSessionId: string | null,
  label: string,
  limit: number,
): ReturnType<DrizzleRecipesRepo['createIfUnderLimit']> {
  return recipes!.createIfUnderLimit({
    accountId,
    agentSessionId,
    label,
    intentLog: [],
    transcriptSnapshot: [],
    limit,
  });
}

async function recipeRows(accountId: string): Promise<number> {
  const [row] = await client!<{ n: number }[]>`
    SELECT count(*)::int AS n FROM recipes WHERE account_id = ${accountId}`;
  return row?.n ?? 0;
}

function inviteOnce(
  ownerAccountId: string,
  inviteeEmail: string,
  maxPending: number,
  now = new Date(),
): ReturnType<DrizzleTeamMembersRepo['upsertInviteIfUnderPendingLimit']> {
  return team!.upsertInviteIfUnderPendingLimit({
    ownerAccountId,
    inviteeEmail,
    role: 'member',
    inviteTokenHash: `hash-${randomUUID()}`,
    inviteExpiresAt: new Date(now.getTime() + TTL_MS),
    invitedByAccountId: ownerAccountId,
    maxPending,
    resendCooldownMs: COOLDOWN_MS,
    inviteTtlMs: TTL_MS,
    now,
  });
}

async function pendingRows(ownerAccountId: string): Promise<number> {
  const [row] = await client!<{ n: number }[]>`
    SELECT count(*)::int AS n FROM team_invites
    WHERE owner_account_id = ${ownerAccountId} AND accepted_at IS NULL`;
  return row?.n ?? 0;
}

describe('the recipe cap and the team-invite limits hold under concurrent requests', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL an account one short of its recipe cap: five concurrent saves of different sessions store exactly one', async () => {
    if (!dbReachable) return;
    const accountId = await seedAccount();
    for (let i = 0; i < 2; i += 1) {
      expect(
        (await saveRecipe(accountId, await newSession(accountId), `seed ${String(i)}`, 3)).kind,
      ).toBe('created');
    }
    const sessions = await Promise.all(Array.from({ length: 5 }, () => newSession(accountId)));
    const outcomes = await Promise.all(
      sessions.map((s, i) => saveRecipe(accountId, s, `race ${String(i)}`, 3)),
    );
    expect(outcomes.map((o) => o.kind).sort()).toEqual([
      'created',
      'limit_reached',
      'limit_reached',
      'limit_reached',
      'limit_reached',
    ]);
    for (const o of outcomes) if (o.kind === 'limit_reached') expect(o.current).toBe(3);
    expect(await recipeRows(accountId)).toBe(3);
  });

  it('CRITICAL five concurrent saves of ONE session under five names store exactly one recipe; the others are told which', async () => {
    if (!dbReachable) return;
    const accountId = await seedAccount();
    const sessionId = await newSession(accountId);
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        saveRecipe(accountId, sessionId, `name ${String(i)}`, 50),
      ),
    );
    const created = outcomes.filter((o) => o.kind === 'created');
    expect(created).toHaveLength(1);
    const winner = created[0]!.kind === 'created' ? created[0]!.record.id : '';
    for (const o of outcomes) {
      if (o.kind !== 'created') {
        expect(o).toEqual({ kind: 'session_already_saved', recipeId: winner });
      }
    }
    expect(await recipeRows(accountId)).toBe(1);
  });

  it('an exact repeat of a save is the recipe already saved, and a save with no source session is never deduplicated', async () => {
    if (!dbReachable) return;
    const accountId = await seedAccount();
    const sessionId = await newSession(accountId);
    const first = await saveRecipe(accountId, sessionId, 'same', 50);
    const again = await saveRecipe(accountId, sessionId, 'same', 50);
    expect(first.kind).toBe('created');
    expect(again.kind).toBe('existing');
    if (first.kind === 'created' && again.kind === 'existing') {
      expect(again.record.id).toBe(first.record.id);
    }
    expect((await saveRecipe(accountId, null, 'loose', 50)).kind).toBe('created');
    expect((await saveRecipe(accountId, null, 'loose', 50)).kind).toBe('created');
    expect(await recipeRows(accountId)).toBe(3);
  });

  it('CRITICAL five concurrent invites of one address write one invite; the other four are inside the cooldown and change nothing', async () => {
    if (!dbReachable) return;
    const owner = await seedAccount();
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => inviteOnce(owner, 'race@example.test', 20)),
    );
    expect(outcomes.map((o) => o.kind).sort()).toEqual([
      'cooldown',
      'cooldown',
      'cooldown',
      'cooldown',
      'upserted',
    ]);
    const written = outcomes.find((o) => o.kind === 'upserted');
    const [row] = await client!<{ invite_token_hash: string }[]>`
      SELECT invite_token_hash FROM team_invites
      WHERE owner_account_id = ${owner} AND invitee_email = 'race@example.test'`;
    expect(written?.kind === 'upserted' ? written.invite.inviteTokenHash : null).toBe(
      row?.invite_token_hash,
    );
    for (const o of outcomes) {
      if (o.kind === 'cooldown') {
        expect(o.retryAfterMs).toBeGreaterThan(COOLDOWN_MS - 60_000);
        expect(o.retryAfterMs).toBeLessThanOrEqual(COOLDOWN_MS);
      }
    }
  });

  it('CRITICAL a team one short of its pending cap: five concurrent invites of new addresses land exactly one', async () => {
    if (!dbReachable) return;
    const owner = await seedAccount();
    for (const e of ['p1@example.test', 'p2@example.test']) {
      expect((await inviteOnce(owner, e, 3)).kind).toBe('upserted');
    }
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, i) => inviteOnce(owner, `new-${String(i)}@example.test`, 3)),
    );
    expect(outcomes.map((o) => o.kind).sort()).toEqual([
      'pending_limit',
      'pending_limit',
      'pending_limit',
      'pending_limit',
      'upserted',
    ]);
    expect(await pendingRows(owner)).toBe(3);
  });

  it('an accepted or expired invite is not waiting, and an invite past its cooldown is sent again with a fresh token even at the cap', async () => {
    if (!dbReachable) return;
    const owner = await seedAccount();
    const past = new Date(Date.now() - COOLDOWN_MS - 60_000);
    expect((await inviteOnce(owner, 'old@example.test', 2, past)).kind).toBe('upserted');
    expect((await inviteOnce(owner, 'taken@example.test', 2)).kind).toBe('upserted');
    // At the cap of 2 …
    expect((await inviteOnce(owner, 'third@example.test', 2)).kind).toBe('pending_limit');
    // … re-sending one already waiting, past its cooldown, is allowed: it adds no invite.
    const resent = await inviteOnce(owner, 'old@example.test', 2);
    expect(resent.kind).toBe('upserted');
    // An accepted invite and an expired one stop counting.
    await client!`UPDATE team_invites SET accepted_at = now()
      WHERE owner_account_id = ${owner} AND invitee_email = 'taken@example.test'`;
    await client!`UPDATE team_invites SET invite_expires_at = now() - interval '1 minute'
      WHERE owner_account_id = ${owner} AND invitee_email = 'old@example.test'`;
    expect((await inviteOnce(owner, 'fourth@example.test', 2)).kind).toBe('upserted');
    expect((await inviteOnce(owner, 'fifth@example.test', 2)).kind).toBe('upserted');
    expect((await inviteOnce(owner, 'sixth@example.test', 2)).kind).toBe('pending_limit');
  });
});
