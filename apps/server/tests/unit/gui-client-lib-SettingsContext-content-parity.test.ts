// W608.A (W631-deepened) — drift guard for apps/gui-client/src/lib/SettingsContext.tsx.
//
// W631 splits the original 2 monster it() blocks into 8 focused per-
// concept blocks + pins previously-implicit React subtleties:
//
//   • Cancelled-load race: the initial loadSettings() useEffect uses
//     a `cancelled` flag flipped by the cleanup function. If a fast
//     unmount lands before the promise resolves, the setSettings
//     call is skipped (no React "set state on unmounted component"
//     warning). Drift to dropping the flag would re-introduce the
//     warning + a potential stale-state write.
//   • V-242 telemetry re-init dependency-array: the effect re-runs
//     when baseUrl OR telemetryOptIn changes. initTelemetry is
//     idempotent + close()s the old client on opt-out so customers
//     who flip the toggle mid-session don't ship stale telemetry.
//   • useMemo client deps: buildClient is memoised on [apiKey,
//     baseUrl] specifically — not the whole settings object — so
//     a settings.theme change doesn't pointlessly rebuild the SDK
//     client.
//   • refreshAccountMe useCallback deps: [client] — refreshing
//     account-me is tied to the SDK client identity, not the raw
//     apiKey, so it follows the buildClient memo.
//   • useSettings hook contract: throws an Error if used outside
//     <SettingsProvider>. Error message pinned verbatim because
//     downstream catch-blocks can pattern-match on it.
//   • update() merges next over previous + persists via saveSettings
//     so a partial Partial<DriftstackSettings> overwrites only the
//     fields the caller passed.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/SettingsContext.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W608.A apps/gui-client/src/lib/SettingsContext.tsx content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module-level framing pinned (single-source-of-truth for apiKey+baseUrl + V-239 AccountSelfProfile + V-242 telemetry re-init)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/\/\/ Settings context — single source of truth for the API key \+ base/);
    expect(body).toMatch(/\/\/ URL across the React tree\./);
    expect(body).toMatch(
      /\/\/ V-239: also fetches \+ exposes the AccountSelfProfile \(V-237 endpoint\)/,
    );
    expect(body).toMatch(
      /\/\/ so views can render "X \/ Y concurrent sessions" \+ "P \/ Q profiles"/,
    );
    expect(body).toMatch(/\/\/ gates without each view re-fetching independently\. `accountMe` is/);
    expect(body).toMatch(
      /\/\/ null while loading or when no apiKey is set; `refreshAccountMe\(\)`/,
    );
    expect(body).toMatch(/\/\/ is exposed so views \(Sessions, Profiles\) can refresh after a/);
    expect(body).toMatch(/\/\/ create\/destroy that mutates the count\./);
  });

  it('SettingsContextValue interface — 6-field shape pinned (settings + loading + client nullable + V-239 accountMe nullable + V-239 refreshAccountMe + update). Drift to a non-nullable client or accountMe would break the "no key set yet → ungated UI" soft-fail invariant.', () => {
    expect(body).toMatch(/^interface SettingsContextValue \{$/m);
    expect(body).toMatch(/settings: DriftstackSettings;/);
    expect(body).toMatch(/loading: boolean;/);
    expect(body).toMatch(/client: DriftstackClient \| null;/);
    expect(body).toMatch(
      /\/\*\* V-239 — current account's tier \+ caps \+ usage\. Null while loading or unauthenticated\. \*\//,
    );
    expect(body).toMatch(/accountMe: AccountSelfProfile \| null;/);
    expect(body).toMatch(
      /\/\*\* V-239 — manually trigger a re-fetch \(e\.g\. after a create\/destroy\)\. \*\//,
    );
    expect(body).toMatch(/refreshAccountMe: \(\) => Promise<void>;/);
    expect(body).toMatch(
      /\/\*\* Update settings \+ persist\. Background callers remain best-effort; explicit/,
    );
    expect(body).toMatch(
      /update:\s*\(\s*next: Partial<DriftstackSettings>,\s*options\?: \{ reportPersistenceFailure\?: boolean \},\s*\) => Promise<void>;/,
    );
    expect(body).toMatch(
      /^export const SettingsContext = createContext<SettingsContextValue \| null>\(null\);$/m,
    );
  });

  it('Initial loadSettings cancelled-race guard pinned — `let cancelled = false` flag flipped by the cleanup function so a fast unmount before the promise resolves doesn\'t setSettings on an unmounted tree. Drift to dropping the flag would re-introduce React\'s "set state on unmounted component" warning + a potential stale-state write.', () => {
    expect(body).toMatch(/export function SettingsProvider/);
    expect(body).toContain('let cancelled = false;');
    expect(body).toContain('void loadSettings()');
    expect(body).toContain('if (!cancelled) {');
    expect(body).toContain('setSettings(s);');
    expect(body).toContain('cancelled = true;');
    // A keychain/store read failure degrades to defaults so the GUI boots
    // instead of blanking via the global unhandledrejection handler.
    expect(body).toContain('setSettings(DEFAULT_SETTINGS);');
  });

  it('V-242 telemetry re-init effect — dependency array [settings.baseUrl, settings.telemetryOptIn]. initTelemetry is "idempotent + reconfigure-safe; it close()s the existing client when the customer opts out mid-session" — so a customer flipping the opt-in toggle MID-SESSION doesn\'t need to refresh the app for the change to take effect.', () => {
    expect(body).toMatch(
      /\/\/ V-242 — re-init telemetry whenever baseUrl or telemetryOptIn changes\./,
    );
    expect(body).toMatch(/\/\/ initTelemetry is idempotent \+ reconfigure-safe; it close\(\)s the/);
    expect(body).toMatch(/\/\/ existing client when the customer opts out mid-session\./);
    expect(body).toMatch(
      /initTelemetry\(\{ baseUrl: settings\.baseUrl, optIn: settings\.telemetryOptIn \}\);/,
    );
    expect(body).toMatch(/\}, \[settings\.baseUrl, settings\.telemetryOptIn\]\);/);
  });

  it('update() — useCallback with [settings] dep, merges Partial<DriftstackSettings> over previous settings + persists via saveSettings. Returns once the on-disk write resolves so callers can chain on completion. Drift to a different merge order (e.g. previous over next) would break the "partial update overwrites only the passed fields" contract.', () => {
    // Contract fragments (merge ORDER + setSettings + persist + [settings] dep). saveSettings
    // is now wrapped in a best-effort try/catch so a persist failure can't blank the app via an
    // unhandled rejection (#9) — assert the durable contract, not the exact whitespace.
    expect(body).toMatch(
      /async \(\s*next: Partial<DriftstackSettings>,\s*options\?: \{ reportPersistenceFailure\?: boolean \},?\s*\) => \{/,
    );
    expect(body).toContain('const merged: DriftstackSettings = { ...settings, ...next };');
    expect(body).toMatch(
      /const credentialUnchanged =\s*merged\.apiKey === settings\.apiKey && merged\.baseUrl === settings\.baseUrl;/,
    );
    expect(body).toContain('if (!reportPersistenceFailure) setSettings(merged);');
    expect(body).toContain('await saveSettings(merged, { credentialUnchanged });');
    expect(body).toContain('if (reportPersistenceFailure) setSettings(merged);');
    expect(body).toContain('if (reportPersistenceFailure) throw e;');
    expect(body).toMatch(
      /const update = useCallback\([\s\S]{0,1800}?\n\s*\[settings\],\s*\n\s*\);/,
    );
  });

  it('Memoised SDK client — useMemo on [apiKey, baseUrl, activeWorkspace, handleUnauthorized (stable)] specifically, not the whole settings object. A settings.theme change must not rebuild the client; a WORKSPACE switch must (the SDK effectiveAccount option is constructor-time). handleUnauthorized is a useCallback([]) so it never churns the client. Drift to [settings] would cause unnecessary client churn.', () => {
    expect(body).toMatch(
      /const client = useMemo\(\s*\n?\s*\(\) => buildClient\(settings\.apiKey, settings\.baseUrl, activeWorkspace, handleUnauthorized\),\s*\n?\s*\[settings\.apiKey, settings\.baseUrl, activeWorkspace, handleUnauthorized\],\s*\n?\s*\);/,
    );
  });

  it("V-239 refreshAccountMe — useCallback on [client, activeWorkspace, setActiveWorkspace]; null-client short-circuit sets accountMe=null; the soft-fail catch FAILS CLOSED: it KEEPS the last-known accountMe (does NOT null it) so a transient /account/me blip cannot evaporate the at-cap session-cap gate (audit wja3dfl5t). It also now reconciles a stale active workspace against the CURRENT account teams, dropping to personal scope (setActiveWorkspace(null)) when the active workspace owner is no longer one of this key's teams — so the deps gained activeWorkspace + setActiveWorkspace. Drift back to nulling on transient error would re-open the at-cap New-session button.", () => {
    expect(body).toMatch(
      /const refreshAccountMe = useCallback\(async \(\): Promise<void> => \{\s*\n\s*if \(!client\) \{\s*\n\s*setAccountMe\(null\);\s*\n\s*return;\s*\n\s*\}/,
    );
    expect(body).toMatch(/const raw = await client\.account\.me\(\);/);
    // round-3 — normalize `teams` to an array at the SOURCE so a partial/legacy
    // /v1/account/me (omitting `teams`) can't crash the whole window via a render
    // outside the per-view ErrorBoundary. Pin the normalization so a refactor
    // can't quietly drop it.
    expect(body).toMatch(
      /const me = raw\.teams === undefined \? \{ \.\.\.raw, teams: \[\] \} : raw;/,
    );
    expect(body).toMatch(/setAccountMe\(me\);/);
    expect(body).toMatch(
      /if \(\s*\n\s*activeWorkspace !== null &&\s*\n\s*!me\.teams\.some\(\(t\) => t\.owner_account_id === activeWorkspace\)\s*\n\s*\) \{\s*\n\s*setActiveWorkspace\(null\);\s*\n\s*\}/,
    );
    expect(body).toMatch(/Soft-fail, but FAIL CLOSED: KEEP the last-known accountMe/);
    expect(body).toMatch(/evaporated the at-cap New-session gate/);
    expect(body).toMatch(/\}, \[client, activeWorkspace, setActiveWorkspace\]\);/);
    // Stale-response guard: a `latestClientRef` (updated by a [client] effect)
    // lets refreshAccountMe skip setAccountMe when a slow /account/me from a
    // PREVIOUS identity resolves after a newer one. Pin the guard + the
    // client-tracking effect so a refactor can't quietly drop the fix.
    expect(body).toMatch(/const latestClientRef = useRef\(client\);/);
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*\n\s*latestClientRef\.current = client;\s*\n\s*\}, \[client\]\);/,
    );
    expect(body).toMatch(
      /if \(client !== latestClientRef\.current\) return; \/\/ superseded by a newer identity/,
    );
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*\n\s*void refreshAccountMe\(\);\s*\n\s*\}, \[refreshAccountMe\]\);/,
    );
  });

  it('useSettings hook — throws Error with exact message "useSettings must be used inside <SettingsProvider>" if called outside the provider tree. Message pinned verbatim because downstream catch-blocks can pattern-match on it for error UX.', () => {
    expect(body).toMatch(/^export function useSettings\(\): SettingsContextValue \{$/m);
    expect(body).toMatch(/const ctx = useContext\(SettingsContext\);/);
    expect(body).toMatch(
      /if \(!ctx\) throw new Error\('useSettings must be used inside <SettingsProvider>'\);/,
    );
    expect(body).toMatch(/return ctx;/);
  });
});
