// W723 — GitHub Actions ci.yml workflow parity. Fiftieth in the
// cross-SDK drift-guard series (W649 + W675-W723).
//
// Pins .github/workflows/ci.yml as the AUTHORITATIVE CI workflow.
// The 5-job matrix MUST stay in shape:
//   build-test (TS + integration with coverage thresholds)
//   e2e (Playwright against real Postgres + Redis)
//   python-sdk (ruff + mypy + pytest + wheel smoke-test)
//   go-sdk (vet + test + examples build)
//   bench-regression (advisory mode, V-165)
//
// CRITICAL invariants:
//   1. Trigger surface: push to main + PR to main, with
//      cancel-in-progress concurrency (prevents stale CI runs from
//      blocking new commits).
//   2. Node 22 across all Node jobs; Python 3.10; Go 1.22.
//   3. Postgres 17 + Redis 7 services with health-check gates.
//   4. Coverage thresholds enforced (V-107).
//   5. Python wheel smoke-test verifies 7-resource accessor wiring
//      on both Driftstack + AsyncDriftstack.
//   6. bench-regression is `continue-on-error: true` (advisory; V-165
//      framing pinned).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const CI = resolve(REPO_ROOT, '.github/workflows/ci.yml');

describe('W723 GitHub Actions ci.yml workflow parity', () => {
  it('ci.yml file exists', () => {
    expect(existsSync(CI), `missing ${CI}`).toBe(true);
  });

  it('CRITICAL trigger surface pinned — push:[main] + pull_request:[main]. Drift to dropping pull_request would let PRs land without CI; drift to dropping push:[main] would skip post-merge verification.', () => {
    const c = read(CI);
    expect(c).toMatch(
      /on:\s*\n\s*push:\s*\n\s*branches: \[main\]\s*\n\s*pull_request:\s*\n\s*branches: \[main\]/,
    );
  });

  it('CRITICAL concurrency `cancel-in-progress: true` pinned. Cancels stale CI runs when a new commit lands on the same ref — prevents pipeline saturation from busy days. Drift to false would let queued runs stack up.', () => {
    const c = read(CI);
    expect(c).toMatch(
      /concurrency:\s*\n\s*group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: true/,
    );
  });

  it('CRITICAL 5-job roster pinned — build-test + e2e + python-sdk + go-sdk + bench-regression. Drift to dropping any job would silently widen the surface that ships unverified.', () => {
    const c = read(CI);

    const jobs = ['build-test', 'e2e', 'python-sdk', 'go-sdk', 'bench-regression'];
    for (const job of jobs) {
      expect(c, `job ${job}`).toMatch(new RegExp(`^\\s*${job}:\\s*\\n`, 'm'));
    }
  });

  it('CRITICAL Node 22 pinned across all Node jobs. Drift to Node 18 or 20 would silently change runtime semantics; CI must match the npm engines field + production runtime.', () => {
    const c = read(CI);

    // 3 actions/setup-node steps (build-test + e2e + bench-regression) use node-version: '22'.
    const node22Matches = (c.match(/node-version: '22'/g) ?? []).length;
    expect(node22Matches, "node-version '22' references").toBeGreaterThanOrEqual(3);
  });

  it('CRITICAL Postgres 17-alpine + Redis 7-alpine service images pinned. Drift to PG 16 would change driver behavior (some PG 17-specific features); drift to Redis 6 would lose some commands; alpine is what keeps the runner-image pull fast.', () => {
    const c = read(CI);

    // 2 PG 17-alpine services (build-test + e2e).
    const pgMatches = (c.match(/image: postgres:17-alpine/g) ?? []).length;
    expect(pgMatches, 'PG 17-alpine service references').toBe(2);

    // 2 Redis 7-alpine services.
    const redisMatches = (c.match(/image: redis:7-alpine/g) ?? []).length;
    expect(redisMatches, 'Redis 7-alpine service references').toBe(2);
  });

  it('CRITICAL service health-check options pinned — interval 5s, timeout 5s, retries 10. Drift to longer intervals would slow CI; drift to fewer retries would flake more often on cold-start runners.', () => {
    const c = read(CI);

    // PG health-cmd.
    expect(c).toMatch(/--health-cmd "pg_isready -U driftstack -d driftstack"/);
    // Redis health-cmd.
    expect(c).toMatch(/--health-cmd "redis-cli ping"/);

    // Counts — appears in both PG + Redis service blocks (4 total).
    const intervals = (c.match(/--health-interval 5s/g) ?? []).length;
    const timeouts = (c.match(/--health-timeout 5s/g) ?? []).length;
    const retries = (c.match(/--health-retries 10/g) ?? []).length;
    expect(intervals).toBe(4);
    expect(timeouts).toBe(4);
    expect(retries).toBe(4);
  });

  it('CRITICAL test-env DATABASE_URL + REDIS_URL pinned to local services. Drift to remote URLs would leak credentials into CI logs; the localhost addresses match the service ports.', () => {
    const c = read(CI);

    expect(c).toMatch(
      /DATABASE_URL: postgres:\/\/driftstack:driftstack@localhost:5432\/driftstack/,
    );
    expect(c).toMatch(/REDIS_URL: redis:\/\/localhost:6379/);
    expect(c).toMatch(/DRIVER: mock/);
    expect(c).toMatch(/NODE_ENV: test/);
  });

  it('CRITICAL V-107 coverage thresholds enforced — `npx vitest run --coverage`. The vitest.config.ts gate is what blocks coverage regressions; CI invokes the coverage runner explicitly.', () => {
    const c = read(CI);

    expect(c).toMatch(
      /V-107: vitest\.config\.ts enforces coverage thresholds \(lines,\s*\n\s*#\s*statements, functions, branches\)/,
    );
    expect(c).toMatch(
      /CI fails if coverage drops\s*\n\s*#\s*below the regression gate set in V-107/,
    );
    expect(c).toMatch(/npx vitest run --coverage/);
  });

  it('CRITICAL build-test 4-step verify chain pinned — Build → Typecheck → Lint → Format-check → Tests. Mirrors W722 pre-push gate ordering; drift to reordering would let one regression mask another.', () => {
    const c = read(CI);

    const order = [
      // Renamed 2026-08-11: the old label claimed the step built only
      // api-types + sdk + server, but `npm run build` is
      // build:packages && build:apps — it builds all six Astro apps, two
      // of which fail closed without PUBLIC_API_BASE_URL. That label is
      // what let the missing env go unnoticed.
      'Build (packages + server + all six Astro apps)',
      'Build SDK (tsup ESM + CJS + .d.ts)',
      'Typecheck',
      'Lint',
      'Format check',
      'Test (unit + integration) with coverage thresholds',
    ];

    let lastIdx = -1;
    for (const step of order) {
      const idx = c.indexOf(step);
      expect(idx, `step ${step}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('CRITICAL e2e job depends on build-test (`needs: build-test`). Drift to running e2e in parallel would let Playwright tests start against a stale build; the needs-gate forces the build to succeed first.', () => {
    const c = read(CI);

    expect(c).toMatch(
      /e2e:\s*\n\s*name: End-to-end \(Playwright against real Postgres \+ Redis\)\s*\n\s*needs: build-test/,
    );
  });

  it('CRITICAL e2e Playwright HTML report uploaded on failure. The `if: failure()` + actions/upload-artifact@v7 contract is what gives engineers the report when CI fails; drift to always-upload would waste artifact storage on successful runs.', () => {
    const c = read(CI);

    expect(c).toMatch(/if: failure\(\)\s*\n\s*uses: actions\/upload-artifact@v7/);
    expect(c).toMatch(/name: playwright-report/);
    expect(c).toMatch(/path: apps\/server\/playwright-report\//);
    expect(c).toMatch(/retention-days: 7/);
  });

  it('CRITICAL python-sdk job 5-step chain — install + ruff check + ruff format + mypy + pytest. Drift to dropping ruff format would let format regressions land; drift to dropping mypy strict would weaken type guarantees.', () => {
    const c = read(CI);

    expect(c).toMatch(/python-version: '3\.10'/);
    expect(c).toMatch(/pip install -e '\.\[dev\]'/);
    expect(c).toMatch(/run: ruff check \./);
    expect(c).toMatch(/run: ruff format --check \./);
    expect(c).toMatch(/Mypy \(strict on hand-written code\)/);
    expect(c).toMatch(/run: mypy src/);
    expect(c).toMatch(/run: pytest -v/);
  });

  it('CRITICAL Python wheel smoke-test verifies 7-resource accessor wiring on Driftstack + AsyncDriftstack. The 7 resources are sessions/api_keys/usage/webhooks/profiles/billing/auth — drift to dropping a resource from the smoke-test would let SDK regen mis-wire silently.', () => {
    const c = read(CI);

    const resources = ['sessions', 'api_keys', 'usage', 'webhooks', 'profiles', 'billing', 'auth'];

    // hasattr(client, 'sessions') etc. on Driftstack sync.
    for (const r of resources) {
      expect(c, `Python smoke check hasattr(${r})`).toMatch(
        new RegExp(`hasattr\\(client, '${r}'\\)`),
      );
    }

    // AsyncDriftstack loop covers same 7 accessors.
    expect(c).toMatch(
      /for accessor in \['sessions', 'api_keys', 'usage', 'webhooks', 'profiles', 'billing', 'auth'\]/,
    );
    expect(c).toMatch(/all 7 resource accessors wired/);
  });

  it("CRITICAL Python wheel smoke-test verifies error-class imports — DriftstackError + RateLimitError + AuthError. Drift to dropping would let an SDK regen ship a wheel that doesn't expose the canonical error roster (W707).", () => {
    const c = read(CI);
    expect(c).toMatch(/from driftstack import DriftstackError, RateLimitError, AuthError/);
  });

  it('CRITICAL Python wheel smoke-test pinned API-key prefix `ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`. The 32-char pattern after `ds_test_` is what the SDK validates against. Drift to a shorter or non-matching key would fail SDK validation.', () => {
    const c = read(CI);
    expect(c).toMatch(/client = Driftstack\(api_key='ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\)/);
    expect(c).toMatch(
      /aclient = AsyncDriftstack\(api_key='ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\)/,
    );
  });

  it('CRITICAL go-sdk job 3-step chain — go vet + go test + go build examples. Drift to dropping examples build would let example regressions land silently.', () => {
    const c = read(CI);

    expect(c).toMatch(/go-version: '1\.22'/);
    expect(c).toMatch(/cache: false # no go\.sum yet — zero non-stdlib runtime deps/);
    expect(c).toMatch(/run: go vet \.\/\.\.\./);
    expect(c).toMatch(/run: go test -v \.\/\.\.\./);
    expect(c).toMatch(/Build examples/);
    expect(c).toMatch(/run: go build \.\/examples\/\.\.\./);
  });

  it('CRITICAL V-165 bench-regression job is ADVISORY (`continue-on-error: true`). Drift to a hard gate would produce false failures on shared-runner noise — the V-log notes this is a separate founder decision once baseline variance accumulates.', () => {
    const c = read(CI);

    expect(c).toMatch(/V-165 — perf regression check \(advisory mode\)/);
    expect(c).toMatch(/continue-on-error: true/);
    expect(c).toMatch(/`continue-on-error: true` because:/);
    expect(c).toMatch(
      /bench results on shared runners are noisy; a hard\s*\n\s*#\s*gate would produce false failures/,
    );
    expect(c).toMatch(/Flipping to a hard gate is a separate founder decision/);
  });

  it('CRITICAL bench-regression threshold + override-env pinned — 50% slowdown vs checked-in CI baseline at docs/benchmarks/baseline.ci.json, override via PERF_REGRESSION_THRESHOLD env var.', () => {
    const c = read(CI);

    expect(c).toMatch(
      /Threshold: 50% slowdown vs the checked-in CI baseline at\s*\n\s*#\s*docs\/benchmarks\/baseline\.ci\.json/,
    );
    expect(c).toMatch(/Override via the\s*\n\s*#\s*PERF_REGRESSION_THRESHOLD env var/);
    expect(c).toMatch(/npm run bench:check-regression/);
  });

  it('CRITICAL bench-regression depends on build-test — `needs: build-test`. Drift to running in parallel would let the bench run against a stale or broken build.', () => {
    const c = read(CI);
    expect(c).toMatch(/bench-regression:[\s\S]{0,1200}needs: build-test/);
  });

  it('CRITICAL actions versions pinned at major-version tags — checkout@v6 + setup-node@v6 + setup-python@v6 + setup-go@v6 + upload-artifact@v7. Drift to floating @main or @latest would let GitHub silently roll changes mid-CI.', () => {
    const c = read(CI);

    expect(c).toMatch(/uses: actions\/checkout@v6/);
    expect(c).toMatch(/uses: actions\/setup-node@v6/);
    expect(c).toMatch(/uses: actions\/setup-python@v6/);
    expect(c).toMatch(/uses: actions\/setup-go@v6/);
    expect(c).toMatch(/uses: actions\/upload-artifact@v7/);
  });

  it('CRITICAL ubuntu-latest runner pinned for all 5 jobs. Drift to ubuntu-22.04-pin or macos-latest would change the runtime environment + cost.', () => {
    const c = read(CI);

    const runners = (c.match(/runs-on: ubuntu-latest/g) ?? []).length;
    expect(runners, 'ubuntu-latest job runners').toBe(5);
  });

  it("CRITICAL every CI job sets timeout-minutes — bounds a hung run (e.g. catastrophic regex backtracking, cf. the documented multi-hour hang class) to minutes instead of GitHub's 6h default. build-test 60 / e2e 40 / python-sdk 25 / go-sdk 20 / bench-regression 25; values are generous vs normal runtime so runner contention never false-kills a legit run. Drift to dropping a timeout would re-expose the 6h-runaway footgun.", () => {
    const c = read(CI);

    const count = (c.match(/^\s*timeout-minutes: \d+$/gm) ?? []).length;
    expect(count, 'one timeout-minutes per job (5 jobs)').toBe(5);
    expect(c).toMatch(/timeout-minutes: 60/); // build-test
    expect(c).toMatch(/timeout-minutes: 40/); // e2e
    expect(c).toMatch(/timeout-minutes: 20/); // go-sdk
    const twentyFives = (c.match(/timeout-minutes: 25/g) ?? []).length;
    expect(twentyFives, 'python-sdk + bench-regression both 25').toBe(2);
  });

  it('CRITICAL "Install: npm ci" (not npm install) pinned in Node jobs. The frozen-lockfile install is what guarantees CI reproducibility; drift to `npm install` would let semver-range bumps slip in.', () => {
    const c = read(CI);

    const npmCiCount = (c.match(/run: npm ci$/gm) ?? []).length;
    expect(npmCiCount, 'npm ci invocations').toBeGreaterThanOrEqual(3);
  });

  it('CI workflow 6-invariant cluster — 5-job roster + Node 22 + PG 17 + Redis 7 + V-107 coverage gate + V-165 advisory bench + cancel-in-progress concurrency + frozen-lockfile npm ci.', () => {
    const c = read(CI);

    expect(c).toMatch(/build-test:/);
    expect(c).toMatch(/e2e:/);
    expect(c).toMatch(/python-sdk:/);
    expect(c).toMatch(/go-sdk:/);
    expect(c).toMatch(/bench-regression:/);
    expect(c).toMatch(/node-version: '22'/);
    expect(c).toMatch(/postgres:17-alpine/);
    expect(c).toMatch(/redis:7-alpine/);
    expect(c).toMatch(/V-107/);
    expect(c).toMatch(/V-165/);
    expect(c).toMatch(/cancel-in-progress: true/);
    expect(c).toMatch(/run: npm ci$/m);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/ci-workflow-parity.test.ts')),
    ).toBe(true);
  });
});
