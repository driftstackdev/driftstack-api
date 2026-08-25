import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  teamWorkspaceLabel,
  teamWorkspaceName,
  teamWorkspaceTitle,
  type TeamWorkspaceIdentity,
} from '../../src/lib/team-label';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * V-1611 #14 — the customer-visible half.
 *
 * ⛔ The label data has shipped since V-326c and BOTH surfaces ignored it.
 * `GET /v1/account/me` sends `owner_email` and `owner_name`, the SDK types them,
 * and the SDK comment says they exist so a team can be labelled "by who owns it
 * (instead of a bare acc_<uuid>)". The GUI rendered `Team 3f9a2c1d · admin` in
 * the sidebar and `Team · member` — no identity at all — in the profiles strip.
 *
 * So this needed no schema change and no new endpoint. It needed the payload to
 * be read.
 */
const base: TeamWorkspaceIdentity = {
  owner_account_id: 'acc_3f9a2c1d-0000-0000-0000-000000000000',
  owner_email: 'alice@example.com',
  owner_name: 'Alice Co',
  role: 'admin',
};

describe('teamWorkspaceName', () => {
  it('uses the owner name when there is one', () => {
    expect(teamWorkspaceName(base)).toBe('Alice Co');
  });

  it('falls back to the email local part when the name is null', () => {
    expect(teamWorkspaceName({ ...base, owner_name: null })).toBe('alice');
  });

  it('treats a whitespace-only name as absent rather than rendering a blank chip', () => {
    expect(teamWorkspaceName({ ...base, owner_name: '   ' })).toBe('alice');
  });

  it('falls through an email that has no local part', () => {
    // "@example.com" splits to '' — an empty string is not a name, and a blank
    // workspace chip is worse than a short id.
    expect(teamWorkspaceName({ ...base, owner_name: null, owner_email: '@example.com' })).toBe(
      'Team 3f9a2c1d',
    );
  });

  it('falls back to a short id when the payload carries neither, and strips acc_', () => {
    // A desktop client can be older than the server it talks to, so both fields
    // are optional at runtime whatever the current type says.
    expect(teamWorkspaceName({ owner_account_id: 'acc_3f9a2c1d-x', role: 'member' })).toBe(
      'Team 3f9a2c1d',
    );
  });

  it('⛔ NEVER renders a bare account id as the whole label', () => {
    for (const t of [
      base,
      { ...base, owner_name: null },
      { ...base, owner_name: null, owner_email: '@x' },
      { owner_account_id: 'acc_deadbeef-1', role: 'member' as const },
    ]) {
      expect(teamWorkspaceName(t)).not.toBe(t.owner_account_id);
    }
  });
});

describe('teamWorkspaceLabel / Title', () => {
  it('carries the role, because the switcher shows several at once', () => {
    expect(teamWorkspaceLabel(base)).toBe('Alice Co · admin');
    expect(teamWorkspaceLabel({ ...base, role: 'member' })).toBe('Alice Co · member');
  });

  it('keeps the owner account id reachable in hover text', () => {
    // The label deliberately stopped showing it; support still asks for it.
    expect(teamWorkspaceTitle(base)).toContain('acc_3f9a2c1d-0000-0000-0000-000000000000');
    expect(teamWorkspaceTitle(base)).toContain('alice@example.com');
  });

  it('omits the parenthetical when there is no email rather than rendering "()"', () => {
    expect(teamWorkspaceTitle({ owner_account_id: 'acc_x', role: 'member' })).toBe(
      'Owner account acc_x',
    );
  });
});

describe('the GUI ladder and migration 0114 agree', () => {
  it('CRITICAL both name a team by owner-name, then email local part, then short id. If they diverge, a team nobody renamed changes its label the day the server starts sending teams.name — which is a customer noticing a change nobody made.', () => {
    const sql = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/db/migrations/0114_teams_entity.sql'),
      'utf8',
    );
    // The migration's COALESCE, in order. Read from the file so this fails if
    // the backfill is re-ordered rather than pinning a remembered copy.
    const coalesce = /COALESCE\(([\s\S]*?)\n\s*\)/.exec(sql)?.[1] ?? '';
    const rungs = coalesce
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(rungs[0], 'first rung is the account name').toContain('BTRIM(a."name")');
    expect(rungs[1], 'second rung is the email local part').toContain(
      'SPLIT_PART(a."email", \'@\', 1)',
    );
    expect(rungs[2], 'third rung is a short id').toContain('LEFT(a."id"::text, 8)');

    // And the GUI produces the same three outcomes for the same three inputs.
    expect(teamWorkspaceName({ ...base, owner_name: 'Alice Co' })).toBe('Alice Co');
    expect(teamWorkspaceName({ ...base, owner_name: '   ' })).toBe('alice');
    expect(teamWorkspaceName({ ...base, owner_name: null, owner_email: '@nolocalpart' })).toMatch(
      /^Team /,
    );
  });
});
