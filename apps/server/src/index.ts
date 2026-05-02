// Fastify entry. Wired in Phase 3 once auth + middleware land.
// Phase 1 stub: prints config, exits cleanly.

import { loadConfig } from './lib/config.js';

function main(): void {
  const config = loadConfig();

  console.warn(
    JSON.stringify({
      msg: 'driftstack-api boot stub (Phase 1)',
      env: config.nodeEnv,
      port: config.port,
      driver: config.driver,
    }),
  );
}

main();
