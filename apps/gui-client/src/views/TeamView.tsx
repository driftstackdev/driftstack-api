// Team management (2026-06-16, founder: "Create teams section on the GUI, if
// the user has access for Teams"). The server team API (routes/team.ts) +
// SDK client.team.* already exist; this view is the missing GUI surface.
//
// Owner-facing: invite a teammate by email (member|admin), see pending invites,
// list confirmed members, remove a member. All calls are account_owner-scoped
// server-side — a non-owner just sees empty lists + a gentle hint.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { TeamMember, TeamInvite, TeamRole } from '@driftstack/sdk';
import { useSettings } from '../lib/SettingsContext';
import { useConfirm } from '../components/ConfirmProvider';
import { EmptyState } from '../components/EmptyState';
import { SkeletonRows } from '../components/Skeleton';

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
  // Notices carry a tone so a failed invite reads distinctly from a success
  // (both used to render as the same muted line — a failure looked like a win).
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  // Distinct from "empty": a non-403 load failure means the list is stale, not
  // that the team is empty (audit wiq542bfj). null = no load error.
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!client) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [m, i] = await Promise.all([client.team.listMembers(), client.team.listInvites()]);
      setMembers(m.data);
      setInvites(i.data);
    } catch (err) {
      // A 403 = not an account owner → legitimately no team to manage (clean empty
      // state, no error). ANY other failure (network/5xx/429) means the list is
      // STALE, not empty — surface it with a retry so an owner doesn't think their
      // team was wiped (the old per-call catch swallowed ALL errors to []). (W2749)
      const status = (err as { status?: number } | null)?.status;
      if (status === 403) {
        setMembers([]);
        setInvites([]);
      } else {
        setLoadError(friendlyTeamError(err, 'Could not load your team — please try again.'));
      }
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Synchronous re-entry guard: the Send button is disabled while busy, but the
  // email's Enter handler isn't — a fast double-Enter (or Enter then click) before
  // the busy state flushes would fire two invites for the same address. A ref
  // blocks the second call immediately (state is async). (audit wiq542bfj)
  const invitingRef = useRef(false);
  const handleInvite = useCallback(async (): Promise<void> => {
    if (!client || invitingRef.current) return;
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setNotice({ tone: 'error', text: 'Enter a valid email address.' });
      return;
    }
    invitingRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await client.team.invite(trimmed, { role });
      setEmail('');
      // Reset the role back to the safe default so the next invite doesn't
      // silently over-grant admin to a member just because the last one was.
      setRole('member');
      setNotice({ tone: 'success', text: `Invite sent to ${trimmed}.` });
      await refresh();
    } catch (err) {
      setNotice({ tone: 'error', text: friendlyTeamError(err, 'Could not send the invite.') });
    } finally {
      invitingRef.current = false;
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
      // Clear any stale invite notice so a prior "Invite sent" success banner
      // doesn't linger beside this unrelated remove action. (audit wiq542bfj)
      setNotice(null);
      setRemovingId(m.id);
      try {
        await client.team.removeMember(m.id);
        await refresh();
      } catch (err) {
        setNotice({ tone: 'error', text: friendlyTeamError(err, 'Could not remove the member.') });
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
            className="btn-primary px-4"
          >
            {busy ? 'Sending…' : 'Send invite'}
          </button>
        </div>
        {notice !== null ? (
          <p
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={`mt-2 rounded-md px-2.5 py-1.5 text-xs ${
              notice.tone === 'error'
                ? 'bg-status-error/10 text-status-error'
                : 'bg-status-ready/10 text-status-ready'
            }`}
          >
            {notice.text}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <SkeletonRows rows={3} label="Loading your team…" />
        ) : loadError !== null ? (
          <div className="flex flex-col items-start gap-3 rounded-lg border border-surface-divider bg-surface-raised p-6">
            <h3 className="text-sm font-semibold text-ink-primary">Couldn&apos;t load your team</h3>
            <p className="max-w-md text-sm text-ink-secondary">{loadError}</p>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover"
            >
              Try again
            </button>
          </div>
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
                <EmptyState
                  title="No teammates yet"
                  description="Invite someone above — or if you're a member of someone else's team, ask the owner to manage it."
                />
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
