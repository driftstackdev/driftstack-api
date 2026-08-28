// Drizzle-backed integration test for DrizzleWebhookRotationReminderRepo.
//
// Last of the pinned-but-never-executed repos found by the import-vs-pin sweep
// (item 5e): a content-parity pin names its source path, nothing imports it, so
// none of this SQL had ever run.
//
// This decides how often a customer is emailed to rotate a webhook signing
// secret, and the selection is one `and` of three predicates:
//
//   isNull(disabledAt)               disabled endpoints are tombstones. Drop it
//                                    and we email about an endpoint the customer
//                                    already deleted.
//
//   lt(secretCreatedAt, threshold)   the age gate. Drop it and every endpoint is
//                                    reminded on the first sweep after creation.
//
//   or(isNull(lastReminderSentAt),   the dedupe, an OR whose halves fail in
//      lt(lastReminderSentAt,        OPPOSITE directions: lose the `lt` and any
//         cooldownCutoff))           endpoint ever reminded is never reminded
//                                    again; lose the `isNull` and one never
//                                    reminded is never eligible, so the notice
//                                    fires for nobody. Lose the clause entirely
//                                    and every sweep re-emails everyone overdue.
//
// ─── why this file does NOT need a private database ───────────────────────────
//
// The query is global — no account scope — and it DECRYPTS every row it returns.
// `db-webhooks-concurrency-drizzle` takes its own database for a related reason:
// a foreign row whose secret is not a v2 envelope makes the shared sweep throw.
// The same hazard applies here, since `readWebhookSecret` fails closed on
// anything that is not v2, and a single legacy row owned by another test file
// would blow up this repo before any assertion ran.
//
// Rather than a second database, this file isolates through the query's OWN age
// predicate. `now` is set to 2001 and the fixtures carry 1999-era
// `secret_created_at` values, so the threshold cutoff lands in 2000 — every row
// any other test seeds has `secret_created_at` defaulting to the real now() and
// is excluded by the same `lt` the production sweep uses. Foreign rows are never
// selected, so they are never decrypted, so their envelope format cannot matter.
// That keeps the isolation inside the behaviour under test instead of beside it.
//
// MUTATION-PROVED against webhook-rotation-reminder-repo.ts, running BOTH this
// file and the existing content-parity pin. Controls: 13/13 here, 8/8 on the pin.
//
//                                                        here      the pin
//   drops the tombstone filter                          1 red       1 red
//   drops the age gate                                 10 red       1 red
//   drops the whole dedupe clause                       2 red       1 red
//   dedupe keeps only isNull                            1 red       1 red
//   dedupe keeps only lt                                6 red       1 red
//   orders newest-secret-first                          1 red       1 red
//   markReminderSent loses its endpoint predicate       1 red       1 red
//   the previous secret comes back enveloped            1 red       1 red
//   the active secret comes back enveloped              2 red       1 red
//   a missing encryption key no longer refuses          1 red       1 red
//
// The age-gate row is the isolation argument above, confirmed rather than
// asserted: with that predicate gone the query stops excluding other files'
// endpoints, decrypts secrets it has no key for, and takes 10 of 13 arms down
// with it. The first arm is written to fail first and say so, precisely so a
// future reader sees the cause rather than nine confusing symptoms.
//
// Like the BYOK reminder pin and unlike validation-schedules', this pin is
// textually thorough — 10 of 10. Its arms still red identically (one each)
// whichever direction the dedupe breaks, so it reports that the text moved, not
// whether customers would now be spammed or silenced.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { DrizzleWebhookRotationReminderRepo } from '../../src/db/webhook-rotation-reminder-repo.js';
import { encryptWebhookSecret } from '../../src/lib/webhook-secret-encryption.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
let DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
// ⛔ Historical seed dates are NOT isolation once a second file adopts them. This
// file seeds 1998-01-01 through 2001-01-01 and calls a GLOBAL sweep over `webhook_endpoints`, and it
// shares literal dates with the other adopters in that table — so on a shared
// database each file's rows enter the others' result sets. It is green today only
// because its arms assert MEMBERSHIP (`toContain`) under `limit: 500`: a foreign
// row is invisible until it pushes a row this file cares about past the limit.
// Adding an ordering assertion, or lowering the limit, would convert that silence
// into the failure `db-webhooks-force-rotation-selection` actually hit. A dedicated
// database removes the shared state instead of negotiating with it — one distinct
// name per file, per the helper's own caveat.
const ISOLATED_DB_NAME = 'driftstack_iso_webhook_rotation_reminder';

const WEBHOOK_KEY = Buffer.alloc(32, 23).toString('base64');

/** Deliberately historical — see the isolation note in the header. */
const NOW = new Date('2001-01-01T00:00:00.000Z');
const THRESHOLD_DAYS = 90; // cutoff 2000-10-03
const COOLDOWN_DAYS = 30; // cutoff 2000-12-02

const OLD_SECRET = new Date('1999-01-01T00:00:00.000Z'); // well past the threshold
const OLDER_SECRET = new Date('1998-01-01T00:00:00.000Z');
const FRESH_SECRET = new Date('2000-12-15T00:00:00.000Z'); // inside the threshold
const REMINDED_RECENTLY = new Date('2000-12-20T00:00:00.000Z'); // inside the cooldown
const REMINDED_LONG_AGO = new Date('2000-06-01T00:00:00.000Z'); // outside the cooldown

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleWebhookRotationReminderRepo | null = null;
let accountId: string | null = null;
const seededEndpoints: string[] = [];
const seededAccounts: string[] = [];

async function seedAccount(): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  await client`
    INSERT INTO accounts (id, email, name, tier, status, created_at, updated_at)
    VALUES (${id}, ${`whrot-${id.slice(0, 8)}@example.test`}, ${'Webhook Rotation Fixture'},
            'free'::account_tier, 'active'::account_status, now(), now())`;
  seededAccounts.push(id);
  return id;
}

async function seedEndpoint(opts: {
  secretCreatedAt: Date;
  lastReminderSentAt?: Date | null;
  disabledAt?: Date | null;
  withPrev?: boolean;
}): Promise<string> {
  if (!client || accountId === null) throw new Error('no client');
  const endpointId = randomUUID();
  const secret = encryptWebhookSecret(`whsec_${'a'.repeat(32)}`, WEBHOOK_KEY, {
    accountId,
    endpointId,
  });
  const prev =
    opts.withPrev === true
      ? encryptWebhookSecret(`whsec_${'b'.repeat(32)}`, WEBHOOK_KEY, { accountId, endpointId })
      : null;
  await client`
    INSERT INTO webhook_endpoints
      (id, account_id, url, secret, secret_prefix, secret_prev, secret_created_at,
       last_reminder_sent_at, disabled_at, events, created_at, updated_at)
    VALUES
      (${endpointId}, ${accountId}, ${'https://hooks.example/rotation'}, ${secret},
       ${'whsec_aaaaaa'}, ${prev},
       ${opts.secretCreatedAt.toISOString()}::timestamptz,
       ${opts.lastReminderSentAt?.toISOString() ?? null}::timestamptz,
       ${opts.disabledAt?.toISOString() ?? null}::timestamptz,
       ARRAY['session.completed']::webhook_event_type[], now(), now())`;
  seededEndpoints.push(endpointId);
  return endpointId;
}

async function dueIds(limit = 500): Promise<string[]> {
  if (!repo) throw new Error('no repo');
  const rows = await repo.findEndpointsNeedingRotationReminder({
    now: NOW,
    thresholdDays: THRESHOLD_DAYS,
    cooldownDays: COOLDOWN_DAYS,
    limit,
  });
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  DB_URL = isolated;
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM webhook_endpoints LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleWebhookRotationReminderRepo(
    { client, db: drizzle(client, { schema }), close: async () => {} },
    { secretEncryptionKeyBase64: WEBHOOK_KEY },
  );
  accountId = await seedAccount();
});

afterAll(async () => {
  if (client) {
    for (const id of seededEndpoints) {
      await client`DELETE FROM webhook_endpoints WHERE id = ${id}`.catch(() => {});
    }
    for (const id of seededAccounts) {
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleWebhookRotationReminderRepo (Drizzle path against real Postgres)',
  () => {
    it('CRITICAL the database is reachable and migrated. In CI the service and migrate step are part of the job, so an unreachable database must FAIL rather than let every arm below pass vacuously.', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and the table present').toBe(true);
      expect(repo, 'repo constructed').not.toBeNull();
      expect(accountId, 'fixture account seeded').not.toBeNull();
    });

    it("CRITICAL the historical `now` isolates this file from every other test's endpoints. The query is global and decrypts what it selects, so a foreign row with a legacy secret would throw before any assertion ran. Rows seeded elsewhere default `secret_created_at` to the real now() and fall outside a threshold cutoff in the year 2000 — if that ever stops holding, this arm fails first and explains why the others did.", async () => {
      if (!dbReachable || !repo) return;
      const own = await seedEndpoint({ secretCreatedAt: OLD_SECRET });
      const ids = await dueIds();
      expect(ids, 'the fixture endpoint is selected').toContain(own);
      expect(
        ids.every((id) => seededEndpoints.includes(id)),
        'and nothing this file did not seed was selected',
      ).toBe(true);
    });

    it('CRITICAL an overdue secret never reminded about IS selected. Every exclusion arm below would also pass against a query returning nothing, so this is what keeps them honest.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedEndpoint({ secretCreatedAt: OLD_SECRET, lastReminderSentAt: null });
      expect(await dueIds(), 'overdue and never reminded').toContain(id);
    });

    it('CRITICAL a disabled endpoint is never selected, however old its secret. Disabled rows are tombstones the customer has already removed; reminding on one asks them to rotate a secret for a webhook they deleted, which reads as the deletion having failed.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedEndpoint({
        secretCreatedAt: OLDER_SECRET,
        disabledAt: new Date('2000-05-01T00:00:00.000Z'),
      });
      expect(await dueIds(), 'a tombstone is not reminded about').not.toContain(id);
    });

    it('CRITICAL a secret younger than the threshold is not selected. Without the age gate every endpoint is reminded on the first sweep after it is created, so a secret generated that morning is reported as overdue for rotation.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedEndpoint({ secretCreatedAt: FRESH_SECRET });
      expect(await dueIds(), 'a two-week-old secret is not due').not.toContain(id);
    });

    it('CRITICAL an overdue secret reminded INSIDE the cooldown is suppressed. This is the anti-spam half of the dedupe: without it every sweep re-emails every overdue customer, turning a quarterly rotation notice into a daily one that arrives fastest to whoever is furthest behind.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedEndpoint({
        secretCreatedAt: OLD_SECRET,
        lastReminderSentAt: REMINDED_RECENTLY,
      });
      expect(await dueIds(), 'reminded inside the cooldown window').not.toContain(id);
    });

    it('CRITICAL an overdue secret reminded BEFORE the cooldown is selected again. The opposite half of the same OR, failing in the opposite direction: lose it and any endpoint ever reminded is never reminded again, so the notice fires once in the lifetime of the endpoint and the secret is never actually rotated.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedEndpoint({
        secretCreatedAt: OLD_SECRET,
        lastReminderSentAt: REMINDED_LONG_AGO,
      });
      expect(await dueIds(), 'the cooldown has elapsed').toContain(id);
    });

    it('CRITICAL the due set is ordered oldest-secret-first. The sweep takes only `limit` rows, so ordering decides who is dropped when more endpoints are overdue than one run can email. Reversed, the oldest secret in the fleet is last every sweep while newer ones are reminded ahead of it — the secret most in need of rotation is the one never mentioned.', async () => {
      if (!dbReachable || !repo) return;
      // Seeded newest-first so insertion order disagrees with the expected order.
      const newer = await seedEndpoint({ secretCreatedAt: OLD_SECRET });
      const older = await seedEndpoint({ secretCreatedAt: OLDER_SECRET });

      const ids = await dueIds();
      const iOlder = ids.indexOf(older);
      const iNewer = ids.indexOf(newer);
      expect(iOlder, 'the oldest secret is in the due set').toBeGreaterThanOrEqual(0);
      expect(iNewer, 'and so is the newer one').toBeGreaterThanOrEqual(0);
      expect(iOlder, 'the older secret is offered first').toBeLessThan(iNewer);
    });

    it('CRITICAL the limit is honoured. The sweep sizes this to what one run can email, and a limit that leaked would send the whole overdue backlog in a single tick.', async () => {
      if (!dbReachable || !repo) return;
      await seedEndpoint({ secretCreatedAt: OLD_SECRET });
      await seedEndpoint({ secretCreatedAt: OLDER_SECRET });
      expect((await dueIds(1)).length, 'at most one endpoint per run').toBeLessThanOrEqual(1);
    });

    it('CRITICAL the selected row carries a DECRYPTED secret and the account address. The reminder is addressed from the join and names the secret prefix, so a row that came back still enveloped would put ciphertext in a customer email, and a null address is a message that cannot be sent at all.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedEndpoint({ secretCreatedAt: OLD_SECRET });
      const rows = await repo.findEndpointsNeedingRotationReminder({
        now: NOW,
        thresholdDays: THRESHOLD_DAYS,
        cooldownDays: COOLDOWN_DAYS,
        limit: 500,
      });
      const mine = rows.find((r) => r.id === id);
      expect(mine, 'the seeded endpoint came back').toBeDefined();
      expect(mine?.secret, 'the secret is decrypted, not an envelope').toBe(
        `whsec_${'a'.repeat(32)}`,
      );
      expect(mine?.secret.startsWith('driftstack:webhook-secret:'), 'not still wrapped').toBe(
        false,
      );
      expect(mine?.accountEmail, 'the join supplied an address').toMatch(/@example\.test$/);
      expect(mine?.events, 'events survive sanitisation').toContain('session.completed');
    });

    it('CRITICAL an endpoint mid-rotation returns BOTH secrets decrypted. During the grace window the previous secret is still accepted, and it is stored enveloped exactly like the current one — a reminder path that decrypted only the active secret would hand back an envelope for the other and fail wherever it was used.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedEndpoint({ secretCreatedAt: OLD_SECRET, withPrev: true });
      const rows = await repo.findEndpointsNeedingRotationReminder({
        now: NOW,
        thresholdDays: THRESHOLD_DAYS,
        cooldownDays: COOLDOWN_DAYS,
        limit: 500,
      });
      const mine = rows.find((r) => r.id === id);
      expect(mine?.secret, 'active secret decrypted').toBe(`whsec_${'a'.repeat(32)}`);
      expect(mine?.secretPrev, 'previous secret decrypted too').toBe(`whsec_${'b'.repeat(32)}`);
    });

    it('CRITICAL a repo built without an encryption key REFUSES rather than returning ciphertext. A deployment missing the key must fail loudly here; the alternative is a sweep that keeps running and mails customers an envelope where their signing secret should be.', async () => {
      if (!dbReachable || !client) return;
      await seedEndpoint({ secretCreatedAt: OLD_SECRET });
      const keyless = new DrizzleWebhookRotationReminderRepo({
        client,
        db: drizzle(client, { schema }),
        close: async () => {},
      });
      await expect(
        keyless.findEndpointsNeedingRotationReminder({
          now: NOW,
          thresholdDays: THRESHOLD_DAYS,
          cooldownDays: COOLDOWN_DAYS,
          limit: 500,
        }),
      ).rejects.toThrow(/encryption key is unavailable/i);
    });

    it('CRITICAL markReminderSent removes the endpoint from the due set and is scoped to it. The write closes the loop, and the single `eq` on the id is all that stops one send from stamping every endpoint — which would silence the entire overdue backlog for a full cooldown after a single email.', async () => {
      if (!dbReachable || !repo) return;
      const sent = await seedEndpoint({ secretCreatedAt: OLD_SECRET });
      const untouched = await seedEndpoint({ secretCreatedAt: OLDER_SECRET });
      expect(await dueIds(), 'both due before the send').toContain(sent);

      await repo.markReminderSent({ endpointId: sent, now: NOW });

      const ids = await dueIds();
      expect(ids, 'the one we emailed is suppressed').not.toContain(sent);
      expect(ids, "but the neighbour's reminder is still owed").toContain(untouched);
    });
  },
);
