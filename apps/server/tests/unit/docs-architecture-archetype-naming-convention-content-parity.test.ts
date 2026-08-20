// W559.A — drift guard for /docs/architecture/archetype-naming-convention.md.
// V-136 archetype-identifier shape. Drift here either weakens the
// dual-iOS+Safari-version-axis discipline (Apple ships Safari indep-
// of iOS major), drops the iphone17_ios18_7_safari26_4 locked
// archetype, or loosens the 5-step iOS-major-bump coordination
// across api-types + marketing + mocks + integration-fakes + server.
//
//   • V-136. Locked 2026-05-05. Driftstack engineering owner.
//   • Identifier shape: <device_family>_<device_model>_ios<major>_
//     <minor>_safari<safari_major>_<safari_minor>.
//   • Locked archetype: iphone17_ios18_7_safari26_4.
//   • iOS 18.7 with Safari 26.4 — pre-V-136 used fictional ios26_4_1.
//   • Display label via packages/api-types/src/common.ts:
//     ARCHETYPE_DISPLAY_LABEL.
//   • 5-step bump coordination across 5 surfaces.
//   • 4-don't-include (patch + build + region + profile-id).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/architecture/archetype-naming-convention.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W559.A /docs/architecture/archetype-naming-convention.md content parity', () => {
  const body = read(LIB);

  it("Header + V-136-locked + identifier-shape framing pinned: '# Archetype naming convention' + '**Status:** locked as of V-136 (2026-05-05).' + '**Owner:** Driftstack engineering.' + '**Audience:** future engineers cycling archetype identifiers' + 'on iOS major bumps.' + '## Identifier shape' + '<device_family>_<device_model>_ios<major>_<minor>_safari<safari_major>_<safari_minor>' + 'For the currently-locked archetype:' + 'iphone16pro_ios18_7_safari26_4' — pinned so the V-136-locked-2026-05-05 + Driftstack-engineering-owner + future-engineers-iOS-major-bumps + identifier-shape + locked-iphone16pro_ios18_7_safari26_4 commitment survives", () => {
    expect(body).toMatch(/^# Archetype naming convention$/m);
    expect(body).toMatch(/\*\*Status:\*\* locked as of V-136 \(2026-05-05\)\./);
    expect(body).toMatch(/\*\*Owner:\*\* Driftstack engineering\./);
    expect(body).toMatch(/\*\*Audience:\*\* future engineers cycling archetype identifiers/);
    expect(body).toMatch(/on iOS major bumps\./);
    expect(body).toMatch(/## Identifier shape/);
    expect(body).toMatch(
      /<device_family>_<device_model>_ios<major>_<minor>_safari<safari_major>_<safari_minor>/,
    );
    expect(body).toMatch(/For the currently-locked archetype:/);
    // V-1180 — the 2026-06-11 cutover moved the locked default iphone16pro → iphone17.
    // This pin froze the pre-cutover value, so the doc could not be corrected without a red.
    expect(body).toMatch(/iphone17_ios18_7_safari26_4/);
    expect(body, 'the doc names the pre-cutover archetype as currently locked again').not.toMatch(
      /For the currently-locked archetype:\s*\n+```\n+iphone16pro_ios18_7_safari26_4/,
    );
  });

  it("4-component + Safari-required framing pinned: '`device_family` — `iphone` for iPhone, `ipad` for iPad. Lowercase, no' + '`device_model` — `16pro`, `15`, `air`, `mini`, etc. Lowercase, no' + 'Drop \"Pro\" capitalization for parity with other identifiers.' + '`ios<major>_<minor>` — Apple's iOS version that the device is running.' + 'Major + minor only; patch version is **not** part of the identifier' + '(patches don't change the WebKit fingerprint surface enough to differentiate).' + '`safari<major>_<minor>` — Safari version. **Required** because Apple ships' + 'Safari independently of iOS major. Two devices on the same iOS may run' + 'different Safari builds; the archetype must distinguish them.' — pinned so the 4-component-iphone/ipad-lowercase + Pro-capitalization-dropped + patch-NOT-part + Safari-required-Apple-ships-independently commitment survives", () => {
    expect(body).toMatch(
      /- `device_family` — `iphone` for iPhone, `ipad` for iPad\. Lowercase, no/,
    );
    expect(body).toMatch(/- `device_model` — `16pro`, `15`, `air`, `mini`, etc\. Lowercase, no/);
    expect(body).toMatch(/Drop "Pro" capitalization for parity with other identifiers\./);
    expect(body).toMatch(
      /- `ios<major>_<minor>` — Apple's iOS version that the device is running\./,
    );
    expect(body).toMatch(
      /Major \+ minor only; patch version is \*\*not\*\* part of the identifier/,
    );
    expect(body).toMatch(
      /\(patches don't change the WebKit fingerprint surface enough to differentiate\)\./,
    );
    expect(body).toMatch(
      /- `safari<major>_<minor>` — Safari version\. \*\*Required\*\* because Apple ships/,
    );
    expect(body).toMatch(/Safari independently of iOS major\. Two devices on the same iOS may run/);
    expect(body).toMatch(/different Safari builds; the archetype must distinguish them\./);
  });

  it("Display label + 5-step bump framing pinned: '## Display label' + 'iPhone 16 Pro / iOS 18.7 / Safari 26.4' + 'Mapped from identifier in `packages/api-types/src/common.ts:ARCHETYPE_DISPLAY_LABEL`.' + 'Marketing-site, customer-dashboard, admin-panel, and GUI client all import' + '`archetypeDisplayLabel(id)` rather than rendering the raw identifier.' + '## When the locked archetype changes' + 'Every iOS major version bump (iOS 19, iOS 20, ...) requires a coordinated' + '**`packages/api-types/src/common.ts`** — update `LOCKED_ARCHETYPE_ID`' + '**Customer-facing copy** in `apps/marketing-site/`:' + '**Mock data** in `apps/customer-dashboard/src/data/mocks.ts`' + '**Integration test fakes** under `apps/server/tests/integration/_helpers/`' + '**Server-side archetype validation** wherever the identifier is hardcoded' + '`apps/server/src/services/sessions.ts`' — pinned so the iPhone-16-Pro/iOS-18.7/Safari-26.4-display + ARCHETYPE_DISPLAY_LABEL-from-common.ts + 4-surface-import + 5-step-iOS-major-bump-coordination commitment survives", () => {
    expect(body).toMatch(/## Display label/);
    // V-1180 — matches LOCKED_ARCHETYPE_DISPLAY_LABEL in packages/api-types/src/common.ts.
    expect(body).toMatch(/iPhone 17 \/ iOS 18\.7 \/ Safari 26\.4/);
    expect(body, 'the customer-facing label reverted to the pre-cutover device').not.toMatch(
      /The human-readable customer-facing label is:\s*\n+```\n+iPhone 16 Pro \//,
    );
    expect(body).toMatch(
      /Mapped from identifier in `packages\/api-types\/src\/common\.ts:ARCHETYPE_DISPLAY_LABEL`\./,
    );
    expect(body).toMatch(
      /Marketing-site, customer-dashboard, admin-panel, and GUI client all import/,
    );
    expect(body).toMatch(
      /`archetypeDisplayLabel\(id\)` rather than rendering the raw identifier\./,
    );
    expect(body).toMatch(/## When the locked archetype changes/);
    expect(body).toMatch(
      /Every iOS major version bump \(iOS 19, iOS 20, \.\.\.\) requires a coordinated/,
    );
    expect(body).toMatch(
      /1\. \*\*`packages\/api-types\/src\/common\.ts`\*\* — update `LOCKED_ARCHETYPE_ID`/,
    );
    expect(body).toMatch(/2\. \*\*Customer-facing copy\*\* in `apps\/marketing-site\/`:/);
    expect(body).toMatch(
      /3\. \*\*Mock data\*\* in `apps\/customer-dashboard\/src\/data\/mocks\.ts`/,
    );
    expect(body).toMatch(
      /4\. \*\*Integration test fakes\*\* under `apps\/server\/tests\/integration\/_helpers\/`/,
    );
    expect(body).toMatch(
      /5\. \*\*Server-side archetype validation\*\* wherever the identifier is hardcoded/,
    );
    expect(body).toMatch(/`apps\/server\/src\/services\/sessions\.ts`/);
  });

  it('Multi-archetype registry section pinned: the platform models a device matrix (NOT single-device); ARCHETYPE_REGISTRY is the source of truth; launch/reference/planned status; display labels DERIVE from it; launch-default change = status flip not a system-wide swap — pinned so the registry-architecture commitment (954db754) survives in the doc', () => {
    expect(body).toMatch(/## Multi-archetype registry/);
    expect(body).toMatch(/The platform is NOT a single-device product/);
    expect(body).toMatch(/exports `ARCHETYPE_REGISTRY`, the single-source-of-truth catalogue/);
    expect(body).toMatch(/- `launch` —/);
    expect(body).toMatch(/- `available` —/);
    expect(body).toMatch(/- `reference` —/);
    expect(body).toMatch(/- `planned` —/);
    expect(body).toMatch(
      /customer-selectable catalog \(GUI \/ dashboard selector\) = entries with/,
    );
    expect(body).toMatch(
      /`ARCHETYPE_DISPLAY_LABEL` and `archetypeDisplayLabel\(id\)` are DERIVED from the\s*\n?\s*registry/,
    );
    expect(body).toMatch(
      /\*\*Changing the launch default is a status flip, not a system-wide swap\.\*\*/,
    );
  });

  it("Don't-include 4-row + parallel-rationale framing pinned: '## Don't include in the identifier' + 'Patch version (`18.7.1`) — fingerprint-stable across patches.' + 'Build number (`22F76`) — internal Apple identifier, not customer-relevant.' + 'Region (`en_US`) — locale is a separate axis' + 'Profile id — profiles are an orthogonal concept' + '## Rationale for parallel iOS + Safari versioning' + 'Apple shipped **iOS 18.7 with Safari 26.4** in a recent release.' + 'Pre-V-136 the codebase used `iphone16pro_ios26_4_1` — conflating the Safari version' + 'with a fictional \"iOS 26.4.1\" that doesn't exist.' + 'Safari 26 is \"Safari 18 evolved\"' — pinned so the 4-don't-include (patch + build-22F76 + region-en_US + profile-id) + iOS-18.7-Safari-26.4 + pre-V-136-conflate-fix + Safari-18-evolved commitment survives", () => {
    expect(body).toMatch(/## Don't include in the identifier/);
    expect(body).toMatch(/- Patch version \(`18\.7\.1`\) — fingerprint-stable across patches\./);
    expect(body).toMatch(
      /- Build number \(`22F76`\) — internal Apple identifier, not customer-relevant\./,
    );
    expect(body).toMatch(/- Region \(`en_US`\) — locale is a separate axis/);
    expect(body).toMatch(/- Profile id — profiles are an orthogonal concept/);
    expect(body).toMatch(/## Rationale for parallel iOS \+ Safari versioning/);
    expect(body).toMatch(/Apple shipped \*\*iOS 18\.7 with Safari 26\.4\*\* in a recent release\./);
    expect(body).toMatch(
      /Pre-V-136\s+the codebase used `iphone16pro_ios26_4_1` — conflating the Safari version/,
    );
    expect(body).toMatch(/with a fictional "iOS 26\.4\.1" that doesn't exist\./);
    expect(body).toMatch(/Safari 26 is "Safari 18 evolved"/);
  });

  it("V-136 specifics + 6-surface-rename + GUI-no-hardcode framing pinned: '## V-136 specifics' + 'V-136 cleared the `iphone16pro_ios26_4_1` → `iphone16pro_ios18_7_safari26_4`' + 'rename across:' + '`packages/api-types/src/common.ts` — added `LOCKED_ARCHETYPE_ID`,' + '`LOCKED_ARCHETYPE_DISPLAY_LABEL`, `ARCHETYPE_DISPLAY_LABEL` map,' + '`archetypeDisplayLabel(id)` helper, plus `PROFILES_PER_TIER`' + '`apps/marketing-site/src/data/capabilities.ts` — `archetypeReference`' + '`apps/marketing-site/src/pages/index.astro` — cumulative-rig section' + '`apps/customer-dashboard/src/data/mocks.ts` (4 occurrences)' + '`apps/admin-panel/src/pages/sessions.astro` (3 occurrences)' + '`apps/customer-dashboard/src/pages/profiles.astro` — now passes' + 'GUI client (`apps/gui-client/`) reads archetype values from real API' + 'responses; no hardcoded identifier to rename.' + 'The `iphone16pro_ios26_4_1` identifier is no longer valid.' — pinned so the V-136-rename + 6-surface-rename + 4-occ-mocks + 3-occ-sessions + profiles.astro-archetypeDisplayLabel + GUI-real-API-no-hardcode + old-identifier-no-longer-valid commitment survives", () => {
    expect(body).toMatch(/## V-136 specifics/);
    expect(body).toMatch(
      /V-136 cleared the `iphone16pro_ios26_4_1` → `iphone16pro_ios18_7_safari26_4`/,
    );
    expect(body).toMatch(/rename across:/);
    expect(body).toMatch(/- `packages\/api-types\/src\/common\.ts` — added `LOCKED_ARCHETYPE_ID`,/);
    expect(body).toMatch(/`LOCKED_ARCHETYPE_DISPLAY_LABEL`, `ARCHETYPE_DISPLAY_LABEL` map,/);
    expect(body).toMatch(/`archetypeDisplayLabel\(id\)` helper, plus `PROFILES_PER_TIER`/);
    expect(body).toMatch(
      /- `apps\/marketing-site\/src\/data\/capabilities\.ts` — `archetypeReference`/,
    );
    expect(body).toMatch(
      /- `apps\/marketing-site\/src\/pages\/index\.astro` — cumulative-rig section/,
    );
    expect(body).toMatch(/- `apps\/customer-dashboard\/src\/data\/mocks\.ts` \(4 occurrences\)/);
    expect(body).toMatch(/- `apps\/admin-panel\/src\/pages\/sessions\.astro` \(3 occurrences\)/);
    expect(body).toMatch(/- `apps\/customer-dashboard\/src\/pages\/profiles\.astro` — now passes/);
    expect(body).toMatch(
      /GUI client \(`apps\/gui-client\/`\) reads archetype values from real API/,
    );
    expect(body).toMatch(/responses; no hardcoded identifier to rename\./);
    expect(body).toMatch(/The `iphone16pro_ios26_4_1` identifier is no longer valid\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
