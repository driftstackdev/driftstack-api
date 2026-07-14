// Real-Postgres proof for the pending team-invite authority fence.
// One owner/email may have accepted history, but never two live pending roles
// or credentials that can be consumed in an arbitrary later order.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleTeamMembersRepo } from '../../src/db/team-members-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededAccountIds: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 8 });
  try {
    await client`SELECT 1 FROM team_invites LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const accountId of seededAccountIds) {
    await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'pending team-invite authority (Drizzle path, real Postgres)',
  () => {
    it('atomically collapses mixed-role refreshes while retaining accepted history', async () => {
      if (!dbReachable || !client) {
        throw new Error('real PostgreSQL setup failed');
      }
      const indexes = await client`
        SELECT indexdef
          FROM pg_indexes
         WHERE schemaname = current_schema()
           AND tablename = 'team_invites'
           AND indexname = 'team_invites_owner_email_pending_unique'
      `;
      expect(indexes).toHaveLength(1);
      expect(String(indexes[0]?.indexdef)).toMatch(
        /UNIQUE INDEX .* \(owner_account_id, invitee_email\) WHERE \(accepted_at IS NULL\)/i,
      );

      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleTeamMembersRepo({ client, db, close: async () => {} });
      const ownerAccountId = randomUUID();
      const inviteeEmail = `invite-fence-${randomUUID()}@test.local`;
      seededAccountIds.push(ownerAccountId);
      await client`INSERT INTO accounts (id, email) VALUES (${ownerAccountId}, ${`owner-${ownerAccountId}@test.local`})`;

      const input = {
        ownerAccountId,
        inviteeEmail,
        inviteExpiresAt: new Date(Date.now() + 60_000),
        invitedByAccountId: ownerAccountId,
      };
      const refreshed = await Promise.all([
        repo.upsertInvite({
          ...input,
          role: 'admin',
          inviteTokenHash: `admin-${randomUUID()}`,
        }),
        repo.upsertInvite({
          ...input,
          role: 'member',
          inviteTokenHash: `member-${randomUUID()}`,
        }),
      ]);
      expect(new Set(refreshed.map((row) => row.id)).size).toBe(1);
      const pending = await client`
        SELECT id, role
          FROM team_invites
         WHERE owner_account_id = ${ownerAccountId}
           AND invitee_email = ${inviteeEmail}
           AND accepted_at IS NULL
      `;
      expect(pending).toHaveLength(1);

      await client`
        UPDATE team_invites
           SET accepted_at = now()
         WHERE id = ${String(pending[0]?.id)}::uuid
      `;
      const next = await repo.upsertInvite({
        ...input,
        role: 'member',
        inviteTokenHash: `next-${randomUUID()}`,
      });
      expect(next.id).not.toBe(String(pending[0]?.id));
      const history = await client`
        SELECT accepted_at
          FROM team_invites
         WHERE owner_account_id = ${ownerAccountId}
           AND invitee_email = ${inviteeEmail}
      `;
      expect(history).toHaveLength(2);
      expect(history.filter((row) => row.accepted_at === null)).toHaveLength(1);
    });

    it('rejects an old invite snapshot after a concurrent token and role replacement', async () => {
      if (!dbReachable || !client) {
        throw new Error('real PostgreSQL setup failed');
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleTeamMembersRepo({ client, db, close: async () => {} });
      const ownerAccountId = randomUUID();
      const acceptingAccountId = randomUUID();
      const inviteeEmail = `invite-replace-${randomUUID()}@test.local`;
      const oldTokenHash = `old-${randomUUID()}`;
      seededAccountIds.push(ownerAccountId, acceptingAccountId);
      await client`
        INSERT INTO accounts (id, email)
        VALUES
          (${ownerAccountId}, ${`owner-${ownerAccountId}@test.local`}),
          (${acceptingAccountId}, ${inviteeEmail})
      `;

      const oldInvite = await repo.upsertInvite({
        ownerAccountId,
        inviteeEmail,
        role: 'admin',
        inviteTokenHash: oldTokenHash,
        inviteExpiresAt: new Date(Date.now() + 60_000),
        invitedByAccountId: ownerAccountId,
      });
      const replacementTokenHash = `replacement-${randomUUID()}`;
      const replacementInvite = await repo.upsertInvite({
        ownerAccountId,
        inviteeEmail,
        role: 'member',
        inviteTokenHash: replacementTokenHash,
        inviteExpiresAt: new Date(Date.now() + 60_000),
        invitedByAccountId: ownerAccountId,
      });

      const staleAccept = await repo.acceptInviteAtomic({
        inviteId: oldInvite.id,
        inviteTokenHash: oldTokenHash,
        memberAccountId: acceptingAccountId,
        memberEmail: inviteeEmail,
        acceptedAt: new Date(),
      });
      expect(staleAccept).toBeNull();
      const memberships = await client`
        SELECT role
          FROM team_members
         WHERE owner_account_id = ${ownerAccountId}
           AND member_account_id = ${acceptingAccountId}
      `;
      expect(memberships).toHaveLength(0);

      const freshAccept = await repo.acceptInviteAtomic({
        inviteId: replacementInvite.id,
        inviteTokenHash: replacementTokenHash,
        memberAccountId: acceptingAccountId,
        memberEmail: inviteeEmail,
        acceptedAt: new Date(),
      });
      expect(freshAccept?.role).toBe('member');
    });
  },
);
