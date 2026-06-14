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

import type { JSX } from 'react';
import { useSettings } from '../lib/SettingsContext';

export type HomeNavTarget = 'ai' | 'recipes' | 'profiles' | 'proxies' | 'sessions';

export function CommandCenterView({
  onNavigate,
}: {
  onNavigate: (kind: HomeNavTarget) => void;
}): JSX.Element {
  const { accountMe } = useSettings();
  const sessionsActive = accountMe?.concurrent_session_active ?? null;
  const sessionsCap = accountMe?.concurrent_session_cap ?? null;
  const profileCount = accountMe?.profile_count ?? null;
  const profileCap = accountMe?.profile_cap ?? null;
  const tier = accountMe?.tier ?? null;

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
