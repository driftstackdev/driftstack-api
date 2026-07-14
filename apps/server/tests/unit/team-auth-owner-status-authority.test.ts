import { describe, expect, it } from 'vitest';
import type { AccountRow } from '../../src/services/auth.js';
import { InMemoryAuthRepo } from '../integration/_helpers/in-memory-auth-repo.js';

const MEMBER: AccountRow = {
  id: 'member_status_authority',
  email: 'member@example.test',
  name: null,
  tier: 'api_builder',
  status: 'active',
  timezone: null,
  avatarR2Key: null,
  slug: null,
  region: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};
const OWNER: AccountRow = {
  ...MEMBER,
  id: 'owner_status_authority',
  email: 'owner@example.test',
};

describe('in-memory team owner authority parity', () => {
  it('returns grants only while the owner account is active', async () => {
    const repo = new InMemoryAuthRepo();
    repo.upsertAccount(MEMBER);
    repo.upsertAccount(OWNER);
    repo.setTeamMemberships(MEMBER.id, [
      {
        membershipId: 'membership_status_authority',
        ownerAccountId: OWNER.id,
        role: 'admin',
      },
    ]);

    await expect(repo.findTeamMemberships(MEMBER.id)).resolves.toHaveLength(1);

    repo.upsertAccount({ ...OWNER, status: 'suspended' });
    await expect(repo.findTeamMemberships(MEMBER.id)).resolves.toEqual([]);

    repo.upsertAccount({ ...OWNER, status: 'deleted' });
    await expect(repo.findTeamMemberships(MEMBER.id)).resolves.toEqual([]);
  });
});
