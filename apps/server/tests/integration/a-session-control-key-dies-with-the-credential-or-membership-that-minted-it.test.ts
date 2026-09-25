// A session's GUI control key dies with the credential or the team membership
// that minted it (security sweep #2).
//
// The per-session control key (`x-driftstack-gui-control-key`) skips every scope
// and ownership check on the session's control and read routes: the live cookie
// jar, page state, downloads, mode, input, takeover, the agent message (the
// owner's AI budget) and DELETE. It was bound only to the session and a 24-hour
// expiry, so:
//
//   · a team admin the owner removed kept reading and driving the owner's session
//     with the key the desktop app had minted for them;
//   · a key minted by an API key the owner then revoked kept working;
//   · a desktop device key revoked from the dashboard, or by a password reset,
//     left every control key it had minted working — the revocation-surviving
//     credential the device-key deny gate exists to stop;
//   · and the owner could not rotate it: the mint route handed every caller the
//     same key back.
//
// Now the key records who minted it, every use re-checks that principal against
// the live rows, the revocations clear the keys their credential minted, a
// different principal's mint replaces the key, and the same principal's mint
// still returns the one key its windows share (the desktop app re-mints on every
// launch and reopen, and on Windows and Linux a second launch only focuses the
// window that already holds the key).
//
// Runs through the whole app on a freshly migrated database of its own, with the
// real repositories, the real team-removal, key-revocation and password-reset
// routes, and the three routes that accept a control key (the session routes,
// the LiveKit token re-mint and the transport report).

import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';
import { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import { DrizzleTeamMembersRepo } from '../../src/db/team-members-repo.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { AgentRuntime } from '../../src/services/agent-runtime.js';
import { DeterministicAgentDecomposer } from '../../src/services/agent-decomposer-deterministic.js';
import { StubAgentExecutor } from '../../src/services/agent-executor.js';
import { createEmailService } from '../../src/services/email.js';
import { buildLegalCatalog } from '../../src/services/legal-catalog.js';
import { TeamMembersService } from '../../src/services/team-members.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  adminCreditsHarness,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import {
  buildRealApp,
  seedAccount,
  seedApiKey,
  seedWebSession,
  type RealApp,
  type SeededKey,
  type SeededWebSession,
} from './_helpers/real-app-with-signed-in-identities.js';

const ISOLATED_DB_NAME = 'driftstack_iso_control_key_minter';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GCK = 'x-driftstack-gui-control-key';

/** The desktop app's credential, as the device-code sign-in mints it. */
const DEVICE_SCOPES = ['read', 'write', 'account_owner'] as const;

let client: postgres.Sql | null = null;
let database: Database | null = null;
let harness: AdminCreditsHarness | null = null;
let app: RealApp | null = null;
let sessionsRepo: DrizzleAgentSessionsRepo | null = null;

interface Owner {
  readonly accountId: string;
  readonly email: string;
  /** The dashboard: a signed-in browser. */
  readonly browser: SeededWebSession;
  /** The owner's own account_owner integration key (revokes keys, removes members). */
  readonly admin: SeededKey;
  /** The owner's desktop app. */
  readonly desktop: SeededKey;
  /** A second desktop install, revoked from the dashboard below. */
  readonly laptop: SeededKey;
  /** A read+write integration key, revoked below. */
  readonly ci: SeededKey;
}

interface Member {
  readonly accountId: string;
  readonly desktop: SeededKey;
  readonly membershipId: string;
}

let owner: Owner | null = null;
let admin: Member | null = null;
let secondAdmin: Member | null = null;
/** An account whose password is reset below. */
let resetter: { accountId: string; email: string; desktop: SeededKey } | null = null;

function sql(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function theApp(): RealApp {
  if (app === null) throw new Error('the app was not built');
  return app;
}
function repo(): DrizzleAgentSessionsRepo {
  if (sessionsRepo === null) throw new Error('the sessions repo was not built');
  return sessionsRepo;
}
function o(): Owner {
  if (owner === null) throw new Error('owner not seeded');
  return owner;
}
function m(): Member {
  if (admin === null) throw new Error('team admin not seeded');
  return admin;
}

async function seedAdmin(
  catalog: ReturnType<typeof buildLegalCatalog>,
  ownerAccountId: string,
): Promise<Member> {
  const accountId = await seedAccount(sql(), `admin-${randomUUID()}@example.test`, catalog);
  const desktop = await seedApiKey(sql(), accountId, {
    scopes: [...DEVICE_SCOPES],
    name: 'Desktop client',
    provenance: 'cli_device',
  });
  const [row] = await sql()<Array<{ id: string }>>`
    INSERT INTO team_members (owner_account_id, member_account_id, role, invited_at, accepted_at)
    VALUES (${ownerAccountId}::uuid, ${accountId}::uuid, 'admin'::team_role, now(), now())
    RETURNING id::text`;
  if (row === undefined) throw new Error('the membership was not seeded');
  return { accountId, desktop, membershipId: row.id };
}

/** A live agent session on the account, as the create route leaves one. */
async function newSession(accountId: string): Promise<string> {
  const rec = await repo().create({ accountId, tokenBudgetTotal: 10_000, mode: 'ai' });
  return rec.id;
}

interface Minted {
  readonly status: number;
  readonly key: string;
  readonly minted: boolean | undefined;
}

/** What the desktop app sends: its keychain credential, no acting-as header. */
async function mint(bearer: string, sessionId: string, query = ''): Promise<Minted> {
  const res = await theApp().inject({
    method: 'GET',
    url: `/v1/agent-sessions/${sessionId}/gui-control-key${query}`,
    headers: { authorization: `Bearer ${bearer}` },
  });
  const body =
    res.statusCode === 200 ? res.json<{ gui_control_key: string; minted: boolean }>() : null;
  return { status: res.statusCode, key: body?.gui_control_key ?? '', minted: body?.minted };
}

/** A read through the control key (the Simulator's session poll). */
async function readWith(key: string, sessionId: string): Promise<number> {
  const res = await theApp().inject({
    method: 'GET',
    url: `/v1/agent-sessions/${sessionId}`,
    headers: { [GCK]: key },
  });
  return res.statusCode;
}

/** A write through the control key (the Simulator's mode toggle). */
async function writeWith(key: string, sessionId: string, mode: 'manual' | 'ai'): Promise<number> {
  const res = await theApp().inject({
    method: 'POST',
    url: `/v1/agent-sessions/${sessionId}/mode`,
    headers: { [GCK]: key },
    payload: { mode },
  });
  return res.statusCode;
}

/** The LiveKit re-mint and the transport report: the two other control-key gates. */
async function otherGatesWith(key: string, sessionId: string): Promise<[number, number]> {
  const livekit = await theApp().inject({
    method: 'POST',
    url: `/v1/agent-sessions/${sessionId}/livekit-token`,
    headers: { [GCK]: key },
  });
  const report = await theApp().inject({
    method: 'POST',
    url: `/v1/agent-sessions/${sessionId}/transport-report`,
    headers: { [GCK]: key },
    payload: { transport: 'udp', relayed: false, rtt_ms: 20, packet_loss_recent_pct: 0 },
  });
  return [livekit.statusCode, report.statusCode];
}

interface StoredKey {
  ciphertext: Buffer | null;
  expires_at: Date | null;
  minted_by_account_id: string | null;
  minted_by_api_key_id: string | null;
  minted_by_web_session_id: string | null;
  minted_by_membership_id: string | null;
}

/** The stored key and its minter, as the database holds them. */
async function stored(sessionId: string): Promise<StoredKey> {
  const [row] = await sql()<StoredKey[]>`
    SELECT gui_control_key_ciphertext AS ciphertext,
           gui_control_key_expires_at AS expires_at,
           gui_control_key_minted_by_account_id::text AS minted_by_account_id,
           gui_control_key_minted_by_api_key_id::text AS minted_by_api_key_id,
           gui_control_key_minted_by_web_session_id::text AS minted_by_web_session_id,
           gui_control_key_minted_by_membership_id::text AS minted_by_membership_id
      FROM agent_sessions WHERE id = ${sessionId}`;
  if (row === undefined) throw new Error(`no agent session ${sessionId}`);
  return row;
}

const CLEARED: StoredKey = {
  ciphertext: null,
  expires_at: null,
  minted_by_account_id: null,
  minted_by_api_key_id: null,
  minted_by_web_session_id: null,
  minted_by_membership_id: null,
};

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 6);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 6 });
  harness = adminCreditsHarness(opened.url);
  const catalog = buildLegalCatalog({ repoRoot: REPO_ROOT });

  const ownerEmail = `owner-${randomUUID()}@example.test`;
  const ownerId = await seedAccount(sql(), ownerEmail, catalog);
  owner = {
    accountId: ownerId,
    email: ownerEmail,
    browser: await seedWebSession(sql(), ownerId),
    admin: await seedApiKey(sql(), ownerId, {
      scopes: ['read', 'write', 'account_owner'],
      name: 'owner integration',
    }),
    desktop: await seedApiKey(sql(), ownerId, {
      scopes: [...DEVICE_SCOPES],
      name: 'Desktop client',
      provenance: 'cli_device',
    }),
    laptop: await seedApiKey(sql(), ownerId, {
      scopes: [...DEVICE_SCOPES],
      name: 'Desktop client',
      provenance: 'cli_device',
    }),
    ci: await seedApiKey(sql(), ownerId, { scopes: ['read', 'write'], name: 'ci' }),
  };
  admin = await seedAdmin(catalog, ownerId);
  secondAdmin = await seedAdmin(catalog, ownerId);
  const resetterEmail = `reset-${randomUUID()}@example.test`;
  const resetterId = await seedAccount(sql(), resetterEmail, catalog);
  resetter = {
    accountId: resetterId,
    email: resetterEmail,
    desktop: await seedApiKey(sql(), resetterId, {
      scopes: [...DEVICE_SCOPES],
      name: 'Desktop client',
      provenance: 'cli_device',
    }),
  };

  const logger = createTestLogger();
  sessionsRepo = new DrizzleAgentSessionsRepo(database, {
    transcriptEncryptionKeyBase64: randomBytes(32).toString('base64'),
  });
  const agentRuntime = new AgentRuntime({
    decomposer: new DeterministicAgentDecomposer(),
    executor: new StubAgentExecutor(),
    sessions: sessionsRepo,
    archetype: 'iphone16pro_ios18_7_safari26_4',
  });
  app = await buildRealApp(database, harness, catalog, {
    staffEmails: new Set(),
    extraDeps: {
      agentRuntime,
      agentSessionsRepo: sessionsRepo,
      guiControlKeyEncryptionKey: randomBytes(32).toString('base64'),
      drizzleFleetNodesRepo: new DrizzleFleetNodesRepo(database),
      livekitSecretEncryptionKey: randomBytes(32).toString('base64'),
      teamMembersService: new TeamMembersService(
        new DrizzleTeamMembersRepo(database),
        createEmailService({ config: null, logger }),
        { dashboardBaseUrl: 'https://app.driftstack.test' },
      ),
    },
  });
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await harness?.base.database.close().catch(() => {});
  await database?.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!RUN_DB_TESTS)(
  'a session control key dies with the credential or membership that minted it',
  () => {
    it('the isolated database is reachable and every seeded credential authenticates — otherwise every 401 below would be measuring a credential that never worked', async () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      for (const bearer of [
        o().browser.token,
        o().admin.plaintext,
        o().desktop.plaintext,
        o().laptop.plaintext,
        o().ci.plaintext,
        m().desktop.plaintext,
        resetter?.desktop.plaintext ?? '',
      ]) {
        const me = await theApp().inject({
          method: 'GET',
          url: '/v1/whoami',
          headers: { authorization: `Bearer ${bearer}` },
        });
        expect(me.statusCode, me.body).toBe(200);
      }
    });

    describe('a team admin the owner removes', () => {
      let used = '';
      let untouched = '';
      let usedKey = '';
      let ownersSession = '';
      let ownersKey = '';

      it('mints a control key on the owner’s session from their desktop app, and it reads and drives the session (the baseline the removal must end)', async () => {
        used = await newSession(o().accountId);
        untouched = await newSession(o().accountId);
        ownersSession = await newSession(o().accountId);
        const first = await mint(m().desktop.plaintext, used);
        expect(first.status).toBe(200);
        usedKey = first.key;
        expect((await mint(m().desktop.plaintext, untouched)).status).toBe(200);
        const owners = await mint(o().desktop.plaintext, ownersSession);
        expect(owners.status).toBe(200);
        ownersKey = owners.key;

        expect(await readWith(usedKey, used)).toBe(200);
        expect(await writeWith(usedKey, used, 'manual')).toBe(200);
      });

      it('the stored key names its minter: the admin’s account, the desktop key they used and the membership they acted through', async () => {
        const row = await stored(used);
        expect(row.ciphertext).not.toBeNull();
        expect({
          account: row.minted_by_account_id,
          apiKey: row.minted_by_api_key_id,
          webSession: row.minted_by_web_session_id,
          membership: row.minted_by_membership_id,
        }).toEqual({
          account: m().accountId,
          apiKey: m().desktop.id,
          webSession: null,
          membership: m().membershipId,
        });
      });

      it('CRITICAL immediately after the removal the key gets 401 on read and on write, and on the LiveKit re-mint and the transport report', async () => {
        const removed = await theApp().inject({
          method: 'DELETE',
          url: `/v1/team/members/mem_${m().membershipId}`,
          headers: { authorization: `Bearer ${o().admin.plaintext}` },
        });
        expect(removed.statusCode, removed.body).toBe(204);

        expect(await readWith(usedKey, used), 'the removed admin still reads the session').toBe(
          401,
        );
        expect(
          await writeWith(usedKey, used, 'ai'),
          'the removed admin still drives the session',
        ).toBe(401);
        expect(await otherGatesWith(usedKey, used)).toEqual([401, 401]);
      });

      it('CRITICAL the removal itself cleared every key the admin minted — including one nobody has presented since', async () => {
        expect(await stored(untouched)).toEqual(CLEARED);
        expect(await stored(used)).toEqual(CLEARED);
      });

      it('the owner’s own key on another session is untouched, and the owner can mint a fresh key for the session the admin held', async () => {
        expect(await readWith(ownersKey, ownersSession)).toBe(200);
        expect((await stored(ownersSession)).ciphertext).not.toBeNull();
        const fresh = await mint(o().desktop.plaintext, used);
        expect(fresh).toMatchObject({ status: 200, minted: true });
        expect(fresh.key).not.toBe(usedKey);
        expect(await readWith(fresh.key, used)).toBe(200);
      });

      it('a team admin demoted to member loses the key too: the membership must still hold the admin role', async () => {
        const second = secondAdmin;
        if (second === null) throw new Error('second admin not seeded');
        const sessionId = await newSession(o().accountId);
        const minted = await mint(second.desktop.plaintext, sessionId);
        expect(minted.status).toBe(200);
        expect(await readWith(minted.key, sessionId)).toBe(200);
        await sql()`
          UPDATE team_members SET role = 'member'::team_role WHERE id = ${second.membershipId}::uuid`;
        expect(await readWith(minted.key, sessionId)).toBe(401);
        expect(await stored(sessionId)).toEqual(CLEARED);
      });
    });

    describe('an API key the owner revokes', () => {
      it('CRITICAL a control key minted by it gets 401 on read and on write, and the revocation cleared the keys it minted', async () => {
        const used = await newSession(o().accountId);
        const untouched = await newSession(o().accountId);
        const minted = await mint(o().ci.plaintext, used);
        expect(minted.status).toBe(200);
        expect((await mint(o().ci.plaintext, untouched)).status).toBe(200);
        expect(await readWith(minted.key, used)).toBe(200);

        const revoked = await theApp().inject({
          method: 'DELETE',
          url: `/v1/api-keys/key_${o().ci.id}`,
          headers: { authorization: `Bearer ${o().admin.plaintext}` },
        });
        expect(revoked.statusCode, revoked.body).toBe(204);

        expect(await readWith(minted.key, used), 'a key minted by a revoked API key reads').toBe(
          401,
        );
        expect(await writeWith(minted.key, used, 'manual')).toBe(401);
        expect(await stored(untouched), 'the revocation left a key its credential minted').toEqual(
          CLEARED,
        );
      });
    });

    describe('a teammate’s key and the owner’s', () => {
      it('CRITICAL the owner’s mint after a teammate minted gives a FRESH key, and the teammate’s key stops working', async () => {
        const second = secondAdmin;
        if (second === null) throw new Error('second admin not seeded');
        // The second admin was demoted above; restore the role for this arm.
        await sql()`
          UPDATE team_members SET role = 'admin'::team_role WHERE id = ${second.membershipId}::uuid`;
        const sessionId = await newSession(o().accountId);
        const teammates = await mint(second.desktop.plaintext, sessionId);
        expect(teammates).toMatchObject({ status: 200, minted: true });
        expect(await readWith(teammates.key, sessionId)).toBe(200);

        const owners = await mint(o().desktop.plaintext, sessionId);
        expect(owners.status).toBe(200);
        expect(owners.key, 'the owner was handed the teammate’s key').not.toBe(teammates.key);
        expect(owners.minted).toBe(true);

        expect(await readWith(teammates.key, sessionId), 'the teammate’s key still works').toBe(
          401,
        );
        expect(await readWith(owners.key, sessionId)).toBe(200);
        expect((await stored(sessionId)).minted_by_api_key_id).toBe(o().desktop.id);
      });
    });

    describe('two windows of the same principal', () => {
      it('CRITICAL share one key — the second mint echoes it — and both keep working, for the owner and for a team admin acting for them', async () => {
        const second = secondAdmin;
        if (second === null) throw new Error('second admin not seeded');
        for (const [who, bearer, apiKeyId, account, membership] of [
          ['the owner', o().desktop.plaintext, o().desktop.id, o().accountId, null],
          [
            'a team admin',
            second.desktop.plaintext,
            second.desktop.id,
            second.accountId,
            second.membershipId,
          ],
        ] as const) {
          const sessionId = await newSession(o().accountId);
          const mainWindow = await mint(bearer, sessionId);
          const simulatorWindow = await mint(bearer, sessionId);
          expect(mainWindow, who).toMatchObject({ status: 200, minted: true });
          expect(simulatorWindow, who).toMatchObject({ status: 200, minted: false });
          expect(simulatorWindow.key, who).toBe(mainWindow.key);

          expect(await readWith(mainWindow.key, sessionId), who).toBe(200);
          expect(await writeWith(simulatorWindow.key, sessionId, 'manual'), who).toBe(200);
          expect(await readWith(simulatorWindow.key, sessionId), who).toBe(200);
          expect(await readWith(mainWindow.key, sessionId), who).toBe(200);

          const row = await stored(sessionId);
          expect(
            {
              account: row.minted_by_account_id,
              apiKey: row.minted_by_api_key_id,
              membership: row.minted_by_membership_id,
            },
            `${who}: the shared key is recorded against the principal that minted it`,
          ).toEqual({ account, apiKey: apiKeyId, membership });
        }
      });

      it('CRITICAL the owner can rotate the key on purpose: ?rotate=true mints a fresh key and the old one stops working at once', async () => {
        const sessionId = await newSession(o().accountId);
        const before = await mint(o().desktop.plaintext, sessionId);
        expect(before.status).toBe(200);
        const rotated = await mint(o().desktop.plaintext, sessionId, '?rotate=true');
        expect(rotated).toMatchObject({ status: 200, minted: true });
        expect(rotated.key).not.toBe(before.key);
        expect(await readWith(before.key, sessionId)).toBe(401);
        expect(await readWith(rotated.key, sessionId)).toBe(200);
        // And the next ordinary mint by the same principal shares the rotated key.
        const again = await mint(o().desktop.plaintext, sessionId);
        expect(again).toMatchObject({ status: 200, minted: false, key: rotated.key });
      });

      it('a rotate value other than true or false is refused, and rotates nothing', async () => {
        const sessionId = await newSession(o().accountId);
        const before = await mint(o().desktop.plaintext, sessionId);
        const refused = await mint(o().desktop.plaintext, sessionId, '?rotate=yes');
        expect(refused.status).toBe(400);
        expect(await readWith(before.key, sessionId)).toBe(200);
      });
    });

    describe('a revoked desktop device key', () => {
      it('CRITICAL revoked from the dashboard, it kills the control keys it minted, and the revocation cleared them', async () => {
        const used = await newSession(o().accountId);
        const untouched = await newSession(o().accountId);
        const minted = await mint(o().laptop.plaintext, used);
        expect(minted.status).toBe(200);
        expect((await mint(o().laptop.plaintext, untouched)).status).toBe(200);
        expect(await readWith(minted.key, used)).toBe(200);

        const revoked = await theApp().inject({
          method: 'DELETE',
          url: `/v1/api-keys/key_${o().laptop.id}`,
          headers: { authorization: `Bearer ${o().browser.token}` },
        });
        expect(revoked.statusCode, revoked.body).toBe(204);

        expect(await readWith(minted.key, used), 'a key minted by a revoked device key reads').toBe(
          401,
        );
        expect(await writeWith(minted.key, used, 'manual')).toBe(401);
        expect(await stored(untouched)).toEqual(CLEARED);
      });

      it('CRITICAL revoked by a password reset, it kills the control keys it minted, and the reset cleared them', async () => {
        const r = resetter;
        if (r === null) throw new Error('resetter not seeded');
        const used = await newSession(r.accountId);
        const untouched = await newSession(r.accountId);
        const minted = await mint(r.desktop.plaintext, used);
        expect(minted.status).toBe(200);
        expect((await mint(r.desktop.plaintext, untouched)).status).toBe(200);
        expect(await readWith(minted.key, used)).toBe(200);

        const requested = await theApp().inject({
          method: 'POST',
          url: '/v1/auth/password-reset/request',
          payload: { email: r.email },
        });
        expect(requested.statusCode, requested.body).toBe(200);
        const token = requested.json<{ debug_token?: string }>().debug_token;
        const confirmed = await theApp().inject({
          method: 'POST',
          url: '/v1/auth/password-reset/confirm',
          payload: { token, new_password: 'a brand new passphrase for this account' },
        });
        expect(confirmed.statusCode, confirmed.body).toBe(200);

        expect(
          await readWith(minted.key, used),
          'a key minted by a device key the reset revoked reads',
        ).toBe(401);
        expect(await stored(untouched)).toEqual(CLEARED);
      });
    });

    describe('a signed-in browser that mints a key', () => {
      it('the key lives exactly as long as that browser session: a sign-out elsewhere of that session kills it', async () => {
        const sessionId = await newSession(o().accountId);
        const minted = await mint(o().browser.token, sessionId);
        expect(minted.status).toBe(200);
        expect(await readWith(minted.key, sessionId)).toBe(200);
        await sql()`UPDATE web_sessions SET revoked_at = now() WHERE id = ${o().browser.id}::uuid`;
        expect(await readWith(minted.key, sessionId)).toBe(401);
        expect(await stored(sessionId)).toEqual(CLEARED);
      });
    });
  },
);
