// Command Center home — the overview the app leads with. Redesigned 2026-06-15
// (founder: the old version "looks cheap/ugly"): a gradient hero with an
// identity glow, a richer icon-led KPI strip (now the home for the fleet stats
// that used to sit on Profiles), and cleaner session-health / activity /
// quick-link sections.
//
// Composes from the already-loaded accountMe (SettingsContext, no extra fetch)
// plus four independent, gracefully-degrading loads (recent profiles, session
// health, recent activity, proxy count) — a slow/failed load never blocks or
// breaks the landing. Pure helpers (computeCapAlerts / summarizeSessions /
// formatAuditAction / sortRecentProfiles) are exported + unit-tested
// independently of the fetches.
//
// Actionable launchpad (founder 2026-06-19: the passive overview was "pretty
// useless"): a "Jump back in" recent-profiles strip sits right under the hero so
// the core action (get into a profile to launch it) is one click away, and the
// live "Running" affordances jump straight to the Sessions surface. Real launch
// lives in Profiles — the home navigates there, it never duplicates that path.

import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { useSettings } from '../lib/SettingsContext';
import { RelativeTime } from '../components/RelativeTime';
import { OnboardingChecklist } from '../components/OnboardingChecklist';
import {
  useOnboardingDismissed,
  useOnboardingCompleted,
  buildOnboardingSteps,
} from '../lib/use-onboarding-steps';
import { listProxyMetadata } from '../lib/proxies';
import { fetchActiveAgentSessionCount } from '../lib/active-agent-sessions';

export type HomeNavTarget = 'ai' | 'recipes' | 'profiles' | 'proxies' | 'sessions' | 'settings';

// Humanise an audit action key for the activity feed: 'profile.created' →
// 'Profile created', 'api_key.rotated' → 'Api key rotated'. Pure + exported so
// the formatting is unit-tested independently of the fetch.
export function formatAuditAction(action: string): string {
  const words = action.replace(/[._-]+/g, ' ').trim();
  if (words.length === 0) return 'Activity';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface ActivityEntry {
  id: string;
  action: string;
  actorType: string;
  timestamp: string;
}

// A profile reduced to what the "Jump back in" strip renders — same shape the
// SDK profiles.list() returns (id / name / last_used_at), trimmed to keep the
// pure sorter testable without the full Profile type or the fetch.
export interface RecentProfile {
  id: string;
  name: string;
  last_used_at: string | null;
}

// Most-recently-used first for the "Jump back in" strip; profiles that have
// never been used (last_used_at === null) sort last (a fresh profile is less
// useful as a "jump back in" target than one mid-flow). Ties (same timestamp,
// or both never-used) keep their incoming order via a stable sort. Pure +
// exported so the ordering is unit-tested independently of the fetch.
export function sortRecentProfiles(
  profiles: ReadonlyArray<RecentProfile>,
  limit: number,
): RecentProfile[] {
  const ranked = profiles
    .map((p, index) => ({
      p,
      index,
      ts: p.last_used_at !== null ? new Date(p.last_used_at).getTime() : Number.NaN,
    }))
    .sort((a, b) => {
      const aUsed = !Number.isNaN(a.ts);
      const bUsed = !Number.isNaN(b.ts);
      if (aUsed !== bUsed) return aUsed ? -1 : 1; // never-used sinks below used
      if (aUsed && bUsed && a.ts !== b.ts) return b.ts - a.ts; // newest first
      return a.index - b.index; // stable for ties / both never-used
    });
  return ranked.slice(0, Math.max(0, limit)).map((r) => r.p);
}

// First letter of the profile name, for the monogram chip; '?' when blank.
export function profileMonogram(name: unknown): string {
  // ⛔ TOTAL ON PURPOSE — it takes `unknown`, not `string`.
  //
  // This runs inside a render `.map()` over data that arrived from the network,
  // and the SDK does `JSON.parse(text) as T`: it CASTS, it never validates. So
  // the compile-time `name: string` is a promise about the server, not a fact
  // about this value. When it was typed `string` an absent name threw
  // "Cannot read properties of undefined (reading 'trim')" and took the ENTIRE
  // Command Center — the app's home page — to the fatal error boundary, needing
  // a reload. One missing string for a total page loss is a blast radius wildly
  // out of proportion to its cause.
  //
  // ⚠️ Not currently reachable through a CONFORMING server: `ProfileSchema` has
  // `name: z.string()`, required and non-nullable. This is defence in depth
  // against the gap between that guarantee and the unvalidated cast, which is
  // exactly the gap a rollback, a proxy, or a partial outage lands in.
  if (typeof name !== 'string') return '?';
  const ch = name.trim().charAt(0);
  return ch === '' ? '?' : ch.toUpperCase();
}

// Proactive cap alerts from accountMe — warn at ≥80% of a cap, error at/over it,
// so the operator sees a launch will be blocked BEFORE they try. Pure +
// exported for unit tests. profile_cap null = unlimited (enterprise) → no alert.
export interface CapAlert {
  id: string;
  tone: 'warn' | 'error';
  title: string;
  detail: string;
  target: HomeNavTarget;
  /** CTA label for the alert's action button. Absent → the button reads
   *  'Manage' (the neutral default), so existing shape assertions still hold.
   *  Set per-alert so the button verb matches the detail (e.g. "stop one to
   *  launch another" pairs with 'Stop a session', not a generic 'Manage'). */
  cta?: string;
}

interface CapAccount {
  concurrent_session_active: number;
  concurrent_session_cap: number;
  profile_count: number;
  profile_cap: number | null;
}

export function computeCapAlerts(account: CapAccount | null): CapAlert[] {
  if (account === null) return [];
  const alerts: CapAlert[] = [];
  const { concurrent_session_active: sa, concurrent_session_cap: sc } = account;
  if (sc > 0) {
    if (sa >= sc)
      alerts.push({
        id: 'sessions-at',
        tone: 'error',
        title: 'At your session limit',
        detail: `${sa} / ${sc} concurrent sessions in use — stop one to launch another.`,
        target: 'sessions',
        cta: 'Stop a session',
      });
    else if (sa / sc >= 0.8)
      alerts.push({
        id: 'sessions-near',
        tone: 'warn',
        title: 'Near your session limit',
        detail: `${sa} / ${sc} concurrent sessions in use.`,
        target: 'sessions',
        cta: 'View sessions',
      });
  }
  const { profile_count: pc, profile_cap: pcap } = account;
  if (pcap !== null && pcap > 0) {
    if (pc >= pcap)
      alerts.push({
        id: 'profiles-at',
        tone: 'error',
        title: 'At your profile limit',
        detail: `${pc} / ${pcap} profiles created.`,
        target: 'profiles',
        cta: 'View profiles',
      });
    else if (pc / pcap >= 0.8)
      alerts.push({
        id: 'profiles-near',
        tone: 'warn',
        title: 'Near your profile limit',
        detail: `${pc} / ${pcap} profiles created.`,
        target: 'profiles',
        cta: 'View profiles',
      });
  }
  return alerts;
}

// Session status taxonomy (api-types SessionStatusSchema). Grouped for the
// health strip: ready/busy = running, creating = spinning up, errored = needs
// attention, destroyed = done. Pure + exported so the rollup is unit-tested.
export type SessionLike = { status: string };
export interface SessionHealth {
  total: number;
  running: number; // ready + busy
  creating: number;
  errored: number;
  destroyed: number;
}

export function summarizeSessions(sessions: ReadonlyArray<SessionLike>): SessionHealth {
  const h: SessionHealth = { total: 0, running: 0, creating: 0, errored: 0, destroyed: 0 };
  for (const s of sessions) {
    h.total += 1;
    if (s.status === 'ready' || s.status === 'busy') h.running += 1;
    else if (s.status === 'creating') h.creating += 1;
    else if (s.status === 'errored') h.errored += 1;
    else if (s.status === 'destroyed') h.destroyed += 1;
  }
  return h;
}

type HealthState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; health: SessionHealth }
  | { kind: 'error' };

type ActivityState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; entries: ActivityEntry[] }
  | { kind: 'error' };

type RecentProfilesState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ready';
      profiles: RecentProfile[];
      freshness: 'fresh' | 'refreshing' | 'stale';
    }
  | { kind: 'error' };

const RECENT_PROFILES_LIMIT = 5;
const RECENT_PROFILES_CACHE_TTL_MS = 5 * 60 * 1000;
const RECENT_PROFILES_CACHE_MAX_SCOPES = 16;

interface RecentProfilesCacheEntry {
  cachedAt: number;
  profiles: RecentProfile[];
}

// Process-local on purpose: returning to Command Center should not repaint a
// skeleton for summaries loaded moments ago, but profile names do not need a
// durable browser-storage footprint. Effective account ids keep personal/team
// workspaces isolated; the small LRU-style cap bounds long-running app use.
const recentProfilesCache = new Map<string, RecentProfilesCacheEntry>();

function readRecentProfilesCache(scope: string, now = Date.now()): RecentProfile[] | null {
  const entry = recentProfilesCache.get(scope);
  if (entry === undefined) return null;
  if (now - entry.cachedAt > RECENT_PROFILES_CACHE_TTL_MS) {
    recentProfilesCache.delete(scope);
    return null;
  }
  recentProfilesCache.delete(scope);
  recentProfilesCache.set(scope, entry);
  return entry.profiles;
}

function writeRecentProfilesCache(scope: string, profiles: RecentProfile[]): void {
  recentProfilesCache.delete(scope);
  recentProfilesCache.set(scope, { cachedAt: Date.now(), profiles });
  while (recentProfilesCache.size > RECENT_PROFILES_CACHE_MAX_SCOPES) {
    const oldestScope = recentProfilesCache.keys().next().value;
    if (oldestScope === undefined) break;
    recentProfilesCache.delete(oldestScope);
  }
}

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function CommandCenterView({
  onNavigate,
  onOpenProfile,
}: {
  onNavigate: (kind: HomeNavTarget) => void;
  /** Open Profiles scoped to a specific profile (the "Jump back in" cards) —
   *  selects + scrolls to it instead of landing on the bare list. Omitted →
   *  the cards fall back to the bare Profiles list. */
  onOpenProfile?: (profileId: string) => void;
}): JSX.Element {
  const { settings, accountMe, client, refreshAccountMe, activeWorkspace } = useSettings();
  const { dismissed: onboardingDismissed, dismiss: dismissOnboarding } = useOnboardingDismissed();
  // First-time-only: once every step has been seen done, the card never comes
  // back — even after the live counts it reads drop again (session removed).
  // The account's own answer is folded in, so a fresh install of a customer
  // who finished elsewhere is closed by the same gate on its first paint.
  const { completed: onboardingCompleted, markCompleted: markOnboardingCompleted } =
    useOnboardingCompleted(accountMe);
  // Refresh accountMe when the home view mounts. The session-health rollup below
  // independently re-fetches on every mount, but accountMe (which drives the cap
  // alerts + the profile/Live-now KPIs) is otherwise only fetched on client change
  // → after a session ends elsewhere and you return home, the live tiles show the
  // fresh count while a stale "At your session limit" alert still renders. Keep
  // both in sync. (audit wn1ghalx1)
  useEffect(() => {
    void refreshAccountMe();
  }, [refreshAccountMe]);
  const profileCount = accountMe?.profile_count ?? null;
  const profileCap = accountMe?.profile_cap ?? null;
  const tier = accountMe?.tier ?? null;
  const hello = greeting(new Date().getHours());

  // Consistency #5 — fold profile-launched AGENT sessions into the "active
  // sessions" surfaces. `concurrent_session_active` is the server's driver-only
  // count, so a profile launch (which creates an `agt_` agent session with no
  // driver row) leaves the Active KPI + cap alerts + Running tile reading 0
  // while a phone runs. Agent and driver ids are disjoint, so adding the active
  // agent count never double-counts. null = unknown → don't adjust.
  const [activeAgentCount, setActiveAgentCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchActiveAgentSessionCount(client).then((n) => {
      if (!cancelled) setActiveAgentCount(n);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Adjust accountMe's concurrent count by the active agent sessions so the cap
  // alerts ("At/Near your session limit") fire against the REAL number of
  // running sessions, matching what the user launched.
  const accountForAlerts =
    accountMe !== null && activeAgentCount !== null
      ? {
          concurrent_session_active: accountMe.concurrent_session_active + activeAgentCount,
          concurrent_session_cap: accountMe.concurrent_session_cap,
          profile_count: accountMe.profile_count,
          profile_cap: accountMe.profile_cap,
        }
      : (accountMe ?? null);
  const capAlerts = computeCapAlerts(accountForAlerts);

  // Live session-health rollup — loads independently of (and after) the hero +
  // KPI so a slow/failed fetch never blocks or breaks the landing.
  const [health, setHealth] = useState<HealthState>({ kind: 'idle' });
  useEffect(() => {
    if (!client) {
      setHealth({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setHealth({ kind: 'loading' });
    client.sessions
      .list()
      .then((page) => {
        if (!cancelled) setHealth({ kind: 'ready', health: summarizeSessions(page.data) });
      })
      .catch(() => {
        if (!cancelled) setHealth({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Recent activity from the audit log — same independent-load contract.
  const [activity, setActivity] = useState<ActivityState>({ kind: 'idle' });
  useEffect(() => {
    if (!client) {
      setActivity({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setActivity({ kind: 'loading' });
    client.auditLog
      .list({ limit: 6 })
      .then((page) => {
        if (cancelled) return;
        const entries: ActivityEntry[] = page.data.map((e) => ({
          id: e.id,
          action: e.action,
          actorType: e.actor_type,
          timestamp: e.timestamp,
        }));
        setActivity({ kind: 'ready', entries });
      })
      .catch(() => {
        if (!cancelled) setActivity({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // "Jump back in" — the account's profiles, most-recently-used first. Same
  // independent-load contract as the other strips (a slow/failed fetch never
  // blocks or breaks the landing). Placed high because launching a profile is
  // the core action; the cards navigate into Profiles (the real launch surface).
  const recentProfilesScope = activeWorkspace ?? accountMe?.id ?? null;
  const [recentProfiles, setRecentProfiles] = useState<RecentProfilesState>(() => {
    if (!client) return { kind: 'idle' };
    const cached =
      recentProfilesScope !== null ? readRecentProfilesCache(recentProfilesScope) : null;
    return cached !== null
      ? { kind: 'ready', profiles: cached, freshness: 'refreshing' }
      : { kind: 'loading' };
  });
  useEffect(() => {
    if (!client) {
      setRecentProfiles({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    const cached =
      recentProfilesScope !== null ? readRecentProfilesCache(recentProfilesScope) : null;
    setRecentProfiles(
      cached !== null
        ? { kind: 'ready', profiles: cached, freshness: 'refreshing' }
        : { kind: 'loading' },
    );
    client.profiles
      .list()
      .then((page) => {
        if (cancelled) return;
        const profiles = sortRecentProfiles(
          // Coerced at the boundary, not trusted: the SDK casts the response
          // rather than parsing it, so a field the schema promises can still
          // arrive absent. Normalising here keeps every downstream consumer
          // total instead of each one re-guarding.
          page.data.map((p) => ({
            id: typeof p.id === 'string' ? p.id : '',
            name: typeof p.name === 'string' ? p.name : '',
            last_used_at: typeof p.last_used_at === 'string' ? p.last_used_at : null,
          })),
          RECENT_PROFILES_LIMIT,
        );
        if (recentProfilesScope !== null) writeRecentProfilesCache(recentProfilesScope, profiles);
        setRecentProfiles({ kind: 'ready', profiles, freshness: 'fresh' });
      })
      .catch(() => {
        if (cancelled) return;
        setRecentProfiles(
          cached !== null
            ? { kind: 'ready', profiles: cached, freshness: 'stale' }
            : { kind: 'error' },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [client, recentProfilesScope]);

  // Local proxy count (Tauri store) — for the fleet KPI moved here from
  // Profiles. Best-effort; absent → '—'.
  const [proxyCount, setProxyCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listProxyMetadata()
      .then((list) => {
        if (!cancelled) setProxyCount(list.length);
      })
      .catch(() => {
        if (!cancelled) setProxyCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Prefer the AUTHORITATIVE live count (server countActiveSessions: non-destroyed
  // + active statuses) over the session-health rollup, which only summarizes the
  // first page (≤50, createdAt-ordered, incl. destroyed) and so undercounts live
  // runs once an account has churned >50 sessions. (audit wn1ghalx1)
  // Consistency #5 — add the active agent sessions (profile launches) the
  // server's driver-only count omits, so the Active KPI matches reality.
  const driverLiveNow =
    accountMe?.concurrent_session_active ??
    (health.kind === 'ready' ? health.health.running : null);
  // A sum with an unknown operand is only a FACT when the known half already
  // settles it. Adding `?? 0` for the unknown half made "driver 0 + agents
  // unknown" print a confident "0" while a phone was running -- absent data
  // rendered as a measurement. So: both known -> the exact total; one known and
  // already non-zero -> a floor we can defend, shown as "3+"; otherwise unknown.
  const liveNowExact = driverLiveNow !== null && activeAgentCount !== null;
  const liveNowFloor = (driverLiveNow ?? 0) + (activeAgentCount ?? 0);
  const liveNow = liveNowExact ? liveNowFloor : liveNowFloor > 0 ? liveNowFloor : null;
  // The "Live now" KPI is a jump-off to live runs only when there's something to
  // jump to — a 0 (or unloaded) count stays a passive stat.
  const liveNowAction = liveNow !== null && liveNow > 0 ? () => onNavigate('sessions') : undefined;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      {/* Cap alerts — proactive, only when near/over a limit. */}
      {capAlerts.length > 0 && (
        <div className="flex flex-col gap-2" data-component="cap-alerts">
          {capAlerts.map((a) => (
            <div
              key={a.id}
              role={a.tone === 'error' ? 'alert' : 'status'}
              className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 ${
                a.tone === 'error'
                  ? 'border-status-error/50 bg-status-error/10'
                  : 'border-status-busy/50 bg-status-busy/10'
              }`}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-primary">{a.title}</p>
                <p className="truncate text-xs text-ink-secondary">{a.detail}</p>
              </div>
              <button
                type="button"
                className="btn-secondary shrink-0 px-3 py-1 text-xs"
                onClick={() => onNavigate(a.target)}
              >
                {a.cta ?? 'Manage'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Hero — gradient + identity glow; leads with Automate. */}
      <section className="relative overflow-hidden rounded-2xl border border-surface-divider bg-surface-raised p-6">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full opacity-40 blur-3xl"
          style={{
            background: 'radial-gradient(circle, rgb(var(--accent-rgb)/0.55), transparent 70%)',
          }}
        />
        <div className="relative flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="section-label text-accent">{hello}</span>
            <h1 className="text-2xl font-semibold tracking-tight text-ink-primary">
              What do you want to automate?
            </h1>
            <p className="max-w-xl text-sm text-ink-secondary">
              Describe a task in plain language and Driftstack plans &amp; runs it on a real iPhone
              profile — or replay one you saved.
            </p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white shadow-[0_3px_10px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.18)] transition-colors hover:bg-accent-hover"
              onClick={() => onNavigate('ai')}
            >
              <IconSparkle /> Ask Driftstack AI
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-surface-divider bg-surface-elevated px-4 py-2 text-sm font-medium text-ink-primary transition-colors hover:bg-surface-divider"
              onClick={() => onNavigate('recipes')}
            >
              <IconBook /> Saved tasks
            </button>
          </div>
        </div>
      </section>

      {/* Get-set-up checklist — the same first-run guidance Profiles shows, now
          also on the home so a new user sees the next step where they land (H2).
          Shared derive + dismissal via use-onboarding-steps; auto-hides once all
          three are done or the user dismisses it. */}
      {/* ⛔ `accountMe !== null` is load-bearing. The step predicates below read
          `accountMe?.profile_count ?? 0`, which turns UNKNOWN into "you have
          none" — so before accountMe loads, or if it fails, a customer with 25
          profiles is told to "Create a profile". The KPI strip two elements down
          renders the SAME field as "—" for exactly this case, so the page
          contradicted itself: one component said unknown, the other said
          incomplete. Same defect as accenting Active at 0 (V-2184) — a definite
          claim asserted from absent data. Rendering nothing until we know is the
          honest state; the checklist reappears the moment accountMe arrives.
          `!onboardingCompleted` keeps a finished checklist finished — the steps
          re-derive from live counts, so without it a removed session brought
          "Get set up" back (same gate as Profiles). */}
      {!onboardingDismissed && !onboardingCompleted && accountMe !== null && (
        <OnboardingChecklist
          steps={buildOnboardingSteps(
            {
              apiKeyPresent: settings.apiKey !== null,
              hasProfile: (accountMe?.profile_count ?? 0) > 0,
              // `activeAgentCount` is null while the agent-session count is
              // unloaded or its fetch failed. A driver session already running
              // settles the answer either way; otherwise an unknown count must
              // stay unknown, or a returning user is told they never launched.
              hasLiveSession:
                (accountMe?.concurrent_session_active ?? 0) > 0
                  ? true
                  : activeAgentCount === null
                    ? null
                    : activeAgentCount > 0,
            },
            { goConnect: () => onNavigate('settings'), goProfile: () => onNavigate('profiles') },
          )}
          onDismiss={dismissOnboarding}
          onCompleted={markOnboardingCompleted}
        />
      )}

      {/* Jump back in — recent profiles, most-recently-used first. Placed high
          because getting into a profile to launch it is the core action; each
          card navigates into Profiles (the real launch surface). */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="section-label">Jump back in</span>
          <button
            type="button"
            className="py-1 text-xs font-medium text-accent hover:underline"
            onClick={() => onNavigate('profiles')}
          >
            all profiles →
          </button>
        </div>
        {/* aria-live so SR users hear the loading → ready/error/empty transition. */}
        <div aria-live="polite">
          <RecentProfilesStrip
            state={recentProfiles}
            onOpen={() => onNavigate('profiles')}
            onOpenProfile={
              onOpenProfile !== undefined ? (id) => onOpenProfile(id) : () => onNavigate('profiles')
            }
          />
        </div>
      </section>

      {/* Fleet KPI strip — icon-led cards (moved here from Profiles). The
          Profiles/Active counts + the Plan tile come from account.me(), which
          (per the Sidebar contract) IGNORES the active-workspace header and so
          always reflects the PERSONAL account's caps — whereas the strips below
          ("Jump back in", "Session health") DO honor it. While viewing a team
          workspace those two scopes describe different numbers, so label this
          strip "Your account" to stop the personal caps reading as this team's
          counts (caps are per-account by design; there is no workspace-scoped
          authoritative count endpoint to swap in). */}
      <section className="flex flex-col gap-2">
        {activeWorkspace !== null && (
          <span className="section-label" data-component="account-kpi-label">
            Your account
          </span>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi
            icon={<IconLayers />}
            label="Profiles"
            value={ratio(profileCount, profileCap)}
            title={
              activeWorkspace !== null
                ? 'Profile cap is per your account, not per workspace.'
                : undefined
            }
          />
          <Kpi
            icon={<IconBolt />}
            // "Active" (not "Live now") matches the server's
            // concurrent_session_active semantics: ALL non-destroyed sessions
            // (creating + ready + busy + errored). The Session-health "Running"
            // tile below counts ready+busy only, so the two are different measures
            // by design — labeling this "Active" stops them reading as the same
            // number and visibly contradicting (audit: liveNow=3 vs Running=1).
            label="Active"
            value={liveNow !== null ? `${String(liveNow)}${liveNowExact ? '' : '+'}` : '—'}
            // ⛔ Conditional, not unconditional. This was a bare `accent`, so a
            // count of ZERO rendered in the live/ready colour — the page's
            // most-read number saying "running" while nothing was. Accent now
            // means there IS something live; nothing live reads neutral.
            accent={liveNow !== null && liveNow > 0}
            onClick={liveNowAction}
            title="Sessions counting against your concurrency cap — includes starting up and errored sessions, not just running ones."
          />
          <Kpi
            icon={<IconGlobe />}
            label="Proxies"
            value={proxyCount !== null ? String(proxyCount) : '—'}
          />
          <Kpi icon={<IconBadge />} label="Plan" value={tier !== null ? titleCase(tier) : '—'} />
        </div>
      </section>

      {/* Live session health — loads independently; degrades gracefully. */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="section-label">Session health</span>
          <button
            type="button"
            className="py-1 text-xs font-medium text-accent hover:underline"
            onClick={() => onNavigate('sessions')}
          >
            view all →
          </button>
        </div>
        {/* aria-live so SR users hear the loading → ready/error/empty transition. */}
        <div aria-live="polite">
          <SessionHealthStrip
            state={health}
            // Consistency #5 — the rollup summarizes driver sessions only; add
            // the active agent sessions (profile launches) so "Running"/"Total"
            // don't read 0 while a launched phone is live.
            extraRunning={activeAgentCount ?? 0}
            onViewLive={() => onNavigate('sessions')}
          />
        </div>
      </section>

      {/* Recent activity from the audit log — loads independently. */}
      <section className="flex flex-col gap-2">
        <span className="section-label">Recent activity</span>
        {/* aria-live so SR users hear the loading → ready/error/empty transition. */}
        <div aria-live="polite">
          <ActivityFeed state={activity} />
        </div>
      </section>

      {/* Quick links into the rest of the app. */}
      <section className="flex flex-col gap-2">
        <span className="section-label">Jump to</span>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          <QuickLink
            icon={<IconLayers />}
            label="Profiles"
            desc="Browse &amp; launch identities"
            onClick={() => onNavigate('profiles')}
          />
          <QuickLink
            icon={<IconGlobe />}
            label="Proxies"
            desc="SOCKS5 exits &amp; health"
            onClick={() => onNavigate('proxies')}
          />
          <QuickLink
            icon={<IconActivity />}
            label="Sessions"
            desc="Live &amp; recent runs"
            onClick={() => onNavigate('sessions')}
          />
        </div>
      </section>
    </div>
  );
}

function SessionHealthStrip({
  state,
  onViewLive,
  extraRunning = 0,
}: {
  state: HealthState;
  onViewLive: () => void;
  /** Active agent (profile-launched) sessions to fold into Running/Total — the
   *  driver-only rollup omits them (consistency #5). */
  extraRunning?: number;
}): JSX.Element {
  if (state.kind === 'idle') {
    return (
      <div className="rounded-xl border border-dashed border-surface-divider px-4 py-3 text-xs text-ink-muted">
        Connect your API key to see live session health.
      </div>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div
        role="status"
        aria-label="Loading session health"
        className="h-[64px] animate-pulse rounded-xl border border-surface-divider bg-surface-inset"
      />
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded-xl border border-surface-divider px-4 py-3 text-xs text-ink-muted">
        Couldn&rsquo;t load sessions right now.
      </div>
    );
  }
  const h = state.health;
  // Fold profile-launched agent sessions into Running/Total (consistency #5).
  const running = h.running + extraRunning;
  const total = h.total + extraRunning;
  if (total === 0) {
    return (
      <div className="rounded-xl border border-dashed border-surface-divider px-4 py-3 text-xs text-ink-muted">
        No sessions yet — launch a profile or ask the AI to start one.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {/* Running is the jump-off to live runs — clickable only when there's
          something live to view (a 0 stays a passive stat). */}
      <HealthTile
        label="Running"
        value={running}
        tone="ready"
        onClick={running > 0 ? onViewLive : undefined}
      />
      <HealthTile label="Creating" value={h.creating} tone="busy" />
      <HealthTile label="Errored" value={h.errored} tone={h.errored > 0 ? 'error' : 'muted'} />
      <HealthTile label="Total" value={total} tone="muted" />
    </div>
  );
}

function HealthTile({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  tone: 'ready' | 'busy' | 'error' | 'muted';
  onClick?: () => void;
}): JSX.Element {
  const valueCls =
    tone === 'ready'
      ? 'text-status-ready'
      : tone === 'busy'
        ? 'text-status-busy'
        : tone === 'error'
          ? 'text-status-error'
          : 'text-ink-primary';
  const body = (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="section-label">{label}</span>
        {onClick !== undefined && (
          <span className="section-label text-accent" aria-hidden="true">
            view live →
          </span>
        )}
      </span>
      <span className={`mono text-xl font-semibold tabular-nums ${valueCls}`}>{value}</span>
    </>
  );
  if (onClick !== undefined) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex cursor-pointer flex-col gap-0.5 rounded-xl border border-surface-divider bg-surface-raised px-4 py-3 text-left transition-colors hover:border-accent/50 hover:bg-surface-elevated hover:ring-1 hover:ring-accent/30"
      >
        {body}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-surface-divider bg-surface-raised px-4 py-3">
      {body}
    </div>
  );
}

function ActivityFeed({ state }: { state: ActivityState }): JSX.Element {
  if (state.kind === 'idle') {
    return (
      <div className="rounded-xl border border-dashed border-surface-divider px-4 py-3 text-xs text-ink-muted">
        Connect your API key to see recent account activity.
      </div>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div
        role="status"
        aria-label="Loading recent activity"
        className="h-[120px] animate-pulse rounded-xl border border-surface-divider bg-surface-inset"
      />
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded-xl border border-surface-divider px-4 py-3 text-xs text-ink-muted">
        Couldn&rsquo;t load recent activity right now.
      </div>
    );
  }
  if (state.entries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-surface-divider px-4 py-3 text-xs text-ink-muted">
        No activity yet — actions you take show up here.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-surface-divider overflow-hidden rounded-xl border border-surface-divider bg-surface-raised">
      {state.entries.map((e) => (
        <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                e.actorType === 'system'
                  ? 'bg-status-busy'
                  : e.actorType === 'staff'
                    ? 'bg-accent'
                    : 'bg-status-ready'
              }`}
              aria-hidden="true"
            />
            <span className="truncate text-sm text-ink-primary">{formatAuditAction(e.action)}</span>
          </div>
          <span className="shrink-0 text-2xs text-ink-muted">
            <RelativeTime iso={e.timestamp} tooltipPrefix="At" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function RecentProfilesStrip({
  state,
  onOpen,
  onOpenProfile,
}: {
  state: RecentProfilesState;
  /** Bare Profiles navigation — used by the idle/empty placeholders where there
   *  is no specific profile to open. */
  onOpen: () => void;
  /** Open a SPECIFIC profile (deep-link) — each populated card calls this with
   *  its id so the card lands on that profile, not the bare list. */
  onOpenProfile: (id: string) => void;
}): JSX.Element {
  if (state.kind === 'idle') {
    return (
      <div className="rounded-xl border border-dashed border-surface-divider px-4 py-3 text-xs text-ink-muted">
        Connect your API key to jump back into a profile.
      </div>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div
        role="status"
        aria-label="Loading recent profiles"
        className="h-[72px] animate-pulse rounded-xl border border-surface-divider bg-surface-inset"
      />
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded-xl border border-surface-divider px-4 py-3 text-xs text-ink-muted">
        Couldn&rsquo;t load your profiles right now.
      </div>
    );
  }
  if (state.profiles.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          onClick={onOpen}
          className="rounded-xl border border-dashed border-surface-divider px-4 py-3 text-left text-xs text-ink-muted transition-colors hover:border-accent/50 hover:text-ink-secondary"
        >
          No profiles yet — create one to get started.
        </button>
        <RecentProfilesFreshness freshness={state.freshness} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {state.profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpenProfile(p.id)}
            title={p.name}
            className="group flex items-center gap-2.5 rounded-xl border border-surface-divider bg-surface-raised px-3 py-2.5 text-left transition-colors hover:border-accent/50 hover:bg-surface-elevated"
          >
            <span
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-inset text-sm font-semibold text-ink-secondary transition-colors group-hover:text-accent"
              aria-hidden="true"
            >
              {profileMonogram(p.name)}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-ink-primary">{p.name}</span>
              <span className="truncate text-2xs text-ink-muted">
                {p.last_used_at !== null ? (
                  <RelativeTime iso={p.last_used_at} tooltipPrefix="Last used" />
                ) : (
                  'Never used'
                )}
              </span>
            </span>
          </button>
        ))}
      </div>
      <RecentProfilesFreshness freshness={state.freshness} />
    </div>
  );
}

function RecentProfilesFreshness({
  freshness,
}: {
  freshness: Extract<RecentProfilesState, { kind: 'ready' }>['freshness'];
}): JSX.Element | null {
  if (freshness === 'fresh') return null;
  return (
    <p role="status" className="px-1 text-2xs text-ink-muted">
      {freshness === 'refreshing'
        ? 'Refreshing recent profiles…'
        : 'Couldn’t refresh — showing your recent profiles.'}
    </p>
  );
}

function Kpi({
  icon,
  label,
  value,
  accent,
  onClick,
  title,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  accent?: boolean;
  onClick?: () => void;
  title?: string;
}): JSX.Element {
  const inner = (
    <>
      <span
        className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg ${accent ? 'bg-accent/15 text-accent' : 'bg-surface-inset text-ink-secondary'}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="section-label">{label}</span>
        {/* The value, not the label, is what this card exists to show. It was
            `text-xl` — barely above body copy — so a strip of four KPIs read as
            four labels with footnotes. Owner: the page "looks too boring". */}
        <span
          className={`mono text-3xl font-semibold leading-none tabular-nums ${accent ? 'text-accent dark:text-status-ready' : 'text-ink-primary'}`}
        >
          {value}
        </span>
      </div>
    </>
  );
  if (onClick !== undefined) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className="flex cursor-pointer items-center gap-3 rounded-xl border border-surface-divider bg-surface-raised px-4 py-3 text-left transition-colors hover:border-accent/50 hover:bg-surface-elevated hover:ring-1 hover:ring-accent/30"
      >
        {inner}
      </button>
    );
  }
  return (
    <div
      title={title}
      className="flex items-center gap-3 rounded-xl border border-surface-divider bg-surface-raised px-4 py-3"
    >
      {inner}
    </div>
  );
}

function QuickLink({
  icon,
  label,
  desc,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  desc: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-3 rounded-xl border border-surface-divider bg-surface-raised px-4 py-3 text-left transition-colors hover:border-accent/50 hover:bg-surface-elevated"
    >
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-inset text-ink-secondary transition-colors group-hover:text-accent"
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-ink-primary">{label}</span>
        <span className="truncate text-xs text-ink-muted">{desc}</span>
      </span>
    </button>
  );
}

function ratio(value: number | null, cap: number | null): string {
  if (value === null) return '—';
  if (cap === null) return String(value);
  return `${value} / ${cap}`;
}

function titleCase(s: string): string {
  return s.length === 0 ? s : (s[0] ?? '').toUpperCase() + s.slice(1);
}

// ─── icons (Lucide-shape, inline, no dependency) ──────────────────
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
function IconSparkle(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <path d="M8 1.75 9.4 5.6 13.25 7 9.4 8.4 8 12.25 6.6 8.4 2.75 7 6.6 5.6Z" />
    </svg>
  );
}
function IconBook(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <path d="M2.75 3.25A1.25 1.25 0 0 1 4 2h8.25v10.5H4a1.25 1.25 0 0 0-1.25 1.25Z" />
      <path d="M2.75 12.75A1.25 1.25 0 0 1 4 14h8.25" />
    </svg>
  );
}
function IconLayers(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <path d="M8 2 1.5 5.25 8 8.5l6.5-3.25Z" />
      <path d="M1.5 8 8 11.25 14.5 8" />
      <path d="M1.5 10.75 8 14l6.5-3.25" />
    </svg>
  );
}
function IconGlobe(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M2.25 8h11.5" />
      <path d="M8 2.25c1.7 2 2.5 4 2.5 5.75S9.7 12 8 13.75C6.3 11.75 5.5 9.75 5.5 8s.8-3.75 2.5-5.75Z" />
    </svg>
  );
}
function IconActivity(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <path d="M1.5 8h2.75l1.5-4.5 3 9 1.5-4.5h4.25" />
    </svg>
  );
}
function IconBolt(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <path d="M8.5 1.5 3.5 9h3.5l-.5 5.5L12 7H8.5Z" />
    </svg>
  );
}
function IconBadge(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <path d="M8 1.5 10 3l2.5-.25L12.25 5.5 14 7.5l-1.75 2 .25 2.75L9.75 12 8 13.5 6.25 12l-2.75.25.25-2.75L2 7.5l1.75-2L3.5 2.75 6 3Z" />
    </svg>
  );
}
