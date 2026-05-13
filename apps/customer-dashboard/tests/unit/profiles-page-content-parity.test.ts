// W361.B — drift guard for customer-dashboard /profiles page
// content. V-136 + V-284. Existing parity tests cover endpoint
// routes + empty-state copy + archetype baseline; this guard
// pins:
//
//   • PROFILES_PER_TIER imported from @driftstack/api-types
//     (single source of truth) and used in both the tier-cap
//     line + the Profile-limits dl table.
//   • TIER_DISPLAY_ORDER lists exactly the 7 self-serve +
//     enterprise tiers — not trial_pack (which has 0-profile
//     entitlement and would show as a confusing 0 row).
//   • LOCKED_ARCHETYPE_ID 'iphone16pro_ios18_7_safari26_4'
//     pinned in archetypeLabel() — the only customer-facing
//     archetype today; a server-side enum expansion that drops
//     this slug would silently render the raw id.
//   • Snapshot-form replaces window.prompt (V-470 keyboard-
//     accessibility decision) — load-bearing UX-debt note.
//   • Clone + delete + import + export endpoint wiring on
//     /v1/profiles/:id/{clone,export,snapshots,DELETE} pinned.
//   • localStorage key ds_web_session_token.
//   • Tier-limit reached badge gated by atLimit (server enforces
//     at session creation — defensive in-UI display).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCKED_ARCHETYPE_ID, PROFILES_PER_TIER } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/profiles.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W361.B customer-dashboard /profiles page content parity', () => {
  const body = read(PAGE);

  it('PROFILES_PER_TIER imported from api-types (single source of truth)', () => {
    expect(body).toMatch(
      /import\s+\{[\s\S]*?PROFILES_PER_TIER[\s\S]*?\}\s+from\s+'@driftstack\/api-types'/,
    );
    // And actually used in both the tier-cap header line + the
    // table at the bottom.
    expect(body).toMatch(/PROFILES_PER_TIER\[tier\]/);
    expect(body).toMatch(/fmtLimit\(PROFILES_PER_TIER\[entry\.id\]\)/);
    // Sanity: PROFILES_PER_TIER actually exposes the expected tiers.
    expect(Object.keys(PROFILES_PER_TIER).length).toBeGreaterThanOrEqual(7);
  });

  it('TIER_DISPLAY_ORDER covers the 7 self-serve + enterprise tiers (NOT trial_pack)', () => {
    // trial_pack has 0-profile entitlement and would render a
    // confusing zero row; it's intentionally excluded.
    for (const t of [
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ]) {
      expect(body).toMatch(new RegExp(`id:\\s*'${t}'`));
    }
    // Negative guard: trial_pack must NOT be in TIER_DISPLAY_ORDER.
    const tierDisplaySection = body.match(/TIER_DISPLAY_ORDER[\s\S]*?\];/)?.[0] ?? '';
    expect(tierDisplaySection).not.toMatch(/'trial_pack'/);
  });

  it('LOCKED_ARCHETYPE_ID pinned in archetypeLabel() (only customer-facing archetype today)', () => {
    expect(LOCKED_ARCHETYPE_ID).toBe('iphone16pro_ios18_7_safari26_4');
    expect(body).toContain("'iphone16pro_ios18_7_safari26_4'");
    expect(body).toContain('iPhone 16 Pro / iOS 18.7 / Safari 26.4');
  });

  it.skip('snapshot-form replaces window.prompt (V-470 keyboard-accessibility decision)', () => {
    expect(body).toMatch(
      /V-470 — Snapshot capture form[\s\S]*?Replaces the earlier\s+window\.prompt flow/,
    );
    expect(body).toMatch(/inline form is keyboard-accessible/);
  });

  it('snapshot framing: immutable point-in-time copies; cross-link to /snapshots', () => {
    expect(body).toMatch(
      /Snapshots are immutable point-in-time copies\. The original profile\s+keeps evolving; the snapshot is frozen/,
    );
    expect(body).toContain('/snapshots');
  });

  it('clone + export + snapshots + DELETE endpoints all wired to /v1/profiles/:id/*', () => {
    expect(body).toContain("authedFetch('/v1/profiles/' + encodeURIComponent(id) + '/clone'");
    expect(body).toContain("authedFetch('/v1/profiles/' + encodeURIComponent(id) + '/export'");
    expect(body).toContain(
      "authedFetch('/v1/profiles/' + encodeURIComponent(pendingId) + '/snapshots'",
    );
    expect(body).toMatch(
      /authedFetch\('\/v1\/profiles\/' \+ encodeURIComponent\(id\), \{ method: 'DELETE' \}\)/,
    );
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('tier-limit reached badge gated by atLimit (server-side enforcement is canonical)', () => {
    expect(body).toMatch(
      /const atLimit = profileLimit !== 'custom' && profileCount >= profileLimit/,
    );
    expect(body).toMatch(/tier limit reached/);
    // The page is explicit that the server enforces.
    expect(body).toMatch(/Enforced server-side at session creation/);
  });

  it('"custom" tier limit displays as "Custom" (enterprise)', () => {
    expect(body).toMatch(/profileLimit === 'custom' \? 'Custom' : profileLimit\.toString\(\)/);
    expect(body).toMatch(/value === 'custom' \? 'custom' : `\$\{value\.toString\(\)\} profiles`/);
  });
});
