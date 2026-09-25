// A key a team member minted on the owner's account reads what the member may read
// (security sweep #12).
//
// An `admin` member can mint a key on the owner's account through
// `X-Driftstack-Account`. The key authenticates AS the owner, with no header, so every
// read resolved as the owner reading their own data — while `api_keys.created_by_account_id`
// still names the member who holds it. The audit log removes the owner's IP address and
// user agent for a team member reading it through the header (audit-log.md); through such
// a key the member got them unredacted, and the same key read the owner's linked sign-in
// emails, the owner's signed-in devices and the owner's OTHER team memberships.
//
// Now a key whose minter is not its own account is read as the member it belongs to:
//   - the audit log and its export redact the owner's network identity, as for the header;
//   - linked sign-ins and signed-in devices refuse it (the header never reached either —
//     both always answer for the caller's own account);
//   - `/v1/account/me` lists no teams for it, and it cannot act for any of the owner's
//     teams: the membership belongs to the owner, not to the member holding the key.
// The owner's own key is unchanged in every one of these.

import { afterEach, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../src/lib/api-keys.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const MEMBER_ID = '00000000-0000-4000-8000-00000000d121';
const DELEGATED_KEY_ID = '00000000-0000-4000-8000-00000000d122';
/** A team the OWNER belongs to as an admin — the member holding the key does not. */
const THIRD_TEAM_OWNER_ID = '00000000-0000-4000-8000-00000000d123';
const THIRD_TEAM_MEMBERSHIP_ID = '00000000-0000-4000-8000-00000000d124';

const OWNER_IP = '203.0.113.77';
const OWNER_UA = 'OwnerBrowser/1.0';

let fx: TestAppFixture | undefined;

afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = undefined;
});

interface Seeded {
  f: TestAppFixture;
  /** The owner's own key (the fixture key: minted by the owner). */
  ownerKey: string;
  /** A `read` key on the owner's account, minted by the member. */
  delegatedKey: string;
}

/** Registers the linked sign-ins routes; no provider is ever called here. */
const OAUTH = {
  signingSecret: 'c'.repeat(32),
  callbackUrlBase: 'https://api.driftstack.test/v1/auth/oauth',
  dashboardOrigin: 'https://app.driftstack.test',
  github: { clientId: 'github-test-id', clientSecret: 'github-test-secret' },
};

async function seed(): Promise<Seeded> {
  const f = await buildTestApp({ tier: 'api_builder', oauthClient: OAUTH });
  const plaintext = generateApiKey('test');
  f.authRepo.upsertApiKey({
    id: DELEGATED_KEY_ID,
    accountId: f.accountId,
    name: 'minted by a team member',
    keyPrefix: keyPrefixFromPlaintext(plaintext),
    keyHash: await hashApiKey(plaintext),
    scopes: ['read'],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    createdByAccountId: MEMBER_ID,
  });
  // The owner's sign-in, recorded the way the auth flows record it.
  await f.accountAuditRepo.insert({
    accountId: f.accountId,
    actorType: 'customer',
    action: 'account.login',
    payload: { method: 'password', issued_from_ip: OWNER_IP, user_agent: OWNER_UA },
    ipAddress: OWNER_IP,
    userAgent: OWNER_UA,
  });
  await f.oauthLinksRepo.insertLink({
    accountId: f.accountId,
    provider: 'github',
    providerSub: 'gh-owner-1',
    providerEmail: 'owner-personal@example.test',
    providerName: null,
    providerAvatarUrl: null,
  });
  f.authRepo.upsertAccount({
    id: THIRD_TEAM_OWNER_ID,
    email: 'third-team-owner@example.test',
    name: 'Third Team',
    tier: 'api_builder',
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
  f.authRepo.setTeamMemberships(f.accountId, [
    {
      membershipId: THIRD_TEAM_MEMBERSHIP_ID,
      ownerAccountId: THIRD_TEAM_OWNER_ID,
      role: 'admin',
    },
  ]);
  return { f, ownerKey: f.plaintext, delegatedKey: plaintext };
}

function as(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${key}`, ...extra };
}

interface AuditEntry {
  action: string;
  ip_address: string | null;
  user_agent: string | null;
  payload: Record<string, unknown> | null;
}

function loginRow(entries: AuditEntry[]): AuditEntry {
  const row = entries.find((e) => e.action === 'account.login');
  if (row === undefined) throw new Error('the seeded account.login row is missing');
  return row;
}

describe("a key a team member minted on the owner's account reads what the member may read", () => {
  it("CRITICAL the audit log redacts the owner's IP address and user agent for the member's key", async () => {
    const s = await seed();
    fx = s.f;
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: as(s.delegatedKey),
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = loginRow(res.json<{ data: AuditEntry[] }>().data);
    expect(row.ip_address).toBeNull();
    expect(row.user_agent).toBeNull();
    expect(row.payload).toEqual({ method: 'password' });
  });

  it("CRITICAL the audit-log export (JSON and CSV) redacts the owner's network identity for the member's key", async () => {
    const s = await seed();
    fx = s.f;
    const json = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log/export?format=json',
      headers: as(s.delegatedKey),
    });
    expect(json.statusCode, json.body).toBe(200);
    const row = loginRow(json.json<{ data: AuditEntry[] }>().data);
    expect(row.ip_address).toBeNull();
    expect(row.user_agent).toBeNull();

    const csv = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log/export?format=csv',
      headers: as(s.delegatedKey),
    });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain('account.login');
    expect(csv.body).not.toContain(OWNER_IP);
    expect(csv.body).not.toContain(OWNER_UA);
  });

  it("CONTROL the owner's own key still sees the owner's own sign-in IP and user agent", async () => {
    const s = await seed();
    fx = s.f;
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: as(s.ownerKey),
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = loginRow(res.json<{ data: AuditEntry[] }>().data);
    expect(row.ip_address).toBe(OWNER_IP);
    expect(row.user_agent).toBe(OWNER_UA);
    expect(row.payload).toMatchObject({ issued_from_ip: OWNER_IP, user_agent: OWNER_UA });
  });

  it("the owner's linked sign-ins and signed-in devices refuse the member's key, and still answer the owner's", async () => {
    const s = await seed();
    fx = s.f;
    for (const url of ['/v1/account/me/oauth-links', '/v1/account/web-sessions']) {
      const member = await fx.app.inject({ method: 'GET', url, headers: as(s.delegatedKey) });
      expect(member.statusCode, `${url}: ${member.body}`).toBe(403);
      expect(member.body).not.toContain('owner-personal@example.test');

      const owner = await fx.app.inject({ method: 'GET', url, headers: as(s.ownerKey) });
      expect(owner.statusCode, `${url}: ${owner.body}`).toBe(200);
    }
    const ownerLinks = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/oauth-links',
      headers: as(s.ownerKey),
    });
    expect(ownerLinks.body).toContain('owner-personal@example.test');
  });

  it("CRITICAL the member's key lists none of the owner's teams and cannot act for one", async () => {
    const s = await seed();
    fx = s.f;
    const me = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: as(s.delegatedKey),
    });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json<{ teams: unknown[] }>().teams).toEqual([]);

    const actAs = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: as(s.delegatedKey, { 'x-driftstack-account': `acc_${THIRD_TEAM_OWNER_ID}` }),
    });
    expect(actAs.statusCode, actAs.body).toBe(403);
  });

  it("CONTROL the owner's own key lists the owner's team and can act for it", async () => {
    const s = await seed();
    fx = s.f;
    const me = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: as(s.ownerKey),
    });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json<{ teams: Array<{ owner_account_id: string }> }>().teams).toEqual([
      expect.objectContaining({ owner_account_id: `acc_${THIRD_TEAM_OWNER_ID}` }),
    ]);

    const actAs = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: as(s.ownerKey, { 'x-driftstack-account': `acc_${THIRD_TEAM_OWNER_ID}` }),
    });
    expect(actAs.statusCode, actAs.body).toBe(200);
  });
});
