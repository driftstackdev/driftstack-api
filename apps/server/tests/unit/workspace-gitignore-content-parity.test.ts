// W539.A — drift guard for /.gitignore (workspace root).
// V-278 deploy-secret exclusion + Cargo.lock-binary commit-this
// posture. Drift here either accidentally commits /infra/env-templates/
// real secret files (would leak prod credentials), commits a Drizzle
// .migrations-applied marker (would break the migration-runner
// idempotency), or excludes Cargo.lock from the Tauri GUI binary
// (would break reproducible-binary builds — V-289).
//
//   • Standard Node ignores: node_modules + dist + build + coverage
//     + *.tsbuildinfo.
//   • V-278 deploy-env exclusion: /infra/env-templates/*.env stays
//     IGNORED, *.env.template stays TRACKED.
//   • .env stays ignored; .env.example stays TRACKED.
//   • Drizzle: .migrations-applied stays ignored.
//   • Tauri/Rust: target/ + gen/ ignored, but Cargo.lock IS committed
//     (rationale comment: binaries should commit Cargo.lock).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, '.gitignore');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W539.A /.gitignore content parity', () => {
  const body = read(LIB);

  it("Standard Node ignores pinned: 'node_modules/' + 'dist/' + 'build/' + 'coverage/' + '.tsbuildinfo' + '*.tsbuildinfo' — pinned so the standard-Node-build-artefact exclusion commitment survives (drift to dropping any of these would accidentally commit build output)", () => {
    expect(body).toMatch(/^node_modules\/$/m);
    expect(body).toMatch(/^dist\/$/m);
    expect(body).toMatch(/^build\/$/m);
    expect(body).toMatch(/^coverage\/$/m);
    expect(body).toMatch(/^\.tsbuildinfo$/m);
    expect(body).toMatch(/^\*\.tsbuildinfo$/m);
  });

  it("V-278 env-template + .env.example whitelist framing pinned: '.env' + '.env.*' + '!.env.example' (whitelist re-includes the committed example) + '# V-278 deploy .env files (REAL secrets; never committed). The .template versions ARE committed.' + '/infra/env-templates/*.env' + '!/infra/env-templates/*.env.template' — pinned so the V-278 deploy-secret exclusion + .template-versions-tracked + .env.example-whitelist commitment survives (drift to accidentally tracking /infra/env-templates/*.env would leak prod credentials on next git add)", () => {
    expect(body).toMatch(/^\.env$/m);
    expect(body).toMatch(/^\.env\.\*$/m);
    expect(body).toMatch(/^!\.env\.example$/m);
    expect(body).toMatch(
      /# V-278 deploy \.env files \(REAL secrets; never committed\)\. The\s*# \.template versions ARE committed\./,
    );
    expect(body).toMatch(/^\/infra\/env-templates\/\*\.env$/m);
    expect(body).toMatch(/^!\/infra\/env-templates\/\*\.env\.template$/m);
  });

  it("Editor + log + test-artefact framing pinned: '.vscode/' + '.idea/' + '*.swp' + '.DS_Store' + '*.log' + 'npm-debug.log*' + 'test-results/' + 'playwright-report/' + 'playwright/.cache/' — pinned so the editor-junk + macOS-Finder-junk + Playwright-output exclusion commitment survives (drift to dropping playwright/.cache/ would balloon repo size with cached browser binaries)", () => {
    expect(body).toMatch(/^\.vscode\/$/m);
    expect(body).toMatch(/^\.idea\/$/m);
    expect(body).toMatch(/^\*\.swp$/m);
    expect(body).toMatch(/^\.DS_Store$/m);
    expect(body).toMatch(/^\*\.log$/m);
    expect(body).toMatch(/^npm-debug\.log\*$/m);
    expect(body).toMatch(/^test-results\/$/m);
    expect(body).toMatch(/^playwright-report\/$/m);
    expect(body).toMatch(/^playwright\/\.cache\/$/m);
  });

  it("V-165 bench-artefact + Drizzle-migration-marker framing pinned: '# Bench artifacts (V-165) — bench output is recorded per-run; only the canonical baseline at docs/benchmarks/baseline.ci.json is committed.' + 'tmp/' + '# Drizzle' + 'drizzle/.migrations-applied' — pinned so the V-165 bench-per-run-tmp + baseline-in-docs-only + Drizzle-idempotency-marker-ignored commitment survives (drift to tracking drizzle/.migrations-applied would break the migration-runner's idempotency check across machines)", () => {
    expect(body).toMatch(
      /# Bench artifacts \(V-165\) — bench output is recorded per-run; only\s*# the canonical baseline at docs\/benchmarks\/baseline\.ci\.json is\s*# committed\./,
    );
    expect(body).toMatch(/^tmp\/$/m);
    expect(body).toMatch(/^# Drizzle$/m);
    expect(body).toMatch(/^drizzle\/\.migrations-applied$/m);
  });

  it("Python-SDK + .npmrc framing pinned: '# Python SDK' + '.venv/' + '__pycache__/' + '*.egg-info/' + '.pytest_cache/' + '.mypy_cache/' + '.ruff_cache/' + 'packages/sdk-python/dist/' + '.npmrc' — pinned so the Python-SDK-tooling-cache + .npmrc-with-NPM_TOKEN exclusion commitment survives (drift to tracking .npmrc would leak the NPM_TOKEN registry secret)", () => {
    expect(body).toMatch(/^# Python SDK$/m);
    expect(body).toMatch(/^\.venv\/$/m);
    expect(body).toMatch(/^__pycache__\/$/m);
    expect(body).toMatch(/^\*\.egg-info\/$/m);
    expect(body).toMatch(/^\.pytest_cache\/$/m);
    expect(body).toMatch(/^\.mypy_cache\/$/m);
    expect(body).toMatch(/^\.ruff_cache\/$/m);
    expect(body).toMatch(/^packages\/sdk-python\/dist\/$/m);
    expect(body).toMatch(/^\.npmrc$/m);
  });

  it("Tauri + Cargo.lock-commit-this framing pinned: '# GUI client (Tauri)' + 'apps/gui-client/dist/' + 'apps/gui-client/src-tauri/target/' + 'apps/gui-client/src-tauri/gen/' + '# Cargo.lock SHOULD be committed for binaries (Tauri app is a binary).' — pinned so the V-289 Tauri-target+gen exclusion + Cargo.lock-IS-tracked (because binary, not library) commitment survives (drift to ignoring Cargo.lock would break reproducible-binary builds; drift to tracking target/ would balloon repo size with Rust build output)", () => {
    expect(body).toMatch(/^# GUI client \(Tauri\)$/m);
    expect(body).toMatch(/^apps\/gui-client\/dist\/$/m);
    expect(body).toMatch(/^apps\/gui-client\/src-tauri\/target\/$/m);
    expect(body).toMatch(/^apps\/gui-client\/src-tauri\/gen\/$/m);
    expect(body).toMatch(
      /# Cargo\.lock SHOULD be committed for binaries \(Tauri app is a binary\)\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
