// The lookup that decides whether a fleet node may connect at all.
//
// v8 coverage: `getPublicKey`, `listActive`, `listActiveByRegion` and
// `touchLastSeen` execute zero statements. `register` and `revoke` beside them
// are exercised — so the fleet-node table is written by tested code and READ by
// untested code, which is the wrong half to leave uncovered:
// `FleetNodeAuthImpl.verify` calls `getPublicKey(claims.iss)` on every harness
// JWT, and its answer decides whether a box on the fleet is allowed to work.
//
// The property that would not survive a well-meaning edit is WHICH COLUMN it
// resolves. This repo keys fleet nodes two different ways and the parameter is
// called `nodeId` in both:
//
//   getPublicKey(nodeId)   resolves `node_id` — the human identifier
//                          ("mac-macstadium-us-001") that the harness puts in
//                          the JWT `iss`. Its own comment records the W2203b
//                          mismatch: matching the uuid `id` column instead makes
//                          a non-uuid `iss` ERROR rather than simply miss.
//   revoke({ nodeId })     resolves the uuid `id` — the internal primary key.
//
// So the same argument name means different columns two methods apart, and
// getting it wrong does not fail loudly at the call site. A test that revokes by
// uuid and then observes the effect through the human-id lookup is what ties the
// two halves together; that is the arm below.
//
// Revocation is asserted as LAYERING, not filtering. `getPublicKey` deliberately
// returns a revoked node WITH its `revokedAt` rather than hiding it, because
// `verify` distinguishes 'revoked_node' from 'unknown_node' and an operator
// debugging a box that will not connect needs those to be different answers.
// Making the query "safer" by excluding revoked rows would collapse both into
// unknown_node, which reads as a misconfiguration rather than a decision someone
// made.
//
// Against a real Postgres: `node_id` is text and `id` is uuid, so the column
// confusion this file pins produces a type error from the DATABASE, not from
// TypeScript — the two are indistinguishable to a double.

import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleFleetNodesRepo | null = null;
let dbReachable = false;
const seeded: string[] = [];

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
    await sql`SELECT node_id FROM fleet_nodes LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleFleetNodesRepo({ db: drizzle(sql) } as unknown as never);
});

afterAll(async () => {
  if (sql && seeded.length > 0) {
    await sql`DELETE FROM fleet_nodes WHERE id = ANY(${sql.array(seeded)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

/** Registered through the real path so both id columns are populated as production has them. */
async function registerNode(opts: { region?: string } = {}): Promise<{
  id: string;
  nodeId: string;
  publicKey: string;
}> {
  const nodeId = `mac-test-${randomUUID().slice(0, 8)}`;
  // fleet_nodes_public_key_format is CHECK (~ '^[A-Za-z0-9_-]{43}=$'), so the
  // column keeps the '=' that Node's base64url encoding strips. A 32-byte
  // Ed25519 key is exactly 43 chars plus that padding.
  const publicKey = `${randomBytes(32).toString('base64url')}=`;
  const detail = await repo!.register({
    publicKeyBase64Url: publicKey,
    displayName: `Test ${nodeId}`,
    region: opts.region ?? 'us',
    hardwareClass: 'm2-pro',
    nodeId,
  });
  seeded.push(detail.id);
  return { id: detail.id, nodeId, publicKey };
}

describe('fleet node auth lookup', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL a node resolves by the human node_id the JWT carries', async () => {
    if (!dbReachable || !repo) return;
    const node = await registerNode();
    const found = await repo.getPublicKey(node.nodeId);
    expect(
      found?.publicKeyBase64Url,
      'the harness JWT issuer did not resolve — every node on the fleet would fail to authenticate',
    ).toBe(node.publicKey);
    expect(found?.revokedAt, 'a live node came back already revoked').toBeNull();
  });

  it('CRITICAL the internal uuid is NOT accepted as the JWT issuer', async () => {
    if (!dbReachable || !repo) return;
    const node = await registerNode();
    // The uuid is a real identifier for this same node — just not the one the
    // JWT carries. Resolving it here would mean the lookup keys the wrong column.
    expect(
      await repo.getPublicKey(node.id),
      'the uuid primary key resolved through the issuer lookup, so the query is matching `id` ' +
        'rather than `node_id`. A real harness issuer is not a uuid, so that column would make ' +
        'every genuine login error instead of merely miss',
    ).toBeNull();
  });

  it('CRITICAL an unknown issuer resolves to nothing rather than erroring', async () => {
    if (!dbReachable || !repo) return;
    // Deliberately non-uuid, exactly like a real issuer: this is the shape that
    // errored against the uuid column in the W2203b mismatch.
    expect(await repo.getPublicKey('mac-does-not-exist-001')).toBeNull();
  });

  it('CRITICAL revoking by uuid is visible through the node_id lookup', async () => {
    if (!dbReachable || !repo) return;
    const node = await registerNode();
    // revoke() takes an argument named nodeId but matches the uuid `id` column.
    await repo.revoke({ nodeId: node.id, reason: 'compromised host' });
    const found = await repo.getPublicKey(node.nodeId);
    expect(
      found,
      'a revoked node stopped resolving entirely. verify() distinguishes revoked_node from ' +
        'unknown_node, and an operator debugging a box that will not connect needs those to be ' +
        'different answers',
    ).not.toBeNull();
    expect(
      found?.revokedAt,
      'the revocation did not reach the lookup the verifier uses, so a revoked box keeps ' +
        'authenticating',
    ).toBeInstanceOf(Date);
  });

  it('CRITICAL revoking one node leaves the rest of the fleet alone', async () => {
    if (!dbReachable || !repo) return;
    const doomed = await registerNode();
    const healthy = await registerNode();
    await repo.revoke({ nodeId: doomed.id, reason: 'decommissioned' });
    expect(
      (await repo.getPublicKey(healthy.nodeId))?.revokedAt,
      'revoking one node revoked another — the fleet would go dark',
    ).toBeNull();
  });

  it('CRITICAL the active listing excludes revoked nodes', async () => {
    if (!dbReachable || !repo) return;
    const live = await registerNode();
    const dead = await registerNode();
    await repo.revoke({ nodeId: dead.id, reason: 'decommissioned' });
    const ids = (await repo.listActive()).map((n) => n.id);
    expect(ids, 'a live node was missing from the active fleet listing').toContain(live.id);
    expect(
      ids,
      'a revoked node was still listed as active — it would keep being handed work',
    ).not.toContain(dead.id);
  });

  it('CRITICAL the per-region listing filters on both region and revocation', async () => {
    if (!dbReachable || !repo) return;
    const here = await registerNode({ region: 'eu' });
    const elsewhere = await registerNode({ region: 'apac' });
    const revokedHere = await registerNode({ region: 'eu' });
    await repo.revoke({ nodeId: revokedHere.id, reason: 'decommissioned' });
    const ids = (await repo.listActiveByRegion('eu')).map((n) => n.id);
    expect(ids).toContain(here.id);
    expect(ids, 'a node from another region was returned for this one').not.toContain(elsewhere.id);
    expect(ids, 'a revoked node was listed as active in its region').not.toContain(revokedHere.id);
  });

  it('CRITICAL a heartbeat records liveness against the right node', async () => {
    if (!dbReachable || !repo) return;
    const node = await registerNode();
    const other = await registerNode();
    await repo.touchLastSeen(node.id, new Date());
    const detail = (await repo.listActive()).find((n) => n.id === node.id);
    expect(detail?.lastSeenAt, 'the heartbeat was not recorded').toBeInstanceOf(Date);
    expect(
      (await repo.listActive()).find((n) => n.id === other.id)?.lastSeenAt,
      'one node’s heartbeat marked another node alive — a dead box would look healthy',
    ).toBeNull();
  });
});
