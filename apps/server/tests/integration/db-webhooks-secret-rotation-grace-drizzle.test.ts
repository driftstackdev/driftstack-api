// The window in which an old webhook secret is still allowed to verify.
//
// v8 coverage: `webhooks-repo.ts` is the largest remaining gap in the server at
// 21 functions with zero executed statements. `rotateSecret` is exercised;
// `forceRotateSecret` and `clearStaleSecretPrev` — the two halves of the
// forced-rotation lifecycle — are not, and between them they decide how long a
// retired secret keeps working.
//
//   forceRotateSecret     installs a new secret and moves the OLD ciphertext
//                         into secret_prev with a deadline, so customers whose
//                         senders still sign with the old secret keep verifying
//                         during the grace window instead of breaking the
//                         instant an operator rotates.
//   clearStaleSecretPrev  a sweep that nulls secret_prev once that deadline has
//                         passed. Its `secret_prev_expires_at < now` is the only
//                         thing that ends the window: without it a retired
//                         secret — including one retired BECAUSE it leaked —
//                         keeps verifying inbound signatures indefinitely, and
//                         the rotation an operator performed to contain a
//                         disclosure quietly never completes.
//
// The comparison is load-bearing in both directions, so both are asserted. Clear
// too eagerly and every sender mid-rotation starts failing verification during
// the window that exists precisely to stop that.
//
// Two guards on the rotation itself get arms because their failure is silent:
//
//   disabled endpoints    the UPDATE is conditioned on isNull(disabledAt), so a
//                         disabled endpoint cannot be rotated back into service.
//   notified reset        graceExpiringNotifiedAt is reset to null, and the
//                         method's own comment says why: a stale non-null value
//                         from a PRIOR cycle would permanently block the
//                         "grace expiring" notice for every future cycle on
//                         that endpoint — so nobody is warned before their old
//                         secret stops working.
//
// Against a real Postgres. `secretPrev: sql`${webhookEndpoints.secret}`` is a
// self-referential column copy performed inside the same UPDATE that overwrites
// that column — the old value survives into secret_prev only because the
// database evaluates the SET list against the pre-update row. No in-memory
// double reproduces that ordering; it would test my reading of the statement.

import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
import { encryptWebhookSecret } from '../../src/lib/webhook-secret-encryption.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const SECRET_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const HOUR = 60 * 60 * 1000;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleWebhooksRepo | null = null;
let dbReachable = false;
const seededAccounts: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  sql = postgres(DB_URL, { max: 2 });
  try {
    await sql`SELECT secret_prev_expires_at FROM webhook_endpoints LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleWebhooksRepo({ db: drizzle(sql) } as unknown as never, {
    secretEncryptionKeyBase64: SECRET_KEY_B64,
  });
});

afterAll(async () => {
  if (sql && seededAccounts.length > 0) {
    await sql`DELETE FROM accounts WHERE id = ANY(${sql.array(seededAccounts)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

/** whsec_ plaintext must be 32 lowercase base32 chars — hex uuids are rejected. */
function base32(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join('');
}

async function seedEndpoint(): Promise<{ accountId: string; id: string }> {
  const accountId = randomUUID();
  const id = randomUUID();
  await sql!`
    INSERT INTO accounts (id, email, status)
    VALUES (${accountId}, ${`whrot-${accountId}@test.local`}, 'active')`;
  seededAccounts.push(accountId);
  const secret = encryptWebhookSecret(`whsec_${base32(32)}`, SECRET_KEY_B64, {
    accountId,
    endpointId: id,
  });
  await sql!`
    INSERT INTO webhook_endpoints (id, account_id, url, secret, secret_prefix, events, active)
    VALUES (${id}, ${accountId}, ${`https://hooks.test.local/${id}`}, ${secret}, 'whsec_old',
            ARRAY['session.completed']::webhook_event_type[], true)`;
  return { accountId, id };
}

interface SecretCols {
  secret: string;
  secret_prev: string | null;
  secret_prev_expires_at: Date | null;
  grace_expiring_notified_at: Date | null;
  secret_prefix: string;
}

async function readSecrets(id: string): Promise<SecretCols> {
  const [row] = await sql!<SecretCols[]>`
    SELECT secret, secret_prev, secret_prev_expires_at, grace_expiring_notified_at, secret_prefix
      FROM webhook_endpoints WHERE id = ${id}`;
  return row!;
}

const forceRotate = (id: string, graceEndsInMs: number) =>
  repo!.forceRotateSecret({
    id,
    newSecret: `whsec_${base32(32)}`,
    newPrefix: 'whsec_new',
    graceWindowEndsAt: new Date(Date.now() + graceEndsInMs),
    now: new Date(),
  });

describe('webhook secret force-rotation and grace window', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL rotating installs a new secret and keeps the old one as prev', async () => {
    if (!dbReachable || !repo) return;
    const { id } = await seedEndpoint();
    const before = await readSecrets(id);
    expect(await forceRotate(id, 7 * 24 * HOUR)).not.toBeNull();
    const after = await readSecrets(id);
    expect(after.secret, 'the rotation left the same secret in place').not.toBe(before.secret);
    expect(
      after.secret_prev,
      'the outgoing secret was not carried into secret_prev — every sender still signing with it ' +
        'starts failing verification the moment an operator rotates, which is what the grace ' +
        'window exists to prevent',
    ).toBe(before.secret);
    expect(after.secret_prev_expires_at, 'the grace window has no deadline').not.toBeNull();
    expect(after.secret_prefix).toBe('whsec_new');
  });

  it('CRITICAL rotating re-arms the grace-expiring notice', async () => {
    if (!dbReachable || !repo) return;
    const { id } = await seedEndpoint();
    // A stale value left over from a previous force-rotation cycle.
    await sql!`UPDATE webhook_endpoints SET grace_expiring_notified_at = now() WHERE id = ${id}`;
    await forceRotate(id, 7 * 24 * HOUR);
    expect(
      (await readSecrets(id)).grace_expiring_notified_at,
      'a stale notified-at from a prior cycle survived the rotation — it would permanently block ' +
        'the grace-expiring notice for every future cycle, so nobody is warned before their old ' +
        'secret stops working',
    ).toBeNull();
  });

  it('CRITICAL a disabled endpoint cannot be rotated back into service', async () => {
    if (!dbReachable || !repo) return;
    const { id } = await seedEndpoint();
    await repo.disableEndpoint(id, new Date());
    const before = await readSecrets(id);
    expect(
      await forceRotate(id, 7 * 24 * HOUR),
      'a disabled endpoint reported a successful rotation',
    ).toBeNull();
    expect(
      (await readSecrets(id)).secret,
      'a disabled endpoint had a fresh secret installed on it',
    ).toBe(before.secret);
  });

  it('CRITICAL rotating an endpoint that does not exist reports null', async () => {
    if (!dbReachable || !repo) return;
    expect(await forceRotate(randomUUID(), HOUR)).toBeNull();
  });

  it('CRITICAL the sweep retires a prev secret whose window has closed', async () => {
    if (!dbReachable || !repo) return;
    const { id } = await seedEndpoint();
    await forceRotate(id, -HOUR); // window already closed
    expect((await readSecrets(id)).secret_prev, 'precondition: prev was populated').not.toBeNull();
    expect((await repo.clearStaleSecretPrev({ now: new Date() })).cleared).toBeGreaterThanOrEqual(
      1,
    );
    const after = await readSecrets(id);
    expect(
      after.secret_prev,
      'a retired secret past its grace deadline still verifies — a rotation performed to contain a ' +
        'leaked secret never actually completes',
    ).toBeNull();
    expect(after.secret_prev_expires_at, 'the stale deadline was left behind').toBeNull();
  });

  it('CRITICAL the sweep leaves a prev secret inside its window alone', async () => {
    if (!dbReachable || !repo) return;
    const { id } = await seedEndpoint();
    await forceRotate(id, 7 * 24 * HOUR);
    await repo.clearStaleSecretPrev({ now: new Date() });
    expect(
      (await readSecrets(id)).secret_prev,
      'the sweep retired a secret still inside its grace window — every sender mid-rotation starts ' +
        'failing verification during the window that exists to stop exactly that',
    ).not.toBeNull();
  });

  it('CRITICAL the sweep never touches an endpoint that has not rotated', async () => {
    if (!dbReachable || !repo) return;
    const { id } = await seedEndpoint();
    const before = await readSecrets(id);
    await repo.clearStaleSecretPrev({ now: new Date() });
    const after = await readSecrets(id);
    expect(after.secret, 'the sweep altered an endpoint that never rotated').toBe(before.secret);
    expect(after.secret_prev).toBeNull();
  });

  it('CRITICAL disabling an endpoint stops it being selected for delivery', async () => {
    if (!dbReachable || !repo) return;
    const { accountId, id } = await seedEndpoint();
    const selected = async (): Promise<string[]> =>
      (await repo!.listEndpointsSubscribedTo(accountId, 'session.completed')).map((e) => e.id);
    expect(await selected(), 'precondition: a live endpoint is selected').toContain(id);
    await repo.disableEndpoint(id, new Date());
    expect(
      await selected(),
      'a disabled endpoint was still selected for fan-out — disabling would be decorative and ' +
        'deliveries keep being enqueued against it',
    ).not.toContain(id);
  });
});
