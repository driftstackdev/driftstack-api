/**
 * What to CALL a team workspace, defined once.
 *
 * ⛔ The data to do this properly has been shipping since V-326c and both
 * surfaces ignored it. `GET /v1/account/me` sends `owner_email` and
 * `owner_name` on every team entry, the SDK types them, and the SDK's own
 * comment says what they are for: *"let the dashboard label a team by who owns
 * it (instead of a bare acc_<uuid>)"*. Meanwhile the GUI rendered:
 *
 *     Sidebar        "Team 3f9a2c1d · admin"   (short id + role)
 *     ProfilesView   "Team · member"           (no identity at all)
 *
 * So this was never a missing-data problem, and it did not need the `teams`
 * table to fix. It needed the payload to be read.
 *
 * Single definition on purpose, in the same spirit as `proxyVerdict` — "the
 * single definition of what to CALL that verdict". Two surfaces disagreeing
 * about what a team is called is how one of them ends up stale.
 */

/** The team fields `GET /v1/account/me` returns. Optional where a pre-V-326c
 *  payload may omit them: this renders in a desktop client that can be older
 *  than the server it is talking to. */
export interface TeamWorkspaceIdentity {
  owner_account_id: string;
  owner_email?: string;
  owner_name?: string | null;
  role: 'admin' | 'member';
}

/**
 * The team's display name.
 *
 * ⚠️ The ladder deliberately MATCHES migration 0114's backfill — account name,
 * else the email local part, else a short id. When the server starts sending a
 * real `teams.name` those two agree instead of competing, and a customer does
 * not see the label change for a team nobody renamed.
 */
export function teamWorkspaceName(t: TeamWorkspaceIdentity): string {
  const named = t.owner_name?.trim();
  if (named !== undefined && named !== '') return named;
  // A local part is only a name if there IS one: "@example.com" has none, and
  // the empty string must fall through rather than render as a blank chip.
  const local = t.owner_email?.split('@')[0]?.trim();
  if (local !== undefined && local !== '') return local;
  return `Team ${t.owner_account_id.replace(/^acc_/, '').slice(0, 8)}`;
}

/** Name plus the caller's role in that workspace — the switcher shows several
 *  at once, and which one you are an admin of is the reason to look. */
export function teamWorkspaceLabel(t: TeamWorkspaceIdentity): string {
  return `${teamWorkspaceName(t)} · ${t.role}`;
}

/** Hover text. Always names the owner account, because the label deliberately
 *  no longer does and support asks for the id. */
export function teamWorkspaceTitle(t: TeamWorkspaceIdentity): string {
  const who = t.owner_email !== undefined && t.owner_email !== '' ? ` (${t.owner_email})` : '';
  return `Owner account ${t.owner_account_id}${who}`;
}
