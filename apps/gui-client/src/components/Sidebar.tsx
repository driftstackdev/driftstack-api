// Sidebar — primary nav chrome.
//
// 2026-05-21 — split out of App.tsx as part of the antidetect-style
// visual overhaul. Adds per-item icons (Lucide-shape inline SVG, no
// dependency) + live count badges driven by real data sources:
//   - Profiles X/Y   ← accountMe.profile_count / .profile_cap
//   - Proxies X      ← local proxies registry (settings.json store)
//   - Sessions X/Y   ← accountMe.concurrent_session_active / .cap
//   - Recordings X   ← RecordingsContext map size
//   - Team           ← accountMe.teams.length (only when ≥1)
//
// Brand stays slate-base + oxblood-accent; no translucent wallpaper
// (we're a dense ops tool, not a marketing surface). Inspiration is the
// information density + glanceable counts, not the visual style itself.

import { useEffect, useState, type ReactNode } from 'react';
import { useSettings } from '../lib/SettingsContext';
import { useRecordings } from '../lib/recordings';
import { isCloudBaseUrl } from '../lib/telemetry';
import { listProxies } from '../lib/proxies';

export type SidebarViewKind =
  | 'profiles'
  | 'proxies'
  | 'sessions-history'
  | 'recordings'
  | 'sessions'
  | 'connectivity'
  | 'fleet'
  | 'settings';

interface SidebarProps {
  current: SidebarViewKind;
  onNavigate: (kind: SidebarViewKind) => void;
  onSignOut: () => void;
}

export function Sidebar({ current, onNavigate, onSignOut }: SidebarProps): JSX.Element {
  const { settings, accountMe } = useSettings();
  const { recordings } = useRecordings();
  const signedIn = settings.apiKey !== null;
  const [proxyCount, setProxyCount] = useState<number | null>(null);

  // Local proxies live in the Tauri store, not the server. Poll lazily —
  // counts that drift one tick out of date are fine; they re-sync on the
  // next nav/render that triggers SettingsContext refresh.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listProxies();
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
  const sessionsActive = accountMe?.concurrent_session_active ?? null;
  const sessionsCap = accountMe?.concurrent_session_cap ?? null;
  const teamCount = accountMe?.teams.length ?? 0;
  const recordingsCount = recordings.size;

  return (
    <aside
      className="flex w-56 flex-col border-r border-surface-divider
                 bg-surface-raised/95 backdrop-blur-sm"
    >
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

      <SidebarSection label="Diagnostics">
        <SidebarItem
          icon={<IconActivity />}
          active={current === 'sessions'}
          onClick={() => onNavigate('sessions')}
          badge={fmtRatio(sessionsActive, sessionsCap)}
        >
          Raw sessions
        </SidebarItem>
        <SidebarItem
          icon={<IconPulse />}
          active={current === 'connectivity'}
          onClick={() => onNavigate('connectivity')}
        >
          Connectivity test
        </SidebarItem>
      </SidebarSection>

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
        {teamCount > 0 && (
          <SidebarItem icon={<IconUsers />} badge={String(teamCount)}>
            Team
          </SidebarItem>
        )}
        <SidebarItem
          icon={<IconCog />}
          active={current === 'settings'}
          onClick={() => onNavigate('settings')}
        >
          Settings
        </SidebarItem>
      </SidebarSection>

      {signedIn && (
        <div className="mt-auto flex flex-col gap-1 border-t border-surface-divider px-3 py-3">
          <div className="flex items-center gap-2 px-2 py-0.5">
            <TierDot tier={accountMe?.tier ?? null} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-xs text-ink-secondary">{accountMe?.email ?? '—'}</span>
              <span
                className="block truncate font-mono text-2xs text-ink-muted"
                title={settings.apiKey ?? undefined}
              >
                {settings.apiKey?.slice(0, 9) ?? ''}…{settings.apiKey?.slice(-6) ?? ''}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="flex w-full items-center justify-between rounded
                       bg-status-error/10 px-2 py-1.5 text-left text-xs
                       font-medium text-status-error transition
                       hover:bg-status-error/20"
          >
            <span>Sign out (forget key)</span>
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

function IconActivity(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <path d="M1.5 8h2.75l1.5-4.5 3 9 1.5-4.5h4.25" />
    </svg>
  );
}

function IconPulse(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <path d="M2 11.25c1.5-1.5 1.5-3 3-3s1.5 1.5 3 1.5 1.5-3 3-3 1.5 1.5 3 1.5" />
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
