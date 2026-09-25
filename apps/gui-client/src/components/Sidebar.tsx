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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useSettings } from '../lib/SettingsContext';
import { useRecordings } from '../lib/recordings';
import { isCloudBaseUrl } from '../lib/telemetry';
import { tierLabelFor } from './TierBadge';
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

/**
 * The narrow tier of the redesign's sidebar (redesign round 1, 2026-09-21): in
 * a window 1060px wide or less it becomes a 56px icon rail. MEASURED on the
 * sidebar's own row with one ResizeObserver, not queried — the AI view's
 * reasoning (`views/agent-chat/use-view-width.ts`): `container-type` would make
 * the row a containing block for every `position: fixed` dialog below it, and
 * the harness renders the app in a fixed stage, not a window.
 */
export const SIDEBAR_RAIL_MAX_PX = 1060;

/** A row width of 0 is "not laid out yet" (and jsdom's only answer), never the
 *  narrowest window: an unmeasured sidebar keeps the full layout. */
export function sidebarIsRail(rowWidth: number): boolean {
  return rowWidth > 0 && rowWidth <= SIDEBAR_RAIL_MAX_PX;
}

function useRailTier(ref: RefObject<HTMLElement>): boolean {
  const [rail, setRail] = useState(false);
  useLayoutEffect(() => {
    const row = ref.current?.parentElement;
    if (row === null || row === undefined || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => setRail(sidebarIsRail(row.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [ref]);
  return rail;
}

/**
 * How much vertical room the nav's rhythm spends, from the most to the least.
 *   roomy  — the full layout: group labels, 30px rows (32 in the rail);
 *   tight  — the same layout at 26px rows (28 in the rail) and closer groups;
 *   folded — `tight`, with the group labels ("Browse", "Automate" …) folded
 *            into hairline dividers; each group keeps its name for a screen
 *            reader.
 */
export type SidebarDensity = 'roomy' | 'tight' | 'folded';
const DENSITIES: readonly SidebarDensity[] = ['roomy', 'tight', 'folded'];

/**
 * The SHORT-WINDOW tiers (gui-v0.1.72 follow-up, 2026-09-25): at full width in a
 * 1061×700 window the nav scrolled and Settings sat below the fold — a
 * destination you cannot see is one you do not know exists. When a layout does
 * not fit the height the nav is given, the next denser one is used, which puts
 * every destination on screen down to a 1060×640 window and below (measured in
 * the harness, both width tiers, with the account footer — plan, figures,
 * Sign out — kept whole): `tight` at 1061×700, `folded` at 1061×640.
 *
 * MEASURED, not queried: the nav is `flex-1 min-h-0`, so its clientHeight is the
 * room it is given whatever it holds, and its scrollHeight is what the layout on
 * screen needs. The sidebar height each layout needed is remembered when it is
 * given up, and it comes back only once the sidebar is that tall again — so two
 * layouts can never take turns. Re-measured on every render too, because the destinations can change
 * (Team, Your servers) without the box changing size. A nav that is not laid out
 * (0 — jsdom) keeps the roomy layout.
 */
function useSidebarDensity(navRef: RefObject<HTMLElement>, rail: boolean): SidebarDensity {
  const [level, setLevel] = useState(0);
  const levelRef = useRef(0);
  /** The sidebar height each layout needed, the last time it overflowed. */
  const need = useRef<number[]>([0, 0, 0]);
  const measure = useCallback(() => {
    const nav = navRef.current;
    if (nav === null) return;
    // Only a layout that is ON SCREEN can be measured: until the render of the
    // density just chosen has landed, the box still holds the previous one, and
    // measuring it again would step twice on one reading.
    if (nav.parentElement?.getAttribute('data-sidebar-density') !== DENSITIES[levelRef.current]) {
      return;
    }
    const room = nav.clientHeight;
    if (room <= 0) return;
    // Kept as the SIDEBAR's height, not the nav's: that is the one number no
    // density changes, so "the room for that layout is back" compares like with
    // like however the footer or the search row may one day be sized.
    const total = nav.parentElement?.clientHeight ?? 0;
    let next = levelRef.current;
    if (nav.scrollHeight > room + 1 && next < DENSITIES.length - 1) {
      need.current[next] = total + (nav.scrollHeight - room);
      next += 1;
    } else if (next > 0 && total >= (need.current[next - 1] ?? 0)) {
      next -= 1;
    }
    if (next !== levelRef.current) {
      levelRef.current = next;
      setLevel(next);
    }
  }, [navRef]);
  // A change of width tier is a different set of layouts: measure them afresh.
  useLayoutEffect(() => {
    levelRef.current = 0;
    need.current = [0, 0, 0];
    setLevel(0);
  }, [rail]);
  useLayoutEffect(() => {
    measure();
  });
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (nav === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(nav);
    return () => observer.disconnect();
  }, [navRef, measure]);
  return DENSITIES[level] ?? 'roomy';
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
  const planLabel = accountMe?.tier != null ? tierLabelFor(accountMe.tier) : null;
  const recordingsCount = recordings.size;
  const asideRef = useRef<HTMLElement>(null);
  const rail = useRailTier(asideRef);
  const navRef = useRef<HTMLElement>(null);
  const density = useSidebarDensity(navRef, rail);
  /** Any rhythm tighter than the roomy one. */
  const short = density !== 'roomy';
  const workspaceName =
    activeWorkspace === null
      ? 'Personal'
      : (() => {
          const team = (accountMe?.teams ?? []).find((t) => t.owner_account_id === activeWorkspace);
          return team === undefined ? 'Team' : teamWorkspaceLabel(team);
        })();

  return (
    <aside
      ref={asideRef}
      data-sidebar-tier={rail ? 'rail' : 'full'}
      data-sidebar-density={density}
      className={
        'flex shrink-0 flex-col overflow-hidden border-r border-surface-divider bg-surface-raised/55 py-3 ' +
        (rail ? 'w-[60px] items-center px-2' : 'w-[216px] px-2.5')
      }
    >
      {onOpenPalette !== undefined && (
        <button
          type="button"
          data-tauri-no-drag
          onClick={onOpenPalette}
          title={rail ? 'Search (⌘K)' : undefined}
          className={
            'flex h-[30px] shrink-0 items-center gap-2 rounded-[7px] bg-surface-inset text-xs text-ink-muted shadow-[inset_0_0_0_1px_rgb(var(--surface-divider-rgb)/0.7)] transition-colors hover:text-ink-primary ' +
            'mb-3.5 ' +
            (rail ? 'w-[34px] justify-center' : 'w-full px-[9px]')
          }
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
            <IconSearch />
          </span>
          <span className={rail ? 'sr-only' : undefined}>Search…</span>
          {!rail && <span className="ml-auto font-mono text-[10px]">⌘K</span>}
        </button>
      )}
      {/* Scroll the nav sections when the window is short so the account
          footer below stays pinned. min-h-0 is load-bearing: without it this
          flex child keeps min-height:auto and refuses to shrink, pushing the
          footer off-screen instead of letting the nav scroll. */}
      <nav
        ref={navRef}
        aria-label="Primary"
        className={
          'flex min-h-0 flex-1 flex-col overflow-y-auto ' + (rail ? 'w-full items-center' : '')
        }
      >
        <SidebarSection label="Home" rail={rail} density={density}>
          <SidebarItem
            rail={rail}
            short={short}
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
        <SidebarSection label="Browse" rail={rail} density={density}>
          <SidebarItem
            rail={rail}
            short={short}
            icon={<IconLayers />}
            active={current === 'profiles'}
            onClick={() => onNavigate('profiles')}
            badge={fmtRatio(profileCount, profileCap)}
          >
            Profiles
          </SidebarItem>
          <SidebarItem
            rail={rail}
            short={short}
            icon={<IconGlobe />}
            active={current === 'proxies'}
            onClick={() => onNavigate('proxies')}
            badge={proxyCount === null ? null : String(proxyCount)}
          >
            Proxies
          </SidebarItem>
        </SidebarSection>

        <SidebarSection label="Automate" rail={rail} density={density}>
          <SidebarItem
            rail={rail}
            short={short}
            icon={<IconSparkle />}
            active={current === 'ai'}
            onClick={() => onNavigate('ai')}
          >
            AI Browser Automation
          </SidebarItem>
          <SidebarItem
            rail={rail}
            short={short}
            icon={<IconBook />}
            active={current === 'recipes'}
            onClick={() => onNavigate('recipes')}
          >
            Saved tasks
          </SidebarItem>
        </SidebarSection>

        <SidebarSection label="History" rail={rail} density={density}>
          <SidebarItem
            rail={rail}
            short={short}
            icon={<IconList />}
            active={current === 'sessions-history'}
            onClick={() => onNavigate('sessions-history')}
          >
            Session log
          </SidebarItem>
          <SidebarItem
            rail={rail}
            short={short}
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
          <SidebarSection label="Self-hosted" rail={rail} density={density}>
            <SidebarItem
              rail={rail}
              short={short}
              icon={<IconServer />}
              active={current === 'fleet'}
              onClick={() => onNavigate('fleet')}
            >
              Your servers
            </SidebarItem>
          </SidebarSection>
        )}

        <SidebarSection label="Account" rail={rail} density={density}>
          {showTeam && (
            <SidebarItem
              rail={rail}
              short={short}
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
            rail={rail}
            short={short}
            icon={<IconBilling />}
            active={current === 'billing'}
            onClick={() => onNavigate('billing')}
          >
            Billing
          </SidebarItem>
          <SidebarItem
            rail={rail}
            short={short}
            icon={<IconCog />}
            active={current === 'settings'}
            onClick={() => onNavigate('settings')}
          >
            Settings
          </SidebarItem>
        </SidebarSection>
      </nav>

      {signedIn && (
        <div
          className={
            'mt-auto flex shrink-0 flex-col border-t border-surface-divider/80 ' +
            (rail
              ? 'w-full items-center gap-1.5 pt-2.5'
              : 'gap-2 pt-2.5 text-[11.5px] text-ink-muted')
          }
        >
          {!rail && (
            <>
              {/* Account: email + plan (no raw API key / base URL — kept friendly). */}
              <div className="flex min-w-0 flex-col">
                <span
                  className="truncate text-xs font-semibold text-ink-primary"
                  title={accountMe?.email ?? undefined}
                >
                  {accountMe?.email ?? '—'}
                </span>
                {planLabel !== null && <span>{planLabel} plan</span>}
              </div>
            </>
          )}
          {/* Workspace switcher — only for members of >=1 team. Switching sets
              the SDK effectiveAccount (SettingsContext.activeWorkspace), which
              re-scopes every read/write to that team's workspace; Personal =
              null. account.me() ignores the effective-account header, so this
              list (the caller's own memberships) stays stable across switches.
              In the rail it is the same native select laid over a team icon:
              the menu it opens still names every workspace in full. */}
          {accountMe !== null && (accountMe.teams?.length ?? 0) > 0 && (
            <label
              className={
                rail
                  ? 'relative flex h-8 w-11 cursor-pointer items-center justify-center rounded-[7px] text-ink-secondary hover:bg-surface-elevated'
                  : 'flex flex-col gap-1'
              }
              title={rail ? `Workspace: ${workspaceName}` : undefined}
            >
              {rail ? (
                <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">
                  <IconUsers />
                </span>
              ) : (
                <span className="text-2xs text-ink-muted">Workspace</span>
              )}
              <select
                data-tauri-no-drag
                aria-label="Active workspace"
                value={activeWorkspace ?? ''}
                onChange={(e) => setActiveWorkspace(e.target.value === '' ? null : e.target.value)}
                // In the rail the select is the click target and its text is
                // deliberately invisible (the icon is what shows); the
                // contrast gate is told so rather than measuring a 1:1 run.
                {...(rail ? { 'data-contrast-decorative': 'true' } : {})}
                className={
                  rail
                    ? 'absolute inset-0 cursor-pointer opacity-0'
                    : 'rounded border border-surface-divider bg-surface-inset px-1.5 py-1 text-xs text-ink-secondary'
                }
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
          {!rail && (
            /* Usage at a glance — what's left, not jargon. */
            <div className="flex justify-between gap-2">
              <UsageStat label="Profiles" value={profileCount} cap={profileCap} />
              <UsageStat label="Sessions" value={sessionsActive} cap={sessionsCap} />
            </div>
          )}
          <button
            type="button"
            data-tauri-no-drag
            onClick={onSignOut}
            aria-label={rail ? 'Sign out' : undefined}
            title={rail ? 'Sign out (⌘⇧L)' : undefined}
            className={
              rail
                ? 'flex h-8 w-11 items-center justify-center rounded-[7px] text-status-error transition hover:bg-status-error/10'
                : `flex w-full items-center justify-between rounded
                       bg-status-error/10 px-2 py-1.5 text-left text-xs
                       font-medium text-status-error transition
                       hover:bg-status-error/10`
            }
          >
            {rail ? (
              <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">
                <IconSignOut />
              </span>
            ) : (
              <>
                <span>Sign out</span>
                {/* 2026-09-12 (review) — no opacity on the hint: `opacity-70` faded the
                    10px shortcut to 3.02:1 (dark) / 3.16 (light) on the sign-out wash,
                    under the 4.5 it needs, and the text-quality gate only learned to
                    see opacity in the same change. At the button's own status-error
                    ink it reads 4.66 / 5.37. */}
                <span className="text-2xs">⌘⇧L</span>
              </>
            )}
          </button>
        </div>
      )}
    </aside>
  );
}

/**
 * ⛔ `transition-none` on every box whose GEOMETRY a density changes (the group,
 * its label; the rows carry `transition-colors`, which already leaves padding
 * alone). Nothing here sets a transition, so the property is the default `all` —
 * and under reduced motion index.css gives every element a 0.01ms duration, so a
 * margin that changed with the density was still its OLD value when the density
 * hook measured the new layout in the same frame: `tight` read 36px taller than
 * it is and was skipped for `folded` at 1061×680 (measured in the harness).
 */
function SidebarSection({
  label,
  rail,
  density = 'roomy',
  children,
}: {
  label: string;
  rail: boolean;
  /** See `SidebarDensity`: `tight` closes the gaps, `folded` also folds the
   *  label into a hairline divider (the group keeps its name for a screen
   *  reader). */
  density?: SidebarDensity;
  children: ReactNode;
}): JSX.Element {
  if (density === 'folded') {
    return (
      <div
        role="group"
        aria-label={label}
        data-sidebar-section={label}
        className={
          'mb-1 flex flex-col gap-px border-t border-surface-divider/70 pt-1 transition-none first:border-t-0 first:pt-0 ' +
          (rail ? 'w-full items-center' : '')
        }
      >
        {children}
      </div>
    );
  }
  const tight = density === 'tight';
  return (
    <div
      data-sidebar-section={label}
      className={
        (tight ? 'mb-2 ' : 'mb-3 ') +
        'flex flex-col gap-px transition-none ' +
        (rail ? 'w-full items-center' : '')
      }
    >
      {!rail && (
        <span
          className={
            'block px-2 text-[10px] font-semibold uppercase leading-3 tracking-[0.09em] text-ink-muted transition-none ' +
            (tight ? 'pb-1' : 'pb-1.5')
          }
        >
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

interface SidebarItemProps {
  children: string;
  icon?: ReactNode;
  badge?: string | null;
  active?: boolean;
  onClick?: () => void;
  /** The narrow tier: icon only, the label kept for screen readers and as a
   *  tooltip, the count pinned to the icon's corner. */
  rail?: boolean;
  /** Any density tighter than roomy: 4px less height a row (26 / 28 in the rail). */
  short?: boolean;
}

function SidebarItem({
  children,
  icon,
  badge,
  active,
  onClick,
  rail = false,
  short = false,
}: SidebarItemProps): JSX.Element {
  const isInteractive = onClick !== undefined;
  const hasBadge = badge !== null && badge !== undefined && badge.length > 0;
  return (
    <button
      type="button"
      data-tauri-no-drag
      onClick={onClick}
      disabled={!isInteractive}
      aria-current={active === true ? 'page' : undefined}
      title={rail ? (hasBadge ? `${children} (${badge})` : children) : undefined}
      // In the rail the pinned count is the first figure only, so the button
      // names the whole badge itself.
      aria-label={rail && hasBadge ? `${children} ${badge}` : undefined}
      className={
        'group relative flex items-center rounded-[7px] text-left text-[12.5px] leading-4 transition-colors ' +
        (rail
          ? `${short ? 'h-7' : 'h-8'} w-11 justify-center `
          : `w-full gap-2.5 whitespace-nowrap px-2 ${short ? 'py-[5px]' : 'py-[7px]'} `) +
        (active === true
          ? 'bg-accent-subtle font-semibold text-ink-primary'
          : 'text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary ' +
            'disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-ink-secondary')
      }
    >
      {icon !== undefined && (
        <span
          className={
            'flex h-4 w-4 shrink-0 items-center justify-center ' +
            (active === true
              ? 'text-accent'
              : 'text-ink-muted opacity-[.85] group-hover:text-ink-secondary')
          }
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <span className={rail ? 'sr-only' : 'flex-1 truncate'}>{children}</span>
      {hasBadge && (
        <span
          aria-hidden={rail ? 'true' : undefined}
          className={
            'shrink-0 rounded-full py-px font-semibold ' +
            // In the rail the count sits on the icon's top-right corner, as the
            // mockup's narrow tier draws it, and stays inside the 56px rail.
            (rail
              ? 'pointer-events-none absolute right-0 top-0 px-1 text-[9px] leading-[12px] '
              : 'ml-auto px-1.5 text-[10px] leading-[14px] ') +
            (active === true
              ? 'bg-accent/[.18] text-accent-text'
              : 'bg-surface-elevated text-ink-secondary')
          }
        >
          {rail ? railFigure(badge) : badge}
        </span>
      )}
    </button>
  );
}

/** The rail has room on the icon's corner for one figure: the count, not the
 *  cap ("8/10" → "8"). The whole badge stays in the title and the name. */
function railFigure(badge: string): string {
  return badge.split('/')[0] ?? badge;
}

function fmtRatio(value: number | null, cap: number | null): string | null {
  if (value === null) return null;
  if (cap === null) return String(value);
  return `${value}/${cap}`;
}

function UsageStat({
  label,
  value,
  cap,
}: {
  label: string;
  value: number | null;
  cap: number | null;
}): JSX.Element {
  // null cap = no fixed limit (enterprise) → the count + "unlimited".
  // The figure is spaced ("8 / 10") so it never reads as the nav badge's.
  const figure = value === null ? '—' : cap === null ? `${value} · unlimited` : `${value} / ${cap}`;
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <b className="text-[12.5px] font-bold text-ink-primary">{figure}</b>
      <span>{label}</span>
    </span>
  );
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

function IconSignOut(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <path d="M6.5 2.75H3.75a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1H6.5" />
      <path d="M10.5 5.25 13.25 8l-2.75 2.75M13.25 8H6.25" />
    </svg>
  );
}
