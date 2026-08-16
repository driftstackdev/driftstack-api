// W541.A — drift guard for /.github/workflows/ci.yml.
// Primary CI workflow. Drift here either drops the service-container
// pg_isready + redis-ping healthchecks (would race the build-test job
// against unhealthy services), changes the docker-compose-credential-
// parity (driftstack/driftstack@5432/driftstack vs the local
// docker-compose service), drops V-107 coverage threshold enforcement
// (would let coverage regressions slip), drops V-103 7-resource-accessor
// SDK wheel smoke-test (would let SDK shape regress silently), or
// converts V-165 bench-regression from advisory to a hard gate (would
// produce false failures from shared-runner noise).
//
//   • 4 jobs: build-test + e2e + python-sdk + go-sdk + bench-regression.
//   • Service containers: postgres:17-alpine + redis:7-alpine with
//     pg_isready / redis-cli ping healthchecks (5s interval, 5s timeout,
//     10 retries — parity with /docker-compose.yml).
//   • Node 22 + actions/checkout@v6 + actions/setup-node@v6 +
//     actions/upload-artifact@v7.
//   • V-107 coverage threshold, run THROUGH verify-suite (--all).
//   • V-103 7-resource-accessor smoke-test (sessions + api_keys +
//     usage + webhooks + profiles + billing + auth).
//   • Python 3.10 ruff + mypy + pytest + build wheel + venv smoke.
//   • Go 1.22 vet + test + examples build (no go.sum yet).
//   • V-165 bench-regression with continue-on-error: true (advisory).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, '.github/workflows/ci.yml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W541.A /.github/workflows/ci.yml content parity', () => {
  const body = read(LIB);

  it("Top-level trigger + concurrency framing pinned: 'name: CI' + 'on: push: branches: [main] + pull_request: branches: [main]' + 'concurrency: group: ${{ github.workflow }}-${{ github.ref }} + cancel-in-progress: true' — pinned so the main-branch-push + main-PR + per-ref-cancel-in-progress (newer push cancels older run on same ref) commitment survives (drift to dropping cancel-in-progress would queue stale runs and exhaust runner minutes)", () => {
    expect(body).toMatch(/^name: CI$/m);
    expect(body).toMatch(/on:\s*\n\s*push:\s*\n\s*branches: \[main\]/);
    expect(body).toMatch(/pull_request:\s*\n\s*branches: \[main\]/);
    expect(body).toMatch(
      /concurrency:\s*\n\s*group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: true/,
    );
  });

  it("Service-container Postgres + Redis healthcheck framing pinned: 'postgres: image: postgres:17-alpine' + 'POSTGRES_USER: driftstack + POSTGRES_PASSWORD: driftstack + POSTGRES_DB: driftstack' + 'ports: 5432:5432' + '--health-cmd \"pg_isready -U driftstack -d driftstack\" --health-interval 5s --health-timeout 5s --health-retries 10' + 'redis: image: redis:7-alpine' + 'ports: 6379:6379' + '--health-cmd \"redis-cli ping\" --health-interval 5s --health-timeout 5s --health-retries 10' — pinned so the docker-compose-credential-parity + 5s/5s/10 healthcheck budget commitment survives (drift to different credentials would break the DATABASE_URL fallback; drift to looser healthcheck would let tests run against an unhealthy service and flake)", () => {
    expect(body).toMatch(/image: postgres:17-alpine/);
    expect(body).toMatch(/POSTGRES_USER: driftstack/);
    expect(body).toMatch(/POSTGRES_PASSWORD: driftstack/);
    expect(body).toMatch(/POSTGRES_DB: driftstack/);
    expect(body).toMatch(/--health-cmd "pg_isready -U driftstack -d driftstack"/);
    expect(body).toMatch(/image: redis:7-alpine/);
    expect(body).toMatch(/--health-cmd "redis-cli ping"/);
    expect(body).toMatch(/--health-interval 5s/);
    expect(body).toMatch(/--health-timeout 5s/);
    expect(body).toMatch(/--health-retries 10/);
  });

  it("env-var DATABASE_URL + REDIS_URL + DRIVER + NODE_ENV framing pinned: 'NODE_ENV: test' + 'DATABASE_URL: postgres://driftstack:driftstack@localhost:5432/driftstack' + 'REDIS_URL: redis://localhost:6379' + 'DRIVER: mock' — pinned so the NODE_ENV-test + exact-DATABASE_URL + Redis-6379 + mock-driver-in-CI (never webkit) commitment survives (drift to a different DATABASE_URL would break against the service container's published port; drift to DRIVER=webkit would attempt to load an unimplemented driver in CI)", () => {
    expect(body).toMatch(/NODE_ENV: test/);
    expect(body).toMatch(
      /DATABASE_URL: postgres:\/\/driftstack:driftstack@localhost:5432\/driftstack/,
    );
    expect(body).toMatch(/REDIS_URL: redis:\/\/localhost:6379/);
    expect(body).toMatch(/DRIVER: mock/);
  });

  it("Build-test job step framing pinned: 'actions/checkout@v6' + 'actions/setup-node@v6 with node-version: 22 + cache: npm' + 'npm ci' + 'npm run build' + 'npm run build --workspace packages/sdk-typescript' + 'npm run typecheck' + 'npm run lint' + 'npm run format:check' + V-107 coverage comment + 'npx vitest run --coverage' — pinned so the v6-actions + Node-22-with-npm-cache + 7-build-test step sequence + V-107 vitest.config.ts-coverage-threshold-enforces-regression-gate commitment survives (drift to skipping --coverage would let coverage regressions slip past CI)", () => {
    expect(body).toMatch(/uses: actions\/checkout@v6/);
    expect(body).toMatch(
      /uses: actions\/setup-node@v6\s*\n\s*with:\s*\n\s*node-version: '22'\s*\n\s*cache: 'npm'/,
    );
    expect(body).toMatch(/run: npm ci/);
    expect(body).toMatch(/run: npm run build$/m);
    expect(body).toMatch(/run: npm run build --workspace packages\/sdk-typescript/);
    expect(body).toMatch(/run: npm run typecheck/);
    expect(body).toMatch(/run: npm run lint/);
    expect(body).toMatch(/run: npm run format:check/);
    expect(body).toMatch(
      /# V-107: vitest\.config\.ts enforces coverage thresholds \(lines,\s*\n\s*# statements, functions, branches\)\. CI fails if coverage drops\s*\n\s*# below the regression gate set in V-107\./,
    );
    // Was `npx vitest run --coverage`, which inherited none of verify-suite's
    // judgement — and the incident that script exists for is a vitest run that
    // EXITS 0 while workers die and files never execute. Coverage cannot see
    // that either: a run that skipped files still reports high coverage over
    // the ones it did run. `--all` keeps the scope (root config + --coverage)
    // and adds the exit-code, unhandled-error and file-count checks.
    expect(body).toMatch(/run: node scripts\/verify-suite\.mjs --all/);
    expect(
      body,
      'CI must not call vitest directly again — that is how the judgement was lost',
    ).not.toMatch(/run: npx vitest run --coverage/);
  });

  it("CRITICAL production-dependency audit gate pinned: 'npm audit --omit=dev --audit-level=high'. Nothing else checks this — deploy.yml runs `npm ci --no-audit` — so dropping this step means a vulnerable RUNTIME dependency reaches production silently. The --omit=dev scope is equally load-bearing: the tree carries 12 advisories (5 high), every one build or lint tooling, so an unscoped gate would either block every PR or be permanently muted, and a muted gate catches nothing.", () => {
    expect(body).toMatch(/name: Audit production dependencies/);
    expect(body).toMatch(/run: npm audit --omit=dev --audit-level=high/);
    // The scope flag specifically — losing it is the failure mode that turns
    // this from a real gate into one somebody disables a week later.
    expect(body).toMatch(/npm audit[^\n]*--omit=dev/);
  });

  it("e2e job framing pinned: 'name: End-to-end (Playwright against real Postgres + Redis)' + 'needs: build-test' + 'CI: \\'true\\'' env var + 'working-directory: apps/server' + 'run: npm run test:e2e' + 'if: failure() + uses: actions/upload-artifact@v7' + 'name: playwright-report' + 'path: apps/server/playwright-report/' + 'retention-days: 7' — pinned so the e2e-needs-build-test + Playwright-against-real-DB+Redis (no mock) + CI-env-flag + failure-only-report-upload + 7-day-retention commitment survives (drift to retention-days: 30 would balloon artifact storage costs)", () => {
    expect(body).toMatch(/name: End-to-end \(Playwright against real Postgres \+ Redis\)/);
    expect(body).toMatch(/needs: build-test/);
    expect(body).toMatch(/CI: 'true'/);
    expect(body).toMatch(/working-directory: apps\/server/);
    expect(body).toMatch(/run: npm run test:e2e/);
    expect(body).toMatch(/if: failure\(\)/);
    expect(body).toMatch(/uses: actions\/upload-artifact@v7/);
    expect(body).toMatch(/name: playwright-report/);
    expect(body).toMatch(/path: apps\/server\/playwright-report\//);
    expect(body).toMatch(/retention-days: 7/);
  });

  it("Python SDK V-103 7-resource-accessor smoke-test framing pinned: 'Python SDK (lint + tests)' + 'python-version: \\'3.10\\'' + 'ruff check' + 'ruff format --check' + 'mypy src' + 'pytest -v' + 'pip install build + python -m build' + 'python -m venv /tmp/smoke + pip install dist/driftstack-*.whl' + V-103 imports 'from driftstack import Driftstack, AsyncDriftstack, verify_webhook_signature' + 'from driftstack import DriftstackError, RateLimitError, AuthError' + 'from driftstack._generated.models import Session, ApiKey, WebhookEndpoint' + Original-4-resources (sessions + api_keys + usage + webhooks) + V-103-additions (profiles + billing + auth) + async parity check across all 7 accessors + 'wheel smoke ok — all 7 resource accessors wired' — pinned so the V-103 7-resource-accessor + Python-3.10 + ruff + mypy + pytest + wheel-build-+-venv-smoke + async-parity-check commitment survives (drift to dropping any of the 7 accessors would catch a regression in the generated SDK shape)", () => {
    expect(body).toMatch(/name: Python SDK \(lint \+ tests\)/);
    expect(body).toMatch(/python-version: '3\.10'/);
    expect(body).toMatch(/run: ruff check \./);
    expect(body).toMatch(/run: ruff format --check \./);
    // `examples` is pinned explicitly, not just `mypy src`. The looser pattern
    // matches either form, so dropping example coverage would leave this guard
    // green while a renamed SDK method shipped in a script customers copy.
    expect(body).toMatch(/run: mypy src examples/);
    expect(body).toMatch(/run: pytest -v/);
    expect(body).toMatch(/pip install build/);
    expect(body).toMatch(/python -m build/);
    expect(body).toMatch(/python -m venv \/tmp\/smoke/);
    expect(body).toMatch(/\/tmp\/smoke\/bin\/pip install dist\/driftstack_sdk-\*\.whl/);
    expect(body).toMatch(
      /from driftstack import Driftstack, AsyncDriftstack, verify_webhook_signature/,
    );
    expect(body).toMatch(/from driftstack import DriftstackError, RateLimitError, AuthError/);
    expect(body).toMatch(
      /from driftstack\._generated\.models import Session, ApiKey, WebhookEndpoint/,
    );
    expect(body).toMatch(/# Original 4 resources/);
    expect(body).toMatch(/assert hasattr\(client, 'sessions'\)/);
    expect(body).toMatch(/assert hasattr\(client, 'api_keys'\)/);
    expect(body).toMatch(/assert hasattr\(client, 'usage'\)/);
    expect(body).toMatch(/assert hasattr\(client, 'webhooks'\)/);
    expect(body).toMatch(/# V-103 additions/);
    expect(body).toMatch(/assert hasattr\(client, 'profiles'\)/);
    expect(body).toMatch(/assert hasattr\(client, 'billing'\)/);
    expect(body).toMatch(/assert hasattr\(client, 'auth'\)/);
    expect(body).toMatch(/# Async parity/);
    expect(body).toMatch(/print\('wheel smoke ok — all 7 resource accessors wired'\)/);
  });

  it("Go SDK + V-165 bench-regression advisory framing pinned: 'Go SDK (vet + tests + examples build)' + 'go-version: \\'1.22\\'' + 'cache: false # no go.sum yet — zero non-stdlib runtime deps' + 'go vet ./...' + 'go test -v ./...' + 'go build ./examples/...' + V-165 bench-regression comment 'continue-on-error: true because: docs/benchmarks/{auth-path,rate-limit,webhook-signature}.md note that bench results on shared runners are noisy; a hard gate would produce false failures.' + 'First-run bootstrap mode (no baseline) exits 2; advisory swallows that' + 'Flipping to a hard gate is a separate founder decision' + 'Threshold: 50% slowdown vs the checked-in CI baseline at docs/benchmarks/baseline.ci.json. Override via the PERF_REGRESSION_THRESHOLD env var.' + 'continue-on-error: true' + 'needs: build-test' + 'npm run bench:json' + 'npm run bench:check-regression' — pinned so the Go-1.22 + zero-non-stdlib-runtime-deps + V-165 advisory-mode-rationale + 50%-threshold + founder-decision-to-flip-to-hard-gate commitment survives", () => {
    expect(body).toMatch(/name: Go SDK \(vet \+ tests \+ examples build\)/);
    expect(body).toMatch(/go-version: '1\.22'/);
    expect(body).toMatch(/cache: false # no go\.sum yet — zero non-stdlib runtime deps/);
    expect(body).toMatch(/run: go vet \.\/\.\.\./);
    expect(body).toMatch(/run: go test -v \.\/\.\.\./);
    expect(body).toMatch(/run: go build \.\/examples\/\.\.\./);
    expect(body).toMatch(/# V-165 — perf regression check \(advisory mode\)\./);
    expect(body).toMatch(/docs\/benchmarks\/\{auth-path,rate-limit,webhook-signature\}\.md/);
    expect(body).toMatch(/#\s+- First-run bootstrap mode \(no baseline\) exits 2; advisory/);
    expect(body).toMatch(/#\s+- Flipping to a hard gate is a separate founder decision once/);
    expect(body).toMatch(/# Threshold: 50% slowdown vs the checked-in CI baseline at/);
    expect(body).toMatch(/docs\/benchmarks\/baseline\.ci\.json/);
    expect(body).toMatch(/PERF_REGRESSION_THRESHOLD/);
    expect(body).toMatch(/continue-on-error: true/);
    expect(body).toMatch(/run: npm run bench:json/);
    expect(body).toMatch(/run: npm run bench:check-regression/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
