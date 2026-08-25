// Sidebar — primary nav chrome.
//
// 2026-05-21 — split out of App.tsx as part of the operator-UI polish
// pass. Adds per-item icons (Lucide-shape inline SVG, no dependency) +
// live count badges driven by real data sources:
//   - Profiles X/Y   ← accountMe.profile_count / .profile_cap
//   - Proxies X      ← local proxies registry (settings.json store)
//   - Sessions X/Y   ← accountMe.concurrent_session_active / .cap
//   - Recordings X   ← RecordingsContext map size
//   - Team           ← accountMe.teams.length (only when ≥1)
//
// Brand identity stays Driftstack — slate-base + oxblood-accent + the
// Geist Sans / Berkeley Mono pair already locked in file 128. We are a
// dense ops tool, not a marketing surface; the glanceable density here
// is functional, not a stylistic borrow.

import { useEffect, useState, type ReactNode } from 'react';
import { useSettings } from '../lib/SettingsContext';
import { useRecordings } from '../lib/recordings';
import { isCloudBaseUrl } from '../lib/telemetry';
import { listProxyMetadata } from '../lib/proxies';
import { fetchActiveAgentSessionCount } from '../lib/active-agent-sessions';
import { teamWorkspaceLabel } from '../lib/team-label';

export type SidebarViewKind =
  | 'home'
  | 'ai'
  | 'recipes'
  | 'profiles'
  | 'proxies'
  | 'sessions-history'
  | 'recordings'
  | 'sessions'
  | 'connectivity'
  | 'fleet'
  | 'team'
  | 'billing'
  | 'settings';

interface SidebarProps {
  current: SidebarViewKind;
  onNavigate: (kind: SidebarViewKind) => void;
  onSignOut: () => void;
  /** Open the ⌘K command palette. Optional so the Sidebar renders unchanged
   *  anywhere a palette isn't wired (audit #42 — teaches the shortcut + gives
   *  mouse users a click path to the otherwise-hidden palette). */
  onOpenPalette?: () => void;
}

export function Sidebar({
  current,
  onNavigate,
  onSignOut,
  onOpenPalette,
}: SidebarProps): JSX.Element {
  const { settings, client, accountMe, activeWorkspace, setActiveWorkspace } = useSettings();
  const { recordings } = useRecordings();
  const signedIn = settings.apiKey !== null;
  const [proxyCount, setProxyCount] = useState<number | null>(null);
  // Consistency #5 — `accountMe.concurrent_session_active` is the SERVER's
  // driver-only count, so profile-launched AGENT sessions (the normal launch
  // path) never show in the "Active sessions" usage row. Fold the active agent
  // count in client-side so the row reflects every running phone. null = not
  // wired / fetch failed → don't adjust (never undercount, never overcount).
  const [activeAgentCount, setActiveAgentCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchActiveAgentSessionCount(client).then((n) => {
      if (!cancelled) setActiveAgentCount(n);
    });
    return () => {
      cancelled = true;
    };
    // Re-fetch on nav (cheap) + on workspace switch so the count tracks the
    // visible surface; accountMe is refreshed by the views that mutate sessions.
  }, [client, current, activeWorkspace]);

  // Local proxies live in the Tauri store, not the server. Poll lazily —
  // counts that drift one tick out of date are fine; they re-sync on the
  // next nav/render that triggers SettingsContext refresh.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listProxyMetadata();
        if (!cancelled) setProxyCount(list.length);
      } catch {
        if (!cancelled) setProxyCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current, settings.apiKey]);

  const profileCount = accountMe?.profile_count ?? null;
  const profileCap = accountMe?.profile_cap ?? null;
  const driverActive = accountMe?.concurrent_session_active ?? null;
  // Total active = driver sessions (server count) + active agent sessions
  // (folded in client-side). Disjoint id-spaces, so the sum never
  // double-counts. When either input is unknown (null) keep the other rather
  // than blanking the row.
  const sessionsActive =
    driverActive === null && activeAgentCount === null
      ? null
      : (driverActive ?? 0) + (activeAgentCount ?? 0);
  const sessionsCap = accountMe?.concurrent_session_cap ?? null;
  // `accountMe?.teams.length` only guards a null accountMe — a non-null /me with
  // teams missing (partial/legacy/malformed server response — the SDK does NO
  // shape validation, it casts the JSON) would throw "Cannot read properties of
  // undefined (reading 'length')" in THIS render. The Sidebar mounts OUTSIDE the
  // per-view ErrorBoundary, so that throw bubbles to RootErrorBoundary and blanks
  // the whole window with no recover path. Optional-chain teams too.
  const teamCount = accountMe?.teams?.length ?? 0;
  // Show the Team section to anyone who's a MEMBER of a team (teamCount>0) OR
  // is on a team-capable tier (so an owner can manage their team even before
  // adding members) — "if the user has access for Teams" (founder 2026-06-16).
  const tier = accountMe?.tier ?? null;
  const teamCapableTier =
    tier === 'team_manual' || tier === 'agency_manual' || tier === 'enterprise';
  const showTeam = teamCount > 0 || teamCapableTier;
  const planLabel =
    accountMe?.tier != null
      ? accountMe.tier.charAt(0).toUpperCase() + accountMe.tier.slice(1)
      : null;
  const recordingsCount = recordings.size;

  return (
    <aside
      className="flex w-56 flex-col border-r border-surface-divider
                 bg-surface-raised/95 backdrop-blur-sm"
    >
      {onOpenPalette !== undefined && (
        <button
          type="button"
          onClick={onOpenPalette}
          className="mx-2 mt-2 flex items-center justify-between rounded-md border border-surface-divider bg-surface-inset px-2.5 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-surface-divider hover:text-ink-primary"
        >
          <span className="flex items-center gap-2">
            <IconSearch />
            Search…
          </span>
          <span className="font-mono text-2xs text-ink-muted">⌘K</span>
        </button>
      )}
      {/* Scroll the nav sections when the window is short so the mt-auto
          account footer below stays pinned. min-h-0 is load-bearing: without
          it this flex child keeps min-height:auto and refuses to shrink,
          pushing the footer off-screen instead of letting the nav scroll. */}
      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <SidebarSection label="Home">
          <SidebarItem
            icon={<IconHome />}
            active={current === 'home'}
            onClick={() => onNavigate('home')}
          >
            Command center
          </SidebarItem>
        </SidebarSection>

        {/* 2026-06-15 — founder reversed the earlier "Automate above Browse"
          call: Profiles is the core surface, so Browse sits directly under
          Home and Automate moves below it. */}
        <SidebarSection label="Browse">
          <SidebarItem
            icon={<IconLayers />}
            active={current === 'profiles'}
            onClick={() => onNavigate('profiles')}
            badge={fmtRatio(profileCount, profileCap)}
          >
            Profiles
          </SidebarItem>
          <SidebarItem
            icon={<IconGlobe />}
            active={current === 'proxies'}
            onClick={() => onNavigate('proxies')}
            badge={proxyCount === null ? null : String(proxyCount)}
          >
            Proxies
          </SidebarItem>
        </SidebarSection>

        <SidebarSection label="Automate">
          <SidebarItem
            icon={<IconSparkle />}
            active={current === 'ai'}
            onClick={() => onNavigate('ai')}
          >
            AI Browser Automation
          </SidebarItem>
          <SidebarItem
            icon={<IconBook />}
            active={current === 'recipes'}
            onClick={() => onNavigate('recipes')}
          >
            Saved tasks
          </SidebarItem>
        </SidebarSection>

        <SidebarSection label="History">
          <SidebarItem
            icon={<IconList />}
            active={current === 'sessions-history'}
            onClick={() => onNavigate('sessions-history')}
          >
            Session log
          </SidebarItem>
          <SidebarItem
            icon={<IconFilm />}
            active={current === 'recordings'}
            onClick={() => onNavigate('recordings')}
            badge={recordingsCount > 0 ? String(recordingsCount) : null}
          >
            Recordings
          </SidebarItem>
        </SidebarSection>

        {/* The client-side console/error buffer is no longer a full-screen nav
          surface — it was a "Logs" page that looked like real session logs but
          only showed captured console output + errors. The floating DevLogPanel
          still exposes it for dev triage. 2026-06-19. */}
        {!isCloudBaseUrl(settings.baseUrl) && (
          <SidebarSection label="Cluster">
            <SidebarItem
              icon={<IconServer />}
              active={current === 'fleet'}
              onClick={() => onNavigate('fleet')}
            >
              Mac mini fleet
            </SidebarItem>
          </SidebarSection>
        )}

        <SidebarSection label="Account">
          {showTeam && (
            <SidebarItem
              icon={<IconUsers />}
              badge={teamCount > 0 ? String(teamCount) : null}
              active={current === 'team'}
              onClick={() => onNavigate('team')}
            >
              Team
            </SidebarItem>
          )}
          {/* Billing is the revenue / upgrade path — always on, no
              cloud/tier gate (a self-hosted customer pays + tops up too). */}
          <SidebarItem
            icon={<IconBilling />}
            active={current === 'billing'}
            onClick={() => onNavigate('billing')}
          >
            Billing
          </SidebarItem>
          <SidebarItem
            icon={<IconCog />}
            active={current === 'settings'}
            onClick={() => onNavigate('settings')}
          >
            Settings
          </SidebarItem>
        </SidebarSection>
      </nav>

      {signedIn && (
        <div className="mt-auto flex flex-col gap-2 border-t border-surface-divider px-3 py-3">
          {/* Account: email + plan (no raw API key / base URL — kept friendly). */}
          <div className="flex items-center gap-2 px-1">
            <TierDot tier={accountMe?.tier ?? null} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-xs text-ink-secondary">{accountMe?.email ?? '—'}</span>
              {planLabel !== null && (
                <span className="text-2xs text-ink-muted">{planLabel} plan</span>
              )}
            </div>
          </div>
          {/* Workspace switcher — only for members of >=1 team. Switching sets
              the SDK effectiveAccount (SettingsContext.activeWorkspace), which
              re-scopes every read/write to that team's workspace; Personal =
              null. account.me() ignores the effective-account header, so this
              list (the caller's own memberships) stays stable across switches. */}
          {accountMe !== null && (accountMe.teams?.length ?? 0) > 0 && (
            <label className="flex flex-col gap-1 px-1">
              <span className="text-2xs text-ink-muted">Workspace</span>
              <select
                data-tauri-no-drag
                aria-label="Active workspace"
                value={activeWorkspace ?? ''}
                onChange={(e) => setActiveWorkspace(e.target.value === '' ? null : e.target.value)}
                className="rounded border border-surface-divider bg-surface-inset px-1.5 py-1 text-xs text-ink-secondary"
              >
                <option value="">Personal</option>
                {(accountMe.teams ?? []).map((t) => (
                  <option key={t.membership_id} value={t.owner_account_id}>
                    {teamWorkspaceLabel(t)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {/* Usage at a glance — what's left, not jargon. */}
          <div className="flex flex-col gap-1 rounded-md bg-surface-inset px-2 py-1.5">
            <UsageRow label="Profiles" value={profileCount} cap={profileCap} />
            <UsageRow label="Active sessions" value={sessionsActive} cap={sessionsCap} />
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="flex w-full items-center justify-between rounded
                       bg-status-error/10 px-2 py-1.5 text-left text-xs
                       font-medium text-status-error transition
                       hover:bg-status-error/20"
          >
            <span>Sign out</span>
            <span className="text-2xs opacity-70">⌘⇧L</span>
          </button>
        </div>
      )}
    </aside>
  );
}

function SidebarSection({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-px py-2">
      <div className="px-3 py-1">
        <span className="section-label">{label}</span>
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

interface SidebarItemProps {
  children: ReactNode;
  icon?: ReactNode;
  badge?: string | null;
  active?: boolean;
  onClick?: () => void;
}

function SidebarItem({ children, icon, badge, active, onClick }: SidebarItemProps): JSX.Element {
  const isInteractive = onClick !== undefined;
  return (
    <button
      type="button"
      data-tauri-no-drag
      onClick={onClick}
      disabled={!isInteractive}
      aria-current={active === true ? 'page' : undefined}
      className={
        'group flex items-center gap-2 px-3 py-1 text-sm text-left transition-colors ' +
        (active === true
          ? 'bg-accent-subtle text-ink-primary'
          : 'text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary ' +
            'disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-ink-secondary')
      }
    >
      {icon !== undefined && (
        <span
          className={
            'flex h-4 w-4 shrink-0 items-center justify-center ' +
            (active === true ? 'text-accent' : 'text-ink-muted group-hover:text-ink-secondary')
          }
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <span className="flex-1 truncate">{children}</span>
      {badge !== null && badge !== undefined && badge.length > 0 && (
        <span
          className={
            'shrink-0 rounded px-1.5 py-px font-mono text-2xs ' +
            (active === true
              ? 'bg-accent/20 text-accent'
              : 'bg-surface-elevated text-ink-muted group-hover:text-ink-secondary')
          }
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function fmtRatio(value: number | null, cap: number | null): string | null {
  if (value === null) return null;
  if (cap === null) return String(value);
  return `${value}/${cap}`;
}

function UsageRow({
  label,
  value,
  cap,
}: {
  label: string;
  value: number | null;
  cap: number | null;
}): JSX.Element {
  // null cap = no fixed limit (enterprise) → show the count + "unlimited".
  const text = value === null ? '—' : cap === null ? `${value} · unlimited` : `${value} / ${cap}`;
  return (
    <div className="flex items-center justify-between text-2xs">
      <span className="text-ink-muted">{label}</span>
      <span className="mono text-ink-secondary">{text}</span>
    </div>
  );
}

function TierDot({ tier }: { tier: string | null }): JSX.Element {
  // Tier → dot color. starter=idle, builder=ready, scale=busy.
  // Defensive default for unknown tiers (forwards-compat with future tiers).
  const cls =
    tier === 'scale' || tier === 'enterprise'
      ? 'bg-accent'
      : tier === 'builder'
        ? 'bg-status-ready'
        : tier === 'starter'
          ? 'bg-status-busy'
          : 'bg-status-idle';
  return <span className={`status-pip h-2 w-2 ${cls}`} title={tier ?? 'unknown tier'} />;
}

// ─── icons (Lucide-shape, 14px stroke, no dependency) ─────────────

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function IconSearch(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  );
}
function IconHome(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <path d="M2.5 7 8 2.5 13.5 7" />
      <path d="M3.75 6v7.5h8.5V6" />
      <path d="M6.5 13.5v-4h3v4" />
    </svg>
  );
}

function IconSparkle(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <path d="M8 1.75 9.4 5.6 13.25 7 9.4 8.4 8 12.25 6.6 8.4 2.75 7 6.6 5.6Z" />
      <path d="M12.75 11.25v2.5M11.5 12.5h2.5" />
    </svg>
  );
}

function IconBook(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <path d="M2.75 3.25A1.25 1.25 0 0 1 4 2h8.25v10.5H4a1.25 1.25 0 0 0-1.25 1.25Z" />
      <path d="M2.75 12.75A1.25 1.25 0 0 1 4 14h8.25" />
    </svg>
  );
}

function IconLayers(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <path d="M8 2 1.5 5.25 8 8.5l6.5-3.25Z" />
      <path d="M1.5 8 8 11.25 14.5 8" />
      <path d="M1.5 10.75 8 14l6.5-3.25" />
    </svg>
  );
}

function IconGlobe(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M2.25 8h11.5" />
      <path d="M8 2.25c1.7 2 2.5 4 2.5 5.75S9.7 12 8 13.75C6.3 11.75 5.5 9.75 5.5 8s.8-3.75 2.5-5.75Z" />
    </svg>
  );
}

function IconList(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <path d="M4.5 4.25h8M4.5 8h8M4.5 11.75h8" />
      <circle cx="2.25" cy="4.25" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="2.25" cy="8" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="2.25" cy="11.75" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconFilm(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.25" />
      <path d="M2.25 5.5h11.5M2.25 10.5h11.5M5.5 2.25v11.5M10.5 2.25v11.5" />
    </svg>
  );
}

function IconServer(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <rect x="2.25" y="3" width="11.5" height="4" rx="1" />
      <rect x="2.25" y="9" width="11.5" height="4" rx="1" />
      <path d="M4.5 5h.01M4.5 11h.01" />
    </svg>
  );
}

function IconUsers(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <circle cx="6" cy="6" r="2.25" />
      <path d="M2 13c.5-2 2-3 4-3s3.5 1 4 3" />
      <path d="M10.75 4.25a2 2 0 0 1 0 3.5" />
      <path d="M13.5 12.75c-.25-1.5-1-2.25-2.25-2.75" />
    </svg>
  );
}

function IconCog(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.75v1.5M8 12.75v1.5M3.75 3.75l1 1M11.25 11.25l1 1M1.75 8h1.5M12.75 8h1.5M3.75 12.25l1-1M11.25 4.75l1-1" />
    </svg>
  );
}

function IconBilling(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <rect x="2" y="3.5" width="12" height="9" rx="1.25" />
      <path d="M2 6.5h12" />
      <path d="M4.5 10h3" />
    </svg>
  );
}
