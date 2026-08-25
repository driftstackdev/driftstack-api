// V-1611 #14 — the teams backfill, proved against real Postgres in an isolated
// schema rather than reasoned about.
//
// Two properties, both of which were WRONG in the first draft of 0114 and were
// only found by running it:
//
//   1. IDEMPOTENCE. The backfill had no NOT EXISTS guard. Running it twice
//      against a seeded database turned 3 teams into 6, because there is
//      deliberately no unique constraint on `owner_account_id` — "one owner can
//      never have two teams" is the defect being fixed, so constraining it
//      would preserve the bug in the schema. Drizzle records applied migrations
//      and would not normally re-run one, but a migration that fails midway is
//      re-applied from the top.
//
//   2. THE NAMING LADDER. `COALESCE(account name, email local part, short id)`.
//      The third rung is the one that matters — it is the only thing standing
//      between the customer and the "Team 3f9a2c1d" string this whole item
//      exists to remove — and it is reachable only when BOTH earlier rungs
//      degrade to empty rather than NULL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations/0114_teams_entity.sql',
);

const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const DB_URL = process.env.DATABASE_URL ?? '';
const TEST_SCHEMA = `teams_backfill_${randomUUID().replaceAll('-', '')}`;
let client: ReturnType<typeof postgres> | null = null;

/** The backfill exactly as 0114 runs it. Kept verbatim so this test fails if
 *  the migration's logic and this copy diverge — a paraphrase would prove only
 *  that the paraphrase works. */
const BACKFILL = `
INSERT INTO teams (owner_account_id, name)
SELECT a.id,
       COALESCE(
         NULLIF(BTRIM(a.name), ''),
         NULLIF(SPLIT_PART(a.email, '@', 1), ''),
         'Team ' || LEFT(a.id::text, 8)
       )
FROM accounts a
WHERE ( EXISTS (SELECT 1 FROM team_members tm WHERE tm.owner_account_id = a.id)
     OR EXISTS (SELECT 1 FROM team_invites ti WHERE ti.owner_account_id = a.id) )
  AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.owner_account_id = a.id)`;

const NAMED = '11111111-1111-1111-1111-111111111111';
const NO_NAME = '22222222-2222-2222-2222-222222222222';
const NEITHER = '33333333-3333-3333-3333-333333333333';
const NO_TEAM = '44444444-4444-4444-4444-444444444444';

/** ⛔ This arm exists because every other arm below runs a COPY of the
 *  migration's SQL, and a guard that pins a copy proves only that the copy
 *  works. It compares the copy against the real file, normalising whitespace
 *  only, so the moment 0114's backfill and this constant diverge the whole file
 *  fails rather than quietly testing something that no longer ships. */
describe('the backfill under test is the one that ships', () => {
  it('CRITICAL the SQL exercised below matches 0114 on disk. Without this the other arms pin a copy, and a copy stays green while the migration it stands for changes underneath it.', () => {
    const squash = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase();
    const file = squash(readFileSync(MIGRATION, 'utf8').replace(/^\s*--.*$/gm, ''));
    const copy = squash(BACKFILL);
    // The copy is unquoted and the migration quotes its identifiers; compare on
    // the shape that survives both.
    expect(file.replace(/"/g, ''), 'the backfill SELECT must still be the one 0114 runs').toContain(
      copy.replace(/"/g, '').replace(/^insert into teams /, 'insert into teams '),
    );
  });
});

describe.skipIf(!RUN_DB_TESTS)('teams backfill (0114)', () => {
  beforeAll(async () => {
    client = postgres(DB_URL, { max: 1, onnotice: () => {} });
    await client.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await client.unsafe(`SET search_path TO "${TEST_SCHEMA}"`);
    // A minimal stand-in for the three tables the backfill reads and writes.
    // No FKs to accounts: this proves the SELECT's shape, not referential
    // integrity, which the real migration inherits from the live schema.
    await client.unsafe(`
      CREATE TABLE accounts (id uuid PRIMARY KEY, email text NOT NULL, name text);
      CREATE TABLE teams (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text,
        owner_account_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX teams_slug_unique ON teams (slug);
      CREATE TABLE team_members (owner_account_id uuid NOT NULL, member_account_id uuid NOT NULL);
      CREATE TABLE team_invites (owner_account_id uuid NOT NULL, invitee_email text NOT NULL);
    `);
  }, 30_000);

  afterAll(async () => {
    await client?.unsafe('SET search_path TO public').catch(() => {});
    await client?.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await client?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    const c = client;
    if (c === null) return;
    await c.unsafe(`SET search_path TO "${TEST_SCHEMA}"`);
    await c.unsafe('TRUNCATE teams, team_members, team_invites, accounts');
    await c.unsafe(`
      INSERT INTO accounts (id, email, name) VALUES
        ('${NAMED}',   'alice@example.com', 'Alice Co'),
        ('${NO_NAME}', 'bob@example.com',   NULL),
        ('${NEITHER}', '@nolocalpart',      '   '),
        ('${NO_TEAM}', 'nobody@example.com','Nobody');
      INSERT INTO team_members (owner_account_id, member_account_id) VALUES
        ('${NAMED}', '${NO_NAME}');
      INSERT INTO team_invites (owner_account_id, invitee_email) VALUES
        ('${NEITHER}', 'invitee@example.com');
      INSERT INTO team_members (owner_account_id, member_account_id) VALUES
        ('${NO_NAME}', '${NAMED}');
    `);
  });

  it('CRITICAL is IDEMPOTENT. Without the NOT EXISTS guard a re-applied migration mints a SECOND team per owner — 3 became 6 — and there is deliberately no unique constraint to stop it, because multiple teams per owner is the goal.', async () => {
    const c = client;
    if (c === null) throw new Error('no client');
    await c.unsafe(BACKFILL);
    const first = await c.unsafe('SELECT count(*)::int AS n FROM teams');
    expect(first[0]?.n).toBe(3);
    await c.unsafe(BACKFILL);
    await c.unsafe(BACKFILL);
    const after = await c.unsafe('SELECT count(*)::int AS n FROM teams');
    expect(after[0]?.n, 're-running the backfill must add nothing').toBe(3);
  });

  it('CRITICAL names each team by the ladder: account name, else the email local part, else a short id. The third rung is the only thing standing between the customer and the "Team 3f9a2c1d" label this item exists to remove.', async () => {
    const c = client;
    if (c === null) throw new Error('no client');
    await c.unsafe(BACKFILL);
    const rows = (await c.unsafe(
      'SELECT owner_account_id::text AS owner, name FROM teams ORDER BY owner_account_id',
    )) as unknown as ReadonlyArray<{ owner: string; name: string }>;
    expect(rows.map((r) => [r.owner, r.name])).toEqual([
      [NAMED, 'Alice Co'],
      [NO_NAME, 'bob'],
      // BOTH earlier rungs degrade to empty rather than NULL here: a whitespace
      // name (BTRIM -> '') and an email with no local part (SPLIT_PART -> '').
      // NULLIF is what converts those to NULL so COALESCE keeps falling.
      [NEITHER, 'Team 33333333'],
    ]);
  });

  it('CRITICAL mints NOTHING for an account that owns no members and no invites. Creating an empty team for every team-capable account would invent state the customer never made.', async () => {
    const c = client;
    if (c === null) throw new Error('no client');
    await c.unsafe(BACKFILL);
    const rows = await c.unsafe(
      `SELECT count(*)::int AS n FROM teams WHERE owner_account_id = '${NO_TEAM}'`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('CRITICAL slug stays NULL, and NULLs do not collide under the unique index. Minting required slugs would silently settle an open product decision about public URLs.', async () => {
    const c = client;
    if (c === null) throw new Error('no client');
    await c.unsafe(BACKFILL);
    const rows = await c.unsafe('SELECT count(*)::int AS n FROM teams WHERE slug IS NULL');
    // Three NULL slugs coexisting proves the nullable-unique-when-set pattern
    // holds — Postgres treats NULLs as distinct in a unique index.
    expect(rows[0]?.n).toBe(3);
  });
});
