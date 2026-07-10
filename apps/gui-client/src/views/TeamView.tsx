// Team management (2026-06-16, founder: "Create teams section on the GUI, if
// the user has access for Teams"). The server team API (routes/team.ts) +
// SDK client.team.* already exist; this view is the missing GUI surface.
//
// Owner-facing: invite a teammate by email (member|admin), see pending invites,
// list confirmed members, remove a member. All calls are account_owner-scoped
// server-side — a non-owner just sees empty lists + a gentle hint.

import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
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

  // Last-write guard: concurrent refresh() calls (e.g. invite's refresh racing a
  // remove's refresh) can resolve out of order — an older, slower listMembers
  // resolving last would clobber a newer snapshot and resurrect a removed member.
  // Each call takes a monotonic id; only the latest in-flight call is allowed to
  // commit its result. Also doubles as an unmount guard (mountedRef). (audit #9)
  const refreshSeqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // `silent` skips the skeleton toggle so a post-mutation re-fetch (invite/remove)
  // repaints in place instead of flashing the whole list back to a 3-row skeleton
  // for both round-trips; only the initial mount load shows the skeleton. (audit #18)
  const refresh = useCallback(
    async (opts?: { silent?: boolean }): Promise<void> => {
      if (!client) return;
      const seq = ++refreshSeqRef.current;
      if (opts?.silent !== true) setLoading(true);
      setLoadError(null);
      try {
        const [m, i] = await Promise.all([client.team.listMembers(), client.team.listInvites()]);
        // Ignore a stale/out-of-order result (a newer refresh already ran) or a
        // result arriving after unmount.
        if (!mountedRef.current || seq !== refreshSeqRef.current) return;
        setMembers(m.data);
        setInvites(i.data);
      } catch (err) {
        if (!mountedRef.current || seq !== refreshSeqRef.current) return;
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
        // Only the latest call, still mounted, clears the skeleton — a stale call
        // must not flip loading off under a newer in-flight load.
        if (mountedRef.current && seq === refreshSeqRef.current && opts?.silent !== true) {
          setLoading(false);
        }
      }
    },
    [client],
  );

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
      // Silent re-fetch: repaint the lists in place, no full-list skeleton flash.
      await refresh({ silent: true });
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
        // Silent re-fetch: repaint the lists in place, no full-list skeleton flash.
        await refresh({ silent: true });
      } catch (err) {
        setNotice({ tone: 'error', text: friendlyTeamError(err, 'Could not remove the member.') });
      } finally {
        setRemovingId(null);
      }
    },
    [client, confirm, refresh],
  );

  // Signed out (no API key) → `refresh` bails before flipping `loading` off, so
  // the skeleton (initialized true) would spin forever. Show an honest
  // connect-first state instead — mirrors the other client-consuming views'
  // empty-connect prompt (TeamView was the only one without one).
  if (!client) {
    return (
      <div className="mx-auto flex h-full w-full max-w-3xl min-w-0 flex-col gap-6 overflow-y-auto p-6">
        <EmptyState
          title="Connect to manage your team"
          description="Add your API key in Settings to invite teammates and manage member roles."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl min-w-0 flex-col gap-6 overflow-y-auto p-6">
      {/* Page hero: gradient card + identity glow with an accent icon chip —
          matching the Command Center / Settings card language. */}
      <header className="relative overflow-hidden rounded-2xl border border-surface-divider bg-surface-raised p-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full opacity-40 blur-3xl"
          style={{
            background: 'radial-gradient(circle, rgb(var(--accent-rgb)/0.55), transparent 70%)',
          }}
        />
        <div className="relative flex items-start gap-4">
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent"
            aria-hidden="true"
          >
            <IconUsers />
          </span>
          <div className="min-w-0">
            <span className="section-label text-accent">Team</span>
            <h2 className="mt-0.5 text-2xl font-semibold tracking-tight text-ink-primary">Team</h2>
            <p className="mt-1 max-w-xl text-sm text-ink-secondary">
              Invite teammates to your account. Members sign in with their own login; admins can
              launch and manage your profiles.
            </p>
          </div>
        </div>
      </header>

      {/* Invite */}
      <Panel>
        <SectionHeader icon={<IconUserPlus />} title="Invite a teammate" />
        <div className="mt-4 flex flex-wrap items-center gap-2">
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
            className={`mt-3 rounded-md px-2.5 py-1.5 text-xs ${
              notice.tone === 'error'
                ? 'bg-status-error/10 text-status-error'
                : 'bg-status-ready/10 text-status-ready'
            }`}
          >
            {notice.text}
          </p>
        ) : null}
      </Panel>

      <div className="min-h-0 flex-1">
        {loading ? (
          <SkeletonRows rows={3} label="Loading your team…" />
        ) : loadError !== null ? (
          <Panel className="flex flex-col items-start gap-3">
            <SectionHeader icon={<IconAlert />} title="Couldn't load your team" />
            <p className="max-w-md text-sm text-ink-secondary">{loadError}</p>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover"
            >
              Try again
            </button>
          </Panel>
        ) : (
          <div className="flex flex-col gap-6">
            {invites.length > 0 ? (
              <Panel>
                <SectionHeader icon={<IconClock />} title="Pending invites" />
                <div className="mt-4 flex flex-col gap-2">
                  {invites.map((inv) => (
                    <div
                      key={inv.id}
                      className="flex items-center justify-between rounded-lg border border-dashed border-surface-divider bg-surface-inset px-3 py-2"
                    >
                      <span className="truncate text-sm text-ink-primary">{inv.invitee_email}</span>
                      <span className="text-[11px] uppercase tracking-wide text-ink-muted">
                        {inv.role} · pending
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>
            ) : null}

            <Panel>
              <SectionHeader icon={<IconUsers />} title="Members" />
              <div className="mt-4">
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
                        className="flex items-center justify-between gap-2 rounded-lg border border-surface-divider bg-surface-inset px-3 py-2"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-raised text-sm font-semibold text-ink-secondary"
                            aria-hidden="true"
                          >
                            {memberMonogram(m.member_email)}
                          </span>
                          <div className="min-w-0">
                            <div className="truncate text-sm text-ink-primary">
                              {m.member_email}
                            </div>
                            <div className="text-[11px] uppercase tracking-wide text-ink-muted">
                              {m.role}
                            </div>
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
              </div>
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

// First letter of the member's email, for the avatar monogram chip; '?' when
// blank. Pure presentation — does not alter the displayed email itself.
function memberMonogram(email: string): string {
  const ch = email.trim().charAt(0);
  return ch === '' ? '?' : ch.toUpperCase();
}

// Console-style sectioned panel — a rounded, hairline-bordered raised card,
// matching the Command Center / Settings card language.
function Panel({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <section
      className={`rounded-xl border border-surface-divider bg-surface-raised px-5 py-4 shadow-sm ${
        className ?? ''
      }`}
    >
      {children}
    </section>
  );
}

// Icon-led card header — an icon chip + a section label (mirrors the Settings
// view's SectionHeader idiom so the page reads with one consistent rhythm).
function SectionHeader({ icon, title }: { icon: ReactNode; title: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-inset text-ink-secondary"
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="section-label">{title}</span>
    </div>
  );
}

// ─── icons (Lucide-shape, inline, no dependency) — matches CommandCenterView ──
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
function IconUsers(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="17" height="17" {...stroke}>
      <circle cx="6" cy="5" r="2.25" />
      <path d="M2 13.25c0-2.2 1.79-3.75 4-3.75s4 1.55 4 3.75" />
      <path d="M10.75 3.4a2.25 2.25 0 0 1 0 4.2M11.25 9.7c1.6.34 2.75 1.66 2.75 3.55" />
    </svg>
  );
}
function IconUserPlus(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <circle cx="6" cy="5" r="2.25" />
      <path d="M2 13.25c0-2.2 1.79-3.75 4-3.75 1.07 0 2.04.36 2.75.96" />
      <path d="M12 8.75v3.5M10.25 10.5h3.5" />
    </svg>
  );
}
function IconClock(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  );
}
function IconAlert(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <path d="M8 2 1.75 13.25h12.5Z" />
      <path d="M8 6.5v3M8 11.5h.01" />
    </svg>
  );
}
