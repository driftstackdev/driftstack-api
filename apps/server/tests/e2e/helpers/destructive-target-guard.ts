// Refuse to run the e2e harness against anything but a local database.
//
// `startTestServer` opens by executing, before any test body runs:
//
//   DROP SCHEMA IF EXISTS "drizzle" CASCADE
//   DROP SCHEMA IF EXISTS "public"  CASCADE
//   CREATE SCHEMA "public"
//
// and `resetState()` then TRUNCATEs accounts, api_keys, profiles, sessions and
// eleven more tables RESTART IDENTITY CASCADE, followed by `redis.flushdb()`.
//
// That is correct for a disposable test database and catastrophic anywhere else,
// and until now nothing checked which database it was. The target came from
// `process.env.DATABASE_URL`, falling back to the shared local dev database. A
// shell that happens to export a remote DATABASE_URL — a staging or production
// one, sourced from a profile, an .env, or a copy-pasted command — destroys that
// database completely, with no confirmation and no recovery, as a side effect of
// running the test suite.
//
// Every legitimate caller is already local, which is what makes a loopback rule
// free rather than disruptive: CI sets
// `postgres://driftstack:driftstack@localhost:5432/driftstack` and
// `redis://localhost:6379`, docker-compose publishes both on localhost, and the
// per-agent scratch databases are localhost too. Production is remote by
// construction — managed Postgres and Redis are never on loopback.
//
// So the rule is: loopback or nothing. A non-loopback host needs a deliberate
// environment variable, because someone who sets that has made a decision rather
// than an accident, and it is the accident this exists to prevent.

import { nonLoopbackTargets } from '../../../src/lib/loopback-host.js';

/**
 * Opt-out for setups whose Postgres is reachable only under a non-loopback name
 * — most plausibly a runner executing inside a compose network where the host is
 * the service name `postgres`. It must be set deliberately; nothing in this repo
 * sets it, and it should stay that way.
 */
export const OVERRIDE_ENV = 'DRIFTSTACK_E2E_ALLOW_NONLOCAL_RESET';

/**
 * Throw unless every destructive target is loopback.
 *
 * Call before opening a connection, not merely before the DROP — a caller that
 * connects first has already pointed real credentials at a real host.
 *
 * @param dbUrl    the Postgres URL whose `public` schema will be dropped
 * @param redisUrl the Redis URL that will be `flushdb`-ed
 * @param env      process environment, injected so this is testable
 */
export function assertLocalDestructiveTarget(
  dbUrl: string,
  redisUrl: string,
  env: Record<string, string | undefined>,
): void {
  // NODE_ENV=production is refused even WITH the override. The override exists
  // for an unusual local topology, not for pointing the suite at production, and
  // no legitimate use of it coincides with a production environment flag.
  if (env['NODE_ENV'] === 'production') {
    throw new Error(
      `The e2e harness DROPs the public schema and TRUNCATEs every account table. ` +
        `NODE_ENV is "production"; refusing to run regardless of ${OVERRIDE_ENV}.`,
    );
  }

  const targets: ReadonlyArray<readonly [string, string]> = [
    ['DATABASE_URL', dbUrl],
    ['REDIS_URL', redisUrl],
  ];

  const remote = nonLoopbackTargets(targets);

  if (remote.length === 0) return;

  if (env[OVERRIDE_ENV] === '1') return;

  const described = remote.map(([label, host]) => `${label} → ${host}`).join(', ');
  throw new Error(
    `The e2e harness DROPs the "public" schema and TRUNCATEs accounts, api_keys, ` +
      `profiles and sessions, then flushes Redis. It will only do that to a local ` +
      `throwaway instance, and these targets are not loopback: ${described}. ` +
      `Point DATABASE_URL and REDIS_URL at a disposable local database ` +
      `(docker compose up -d, or a scratch database such as driftstack_e2e_local). ` +
      `If a non-loopback host is genuinely required, set ${OVERRIDE_ENV}=1 ` +
      `deliberately — never to make this message go away.`,
  );
}
