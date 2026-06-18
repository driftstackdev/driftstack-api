// W485.A — drift guard for apps/gui-client/src/views/ProfilesView.tsx.
// Profiles view: list/create/delete V-136 persistent identity slots
// with V-239 cap-gate. Drift here either drops the V-239 cap-gating
// (customer sees a 402/cap-error from server in normal flow instead
// of a disabled button + tooltip) or breaks the auto-poll cleanup
// (poll continues after unmount + chews API quota).
//
//   • Framing pinned: 'Profiles view — list profiles, create new,
//     delete.' + V-136 Tier 3 framing.
//   • REFRESH_MS = 5000 module constant.
//   • V-238 KNOWN_ARCHETYPES single-option pinned with iphone16pro
//     id + label.
//   • V-239 cap-gate framing pinned + atProfileCap calculation.
//   • refreshAccountMe after delete + after create (cap unlock
//     invariant).
//   • Modal: ESC-to-close + backdrop-click-to-close (not while
//     submitting).
//   • Form: name 1-120 required + description 500-max optional +
//     archetype select disabled when KNOWN_ARCHETYPES.length < 2.
//   • EmptyConnect 'Set an API key in Settings' framing.
//   • friendlyError: DriftstackError → title+kind+detail else Error
//     → message else String(err).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/ProfilesView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W485.A apps/gui-client/src/views/ProfilesView.tsx content parity', () => {
  const body = read(LIB);

  it("Framing pinned: 'Profiles view — list profiles, create new, delete.' + V-136 Tier 3 draft framing ('Persistent identity slots that survive across sessions. Each profile carries its own cookies + localStorage; the driver attaches them to a session when the session is created against a profile.')", () => {
    expect(body).toMatch(/\/\/ Profiles view — list profiles, create new, delete\./);
    expect(body).toMatch(
      /\/\/ V-136 \(Tier 3 draft\)\. Persistent identity slots that survive across\s*\n?\s*\/\/ sessions\. Each profile carries its own cookies \+ localStorage; the\s*\n?\s*\/\/ driver attaches them to a session when the session is created against\s*\n?\s*\/\/ a profile\./,
    );
  });

  it('2026-05-20 — REFRESH_MS bumped 5000→15_000 (mirror of SessionsView change per d15460c7; customer feedback "the page keeps refreshing")', () => {
    expect(body).toMatch(/const REFRESH_MS = 15_000;/);
  });

  it("W637 KNOWN_ARCHETYPES derived from ARCHETYPE_REGISTRY filtered to verified statuses (launch + available) — pinned so the GUI archetype catalog is the single-source registry (not a hardcoded list) and EXCLUDES reference/planned (e.g. iPhone 17, still per-value verified) so an unverified fingerprint can't ship; new devices appear automatically when A1 flips their status", () => {
    // LiveKitInfo dropped 2026-06-18 when the dead in-app overlay (watchInfo)
    // was removed — the launch flow only opens the separate simulator window now.
    expect(body).toMatch(
      /import \{ ARCHETYPE_REGISTRY, type ArchetypeStatus \} from '@driftstack\/sdk';/,
    );
    expect(body).toMatch(
      /const SELECTABLE_STATUSES = new Set<ArchetypeStatus>\(\['launch', 'available'\]\);/,
    );
    expect(body).toMatch(
      /const KNOWN_ARCHETYPES: ReadonlyArray<\{ id: string; label: string \}> = ARCHETYPE_REGISTRY\.filter\(\s*\n?\s*\(a\) => SELECTABLE_STATUSES\.has\(a\.status\),\s*\n?\s*\)\.map\(\(a\) => \(\{ id: a\.id, label: a\.displayLabel \}\)\);/,
    );
    // reference/planned MUST NOT be selectable (the 100%-verified rule).
    expect(body).not.toMatch(/SELECTABLE_STATUSES[\s\S]{0,80}?'planned'/);
    expect(body).not.toMatch(/SELECTABLE_STATUSES[\s\S]{0,80}?'reference'/);
  });

  it("V-239 cap-gate framing pinned ('gate the New profile button at the tier cap (skip when profile_cap === null which means enterprise / no fixed cap).') + atProfileCap = profileCap !== null && profileCount !== null && profileCount >= profileCap — pinned so a null profile_cap (enterprise) doesn't accidentally gate the button", () => {
    expect(body).toMatch(
      /\/\/ V-239 — gate the New profile button at the tier cap \(skip when\s*\n?\s*\/\/ profile_cap === null which means enterprise \/ no fixed cap\)\./,
    );
    expect(body).toMatch(
      /const profileCap = accountMe\?\.profile_cap \?\? null;\s*\n?\s*const profileCount = accountMe\?\.profile_count \?\? null;\s*\n?\s*const atProfileCap = profileCap !== null && profileCount !== null && profileCount >= profileCap;/,
    );
  });

  it('2026-05-20 — refreshAccountMe still fires after handleDelete success + after CreateProfileModal onCreated (V-239 cap-gate invariant) but the deleteBinding + refresh(false) calls were inserted ahead of refreshAccountMe in handleDelete per the antidetect-browser restructure', () => {
    expect(body).toMatch(
      /await client\.profiles\.delete\(id\);\s*\n?\s*\/\/ Drop the local binding so stale \{currentSessionId, defaultProxyId\}\s*\n?\s*\/\/ entries don't accumulate as customers churn through profiles\.\s*\n?\s*await deleteBinding\(id\);\s*\n?\s*await refresh\(false\);\s*\n?\s*await refreshAccountMe\(\);/,
    );
    expect(body).toMatch(/void refreshAccountMe\(\);/);
  });

  it('2026-05-20 — auto-poll lifecycle: useEffect runs refresh(true) initially (showLoading hint) + setInterval refresh(false) at REFRESH_MS (no flicker on background ticks); cleanup clearInterval keeps unchanged; client.profiles.iterate({ limit: 50 }) still caps per-poll in-memory accumulation', () => {
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*\n?\s*void refresh\(true\);\s*\n?\s*const id = window\.setInterval\(\(\) => void refresh\(false\), REFRESH_MS\);\s*\n?\s*return \(\) => window\.clearInterval\(id\);\s*\n?\s*\}, \[refresh\]\);/,
    );
    expect(body).toMatch(
      /for await \(const profile of client\.profiles\.iterate\(\{ limit: 50 \}\)\)/,
    );
  });

  it("CreateProfileModal: ESC-to-close (Escape key + !submitting gate) + backdrop-click-to-close (target === currentTarget && !submitting) — pinned so both close paths are submission-safe; modal is role='dialog' aria-modal='true' aria-labelledby='create-profile-title' for screen-reader semantics", () => {
    expect(body).toMatch(
      /if \(e\.key === 'Escape' && !submitting\) \{\s*\n?\s*e\.preventDefault\(\);\s*\n?\s*onClose\(\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/if \(e\.target === e\.currentTarget && !submitting\) onClose\(\);/);
    expect(body).toMatch(
      /role="dialog"\s*\n?\s*aria-modal="true"\s*\n?\s*aria-labelledby="create-profile-title"/,
    );
  });

  it("Form: name input maxLength=120 minLength=1 required + description textarea maxLength=500 rows=2 + archetype select disabled={submitting || KNOWN_ARCHETYPES.length < 2} — pinned so server schema bounds (1-120 name / 500-max description) stay enforced client-side, and select stays disabled while there's only one archetype available", () => {
    expect(body).toMatch(/maxLength=\{120\}\s*\n?\s*minLength=\{1\}\s*\n?\s*required/);
    expect(body).toMatch(/maxLength=\{500\}\s*\n?\s*rows=\{2\}/);
    expect(body).toMatch(/disabled=\{submitting \|\| KNOWN_ARCHETYPES\.length < 2\}/);
  });

  it("Empty no-profiles framing pinned: 'A profile is a persistent identity — cookies, localStorage, IndexedDB — reused across sessions. Bind a session to a profile to keep login state, returning-visitor signals, and stealth fingerprints stable between runs.' — pinned so customer understands what they're creating", () => {
    expect(body).toMatch(
      /A profile is a persistent identity — cookies, localStorage, IndexedDB — reused across\s*\n?\s*sessions\. Bind a session to a profile to keep login state, returning-visitor signals,\s*\n?\s*and stealth fingerprints stable between runs\./,
    );
    expect(body).toMatch(/Sessions without a profile start ephemeral — fresh state every run\./);
  });

  it("New profile button: disabled={state.loading || atProfileCap} + aria-disabled={state.loading || atProfileCap}; title tooltip 'Profile cap reached ({cap} for {tier}). Delete a profile or upgrade to add more.' when atProfileCap else undefined — pinned so both screen readers + hover surface the cap explanation", () => {
    expect(body).toMatch(
      /disabled=\{state\.loading \|\| atProfileCap\}\s*\n?\s*aria-disabled=\{state\.loading \|\| atProfileCap\}\s*\n?\s*title=\{\s*\n?\s*atProfileCap\s*\n?\s*\? `Profile cap reached \(\$\{\(profileCap \?\? 0\)\.toString\(\)\} for \$\{\s*\n?\s*accountMe\?\.tier \?\? 'this tier'\s*\n?\s*\}\)\. Delete a profile or upgrade to add more\.`\s*\n?\s*: undefined\s*\n?\s*\}/,
    );
  });

  it("2026-05-20 — friendlyError signature widened to (err, baseUrl?: string) for the Tauri-WebKit 'Load failed' diagnosticFetchError preflight; baseUrl-undefined branch keeps the prior DriftstackError → Error → String fallback chain so non-network callers still get the structured shape (rendered as '[object Object]' was the prior bug)", () => {
    expect(body).toMatch(
      /function friendlyError\(err: unknown, baseUrl\?: string\): string \{\s*\n?\s*\/\/ 2026-05-20 — network-failure preflight \(catches Tauri WebKit\s*\n?\s*\/\/ "Load failed" before falling through to per-view formatting\)\.\s*\n?\s*if \(baseUrl !== undefined\) \{\s*\n?\s*const diag = diagnosticFetchError\(err, baseUrl\);\s*\n?\s*if \(diag !== null\) return diag;\s*\n?\s*\}\s*\n?\s*if \(err instanceof DriftstackError\) \{\s*\n?\s*return `\$\{err\.title\} \(\$\{err\.kind\}\): \$\{err\.detail \?\? err\.message\}`;\s*\n?\s*\}\s*\n?\s*if \(err instanceof Error\) \{\s*\n?\s*return err\.message;\s*\n?\s*\}\s*\n?\s*return String\(err\);\s*\n?\s*\}/,
    );
  });

  it('Launch gates on `busy` ONLY, not atProfileCap (free-tier fix 0ccff415): the profile cap limits CREATING profiles, not launching an existing one (launch consumes a session slot). A regression to `disabled={busy || atProfileCap}` re-greys Launch on a free-tier account (profile_cap 1) so the one allowed profile can never launch — the exact bug a self-hosted user hit. GRID + LIST(table) both route Launch through handleLaunch with launchDisabled gated on activeWorkspace only. (Duplicate removed per founder 2026-06-15.)', () => {
    expect(body).toMatch(/void handleLaunch\(profile\)/);
    // The fix's rationale comment must stay (explains why Launch is busy-only).
    expect(body).toMatch(/NOT atProfileCap: the/);
    // The specific regression guard: the Launch button must never re-gate on the
    // profile cap. (`state.loading || atProfileCap` on the New-profile button is
    // correct + separately pinned above; this targets the `busy || atProfileCap` form.)
    expect(body).not.toMatch(/disabled=\{busy\s*\|\|\s*atProfileCap\}/);
  });

  it("Launch in a team workspace is gated by ROLE (2026-06-16): the server now lets a team ADMIN launch the owner's profile (agent-sessions create honors X-Driftstack-Account for admins, mirroring driver V-326e3), so only NON-admin members are blocked. activeRole reads the membership role for the active workspace; teamLaunchBlocked = activeWorkspace !== null && activeRole !== 'admin'. GRID gates via the ProfilePhoneCard launchDisabled prop, LIST via the row-model field — both off the shared teamLaunchBlocked.", () => {
    expect(body).toMatch(
      /const teamLaunchBlocked = activeWorkspace !== null && activeRole !== 'admin'/,
    );
    expect(body).toContain('launchDisabled={teamLaunchBlocked}'); // grid card prop
    expect(body).toContain('launchDisabled: teamLaunchBlocked'); // table row model
    expect(body).toMatch(/ask a team admin to launch it/);
  });

  it('Workspace recovery bar is ALWAYS rendered when activeWorkspace !== null — independent of profiles/accountMe load state (a revoked-membership persisted workspace 403s everything; the in-stats-row switcher is gated on profiles.length>0 AND accountMe.teams, so without this top-level Switch-to-Personal escape the hub would brick with no way back).', () => {
    expect(body).toContain('data-component="workspace-recovery-bar"');
    expect(body).toContain('{activeWorkspace !== null && (');
    expect(body).toMatch(/↩ Switch to Personal/);
    expect(body).toContain('onClick={() => setActiveWorkspace(null)}');
  });

  it("W624 stop-actually-stops: boundSession resolves the profile's session by KIND (agt_ → agent, else live driver session) so an agent-backed profile counts as running AND its Stop closes the right thing — handleStop calls agentSessions.close(agt_) / sessions.destroy(ses_). The founder-hit bug: launch-with-LiveKit bound an agt_ id that the driver-only lookup never matched, so the profile showed idle and Stop no-op'd (the agent session kept running).", () => {
    expect(body).toMatch(
      /function boundSession\(profileId: string\): \{ id: string; kind: 'agent' \| 'driver' \} \| null \{/,
    );
    expect(body).toMatch(/if \(sid\.startsWith\('agt_'\)\) return \{ id: sid, kind: 'agent' \};/);
    expect(body).toMatch(
      /return activeSessions\.some\(\(s\) => s\.id === sid\) \? \{ id: sid, kind: 'driver' \} : null;/,
    );
    // handleStop closes by kind (the actual fix for "destroy keeps running").
    expect(body).toMatch(
      /if \(bound\.kind === 'agent'\) \{\s*\n?\s*await client\.agentSessions\.close\(bound\.id\);\s*\n?\s*\} else \{\s*\n?\s*await client\.sessions\.destroy\(bound\.id\);\s*\n?\s*\}/,
    );
    // running flag + status filter both recognise agt_ sessions.
    expect(body).toMatch(/const running = bound !== null;/);
    expect(body).toMatch(/sid !== null && \(sid\.startsWith\('agt_'\) \|\| activeSessions\.some/);
    // Live view re-opens the stream for an agent session (livekitToken).
    expect(body).toMatch(/await client\.agentSessions\.livekitToken\(agentSessionId\);/);
  });

  it('W625 mock-driver heads-up: ProfilesView reads useConnectionStatus(settings.baseUrl).driver and renders a data-banner="mock-driver" notice only when driver===\'mock\'; the hook parses driver from /version (mock|webkit|playwright, else null) — pinned so a mock deployment sets launch expectations up front instead of the customer hitting an empty stream post-launch', () => {
    expect(body).toMatch(
      /import \{ useConnectionStatus \} from '\.\.\/lib\/use-connection-status';/,
    );
    expect(body).toMatch(/const serverDriver = useConnectionStatus\(settings\.baseUrl\)\.driver;/);
    expect(body).toMatch(/\{serverDriver === 'mock' && \(/);
    expect(body).toMatch(/data-banner="mock-driver"/);
    // The hook actually surfaces driver from /version.
    const hook = read(resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-connection-status.ts'));
    expect(hook).toMatch(/driver: ServerDriver \| null;/);
    expect(hook).toMatch(
      /body\.driver === 'mock' \|\|\s*\n?\s*body\.driver === 'webkit' \|\|\s*\n?\s*body\.driver === 'playwright'/,
    );
  });

  it('W638 reopenStream stale-binding self-heal: a 403/404 from livekitToken (closed/gone agent session that boundSession optimistically showed as running) clears the profile binding + refreshes so it self-heals to idle instead of re-offering a Live-view that 403s', () => {
    expect(body).toMatch(
      /if \(err instanceof DriftstackError && \(err\.status === 403 \|\| err\.status === 404\)\) \{\s*\n?\s*await clearProfileSession\(profileId\)\.catch\(\(\) => undefined\);\s*\n?\s*await refresh\(false\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
