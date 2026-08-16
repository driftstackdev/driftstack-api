#!/usr/bin/env node
// Run the Playwright e2e suite WITHOUT docker compose, against a disposable
// local Postgres database and an unused Redis index.
//
// Why this exists. `npm run test:e2e` is wired to `test:e2e:setup`
// (`docker compose up -d --wait`), so on a machine without Docker the suite gets
// recorded as "unrun" and stays that way — which is how three specs in
// `rate-limit.spec.ts` were able to rot unnoticed until someone ran them. The
// suite itself needs nothing but a Postgres and a Redis: migrations apply
// idempotently on boot, so a brand-new empty database is fine. Measured: 199
// tests in 52 seconds.
//
// Why it REFUSES rather than defaults. `resetState()` runs
// `TRUNCATE … RESTART IDENTITY CASCADE` over the whole schema and `redis.flushdb()`
// before every test, and the harness defaults are the shared development database
// (`…/driftstack`) and Redis db0. Those defaults are correct for compose, where
// both are disposable containers; they are exactly wrong for a developer machine
// where that database holds real local state and db0 is whatever else is running.
//
// The harness already refuses a NON-LOOPBACK target (readiness item 30). That
// rule cannot help here, because every one of these mistakes is on loopback. This
// script adds the checks that only make sense once "not compose" is the stated
// contract, and it is a separate entry point precisely so `test:e2e` keeps
// working unchanged for the compose flow.

import { spawn } from 'node:child_process';

/** Postgres database name that docker compose owns and a developer machine does not. */
const COMPOSE_DB_NAME = 'driftstack';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Decide whether a target is safe for the NO-DOCKER e2e path.
 *
 * Pure so the rules can be tested without spawning anything. Returns every
 * problem rather than the first, so a misconfigured shell is fixed in one pass.
 */
export function validateE2eLocalTarget({ databaseUrl, redisUrl }) {
  const problems = [];

  if (databaseUrl === undefined || databaseUrl === '') {
    problems.push(
      'DATABASE_URL is unset. The harness would fall back to the shared development ' +
        'database and TRUNCATE it. Point it at a disposable database.',
    );
  } else {
    let parsed;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      // A guard that cannot identify its target must not conclude the target is
      // safe, or malformed input becomes the bypass.
      problems.push('DATABASE_URL is not a parseable URL, so its target cannot be checked.');
    } else {
      if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
        problems.push(`DATABASE_URL host ${parsed.hostname} is not loopback.`);
      }
      const dbName = parsed.pathname.replace(/^\//, '');
      if (dbName === '') {
        problems.push('DATABASE_URL names no database.');
      } else if (dbName === COMPOSE_DB_NAME) {
        problems.push(
          `DATABASE_URL points at "${COMPOSE_DB_NAME}", the shared development database. ` +
            'The suite TRUNCATEs every table in whatever it connects to. Use a disposable ' +
            'database such as driftstack_e2e_local.',
        );
      }
    }
  }

  if (redisUrl === undefined || redisUrl === '') {
    problems.push(
      'REDIS_URL is unset. The harness would flushdb() the DEFAULT index, which is ' +
        'whatever else on this machine is using Redis. Select an unused index, e.g. ' +
        'redis://localhost:6379/12.',
    );
  } else {
    let parsed;
    try {
      parsed = new URL(redisUrl);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      problems.push('REDIS_URL is not a parseable URL, so its target cannot be checked.');
    } else {
      if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
        problems.push(`REDIS_URL host ${parsed.hostname} is not loopback.`);
      }
      const index = parsed.pathname.replace(/^\//, '');
      if (index === '' || index === '0') {
        problems.push(
          'REDIS_URL must select a non-default database index — flushdb() on index 0 ' +
            'wipes the index every other local tool uses.',
        );
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/* c8 ignore start — CLI wiring; the rules above are what the tests drive. */
if (process.argv[1]?.endsWith('e2e-local.mjs') === true) {
  const verdict = validateE2eLocalTarget({
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
  });
  if (!verdict.ok) {
    console.error('e2e-local: refusing to run — the target is not disposable.\n');
    for (const p of verdict.problems) console.error(`  - ${p}`);
    console.error(
      '\nExample:\n' +
        '  createdb driftstack_e2e_local\n' +
        '  DATABASE_URL=postgres://localhost:5432/driftstack_e2e_local \\\n' +
        '  REDIS_URL=redis://localhost:6379/12 npm run test:e2e:local\n',
    );
    process.exit(1);
  }
  const child = spawn(
    'npx',
    ['playwright', 'test', '--config=playwright.config.ts', ...process.argv.slice(2)],
    { cwd: new URL('../apps/server/', import.meta.url).pathname, stdio: 'inherit' },
  );
  child.on('close', (code) => process.exit(code ?? 1));
}
/* c8 ignore stop */
