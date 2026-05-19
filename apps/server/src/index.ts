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
import { createProductionDeps } from './lib/bootstrap.js';
import { buildApp } from './lib/app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

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
  const app = await buildApp(deps);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ component: 'lifecycle', signal }, 'shutdown signal received');
    try {
      await app.close();
    } catch (err) {
      logger.warn(
        {
          component: 'lifecycle',
          err:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
              : { value: err },
        },
        'app close failed (proceeding to teardown)',
      );
    }
    await teardown();
    process.exit(0);
  };

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
