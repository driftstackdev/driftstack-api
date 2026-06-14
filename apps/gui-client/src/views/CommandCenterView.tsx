// G4 (5→10, 2026-06-14) — Command Center home. The overview the app never had,
// and the surface that makes Automate PRIMARY (founder: "Automate should be
// above Browse / be primary"): it leads with an "Ask Driftstack AI / Browse
// recipes" hero, then a glanceable account KPI strip, then quick links into the
// rest of the app.
//
// v1 composes ONLY from the already-loaded accountMe (SettingsContext, V-239
// pre-fetch) — no new fetches — so it's robust + low blind-visual risk; it
// degrades to "—" while accountMe is null (loading / unauthenticated). Live
// session-health + an activity feed are a follow-up once v1 is proven. Shipped
// as a NON-default view first (reachable via the Home nav + ⌘K); flipping the
// default landing to it is a 1-line follow-up after founder review at rebuild #7.
//
// Granular onNavigate (a nav-kind string, not the App View type) keeps this off
// the App↔view import cycle, matching the other views' callback shape.

import { useEffect, useState, type JSX } from 'react';
import { useSettings } from '../lib/SettingsContext';

export type HomeNavTarget = 'ai' | 'recipes' | 'profiles' | 'proxies' | 'sessions';

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

export function CommandCenterView({
  onNavigate,
}: {
  onNavigate: (kind: HomeNavTarget) => void;
}): JSX.Element {
  const { accountMe, client } = useSettings();
  const sessionsActive = accountMe?.concurrent_session_active ?? null;
  const sessionsCap = accountMe?.concurrent_session_cap ?? null;
  const profileCount = accountMe?.profile_count ?? null;
  const profileCap = accountMe?.profile_cap ?? null;
  const tier = accountMe?.tier ?? null;

  // Live session-health rollup — loads independently of (and after) the hero +
  // KPI so a slow/failed fetch never blocks or breaks the landing; it just
  // shows a skeleton then a value or a quiet "couldn't load".
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

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      {/* Hero — leads with Automate (the primary surface). */}
      <section className="flex flex-col gap-3 rounded-xl border border-surface-divider bg-surface-raised p-5">
        <div className="flex flex-col gap-1">
          <span className="section-label">Command center</span>
          <h1 className="text-xl font-semibold tracking-tight text-ink-primary">
            What do you want to automate?
          </h1>
          <p className="max-w-xl text-sm text-ink-secondary">
            Describe a task in plain language and Driftstack plans &amp; runs it on a profile — or
            replay a saved recipe.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary px-4 py-2 text-sm"
            onClick={() => onNavigate('ai')}
          >
            Ask Driftstack AI
          </button>
          <button
            type="button"
            className="btn-secondary px-4 py-2 text-sm"
            onClick={() => onNavigate('recipes')}
          >
            Browse recipes
          </button>
        </div>
      </section>

      {/* Account KPI strip — from accountMe (no fetch). */}
      <section className="flex flex-col gap-2">
        <span className="section-label">Account</span>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-surface-divider bg-surface-divider sm:grid-cols-3">
          <Kpi label="Plan" value={tier !== null ? titleCase(tier) : '—'} />
          <Kpi label="Sessions" value={ratio(sessionsActive, sessionsCap)} sub="active / cap" />
          <Kpi label="Profiles" value={ratio(profileCount, profileCap)} sub="created / cap" />
        </div>
      </section>

      {/* Live session health — loads independently; degrades gracefully. */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="section-label">Session health</span>
          <button
            type="button"
            className="section-label text-accent hover:underline"
            onClick={() => onNavigate('sessions')}
          >
            view all
          </button>
        </div>
        <SessionHealthStrip state={health} />
      </section>

      {/* Quick links into the rest of the app. */}
      <section className="flex flex-col gap-2">
        <span className="section-label">Jump to</span>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <QuickLink
            label="Profiles"
            desc="Browse &amp; launch identities"
            onClick={() => onNavigate('profiles')}
          />
          <QuickLink
            label="Proxies"
            desc="SOCKS5 exits &amp; health"
            onClick={() => onNavigate('proxies')}
          />
          <QuickLink
            label="Sessions"
            desc="Live &amp; recent runs"
            onClick={() => onNavigate('sessions')}
          />
        </div>
      </section>
    </div>
  );
}

function SessionHealthStrip({ state }: { state: HealthState }): JSX.Element {
  if (state.kind === 'idle') {
    return (
      <div className="rounded-lg border border-dashed border-surface-divider px-4 py-3 text-xs text-ink-muted">
        Connect your API key to see live session health.
      </div>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div className="h-[58px] animate-pulse rounded-lg border border-surface-divider bg-surface-inset" />
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded-lg border border-surface-divider px-4 py-3 text-xs text-ink-muted">
        Couldn&rsquo;t load sessions right now.
      </div>
    );
  }
  const h = state.health;
  if (h.total === 0) {
    return (
      <div className="rounded-lg border border-dashed border-surface-divider px-4 py-3 text-xs text-ink-muted">
        No sessions yet — launch a profile or ask the AI to start one.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-surface-divider bg-surface-divider sm:grid-cols-4">
      <HealthTile label="Running" value={h.running} tone="ready" />
      <HealthTile label="Creating" value={h.creating} tone="busy" />
      <HealthTile label="Errored" value={h.errored} tone={h.errored > 0 ? 'error' : 'muted'} />
      <HealthTile label="Total" value={h.total} tone="muted" />
    </div>
  );
}

function HealthTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'ready' | 'busy' | 'error' | 'muted';
}): JSX.Element {
  const valueCls =
    tone === 'ready'
      ? 'text-status-ready'
      : tone === 'busy'
        ? 'text-status-busy'
        : tone === 'error'
          ? 'text-status-error'
          : 'text-ink-primary';
  return (
    <div className="flex flex-col gap-0.5 bg-surface-base px-4 py-2.5">
      <span className="section-label">{label}</span>
      <span className={`mono text-xl font-semibold tabular-nums ${valueCls}`}>{value}</span>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 bg-surface-base px-4 py-3">
      <span className="section-label">{label}</span>
      <span className="mono text-2xl font-semibold tabular-nums text-ink-primary">{value}</span>
      {sub !== undefined && <span className="text-2xs text-ink-muted">{sub}</span>}
    </div>
  );
}

function QuickLink({
  label,
  desc,
  onClick,
}: {
  label: string;
  desc: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-0.5 rounded-lg border border-surface-divider bg-surface-raised px-4 py-3 text-left transition-colors hover:border-accent/50 hover:bg-surface-elevated"
    >
      <span className="text-sm font-medium text-ink-primary">{label}</span>
      <span className="text-xs text-ink-muted">{desc}</span>
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
