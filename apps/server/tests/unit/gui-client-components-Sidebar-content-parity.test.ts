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

  it("section taxonomy pinned: 'Home' (Command Center) + 'Browse' (Profiles + Proxies) lead, then 'Automate' (AI chat + Saved tasks) + 'History' (Session log + Recordings) + 'Cluster' (Mac mini fleet, cloud-customer-gated via isCloudBaseUrl) + 'Account' (Settings, Team conditional). 2026-06-15: Raw sessions removed (redundant with the profile View/Open) + Connectivity test moved into Settings. 2026-06-19: the 'Diagnostics' (Logs) nav surface was removed — it was a client-side console/error buffer mislabeled as session logs; the floating DevLogPanel keeps it for dev triage. The speculative Marketplace preview was removed before backend work on 2026-07-12. Do not collapse / rename sections without updating the GUI snapshot tests + this pin.", () => {
    expect(body).toMatch(/<SidebarSection label="Home">/);
    expect(body).toMatch(/<SidebarSection label="Automate">/);
    expect(body).toMatch(/<SidebarSection label="Browse">/);
    expect(body).toMatch(/<SidebarSection label="History">/);
    expect(body).toMatch(/<SidebarSection label="Cluster">/);
    expect(body).toMatch(/<SidebarSection label="Account">/);
    expect(body).toMatch(/Mac mini fleet/);
    // Connectivity test now lives in Settings, not the sidebar.
    expect(body).not.toMatch(/Connectivity test/);
    expect(body).not.toMatch(/Raw sessions/);
    // 2026-06-19 — the full-screen "Logs" nav surface was removed.
    expect(body).not.toMatch(/<SidebarSection label="Diagnostics">/);
  });

  it("SidebarViewKind 13-variant union exported: home / ai / recipes / profiles / proxies / sessions-history / recordings / sessions / connectivity / fleet / team / billing / settings — pinned so App.tsx + future callers stay tied to the canonical nav-key taxonomy (live-session + recording-player are not in this union — they are routed-to, not navigated-to). 'ai' added by S7; 'recipes'/'logs' by the P3 feature-views slice; 'home' (Command Center) by the 5→10 G4 slice; 'team' by the Teams-management slice (2026-06-16); 'logs' removed when the client-buffer nav surface was retired (2026-06-19); 'billing' added when the customer billing/crypto-checkout cluster was wired into nav (revenue path, 2026-06-19); the speculative Marketplace preview was removed before backend work (2026-07-12).", () => {
    expect(body).toMatch(
      /export type SidebarViewKind =\s*\| 'home'\s*\| 'ai'\s*\| 'recipes'\s*\| 'profiles'\s*\| 'proxies'\s*\| 'sessions-history'\s*\| 'recordings'\s*\| 'sessions'\s*\| 'connectivity'\s*\| 'fleet'\s*\| 'team'\s*\| 'billing'\s*\| 'settings';/,
    );
    expect(body).not.toMatch(/marketplace/i);
    expect(body).not.toMatch(/\| 'logs'/);
  });

  it('Count-badge data sources pinned: Profiles X/Y via accountMe.profile_count / .profile_cap, Team N via accountMe.teams.length, Recordings N via RecordingsContext map size — pin so a casual refactor cannot drop a counter without showing up in the diff. (Sessions badge dropped 2026-06-15 with the Raw sessions nav item.)', () => {
    expect(body).toMatch(/accountMe\?\.profile_count \?\? null/);
    expect(body).toMatch(/accountMe\?\.profile_cap \?\? null/);
    // round-3 — `teams` is now optional-chained too (accountMe?.teams?.length) so a
    // non-null /account/me that omits `teams` (partial/legacy/malformed payload) can't
    // throw "Cannot read properties of undefined (reading 'length')" and blank the
    // whole window (the Sidebar mounts outside the per-view ErrorBoundary).
    expect(body).toMatch(/accountMe\?\.teams\?\.length \?\? 0/);
    expect(body).toMatch(/recordings\.size/);
  });

  it('Cluster section cloud-gate: !isCloudBaseUrl(settings.baseUrl) — pinned so a cloud-hosted customer never sees the Mac-mini-fleet ops surface (the same binary serves both deploy targets; this is a render-only gate, not auth)', () => {
    expect(body).toMatch(
      /\{!isCloudBaseUrl\(settings\.baseUrl\) && \(\s*<SidebarSection label="Cluster">/,
    );
  });

  it('Team-item visibility gate: showTeam (teamCount > 0 OR a team-capable tier) — and the item navigates to the team view. Pinned so solo accounts (the v1.0 baseline) do not see the affordance, while members AND team-capable owners reach team management (2026-06-16).', () => {
    expect(body).toMatch(/\{showTeam &&/);
    expect(body).toMatch(/const showTeam = teamCount > 0 \|\| teamCapableTier;/);
    expect(body).toMatch(/onClick=\{\(\) => onNavigate\('team'\)\}/);
  });

  it("Sign-out block: rendered only when signedIn (settings.apiKey !== null); ⌘⇧L hint preserved next to the button — pinned so the keyboard-shortcut affordance doesn't silently drop in a future restyle", () => {
    expect(body).toMatch(/const signedIn = settings\.apiKey !== null;/);
    expect(body).toMatch(/⌘⇧L/);
  });

  it('Workspace switcher (founder-approved): footer <select> rendered only for members of >=1 team (accountMe.teams.length > 0); options = Personal (value="") + each team; onChange -> setActiveWorkspace(value===""? null : value) which re-scopes the SDK effectiveAccount. Pinned so a solo account never sees the affordance and the switch wiring cannot silently drop.', () => {
    expect(body).toMatch(/activeWorkspace, setActiveWorkspace \} = useSettings\(\);/);
    // round-3 — the team-count gate is optional-chained ((accountMe.teams?.length ?? 0) > 0)
    // so a malformed /account/me missing `teams` survives instead of throwing in this render.
    // Still gated on a non-null accountMe AND >=1 team, so a solo account never sees the switcher.
    expect(body).toMatch(/accountMe !== null && \(accountMe\.teams\?\.length \?\? 0\) > 0 &&/);
    expect(body).toMatch(/aria-label="Active workspace"/);
    expect(body).toMatch(/value=\{activeWorkspace \?\? ''\}/);
    expect(body).toContain(
      "onChange={(e) => setActiveWorkspace(e.target.value === '' ? null : e.target.value)}",
    );
    expect(body).toMatch(/<option value="">Personal<\/option>/);
    expect(body).toContain('function workspaceLabel(');
  });
});
