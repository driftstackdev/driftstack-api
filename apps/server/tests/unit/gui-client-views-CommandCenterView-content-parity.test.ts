// Drift guard for apps/gui-client/src/views/CommandCenterView.tsx.
// The Command Center home is the app's landing launchpad (founder 2026-06-19:
// the old passive overview was "pretty useless" — it now has actionable bits).
// Drift here either (a) drops the "Jump back in" recent-profiles strip or the
// live jump-off affordances (the home silently regresses to the passive
// overview the founder rejected), or (b) breaks the independent gracefully-
// degrading load contract so a slow/failed fetch blanks or wedges the landing,
// or (c) re-introduces a real launch path here (launch belongs to Profiles —
// the home must only NAVIGATE there, never duplicate that path).
//
//   • Four independent gracefully-degrading loads pinned (recent profiles,
//     session health, recent activity, proxy count). Recent profiles retain a
//     bounded, workspace-scoped cache while refreshing and surface staleness.
//   • Exported pure helpers pinned: computeCapAlerts / summarizeSessions /
//     formatAuditAction / sortRecentProfiles / profileMonogram.
//   • sortRecentProfiles: last_used_at desc, nulls (never-used) last, stable
//     ties, capped at RECENT_PROFILES_LIMIT (5).
//   • "Jump back in" strip: loads client.profiles.list(), cards navigate to
//     'profiles' (the real launch surface), empty state copy pinned.
//   • Actionable live affordances: the "Live now" KPI + the Session-health
//     "Running" tile jump to 'sessions' only when running > 0 (a 0 stays a
//     passive stat).
//   • Real launch stays out: the home navigates to Profiles, it does not call
//     a profiles.launch path of its own.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/CommandCenterView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('apps/gui-client/src/views/CommandCenterView.tsx content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('header framing pinned: four independent gracefully-degrading loads + the actionable-launchpad intent + the "launch lives in Profiles" rule', () => {
    expect(body).toContain(
      'plus four independent, gracefully-degrading loads (recent profiles, session',
    );
    expect(body).toContain(
      '// Actionable launchpad (founder 2026-06-19: the passive overview was "pretty',
    );
    expect(body).toContain(
      '// lives in Profiles — the home navigates there, it never duplicates that path.',
    );
  });

  it('exported pure helpers pinned (unit-tested independently of the fetches): computeCapAlerts / summarizeSessions / formatAuditAction / sortRecentProfiles / profileMonogram', () => {
    expect(body).toContain('export function computeCapAlerts(');
    expect(body).toContain('export function summarizeSessions(');
    expect(body).toContain('export function formatAuditAction(');
    expect(body).toContain('export function sortRecentProfiles(');
    expect(body).toContain('export function profileMonogram(');
  });

  it('RecentProfile shape mirrors the SDK profiles.list() row (id / name / last_used_at)', () => {
    expect(body).toMatch(
      /export interface RecentProfile \{\s*id: string;\s*name: string;\s*last_used_at: string \| null;\s*\}/,
    );
  });

  it('sortRecentProfiles: last_used_at desc, never-used (null) sinks last, stable ties, capped at the limit', () => {
    expect(body).toContain('export function sortRecentProfiles(');
    // never-used (NaN ts) sinks below used
    expect(body).toContain('if (aUsed !== bUsed) return aUsed ? -1 : 1;');
    // newest first for two used rows
    expect(body).toContain('if (aUsed && bUsed && a.ts !== b.ts) return b.ts - a.ts;');
    // stable for ties / both-never-used
    expect(body).toContain('return a.index - b.index;');
    expect(body).toContain('.slice(0, Math.max(0, limit))');
    expect(body).toContain('const RECENT_PROFILES_LIMIT = 5;');
  });

  it('profileMonogram: first non-space char uppercased, blank → "?"', () => {
    expect(body).toMatch(
      /export function profileMonogram\(name: string\): string \{\s*const ch = name\.trim\(\)\.charAt\(0\);\s*return ch === '' \? '\?' : ch\.toUpperCase\(\);/,
    );
  });

  it('"Jump back in" keeps bounded workspace-scoped cached profiles visible while refreshing, then marks fresh or stale truthfully', () => {
    expect(body).toContain('client.profiles');
    expect(body).toContain('.list()');
    expect(body).toContain('const RECENT_PROFILES_CACHE_TTL_MS = 5 * 60 * 1000;');
    expect(body).toContain('const RECENT_PROFILES_CACHE_MAX_SCOPES = 16;');
    expect(body).toContain('const recentProfilesScope = activeWorkspace ?? accountMe?.id ?? null;');
    expect(body).toMatch(
      /cached !== null\s*\? \{ kind: 'ready', profiles: cached, freshness: 'refreshing' \}\s*: \{ kind: 'loading' \}/,
    );
    expect(body).toMatch(/setRecentProfiles\(\{ kind: 'ready', profiles, freshness: 'fresh' \}\)/);
    expect(body).toMatch(
      /cached !== null\s*\? \{ kind: 'ready', profiles: cached, freshness: 'stale' \}\s*: \{ kind: 'error' \}/,
    );
    expect(body).toContain("? 'Refreshing recent profiles…'");
    expect(body).toContain(": 'Couldn’t refresh — showing your recent profiles.'");
    expect(body).toMatch(
      /sortRecentProfiles\(\s*page\.data\.map\(\(p\) => \(\{ id: p\.id, name: p\.name, last_used_at: p\.last_used_at \}\)\),\s*RECENT_PROFILES_LIMIT,\s*\)/,
    );
  });

  it('"Jump back in" section sits right under the hero with cards + an empty state, all routing to Profiles (the real launch surface) — the home never launches itself', () => {
    expect(body).toContain('Jump back in');
    // Idle/empty placeholders fall back to the bare Profiles list; populated
    // "Jump back in" cards deep-link to their specific profile via onOpenProfile,
    // still landing in Profiles (2026-06-20) — never a launch path of its own.
    expect(body).toContain("onOpen={() => onNavigate('profiles')}");
    expect(body).toContain('onOpenProfile');
    expect(body).toContain('No profiles yet — create one to get started.');
    // The home routes into Profiles; it must NOT call a launch path of its own.
    expect(body).not.toContain('.launch(');
  });

  it('the live side is actionable: "Live now" KPI + Session-health "Running" tile jump to sessions only when running > 0', () => {
    expect(body).toContain(
      "const liveNowAction = liveNow !== null && liveNow > 0 ? () => onNavigate('sessions') : undefined;",
    );
    expect(body).toContain('onClick={liveNowAction}');
    // 2026-06-30 — the SessionHealthStrip's running threshold is on its own
    // destructured `running` prop (not an inline `h.running` accessor), and the
    // component invocation wraps across multiple lines (extraRunning prop added) —
    // the underlying invariant (jump to sessions only when running > 0) is unchanged.
    expect(body).toContain('onClick={running > 0 ? onViewLive : undefined}');
    expect(body).toContain('<SessionHealthStrip');
    expect(body).toContain("onViewLive={() => onNavigate('sessions')}");
  });
});
