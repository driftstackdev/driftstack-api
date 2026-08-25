// W461.A — drift guard for apps/server/src/index.ts.
// Production entry point. Drift here either drops the
// bootstrap-failure → exit(1) fatal-on-throw guard (broken deploy
// promotes silently because the /health probe never goes red) or
// breaks the SIGTERM/SIGINT graceful shutdown (in-flight requests
// get killed mid-write instead of completing via app.close()
// + teardown()).
//
//   • Production-entry framing pinned: 'Loads config, builds the
//     dep graph via createProductionDeps, builds the Fastify app,
//     listens, and installs SIGTERM / SIGINT handlers for graceful
//     shutdown.'
//   • Fatal-bootstrap framing pinned: 'Failure to bootstrap
//     (Postgres / Redis unreachable, config invalid) is fatal:
//     process exits with code 1, the deploy pipeline's /health
//     probe fails, the orchestrator does not promote the new image.'
//   • 4 imports: loadConfig + createLogger + createProductionDeps
//     + buildApp.
//   • main async fn: loadConfig() → createLogger(config) →
//     try/catch createProductionDeps with logger.fatal +
//     process.exit(1) on failure.
//   • Sentry framing pinned (V-117): 'Sentry hooks (error-handler
//     + request breadcrumbs) are now installed inside buildApp
//     from deps.sentry. teardown holds the SentryClient reference
//     for flush/close on shutdown via the bootstrap closure.'
//   • shutdown handler: app.close() catch warn (logs 'app close
//     failed (proceeding to teardown)' + does NOT bail) +
//     teardown() + process.exit(0).
//   • SIGTERM + SIGINT signal handlers both wired to shutdown.
//   • app.listen failure: logger.fatal + teardown() + exit(1).
//   • void main() bootstrap call at module bottom.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildAppWithFatalTeardown, shareFirstAsyncCall } from '../../src/lib/bootstrap.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/index.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W461.A apps/server/src/index.ts content parity', () => {
  const body = read(LIB);

  it('holds build failure on teardown, exits 1 once, and never reaches listen', async () => {
    let releaseTeardown: (() => void) | undefined;
    const heldTeardown = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    const order: string[] = [];
    const listen = vi.fn(() => Promise.resolve());
    const run = buildAppWithFatalTeardown({
      build: () => Promise.reject(new Error('plugin rejected')),
      teardown: vi.fn(() => {
        order.push('teardown');
        return heldTeardown;
      }),
      onFailure: () => order.push('fatal'),
      exit: (code) => order.push(`exit:${code.toString()}`),
    });

    await vi.waitFor(() => expect(order).toEqual(['fatal', 'teardown']));
    expect(listen).not.toHaveBeenCalled();
    releaseTeardown?.();
    const app = await run;
    if (app !== null) await listen();

    expect(app).toBeNull();
    expect(order).toEqual(['fatal', 'teardown', 'exit:1']);
    expect(listen).not.toHaveBeenCalled();
  });

  it('makes rapid mixed signals await one close, teardown, and final exit', async () => {
    let releaseClose: (() => void) | undefined;
    let releaseTeardown: (() => void) | undefined;
    const heldClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const heldTeardown = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    const close = vi.fn(() => heldClose);
    const teardown = vi.fn(() => heldTeardown);
    const exit = vi.fn();
    const signals: string[] = [];
    const shutdown = shareFirstAsyncCall(async (signal: string) => {
      signals.push(signal);
      await close();
      await teardown();
      exit(0);
    });

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');
    expect(second).toBe(first);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(signals).toEqual(['SIGTERM']);
    expect(teardown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    releaseClose?.();
    await vi.waitFor(() => expect(teardown).toHaveBeenCalledTimes(1));
    expect(exit).not.toHaveBeenCalled();

    releaseTeardown?.();
    await Promise.all([first, second]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("Production-entry framing pinned: 'Production entry. Loads config, builds the dep graph via createProductionDeps, builds the Fastify app, listens, and installs SIGTERM / SIGINT handlers for graceful shutdown.'", () => {
    expect(body).toMatch(
      /\/\/ Production entry\. Loads config, builds the dep graph via\s*\/\/ `createProductionDeps`, builds the Fastify app, listens, and\s*\/\/ installs SIGTERM \/ SIGINT handlers for graceful shutdown\./,
    );
  });

  it("Fatal-bootstrap framing pinned: 'Failure to bootstrap (Postgres / Redis unreachable, config invalid) is fatal: process exits with code 1, the deploy pipeline's /health probe fails, the orchestrator does not promote the new image.'", () => {
    expect(body).toMatch(
      /\/\/ Failure to bootstrap \(Postgres \/ Redis unreachable, config\s*\/\/ invalid\) is fatal: process exits with code 1, the deploy\s*\/\/ pipeline's \/health probe fails, the orchestrator does not\s*\/\/ promote the new image\./,
    );
  });

  it('imports config/logger/buildApp plus bootstrap construction and lifecycle owners', () => {
    expect(body).toMatch(/import \{ loadConfig \} from '\.\/lib\/config\.js';/);
    expect(body).toMatch(/import \{ createLogger \} from '\.\/lib\/logger\.js';/);
    expect(body).toMatch(
      /import \{\s*buildAppWithFatalTeardown,\s*createProductionDeps,\s*shareFirstAsyncCall,\s*\} from '\.\/lib\/bootstrap\.js';/,
    );
    expect(body).toMatch(/import \{ buildApp \} from '\.\/lib\/app\.js';/);
  });

  it("main async fn: loadConfig() → createLogger(config) → try/catch createProductionDeps with logger.fatal {component:'bootstrap', err} + 'bootstrap failed — exiting' + process.exit(1) on failure", () => {
    expect(body).toMatch(
      /async function main\(\): Promise<void> \{\s*const config = loadConfig\(\);\s*const logger = createLogger\(config\);/,
    );
    expect(body).toMatch(
      /let bootstrap;\s*try \{\s*bootstrap = await createProductionDeps\(config, logger\);\s*\} catch \(err\) \{\s*logger\.fatal\(\s*\{\s*component: 'bootstrap',\s*err:\s*err instanceof Error\s*\? \{ name: err\.name, message: err\.message, stack: err\.stack \}\s*: \{ value: err \},\s*\},\s*'bootstrap failed — exiting',\s*\);\s*process\.exit\(1\);\s*\}/,
    );
  });

  it('V-117 Sentry framing pinned with fatal build cleanup + {deps, teardown} destructure', () => {
    expect(body).toMatch(
      /const \{ deps, teardown \} = bootstrap;[\s\S]*?const app = await buildAppWithFatalTeardown\(\{\s*build: \(\) => buildApp\(deps\),\s*teardown,/,
    );
    expect(body).toContain("'app build failed — exiting'");
    expect(body).toContain('if (app === null) return;');
    expect(body.indexOf('if (app === null) return;')).toBeLessThan(
      body.indexOf("process.on('SIGTERM'"),
    );
    expect(body.indexOf('if (app === null) return;')).toBeLessThan(
      body.indexOf('await app.listen'),
    );
  });

  it("shutdown handler: 'shutdown signal received' log + app.close() RACED against a CLOSE_DEADLINE_MS timeout (an active SSE stream can't hang the drain past systemd's stop window; default forceCloseConnections:'idle' won't reap it) + catch logger.warn 'app close failed or timed out (proceeding to teardown)' + teardown() ALWAYS runs + process.exit(0). Short focused pins (not one long-chain regex) per the no-long-chain-regex rule.", () => {
    expect(body).toMatch(
      /const shutdown = shareFirstAsyncCall\(async \(signal: string\): Promise<void> => \{/,
    );
    expect(body).toMatch(
      /logger\.info\(\{ component: 'lifecycle', signal \}, 'shutdown signal received'\);/,
    );
    // The hardening: bound app.close() with a deadline so a never-ending SSE
    // response can't hang shutdown until SIGKILL (which would SKIP teardown).
    expect(body).toMatch(/const CLOSE_DEADLINE_MS = 10_000;/);
    expect(body).toMatch(/await Promise\.race\(\[\s*app\.close\(\),/);
    expect(body).toMatch(/app\.close did not settle within \$\{CLOSE_DEADLINE_MS\}ms/);
    expect(body).toMatch(/\)\.unref\(\);/);
    // Warn on close failure/timeout, then ALWAYS teardown + clean exit.
    expect(body).toMatch(/'app close failed or timed out \(proceeding to teardown\)',/);
    expect(body).toMatch(/await teardown\(\);\s*process\.exit\(0\);/);
    // Regression guard: the old UNBOUNDED `await app.close();` (no race) is gone —
    // that form hung shutdown on active SSE until systemd SIGKILL, skipping teardown.
    expect(body).not.toMatch(/try \{\s*await app\.close\(\);\s*\} catch/);
  });

  it('Both SIGTERM + SIGINT wired to shutdown via process.on(...) with void wrapping for fire-and-forget', () => {
    expect(body).toMatch(/process\.on\('SIGTERM', \(\) => void shutdown\('SIGTERM'\)\);/);
    expect(body).toMatch(/process\.on\('SIGINT', \(\) => void shutdown\('SIGINT'\)\);/);
  });

  it("app.listen failure: try await app.listen({host, port}) with logger.info success path ({host, port, env}, 'driftstack-api listening') + catch logger.fatal 'app.listen failed — exiting' (full err object incl. stack+cause) + await teardown() + process.exit(1)", () => {
    expect(body).toMatch(
      /try \{\s*await app\.listen\(\{ host: config\.host, port: config\.port \}\);\s*logger\.info\(\s*\{ component: 'lifecycle', host: config\.host, port: config\.port, env: config\.nodeEnv \},\s*'driftstack-api listening',\s*\);\s*\} catch \(err\) \{\s*logger\.fatal\(\s*\{\s*component: 'lifecycle',\s*err:\s*err instanceof Error\s*\? \{ name: err\.name, message: err\.message, stack: err\.stack, cause: err\.cause \}\s*: \{ value: err \},\s*\},\s*'app\.listen failed — exiting',\s*\);\s*await teardown\(\);\s*process\.exit\(1\);\s*\}/,
    );
  });

  it('void main() bootstrap call at module bottom (fire-and-forget pattern)', () => {
    expect(body).toMatch(/void main\(\);/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
