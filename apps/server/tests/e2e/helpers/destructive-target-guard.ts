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

/** Hostnames that cannot be a managed/remote database. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

/**
 * Opt-out for setups whose Postgres is reachable only under a non-loopback name
 * — most plausibly a runner executing inside a compose network where the host is
 * the service name `postgres`. It must be set deliberately; nothing in this repo
 * sets it, and it should stay that way.
 */
export const OVERRIDE_ENV = 'DRIFTSTACK_E2E_ALLOW_NONLOCAL_RESET';

function hostOf(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // An unparseable URL is not evidence of safety. Refusing here also means the
    // guard cannot be bypassed by handing it something it fails to understand.
    throw new Error(
      `${label} is not a parseable URL, so the e2e harness cannot confirm it is a ` +
        `local throwaway database. Refusing to DROP SCHEMA and TRUNCATE against an ` +
        `unidentified target.`,
    );
  }
  return url.hostname.toLowerCase();
}

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

  const remote = targets
    .map(([label, raw]) => [label, hostOf(raw, label)] as const)
    .filter(([, host]) => !LOOPBACK_HOSTS.has(host));

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
