// Team management (2026-06-16, founder: "Create teams section on the GUI, if
// the user has access for Teams"). The server team API (routes/team.ts) +
// SDK client.team.* already exist; this view is the missing GUI surface.
//
// Owner-facing: invite a teammate by email (member|admin), see pending invites,
// list confirmed members, remove a member. All calls are account_owner-scoped
// server-side — a non-owner just sees empty lists + a gentle hint.

import { useCallback, useEffect, useState, type JSX } from 'react';
import type { TeamMember, TeamInvite, TeamRole } from '@driftstack/sdk';
import { useSettings } from '../lib/SettingsContext';
import { useConfirm } from '../components/ConfirmProvider';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Map a raw team API error to customer-friendly copy (the notice showed raw
 *  err.message — status codes / scope jargon a user can't act on). */
function friendlyTeamError(err: unknown, fallback: string): string {
  const status = (err as { status?: number } | null)?.status;
  const msg = err instanceof Error ? err.message : '';
  if (status === 403 || /forbidden|owner|scope|not allowed/i.test(msg)) {
    return 'Only the account owner can manage the team.';
  }
  if (status === 402 || /seat|limit|quota|upgrade/i.test(msg)) {
    return "You've reached your team's seat limit — upgrade your plan to add more members.";
  }
  if (/load failed|network|fetch|ECONN|getaddrinfo|timeout|unreachable/i.test(msg)) {
    return "Couldn't reach the server — check your connection and try again.";
  }
  return msg.length > 0 ? msg : fallback;
}

export function TeamView(): JSX.Element {
  const { client } = useSettings();
  const confirm = useConfirm();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('member');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!client) return;
    setLoading(true);
    try {
      const [m, i] = await Promise.all([
        client.team.listMembers().catch(() => ({ data: [] as TeamMember[] })),
        client.team.listInvites().catch(() => ({ data: [] as TeamInvite[] })),
      ]);
      setMembers(m.data);
      setInvites(i.data);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInvite = useCallback(async (): Promise<void> => {
    if (!client) return;
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setNotice('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await client.team.invite(trimmed, { role });
      setEmail('');
      setNotice(`Invite sent to ${trimmed}.`);
      await refresh();
    } catch (err) {
      setNotice(friendlyTeamError(err, 'Could not send the invite.'));
    } finally {
      setBusy(false);
    }
  }, [client, email, role, refresh]);

  const handleRemove = useCallback(
    async (m: TeamMember): Promise<void> => {
      if (!client) return;
      const ok = await confirm(`Remove ${m.member_email} from your team?`, {
        confirmLabel: 'Remove',
      });
      if (!ok) return;
      setRemovingId(m.id);
      try {
        await client.team.removeMember(m.id);
        await refresh();
      } catch (err) {
        setNotice(friendlyTeamError(err, 'Could not remove the member.'));
      } finally {
        setRemovingId(null);
      }
    },
    [client, confirm, refresh],
  );

  return (
    <div className="flex h-full min-w-0 flex-col gap-4 p-6">
      <div className="border-b border-surface-divider pb-3">
        <h2 className="text-[19px] font-semibold tracking-tight text-ink-primary">Team</h2>
        <p className="mt-0.5 text-xs text-ink-secondary">
          Invite teammates to your account. Members sign in with their own login; admins can launch
          and manage your profiles.
        </p>
      </div>

      {/* Invite */}
      <div className="rounded-lg border border-surface-divider bg-surface-raised p-4">
        <h3 className="text-sm font-semibold text-ink-primary">Invite a teammate</h3>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleInvite();
            }}
            placeholder="teammate@company.com"
            aria-label="Invitee email"
            className="min-w-0 flex-1 rounded-lg border border-surface-divider bg-surface-inset px-3 py-1.5 text-sm text-ink-primary placeholder:text-ink-muted focus:border-accent focus:outline-none"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as TeamRole)}
            aria-label="Invitee role"
            className="rounded-lg border border-surface-divider bg-surface-inset px-2.5 py-1.5 text-sm text-ink-primary focus:border-accent focus:outline-none"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button
            type="button"
            onClick={() => void handleInvite()}
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send invite'}
          </button>
        </div>
        {notice !== null ? <p className="mt-2 text-xs text-ink-secondary">{notice}</p> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="py-8 text-center text-xs text-ink-muted">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4">
            {invites.length > 0 ? (
              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  Pending invites
                </h3>
                <div className="flex flex-col gap-2">
                  {invites.map((inv) => (
                    <div
                      key={inv.id}
                      className="flex items-center justify-between rounded-lg border border-dashed border-surface-divider bg-surface-raised px-3 py-2"
                    >
                      <span className="truncate text-sm text-ink-primary">{inv.invitee_email}</span>
                      <span className="text-[11px] uppercase tracking-wide text-ink-muted">
                        {inv.role} · pending
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Members
              </h3>
              {members.length === 0 ? (
                <p className="rounded-lg border border-dashed border-surface-divider py-8 text-center text-xs text-ink-muted">
                  No teammates yet. Invite someone above — or if you're a member of someone else's
                  team, ask the owner to manage it.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {members.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-surface-divider bg-surface-raised px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm text-ink-primary">{m.member_email}</div>
                        <div className="text-[11px] uppercase tracking-wide text-ink-muted">
                          {m.role}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleRemove(m)}
                        disabled={removingId === m.id}
                        className="shrink-0 rounded-lg border border-surface-divider px-2.5 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:border-status-error/60 hover:text-status-error disabled:opacity-50"
                      >
                        {removingId === m.id ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
