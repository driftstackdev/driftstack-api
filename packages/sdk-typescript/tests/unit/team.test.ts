// V-309e — TeamResource SDK tests.

import { describe, expect, it, vi } from 'vitest';
import { TeamResource } from '../../src/resources/team.js';
import type { HttpClient } from '../../src/http.js';

interface RequestOpts {
  method: string;
  path: string;
  body?: unknown;
}

describe('TeamResource', () => {
  it('invite POSTs /v1/team/invites with email + role', async () => {
    const calls: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      return Promise.resolve({ message: 'Invite sent.' });
    });
    const team = new TeamResource({ request } as unknown as HttpClient);
    await team.invite('user@example.test', { role: 'admin' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/v1/team/invites');
    expect(calls[0]!.body).toEqual({ email: 'user@example.test', role: 'admin' });
  });

  it('invite without role omits the field', async () => {
    const calls: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      return Promise.resolve({ message: 'Invite sent.' });
    });
    const team = new TeamResource({ request } as unknown as HttpClient);
    await team.invite('user@example.test');
    expect(calls[0]!.body).toEqual({ email: 'user@example.test' });
  });

  it('listMembers GETs /v1/team/members', async () => {
    const request = vi.fn(() => Promise.resolve({ data: [] }));
    const team = new TeamResource({ request } as unknown as HttpClient);
    const result = await team.listMembers();
    expect(result.data).toEqual([]);
    expect(request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/team/members' });
  });

  it('listInvites GETs /v1/team/invites', async () => {
    const request = vi.fn(() => Promise.resolve({ data: [] }));
    const team = new TeamResource({ request } as unknown as HttpClient);
    await team.listInvites();
    expect(request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/team/invites' });
  });

  it('listOwners GETs /v1/team/owners with a typed workspace envelope', async () => {
    const request = vi.fn(() =>
      Promise.resolve({
        data: [
          {
            owner_account_id: 'acc_owner',
            owner_email: 'owner@example.test',
            owner_name: 'Owner',
            role: 'admin',
            membership_id: 'mem_test',
          },
        ],
      }),
    );
    const team = new TeamResource({ request } as unknown as HttpClient);
    const result = await team.listOwners();
    expect(result.data[0]?.owner_email).toBe('owner@example.test');
    expect(request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/team/owners' });
  });

  it('acceptInvite POSTs token in body', async () => {
    const calls: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      return Promise.resolve({
        membership: {
          id: 'mem_test',
          owner_account_id: 'acc_owner',
          member_account_id: 'acc_member',
          member_email: 'm@example.test',
          role: 'member',
          invited_at: '2026-05-08T00:00:00Z',
          accepted_at: '2026-05-08T00:00:00Z',
          invited_by_account_id: 'acc_owner',
        },
      });
    });
    const team = new TeamResource({ request } as unknown as HttpClient);
    const result = await team.acceptInvite('plaintexttoken');
    expect(calls[0]!.path).toBe('/v1/team/invites/accept');
    expect(calls[0]!.body).toEqual({ token: 'plaintexttoken' });
    expect(result.membership.member_email).toBe('m@example.test');
  });

  it('removeMember DELETEs the membership URL', async () => {
    const calls: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      return Promise.resolve(undefined);
    });
    const team = new TeamResource({ request } as unknown as HttpClient);
    await team.removeMember('mem_test');
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.path).toBe('/v1/team/members/mem_test');
  });

  // ⛔ listTeams and renameTeam shipped with NO test in ANY of the three SDKs —
  // not TypeScript, not Python, not Go (V-1978). Both target real routes with
  // matching verbs, so nothing was broken; nothing was checking either.

  it('listTeams GETs /v1/teams and returns the envelope verbatim', async () => {
    const team1 = {
      id: 'team_11111111-2222-3333-4444-555555555555',
      name: 'Acme',
      slug: null,
      owner_account_id: 'acc_1',
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    };
    const calls: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      return Promise.resolve({ data: [team1] });
    });
    const team = new TeamResource({ request } as unknown as HttpClient);
    const out = await team.listTeams();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.path).toBe('/v1/teams');
    // `slug` is published but always null today; a client that dropped it would
    // change the shape customers destructure.
    expect(out).toEqual({ data: [team1] });
  });

  it('listTeams sends NO body — it is a read, and a body would change the request', async () => {
    const calls: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      return Promise.resolve({ data: [] });
    });
    const team = new TeamResource({ request } as unknown as HttpClient);
    await team.listTeams();
    expect(calls[0]!.body).toBeUndefined();
  });

  it('CRITICAL renameTeam PATCHes /v1/teams/:id with exactly { name }', async () => {
    const calls: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      return Promise.resolve({ team: { id: 'team_1', name: 'New' } });
    });
    const team = new TeamResource({ request } as unknown as HttpClient);
    await team.renameTeam('team_1', 'New');
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.path).toBe('/v1/teams/team_1');
    // Exactly { name }: the route runs reportUnknownRequestFields against
    // RenameTeamBodySchema, so an extra key is a warning the caller never sees.
    expect(calls[0]!.body).toEqual({ name: 'New' });
  });

  it('CRITICAL renameTeam URL-encodes the team id, so a caller-supplied id cannot alter the path', async () => {
    const calls: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      return Promise.resolve({ team: { id: 'x', name: 'n' } });
    });
    const team = new TeamResource({ request } as unknown as HttpClient);
    await team.renameTeam('team/with space', 'n');
    expect(calls[0]!.path).toBe('/v1/teams/team%2Fwith%20space');
  });
});
