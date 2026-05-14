// W810 — cross-app + cross-package tsconfig.json byte-identity
// parity. One-hundred-thirty-sixth in the drift-guard series. Pins
// 9 tsconfig.json files in 2 byte-identical groups:
//
//   Astro apps (4): admin-panel + customer-dashboard + docs +
//                   marketing-site — all extend astro/tsconfigs/strict
//                   + jsx:preserve + baseUrl:'.' + @/* path alias.
//
//   Internal packages (5): recipe-library + behavioural-simulation +
//                          webhook-delivery + webrtc-streaming +
//                          recapture-automation — all extend ../../
//                          tsconfig.base.json + rootDir:src + outDir
//                          :dist + composite:true.
//
// Each group must move in lockstep — drift between members would
// silently let one app/package compile under different strictness
// or generate output to a different location.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const ASTRO_APPS = [
  'apps/admin-panel/tsconfig.json',
  'apps/customer-dashboard/tsconfig.json',
  'apps/docs/tsconfig.json',
  'apps/marketing-site/tsconfig.json',
];

const INTERNAL_PACKAGES = [
  'packages/recipe-library/tsconfig.json',
  'packages/behavioural-simulation/tsconfig.json',
  'packages/webhook-delivery/tsconfig.json',
  'packages/webrtc-streaming/tsconfig.json',
  'packages/recapture-automation/tsconfig.json',
];

describe('W810 cross-app + cross-package tsconfig.json byte-identity parity', () => {
  it('all 9 tsconfig.json files exist', () => {
    for (const f of [...ASTRO_APPS, ...INTERNAL_PACKAGES]) {
      expect(existsSync(resolve(REPO_ROOT, f))).toBe(true);
    }
  });

  // ─── Astro apps group ─────────────────────────────────────────

  it('CRITICAL all 4 Astro app tsconfig.json files are BYTE-IDENTICAL. Drift between admin-panel / customer-dashboard / docs / marketing-site would silently let one app compile under different strictness or generate output to a different location.', () => {
    const reference = read(resolve(REPO_ROOT, ASTRO_APPS[0]!));
    for (const f of ASTRO_APPS.slice(1)) {
      const content = read(resolve(REPO_ROOT, f));
      expect(content, `${f} differs from ${ASTRO_APPS[0]}`).toBe(reference);
    }
  });

  it("CRITICAL Astro tsconfig extends 'astro/tsconfigs/strict' pinned. Drift to 'astro/tsconfigs/base' or 'astro/tsconfigs/strictest' would either weaken type-safety or break the canonical Astro project strictness convention.", () => {
    const p = read(resolve(REPO_ROOT, ASTRO_APPS[0]!));
    expect(p).toMatch(/"extends": "astro\/tsconfigs\/strict"/);
  });

  it("CRITICAL Astro tsconfig 4-compilerOption set pinned — jsx:preserve + baseUrl:'.' + @/* → src/* path alias. Drift to jsx:react-jsx would break Astro's static-rendering pipeline; drift to a different path alias would break every '@/X' import.", () => {
    const p = read(resolve(REPO_ROOT, ASTRO_APPS[0]!));
    expect(p).toMatch(/"jsx": "preserve"/);
    expect(p).toMatch(/"baseUrl": "\."/);
    expect(p).toMatch(/"paths": \{\s*\n\s+"@\/\*": \["src\/\*"\]\s*\n\s+\}/);
  });

  it('CRITICAL Astro tsconfig include set — src/**/* + astro.config.mjs + tailwind.config.mjs pinned. Drift to dropping astro.config.mjs/tailwind.config.mjs would lose type-checking of those config files.', () => {
    const p = read(resolve(REPO_ROOT, ASTRO_APPS[0]!));
    expect(p).toMatch(
      /"include": \["src\/\*\*\/\*", "astro\.config\.mjs", "tailwind\.config\.mjs"\]/,
    );
    expect(p).toMatch(/"exclude": \["dist"\]/);
  });

  // ─── Internal packages group ──────────────────────────────────

  it('CRITICAL all 5 internal-package tsconfig.json files are BYTE-IDENTICAL. Drift between recipe-library / behavioural-simulation / webhook-delivery / webrtc-streaming / recapture-automation would break the monorepo project-references graph (composite builds depend on consistent shape across siblings).', () => {
    const reference = read(resolve(REPO_ROOT, INTERNAL_PACKAGES[0]!));
    for (const f of INTERNAL_PACKAGES.slice(1)) {
      const content = read(resolve(REPO_ROOT, f));
      expect(content, `${f} differs from ${INTERNAL_PACKAGES[0]}`).toBe(reference);
    }
  });

  it("CRITICAL internal-package tsconfig extends '../../tsconfig.base.json' pinned. Drift to extending astro/tsconfigs/strict or some other base would diverge package strictness from the monorepo root.", () => {
    const p = read(resolve(REPO_ROOT, INTERNAL_PACKAGES[0]!));
    expect(p).toMatch(/"extends": "\.\.\/\.\.\/tsconfig\.base\.json"/);
  });

  it("CRITICAL internal-package tsconfig 4-compilerOption set pinned — rootDir:src + outDir:dist + composite:true + tsBuildInfoFile:'dist/.tsbuildinfo'. The composite:true flag is required for monorepo project-references; drift to false would break incremental builds across packages.", () => {
    const p = read(resolve(REPO_ROOT, INTERNAL_PACKAGES[0]!));
    expect(p).toMatch(/"rootDir": "src"/);
    expect(p).toMatch(/"outDir": "dist"/);
    expect(p).toMatch(/"composite": true/);
    expect(p).toMatch(/"tsBuildInfoFile": "dist\/\.tsbuildinfo"/);
  });

  it('CRITICAL internal-package tsconfig include + exclude pinned — include:["src/**/*"] + exclude:["dist","node_modules","tests"]. The tests-excluded shape matches the per-package vitest convention (tests live alongside but compile separately).', () => {
    const p = read(resolve(REPO_ROOT, INTERNAL_PACKAGES[0]!));
    expect(p).toMatch(/"include": \["src\/\*\*\/\*"\]/);
    expect(p).toMatch(/"exclude": \["dist", "node_modules", "tests"\]/);
  });

  // ─── Cross-group sanity ───────────────────────────────────────

  it('CRITICAL Astro apps + internal packages use DIFFERENT base configs. Astro extends astro/tsconfigs/strict; internal packages extend ../../tsconfig.base.json. Drift to using the same base would either lose Astro-specific JSX defaults or pull astro dep into non-astro packages.', () => {
    const astro = read(resolve(REPO_ROOT, ASTRO_APPS[0]!));
    const internal = read(resolve(REPO_ROOT, INTERNAL_PACKAGES[0]!));
    expect(astro).not.toBe(internal);
    expect(astro).toMatch(/astro\/tsconfigs\/strict/);
    expect(internal).toMatch(/tsconfig\.base\.json/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/tsconfig-cross-app-and-cross-package-byte-identity-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
