// W486.S — drift guard for apps/gui-client/src/components/Sidebar.tsx.
// Sidebar split out of App.tsx in 2026-05-21 09ffe07d (operator-UI
// polish wave — per-item icons + live count badges). The 4-section
// taxonomy invariant moved here from W486.A; the visible-text contract
// for the Profiles/Proxies/Recordings/Sessions count badges is locked
// at the component level by tests/unit/Sidebar.test.tsx, so this file
// pins the source-of-truth wiring + framing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/Sidebar.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W486.S apps/gui-client/src/components/Sidebar.tsx content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("4-section taxonomy pinned: 'Browse' (Profiles + Proxies) + 'History' (Session log + Recordings) + 'Diagnostics' (Raw sessions + Connectivity test) + 'Cluster' (Mac mini fleet, cloud-customer-gated via isCloudBaseUrl) + 'Account' (Settings, Team conditional) — the IA grouping stays profile-first per Driftstack's operator-tool framing; do not collapse / rename sections without updating the GUI snapshot tests + this pin", () => {
    expect(body).toMatch(/<SidebarSection label="Browse">/);
    expect(body).toMatch(/<SidebarSection label="History">/);
    expect(body).toMatch(/<SidebarSection label="Diagnostics">/);
    expect(body).toMatch(/<SidebarSection label="Cluster">/);
    expect(body).toMatch(/<SidebarSection label="Account">/);
    expect(body).toMatch(/Mac mini fleet/);
    expect(body).toMatch(/Connectivity test/);
  });

  it("SidebarViewKind 9-variant union exported: ai / profiles / proxies / sessions-history / recordings / sessions / connectivity / fleet / settings — pinned so App.tsx + future callers stay tied to the canonical nav-key taxonomy (live-session + recording-player are not in this union — they are routed-to, not navigated-to). 'ai' added by the AI-chat S7 slice (the Automate section).", () => {
    expect(body).toMatch(
      /export type SidebarViewKind =\s*\n?\s*\| 'ai'\s*\n?\s*\| 'profiles'\s*\n?\s*\| 'proxies'\s*\n?\s*\| 'sessions-history'\s*\n?\s*\| 'recordings'\s*\n?\s*\| 'sessions'\s*\n?\s*\| 'connectivity'\s*\n?\s*\| 'fleet'\s*\n?\s*\| 'settings';/,
    );
  });

  it('Count-badge data sources pinned: Profiles X/Y via accountMe.profile_count / .profile_cap, Sessions X/Y via accountMe.concurrent_session_active / .cap, Team N via accountMe.teams.length, Recordings N via RecordingsContext map size — pin so a casual refactor cannot drop a counter without showing up in the diff', () => {
    expect(body).toMatch(/accountMe\?\.profile_count \?\? null/);
    expect(body).toMatch(/accountMe\?\.profile_cap \?\? null/);
    expect(body).toMatch(/accountMe\?\.concurrent_session_active \?\? null/);
    expect(body).toMatch(/accountMe\?\.concurrent_session_cap \?\? null/);
    expect(body).toMatch(/accountMe\?\.teams\.length \?\? 0/);
    expect(body).toMatch(/recordings\.size/);
  });

  it('Cluster section cloud-gate: !isCloudBaseUrl(settings.baseUrl) — pinned so a cloud-hosted customer never sees the Mac-mini-fleet ops surface (the same binary serves both deploy targets; this is a render-only gate, not auth)', () => {
    expect(body).toMatch(
      /\{!isCloudBaseUrl\(settings\.baseUrl\) && \(\s*\n?\s*<SidebarSection label="Cluster">/,
    );
  });

  it('Team-item visibility gate: teamCount > 0 — pinned so solo accounts (the v1.0 baseline) do not see a dead "Team" affordance, while customers with at least one team membership see the count badge', () => {
    expect(body).toMatch(/\{teamCount > 0 &&/);
  });

  it("Sign-out block: rendered only when signedIn (settings.apiKey !== null); ⌘⇧L hint preserved next to the button — pinned so the keyboard-shortcut affordance doesn't silently drop in a future restyle", () => {
    expect(body).toMatch(/const signedIn = settings\.apiKey !== null;/);
    expect(body).toMatch(/⌘⇧L/);
  });
});
