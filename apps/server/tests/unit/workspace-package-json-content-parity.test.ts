// W529.A — drift guard for /package.json (workspace root).
// Top-level monorepo manifest. Drift here either changes the
// workspaces array (would silently exclude an app/package from the
// monorepo build pipeline), changes a key script (would break CI),
// or drops a load-bearing devDep (would silently disable typecheck,
// lint, test, or bench).
//
//   • Workspace identity: driftstack-api, private:true, type:module,
//     license:MIT, engines.node>=22.
//   • workspaces: apps/* + packages/*.
//   • dev:all 6-app concurrently (server + dashboard + admin + marketing
//     + docs + status).
//   • pretest hook: npm run build (ordered: build:packages then build:apps; ensures fresh builds
//     before vitest).
//   • db:* scripts wire to drizzle-kit + apps/server.
//   • sdk:python:* 4-script ladder: dump-spec + generate + test + lint.
//   • husky prepare + lint-staged (eslint --fix + prettier at 8 GB heap).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W529.A /package.json (workspace root) content parity', () => {
  const body = read(LIB);
  const pkg = JSON.parse(body) as {
    name: string;
    private: boolean;
    type: string;
    license: string;
    engines: Record<string, string>;
    workspaces: string[];
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
    'lint-staged': Record<string, string[]>;
  };

  it("Workspace identity framing pinned: 'name: driftstack-api' + 'private: true' + 'type: module' + 'license: MIT' + 'engines.node: >=22' — pinned so the monorepo-root-identity + never-publish-to-npm + ESM + Node-22-minimum commitment survives (drift to lowering engines.node would silently allow incompatible Node versions to run prod)", () => {
    expect(pkg.name).toBe('driftstack-api');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.license).toBe('MIT');
    expect(pkg.engines.node).toBe('>=22.12.0');
  });

  it("workspaces 2-glob framing pinned: 'apps/*' + 'packages/*' — pinned so the npm-workspaces include glob (every app + package gets npm-link'd, every workspace script runs across apps/* + packages/*) commitment survives (drift to dropping packages/* would orphan sdk-typescript + api-types from the monorepo)", () => {
    expect(pkg.workspaces).toEqual(['apps/*', 'packages/*']);
  });

  it("dev:all 6-app concurrently framing pinned: 'concurrently --names server,dashboard,admin,marketing,docs,status --prefix-colors auto -k npm:dev:server npm:dev:dashboard npm:dev:admin npm:dev:marketing npm:dev:docs npm:dev:status' + 6-per-app dev:server/dashboard/admin/marketing/docs/status scripts wired to @driftstack/* workspaces — pinned so the 6-app dev-all + per-app dev-script commitment survives", () => {
    expect(pkg.scripts['dev:all']).toBe(
      "concurrently --names server,dashboard,admin,marketing,docs,status --prefix-colors auto -k 'npm:dev:server' 'npm:dev:dashboard' 'npm:dev:admin' 'npm:dev:marketing' 'npm:dev:docs' 'npm:dev:status'",
    );
    expect(pkg.scripts['dev:server']).toBe('npm run dev --workspace @driftstack/server');
    expect(pkg.scripts['dev:dashboard']).toBe(
      'npm run dev --workspace @driftstack/customer-dashboard',
    );
    expect(pkg.scripts['dev:admin']).toBe('npm run dev --workspace @driftstack/admin-panel');
    expect(pkg.scripts['dev:marketing']).toBe('npm run dev --workspace @driftstack/marketing-site');
    expect(pkg.scripts['dev:docs']).toBe('npm run dev --workspace @driftstack/docs');
    expect(pkg.scripts['dev:status']).toBe('npm run dev --workspace @driftstack/status-site');
  });

  it("test + pretest + lint + typecheck framing pinned: 'pretest: npm run build' (ordered fresh-build hook, build:packages then build:apps, before vitest) + 'test: vitest run' + 'test:watch: vitest' + 'bench: vitest bench --run' + 'bench:check-regression: node scripts/check-bench-regression.mjs' + 'typecheck: npm run typecheck --workspaces --if-present' + 'lint: eslint . && node scripts/check-subprocessor-mirror.mjs' + format/format:check running prettier through node with an explicit heap — pinned so the pretest-build-hook + test/bench/typecheck/lint workspace propagation + check-subprocessor-mirror lint-companion commitment survives", () => {
    // 2026-05-20 — pretest wraps the workspace build in a
    // PUBLIC_API_BASE_URL default so astro builds don't crash when
    // the env var is unset (pre-push gate guarantee per task #45);
    // assert the env-default literal + the trailing build command.
    //
    // 2026-07-31 — prefixed with the stale-vite-cache healer. A vite cache
    // entry can embed an absolute path under the OS temp root, which macOS
    // reaps; vitest then fails to COLLECT the affected files and the suite
    // silently shrinks (measured: 26,400 tests to 645) with only a cryptic
    // ENOENT to go on. The healer runs first so the build below, and the suite
    // after it, start from a cache that is not pointing at a dead path.
    expect(pkg.scripts.pretest).toBe(
      'node scripts/clear-stale-vite-cache.mjs && ' +
        'PUBLIC_API_BASE_URL="${PUBLIC_API_BASE_URL:-http://localhost:3000}" npm run build',
    );
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.scripts['test:watch']).toBe('vitest');
    expect(pkg.scripts.bench).toBe('vitest bench --run');
    expect(pkg.scripts['bench:check-regression']).toBe('node scripts/check-bench-regression.mjs');
    expect(pkg.scripts.typecheck).toBe('npm run typecheck --workspaces --if-present');
    expect(pkg.scripts.lint).toBe('eslint . && node scripts/check-subprocessor-mirror.mjs');
    // Both format scripts invoke prettier's CJS entry through node with an
    // explicit --max-old-space-size. Bare `prettier --check .` ABORTS with a
    // heap OOM on this repo at Node's default limit (measured: 4288 MB here,
    // exit 134) — the gate could not be run locally at all, and formatting was
    // never the problem: with a larger heap it reports zero violations.
    //
    // Pinned on the SHAPE rather than the exact byte string, so raising the
    // ceiling later is not a test edit, while dropping the heap flag — which is
    // the regression, since it silently restores an unrunnable gate — still is.
    for (const script of ['format', 'format:check'] as const) {
      expect(pkg.scripts[script], `${script} runs prettier through node`).toMatch(
        /^node --max-old-space-size=\d+ \.\/node_modules\/prettier\/bin\/prettier\.cjs /,
      );
    }
    expect(pkg.scripts.format, 'format still writes').toMatch(/--write \.$/);
    expect(pkg.scripts['format:check'], 'format:check still checks').toMatch(/--check \.$/);
  });

  it("db + sdk:python framing pinned: 'db:generate: drizzle-kit generate' + 'db:migrate: npm run db:migrate --workspace apps/server' + 'db:seed: npm run db:seed --workspace apps/server' + 'db:studio: drizzle-kit studio' + 'sdk:python:dump-spec: tsx apps/server/src/lib/dump-openapi.ts packages/sdk-python/openapi.json' + 'sdk:python:generate: bash packages/sdk-python/scripts/generate.sh' + 'sdk:python:test: cd packages/sdk-python && .venv/bin/pytest' + 'sdk:python:lint: cd packages/sdk-python && .venv/bin/ruff check . && .venv/bin/ruff format --check .' — pinned so the 4-db-script + 4-sdk:python-script ladder (dump-spec → generate → test → lint) commitment survives", () => {
    expect(pkg.scripts['db:generate']).toBe('drizzle-kit generate');
    expect(pkg.scripts['db:migrate']).toBe('npm run db:migrate --workspace apps/server');
    expect(pkg.scripts['db:seed']).toBe('npm run db:seed --workspace apps/server');
    expect(pkg.scripts['db:studio']).toBe('drizzle-kit studio');
    expect(pkg.scripts['sdk:python:dump-spec']).toBe(
      'tsx apps/server/src/lib/dump-openapi.ts packages/sdk-python/openapi.json',
    );
    expect(pkg.scripts['sdk:python:generate']).toBe('bash packages/sdk-python/scripts/generate.sh');
    expect(pkg.scripts['sdk:python:test']).toBe('cd packages/sdk-python && .venv/bin/pytest');
    // 2026-07-31 — mypy over `src examples` appended. The twelve example
    // scripts are what a customer copies, and ruff only checks their syntax: a
    // call to a renamed or removed SDK method lints clean and ships broken. The
    // Go SDK gets this for free via `go build ./examples/...`; Python did not.
    expect(pkg.scripts['sdk:python:lint']).toBe(
      'cd packages/sdk-python && .venv/bin/ruff check . && .venv/bin/ruff format --check . && ' +
        '.venv/bin/mypy src examples',
    );
  });

  it("Critical devDep + lint-staged + husky framing pinned: 7-tooling devDeps (eslint + prettier + vitest + drizzle-kit + drizzle-orm + tsx + typescript) + 'prepare: husky' + lint-staged 2-pattern (ts/tsx/js/jsx/mjs/cjs → eslint --fix + prettier; json/md/yml/yaml/css → prettier only), both invoking prettier through node with --max-old-space-size=8192 — pinned so the toolchain dep-set + husky-prepare-hook + lint-staged 2-pattern commitment survives (drift to dropping eslint --fix would let unfixable lint errors slip into commits; drift back to a bare `prettier --write` reinstates the V-774 OOM that blocked every commit touching docs/verification-log.md, since the repo's own format scripts alreadyneed the 8 GB heap)", () => {
    expect(pkg.devDependencies).toHaveProperty('eslint');
    expect(pkg.devDependencies).toHaveProperty('prettier');
    expect(pkg.devDependencies).toHaveProperty('vitest');
    expect(pkg.devDependencies).toHaveProperty('drizzle-kit');
    expect(pkg.devDependencies).toHaveProperty('drizzle-orm');
    expect(pkg.devDependencies).toHaveProperty('tsx');
    expect(pkg.devDependencies).toHaveProperty('typescript');
    expect(pkg.devDependencies).toHaveProperty('husky');
    expect(pkg.devDependencies).toHaveProperty('lint-staged');
    expect(pkg.scripts.prepare).toBe('husky');
    expect(pkg['lint-staged']['*.{ts,tsx,js,jsx,mjs,cjs}']).toEqual([
      'eslint --fix',
      'node --max-old-space-size=8192 ./node_modules/prettier/bin/prettier.cjs --write',
    ]);
    expect(pkg['lint-staged']['*.{json,md,yml,yaml,css}']).toEqual([
      'node --max-old-space-size=8192 ./node_modules/prettier/bin/prettier.cjs --write',
    ]);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
