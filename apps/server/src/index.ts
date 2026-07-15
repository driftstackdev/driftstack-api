// Production entry. Loads config, builds the dep graph via
// `createProductionDeps`, builds the Fastify app, listens, and
// installs SIGTERM / SIGINT handlers for graceful shutdown.
//
// Failure to bootstrap (Postgres / Redis unreachable, config
// invalid) is fatal: process exits with code 1, the deploy
// pipeline's /health probe fails, the orchestrator does not
// promote the new image.

import { loadConfig } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import {
  buildAppWithFatalTeardown,
  createProductionDeps,
  shareFirstAsyncCall,
} from './lib/bootstrap.js';
import { buildApp } from './lib/app.js';
import { installUnhandledRejectionBackstop } from './lib/unhandled-rejection-backstop.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  // Install the unhandled-rejection backstop FIRST, before any async wiring, so
  // a rejection during bootstrap/runtime is logged rather than crashing us.
  installUnhandledRejectionBackstop(logger);

  let bootstrap;
  try {
    bootstrap = await createProductionDeps(config, logger);
  } catch (err) {
    logger.fatal(
      {
        component: 'bootstrap',
        err:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : { value: err },
      },
      'bootstrap failed — exiting',
    );
    process.exit(1);
  }

  const { deps, teardown } = bootstrap;
  // V-117: Sentry hooks (error-handler + request breadcrumbs) are now
  // installed inside buildApp from `deps.sentry`. teardown holds the
  // SentryClient reference for flush/close on shutdown via the
  // bootstrap closure.
  const app = await buildAppWithFatalTeardown({
    build: () => buildApp(deps),
    teardown,
    onFailure: (err) => {
      logger.fatal(
        {
          component: 'bootstrap',
          err:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
              : { value: err },
        },
        'app build failed — exiting',
      );
    },
    exit: (code) => process.exit(code),
  });
  if (app === null) return;

  // Bound the graceful drain. app.close() waits for in-flight requests to
  // finish — but a long-lived SSE stream (status / notification / transcript)
  // never ends on its own, and Fastify's default forceCloseConnections:'idle'
  // only reaps idle keep-alives, not an active SSE response. So an unbounded
  // `await app.close()` hangs until systemd's TimeoutStopSec SIGKILLs us —
  // which SKIPS teardown(), losing buffered Sentry events + leaking the
  // Postgres/Redis handles, and stalls the deploy for the full stop window.
  // Race the close against a deadline (well under TimeoutStopSec) so teardown
  // ALWAYS runs and the process exits cleanly within the stop window. The
  // normal (no-active-SSE) path is unchanged — app.close() resolves in ms.
  const CLOSE_DEADLINE_MS = 10_000;
  const shutdown = shareFirstAsyncCall(async (signal: string): Promise<void> => {
    logger.info({ component: 'lifecycle', signal }, 'shutdown signal received');
    try {
      await Promise.race([
        app.close(),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`app.close did not settle within ${CLOSE_DEADLINE_MS}ms`)),
            CLOSE_DEADLINE_MS,
          ).unref();
        }),
      ]);
    } catch (err) {
      logger.warn(
        {
          component: 'lifecycle',
          err:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
              : { value: err },
        },
        'app close failed or timed out (proceeding to teardown)',
      );
    }
    await teardown();
    process.exit(0);
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ host: config.host, port: config.port });
    logger.info(
      { component: 'lifecycle', host: config.host, port: config.port, env: config.nodeEnv },
      'driftstack-api listening',
    );
  } catch (err) {
    logger.fatal(
      {
        component: 'lifecycle',
        err:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
            : { value: err },
      },
      'app.listen failed — exiting',
    );
    await teardown();
    process.exit(1);
  }
}

void main();
