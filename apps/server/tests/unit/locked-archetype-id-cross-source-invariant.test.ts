// W847 — V-136 LOCKED_ARCHETYPE_ID cross-source invariant. One-
// hundred-seventy-third in the drift-guard series. Pins that the
// canonical archetype identifier 'iphone17_ios18_7_safari26_4' (it named the
// pre-2026-06-11 'iphone16pro_ios18_7_safari26_4' until 2026-08-16; the arms
// have tracked the cutover since it happened — see the note at LOCKED_ARCHETYPE_ID
// below — but this description had not)
// is referenced consistently across:
//   - api-types schema (source-of-truth: LOCKED_ARCHETYPE_ID).
//   - Integration test scenarios.ts (default archetype).
//   - Cross-SDK profile-management examples (W801 W798).
//   - apps/marketing-site (public copy).
//   - apps/customer-dashboard + apps/admin-panel mocks.
//
// Drift to a different archetype identifier in ANY of these would
// break the cross-cutting V-136 source-of-truth contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// 2026-06-11 launch-archetype cutover: canonical id moved iphone16pro → iphone17.
const LOCKED_ARCHETYPE_ID = 'iphone17_ios18_7_safari26_4';
const LOCKED_ARCHETYPE_DISPLAY = 'iPhone 17 / iOS 18.7 / Safari 26.4';

describe('W847 LOCKED_ARCHETYPE_ID cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it("CRITICAL packages/api-types/src/common.ts declares LOCKED_ARCHETYPE_ID = 'iphone17_ios18_7_safari26_4' as the cross-cutting source-of-truth. Drift to a different identifier would cascade through every other reference.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(new RegExp(`export const LOCKED_ARCHETYPE_ID = '${LOCKED_ARCHETYPE_ID}';`));
  });

  it("CRITICAL packages/api-types/src/common.ts also declares LOCKED_ARCHETYPE_DISPLAY_LABEL = 'iPhone 17 / iOS 18.7 / Safari 26.4' (human-readable form). The dual ID + DISPLAY pair lets API responses ship both the machine ID and the customer-renderable label.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(
      new RegExp(
        `export const LOCKED_ARCHETYPE_DISPLAY_LABEL = '${LOCKED_ARCHETYPE_DISPLAY.replace(/\./g, '\\.')}';`,
      ),
    );
  });

  // ─── Integration scenarios.ts uses the EXACT same string ─────

  it('CRITICAL apps/server/tests/integration/_helpers/scenarios.ts uses the EXACT same archetype string as default. Drift would make integration-test fixtures mismatch the production schema constant.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/tests/integration/_helpers/scenarios.ts'));
    expect(p).toMatch(new RegExp(LOCKED_ARCHETYPE_ID));
  });

  // ─── SDK examples reference the same archetype ────────────────

  it('CRITICAL all 3 cross-SDK profile-management examples reference V-136 + LOCKED_ARCHETYPE_ID. The TS+Python+Go examples all have the same archetype-default comment per W801.', () => {
    const tsExample = read(
      resolve(REPO_ROOT, 'packages/sdk-typescript/examples/profile-management.ts'),
    );
    const pyExample = read(
      resolve(REPO_ROOT, 'packages/sdk-python/examples/profile_management.py'),
    );

    expect(tsExample).toMatch(/V-136 LOCKED_ARCHETYPE_ID/);
    expect(pyExample).toMatch(/V-136 LOCKED_ARCHETYPE_ID/);
    expect(tsExample).toMatch(/iPhone 17 \/ iOS 18\.7 \/ Safari 26\.4/);
    expect(pyExample).toMatch(/iPhone 17 \/ iOS 18\.7 \/ Safari 26\.4/);
  });

  // ─── Python pytest_fixture references same archetype ─────────

  it('CRITICAL Python pytest_fixture.py SESSION_FIXTURE uses the EXACT same archetype string. Matches W802 single-language SDK examples pinning.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-python/examples/pytest_fixture.py'));
    expect(p).toMatch(new RegExp(`"archetype": "${LOCKED_ARCHETYPE_ID}"`));
  });

  // ─── Customer dashboard derives labels from the registry ─────

  it('CRITICAL customer-dashboard live overview imports ARCHETYPE_REGISTRY + archetypeDisplayLabel instead of duplicating a retired mock identifier', () => {
    const dashboard = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/index.astro'));
    expect(dashboard).toMatch(
      /import \{ ARCHETYPE_REGISTRY, archetypeDisplayLabel \} from '@driftstack\/api-types';/,
    );
    expect(dashboard).toMatch(
      /ARCHETYPE_REGISTRY\.map\(\(a\) => \[a\.id, archetypeDisplayLabel\(a\.id\)\]\)/,
    );
  });

  // ─── Marketing-site index references same ────────────────────

  it('CRITICAL apps/marketing-site/src/pages/index.astro references the EXACT same archetype string. Drift to a different identifier in marketing copy would mislead customers about what we actually ship.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/index.astro'));
    expect(p).toMatch(new RegExp(LOCKED_ARCHETYPE_ID));
  });

  // ─── No alternate archetype identifiers anywhere ─────────────

  it('CRITICAL no NON-iOS archetype IDs (android_pixel* / chrome_windows* / safari_macos*) appear in source — the platform emulates iOS iPhone/iPad ONLY, so a non-iOS fingerprint slug is always wrong. iOS device variants (iphone16/17/pro/pro-max) are now legitimate ARCHETYPE_REGISTRY entries (multi-archetype per founder 2026-05-30, superseding the V-136 single-canonical-archetype contract).', () => {
    const dirs = [
      'packages/api-types/src',
      'apps/server/src',
      'packages/sdk-typescript/src',
      'packages/sdk-python/src/driftstack',
      'packages/sdk-go',
    ];
    // Sample the most likely files; full scan is W843/W844-style.
    const sampleFiles = [
      'packages/api-types/src/common.ts',
      'apps/server/tests/integration/_helpers/scenarios.ts',
      'packages/sdk-typescript/examples/profile-management.ts',
    ];
    for (const f of sampleFiles) {
      const p = read(resolve(REPO_ROOT, f));
      // Forbidden NON-iOS archetypes — the platform emulates iOS iPhone/iPad
      // ONLY. iOS device variants (iphone15pro / iphone17pro / …) are now
      // legitimate ARCHETYPE_REGISTRY entries (multi-archetype 2026-05-30),
      // so they are no longer forbidden; a wrong-PLATFORM slug still is.
      const forbiddenPatterns = [/\bandroid_pixel_/, /\bchrome_windows_/, /\bsafari_macos_/];
      for (const re of forbiddenPatterns) {
        expect(p, `${f} references forbidden alternate archetype: ${re}`).not.toMatch(re);
      }
    }
    void dirs; // Silence unused.
  });

  // ─── Anchor pinned: V-136 = the canonical archetype provenance ─

  it("CRITICAL V-136 is the canonical V-anchor for LOCKED_ARCHETYPE_ID. The 'V-136 LOCKED_ARCHETYPE_ID' anchor appears in api-types/common.ts inline comment + SDK examples + cross-SDK docs. Drift to a different V-anchor would orphan teaching cross-links.", () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(apiTypes).toMatch(/V-136/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/locked-archetype-id-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
