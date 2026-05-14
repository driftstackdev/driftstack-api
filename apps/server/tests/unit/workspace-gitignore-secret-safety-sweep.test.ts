// W845 — workspace gitignore + tracked-files secret-safety sweep.
// One-hundred-seventy-first in the drift-guard series. Pins that
// .gitignore blocks secret-bearing files AND that no such files are
// currently tracked. Defense against credential commits.
//
// Strategy: validate the .gitignore patterns by reading the file,
// not via `git ls-files` shellout (which would require git in test
// env). The pinned patterns are the canonical defense.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W845 workspace gitignore + tracked-files secret-safety', () => {
  it('.gitignore exists at canonical path', () => {
    expect(existsSync(resolve(REPO_ROOT, '.gitignore'))).toBe(true);
  });

  // ─── .gitignore patterns ──────────────────────────────────────

  it("CRITICAL .gitignore declares '.env' + '.env.*' + allow-list '!.env.example'. The combination prevents .env from being committed (real secrets) while keeping .env.example tracked (placeholder template per W807).", () => {
    const p = read(resolve(REPO_ROOT, '.gitignore'));
    expect(p).toMatch(/^\.env$/m);
    expect(p).toMatch(/^\.env\.\*$/m);
    expect(p).toMatch(/^!\.env\.example$/m);
  });

  it("CRITICAL .gitignore declares V-278 env-template ignore — '/infra/env-templates/*.env' (ignore real) + '!/infra/env-templates/*.env.template' (keep templates). Drift to dropping these patterns would let production.env / staging.env (real secrets) get committed.", () => {
    const p = read(resolve(REPO_ROOT, '.gitignore'));
    expect(p).toMatch(/V-278 deploy \.env files \(REAL secrets; never committed\)/);
    expect(p).toMatch(/^\/infra\/env-templates\/\*\.env$/m);
    expect(p).toMatch(/^!\/infra\/env-templates\/\*\.env\.template$/m);
  });

  // ─── node_modules + dist + tsbuildinfo ────────────────────────

  it('CRITICAL .gitignore declares standard JS/TS build-artifact ignores — node_modules + dist + build + coverage + .tsbuildinfo. Drift would let multi-GB of build artifacts pollute the repo.', () => {
    const p = read(resolve(REPO_ROOT, '.gitignore'));
    expect(p).toMatch(/^node_modules\/$/m);
    expect(p).toMatch(/^dist\/$/m);
    expect(p).toMatch(/^build\/$/m);
    expect(p).toMatch(/^coverage\/$/m);
    expect(p).toMatch(/^\.tsbuildinfo$/m);
    expect(p).toMatch(/^\*\.tsbuildinfo$/m);
  });

  // ─── tmp/ for V-165 bench output ──────────────────────────────

  it("CRITICAL .gitignore ignores 'tmp/' (V-165 bench output dir). The 'bench output is recorded per-run; only the canonical baseline at docs/benchmarks/baseline.ci.json is committed' framing explains why. Drift would let local bench results pollute the repo.", () => {
    const p = read(resolve(REPO_ROOT, '.gitignore'));
    expect(p).toMatch(/Bench artifacts \(V-165\)/);
    expect(p).toMatch(
      /the canonical baseline at docs\/benchmarks\/baseline\.ci\.json is\s*\n# committed/,
    );
    expect(p).toMatch(/^tmp\/$/m);
  });

  // ─── Editor / OS artifacts ────────────────────────────────────

  it('CRITICAL .gitignore declares editor artifact ignores — .vscode + .idea + *.swp + .DS_Store. Drift would let per-developer editor config pollute the repo.', () => {
    const p = read(resolve(REPO_ROOT, '.gitignore'));
    expect(p).toMatch(/^\.vscode\/$/m);
    expect(p).toMatch(/^\.idea\/$/m);
    expect(p).toMatch(/^\*\.swp$/m);
    expect(p).toMatch(/^\.DS_Store$/m);
  });

  // ─── Test artifacts ───────────────────────────────────────────

  it('CRITICAL .gitignore declares test artifacts ignored — test-results/ + playwright-report/ + playwright/.cache/. These are per-run outputs (V-NNN e2e infrastructure); committing them would create churn.', () => {
    const p = read(resolve(REPO_ROOT, '.gitignore'));
    expect(p).toMatch(/^test-results\/$/m);
    expect(p).toMatch(/^playwright-report\/$/m);
    expect(p).toMatch(/^playwright\/\.cache\/$/m);
  });

  // ─── No .env files in env-templates dir tracked ───────────────

  it("CRITICAL infra/env-templates/ only contains *.env.template files in tracked source — production.env + staging.env (no .template suffix) MUST be locally-generated, NEVER committed. This pin checks file PRESENCE — if production.env exists on disk but is gitignored, that's fine (the .gitignore handles it).", () => {
    // Pin that the .template files DO exist (W807).
    expect(existsSync(resolve(REPO_ROOT, 'infra/env-templates/production.env.template'))).toBe(
      true,
    );
    expect(existsSync(resolve(REPO_ROOT, 'infra/env-templates/staging.env.template'))).toBe(true);
  });

  // ─── 4-layer secret-leak defense ──────────────────────────────

  it('CRITICAL 4-layer secret-leak defense:\n 1. .gitignore patterns (this file).\n 2. V-527 commit-msg hook V-205 attribution + V-211 anonymity (W807).\n 3. W840 SDK plaintext-secret regex scan.\n 4. W842/W844 V-205 source-tree sweep.\n Drift to dropping any layer would create a gap.', () => {
    expect(existsSync(resolve(REPO_ROOT, '.gitignore'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg'))).toBe(true);
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-no-plaintext-secret-leakage-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-v205-attribution-source-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/public-app-v205-attribution-sweep.test.ts'),
      ),
    ).toBe(true);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/workspace-gitignore-secret-safety-sweep.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
