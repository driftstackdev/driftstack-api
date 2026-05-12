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

  it('REFRESH_MS = 5000 module constant pinned — pinned so the auto-poll cadence stays in sync with the SessionsView mirror shape (footer copy + cap-counter both depend on this)', () => {
    expect(body).toMatch(/const REFRESH_MS = 5000;/);
  });

  it("V-238 KNOWN_ARCHETYPES single-option catalog pinned with iphone16pro_ios18_7_safari26_4 id + 'iPhone 16 Pro / iOS 18.7 / Safari 26.4' label — pinned so the archetype select stays preselected to the canonical one + disabled until V-136 expansion lands more archetypes", () => {
    expect(body).toMatch(
      /\/\/ V-238 — only one customer-pickable archetype today\. When V-136-style\s*\n?\s*\/\/ expansion lands more archetypes \(e\.g\. iPhone 17 Pro \/ iOS 19\), surface\s*\n?\s*\/\/ them here\. The form preselects this single option; the select control\s*\n?\s*\/\/ is disabled until there are 2\+ choices\./,
    );
    expect(body).toMatch(
      /const KNOWN_ARCHETYPES: ReadonlyArray<\{ id: string; label: string \}> = \[\s*\n?\s*\{ id: 'iphone16pro_ios18_7_safari26_4', label: 'iPhone 16 Pro \/ iOS 18\.7 \/ Safari 26\.4' \},\s*\n?\s*\];/,
    );
  });

  it("V-239 cap-gate framing pinned ('gate the New profile button at the tier cap (skip when profile_cap === null which means enterprise / no fixed cap).') + atProfileCap = profileCap !== null && profileCount !== null && profileCount >= profileCap — pinned so a null profile_cap (enterprise) doesn't accidentally gate the button", () => {
    expect(body).toMatch(
      /\/\/ V-239 — gate the New profile button at the tier cap \(skip when\s*\n?\s*\/\/ profile_cap === null which means enterprise \/ no fixed cap\)\./,
    );
    expect(body).toMatch(
      /const profileCap = accountMe\?\.profile_cap \?\? null;\s*\n?\s*const profileCount = accountMe\?\.profile_count \?\? null;\s*\n?\s*const atProfileCap = profileCap !== null && profileCount !== null && profileCount >= profileCap;/,
    );
  });

  it('refreshAccountMe() called after handleDelete success + after CreateProfileModal onCreated — pinned so the cap counter unlocks New profile button after delete + flips to disabled after create (V-239 invariant)', () => {
    expect(body).toMatch(
      /await client\.profiles\.delete\(id\);\s*\n?\s*await refresh\(\);\s*\n?\s*\/\/ V-239 — refresh the cap counter so a deletion unlocks the\s*\n?\s*\/\/ New profile button when we drop below cap\.\s*\n?\s*await refreshAccountMe\(\);/,
    );
    expect(body).toMatch(
      /void refresh\(\);\s*\n?\s*\/\/ V-239 — refresh the cap counter so the gate flips to\s*\n?\s*\/\/ disabled if we just hit cap\.\s*\n?\s*void refreshAccountMe\(\);/,
    );
  });

  it("Auto-poll lifecycle: useEffect initial fetch + setInterval REFRESH_MS + cleanup clearInterval — pinned so poll stops on unmount and doesn't chew API quota in background; refresh deps [client]; client.profiles.iterate({ limit: 50 }) — pinned so we cap the in-memory accumulation per poll", () => {
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*\n?\s*void refresh\(\);\s*\n?\s*const id = window\.setInterval\(\(\) => void refresh\(\), REFRESH_MS\);\s*\n?\s*return \(\) => window\.clearInterval\(id\);\s*\n?\s*\}, \[refresh\]\);/,
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

  it("friendlyError: DriftstackError → '{title} ({kind}): {detail ?? message}' / Error → .message / fallback String(err) — pinned so client-thrown DriftstackErrors surface their structured shape and non-Error throws still stringify instead of rendering as '[object Object]'", () => {
    expect(body).toMatch(
      /function friendlyError\(err: unknown\): string \{\s*\n?\s*if \(err instanceof DriftstackError\) \{\s*\n?\s*return `\$\{err\.title\} \(\$\{err\.kind\}\): \$\{err\.detail \?\? err\.message\}`;\s*\n?\s*\}\s*\n?\s*if \(err instanceof Error\) \{\s*\n?\s*return err\.message;\s*\n?\s*\}\s*\n?\s*return String\(err\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
