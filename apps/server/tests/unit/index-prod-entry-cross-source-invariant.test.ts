// W990 — production entry V-117 + V-167 cross-source invariant.
// Three-hundred-sixteenth in the drift-guard series. Pins the apps/
// server/src/index.ts production entry primitive:
//
//   Header framing — 'Production entry. Loads config, builds the dep
//   graph via createProductionDeps, builds the Fastify app, listens,
//   and installs SIGTERM / SIGINT handlers for graceful shutdown'.
//
//   Bootstrap-fatal framing — 'Failure to bootstrap (Postgres / Redis
//   unreachable, config invalid) is fatal: process exits with code
//   1, the deploy pipeline's /health probe fails, the orchestrator
//   does not promote the new image'.
//
//   Bootstrap log — logger.fatal with component:'bootstrap' + {name,
//     message, stack} err + 'bootstrap failed — exiting'.
//
//   V-117 Sentry framing — 'V-117: Sentry hooks (error-handler +
//   request breadcrumbs) are now installed inside buildApp from
//   deps.sentry. teardown holds the SentryClient reference for
//   flush/close on shutdown via the bootstrap closure'.
//
//   shutdown 3-step — app.close() (raced vs CLOSE_DEADLINE_MS so an
//     active SSE stream can't hang the drain) → teardown() →
//     process.exit(0).
//
//   SIGTERM + SIGINT handlers — process.on('SIGTERM' / 'SIGINT', ...).
//
//   app.close failure/timeout swallow framing — 'app close failed or
//     timed out (proceeding to teardown)' warn log.
//
//   app.listen failure — fatal log + teardown + process.exit(1).
//
//   shutdown signal log — 'shutdown signal received' info with
//     component:'lifecycle' + signal.
//
//   driftstack-api-listening log — 'driftstack-api listening' info
//     with host + port + env.
//
// stays in lockstep across apps/server/src/index.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W990 production entry V-117 + V-167 cross-source invariant', () => {
  // ─── Header framing ──────────────────────────────────────────

  it("CRITICAL apps/server/src/index.ts header pins surface — 'Production entry. Loads config, builds the dep graph via createProductionDeps, builds the Fastify app, listens, and installs SIGTERM / SIGINT handlers for graceful shutdown'. The 4-step (config + bootstrap + buildApp + listen) + V-167 SIGTERM/SIGINT design is the production-entry contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/index.ts'));
    expect(p).toMatch(/Production entry\. Loads config, builds the dep graph via/);
    expect(p).toMatch(/`createProductionDeps`, builds the Fastify app, listens, and/);
    expect(p).toMatch(/installs SIGTERM \/ SIGINT handlers for graceful shutdown\./);
  });

  // ─── Bootstrap-fatal framing ─────────────────────────────────

  it("CRITICAL bootstrap-fatal framing — 'Failure to bootstrap (Postgres / Redis unreachable, config invalid) is fatal: process exits with code 1, the deploy pipeline's /health probe fails, the orchestrator does not promote the new image'. The fail-fast-on-boot + health-probe-fails + no-promote design is the deploy-safety contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/index.ts'));
    expect(p).toMatch(/Failure to bootstrap \(Postgres \/ Redis unreachable, config/);
    expect(p).toMatch(/invalid\) is fatal: process exits with code 1, the deploy/);
    expect(p).toMatch(/pipeline's \/health probe fails, the orchestrator does not/);
    expect(p).toMatch(/promote the new image\./);
  });

  // ─── createProductionDeps call ───────────────────────────────

  it("CRITICAL bootstrap call — 'createProductionDeps(config, logger)' inside try/catch + logger.fatal on failure + process.exit(1). The 2-arg createProductionDeps + fatal-log-then-exit is the V-117 bootstrap contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/index.ts'));
    expect(p).toMatch(/bootstrap = await createProductionDeps\(config, logger\);/);
    expect(p).toMatch(/logger\.fatal\(/);
    expect(p).toMatch(/component: 'bootstrap',/);
    expect(p).toMatch(/'bootstrap failed — exiting',/);
    expect(p).toMatch(/process\.exit\(1\);/);
  });

  // ─── Bootstrap-error shape ───────────────────────────────────

  it('CRITICAL bootstrap-failure err shape — Error case: { name, message, stack }; non-Error case: { value }. The 3-field-Error + 1-field-fallback design preserves full stack on real Errors without crashing on weird thrown values.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/index.ts'));
    expect(p).toMatch(/err instanceof Error/);
    expect(p).toMatch(/\? \{ name: err\.name, message: err\.message, stack: err\.stack \}/);
    expect(p).toMatch(/: \{ value: err \},/);
  });

  // ─── V-117 Sentry framing ────────────────────────────────────

  it("CRITICAL V-117 Sentry framing — 'V-117: Sentry hooks (error-handler + request breadcrumbs) are now installed inside buildApp from deps.sentry. teardown holds the SentryClient reference for flush/close on shutdown via the bootstrap closure'. The hooks-in-buildApp + teardown-closure design is the V-117 Sentry-lifecycle contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/index.ts'));
    expect(p).toMatch(/V-117: Sentry hooks \(error-handler \+ request breadcrumbs\) are now/);
    expect(p).toMatch(/installed inside buildApp from `deps\.sentry`\. teardown holds the/);
    expect(p).toMatch(/SentryClient reference for flush\/close on shutdown via the/);
    expect(p).toMatch(/bootstrap closure\./);
    expect(p).toMatch(/const app = await buildAppWithFatalTeardown\(\{/);
    expect(p).toMatch(/build: \(\) => buildApp\(deps\),/);
    expect(p).toMatch(/'app build failed — exiting',/);
    expect(p).toMatch(/if \(app === null\) return;/);
    expect(p.indexOf('if (app === null) return;')).toBeLessThan(p.indexOf("process.on('SIGTERM'"));
    expect(p.indexOf('if (app === null) return;')).toBeLessThan(p.indexOf('await app.listen'));
  });

  // ─── shutdown 3-step ─────────────────────────────────────────

  it('CRITICAL shutdown 3-step — app.close() (RACED against a CLOSE_DEADLINE_MS timeout) → teardown() → process.exit(0). The 3-step graceful-drain matches the V-167 lifecycle order; the timeout race keeps an active SSE stream from hanging the close past the systemd stop window while still guaranteeing teardown runs.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/index.ts'));
    expect(p).toMatch(/const shutdown = shareFirstAsyncCall\(async \(signal: string\)/);
    expect(p).toMatch(/await Promise\.race\(\[\s*app\.close\(\),/);
    expect(p).toMatch(/const CLOSE_DEADLINE_MS = 10_000;/);
    expect(p).toMatch(/await teardown\(\);/);
    expect(p).toMatch(/process\.exit\(0\);/);
  });

  it("CRITICAL shutdown signal log — 'shutdown signal received' info with component:'lifecycle' + signal. The structured-signal-log gives ops dashboards a clean 'received SIGTERM' marker.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/index.ts'));
    expect(p).toMatch(
      /logger\.info\(\{ component: 'lifecycle', signal \}, 'shutdown signal received'\);/,
    );
  });

  it("CRITICAL app.close failure/timeout swallow — 'app close failed or timed out (proceeding to teardown)' warn. The proceed-on-close design ensures teardown runs even when Fastify hooks throw OR the close races past its deadline (active SSE held the socket open).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/index.ts'));
    expect(p).toMatch(/'app close failed or timed out \(proceeding to teardown\)',/);
  });

  // ─── SIGTERM + SIGINT handlers ───────────────────────────────

  it("CRITICAL SIGTERM + SIGINT handlers — process.on('SIGTERM', ...) + process.on('SIGINT', ...). The 2-signal coverage is the V-167 graceful-shutdown contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/index.ts'));
    expect(p).toMatch(/process\.on\('SIGTERM', \(\) => void shutdown\('SIGTERM'\)\);/);
    expect(p).toMatch(/process\.on\('SIGINT', \(\) => void shutdown\('SIGINT'\)\);/);
  });

  // ─── app.listen 2-arg ────────────────────────────────────────

  it("CRITICAL app.listen({host, port}) + 'driftstack-api listening' info log with host + port + env. The 4-field log gives the operator a single canonical line confirming successful bind.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/index.ts'));
    expect(p).toMatch(/await app\.listen\(\{ host: config\.host, port: config\.port \}\);/);
    expect(p).toMatch(
      /component: 'lifecycle', host: config\.host, port: config\.port, env: config\.nodeEnv/,
    );
    expect(p).toMatch(/'driftstack-api listening',/);
  });

  it('CRITICAL app.listen failure → fatal log + teardown + process.exit(1). The teardown-before-exit ensures clean DB/Redis disconnect even on bind-port-failure paths.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/index.ts'));
    expect(p).toMatch(/'app\.listen failed — exiting',/);
    expect(p).toMatch(/await teardown\(\);/);
    expect(p).toMatch(/process\.exit\(1\);/);
  });

  // ─── lifecycle imports ──────────────────────────────────────

  it('CRITICAL imports include production deps, build, and shared lifecycle owners.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/index.ts'));
    expect(p).toMatch(/import \{ loadConfig \} from '\.\/lib\/config\.js';/);
    expect(p).toMatch(/import \{ createLogger \} from '\.\/lib\/logger\.js';/);
    expect(p).toMatch(/buildAppWithFatalTeardown,/);
    expect(p).toMatch(/createProductionDeps,/);
    expect(p).toMatch(/shareFirstAsyncCall,/);
    expect(p).toMatch(/import \{ buildApp \} from '\.\/lib\/app\.js';/);
  });

  // ─── main() invocation ───────────────────────────────────────

  it("CRITICAL 'void main();' at module bottom — top-level invocation. The void-keyword silences the unhandled-Promise warning while still firing main().", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/index.ts'));
    expect(p).toMatch(/void main\(\);/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/index-prod-entry-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
