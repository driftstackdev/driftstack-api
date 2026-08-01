// Refuse to seed anything but a local database.
//
// `seed.ts` mints an API key with scopes `['read', 'write', 'admin']` — full
// admin — and prints its plaintext to the console so a developer can paste it
// into a curl command. That is exactly right for a local dev database.
//
// Against any other database it is a credential-issuing incident: a working
// full-admin key exists there, and its plaintext is now in a shell scrollback,
// a terminal history, or a CI log. Nothing about the script's output says which
// database it landed in, so the mistake is not self-announcing either.
//
// Until now the target came from `config.databaseUrl` with no check. The
// accident needs no unusual state — an operator with a staging or production
// `DATABASE_URL` exported, running `npm run db:seed`, gets a prod admin key.
//
// Loopback-or-nothing is affordable here for the same reason it is in the e2e
// harness: seeding is a local-development affordance. Seeding a remote database
// is a real thing someone might do once during environment setup, so it is
// possible — but it has to be asked for, because asking is what distinguishes it
// from the accident.

import { hostOfConnectionString, isLoopbackHost } from '../lib/loopback-host.js';

/**
 * Opt-in for deliberately seeding a non-local database, e.g. first-time staging
 * setup. Nothing in this repo sets it.
 */
export const SEED_OVERRIDE_ENV = 'DRIFTSTACK_SEED_ALLOW_REMOTE';

/**
 * Throw unless the seed target is a local throwaway.
 *
 * Call before opening a connection: a caller that has connected has already
 * presented real credentials to a real host.
 *
 * @param databaseUrl the database that would receive the admin key
 * @param env         process environment, injected so this is testable
 */
export function assertSeedTargetIsLocal(
  databaseUrl: string,
  env: Record<string, string | undefined>,
): void {
  // Refused even WITH the override. The override exists for setting up a fresh
  // remote environment; no legitimate use of it coincides with a production
  // environment flag, and that is the combination worth being absolute about.
  if (env['NODE_ENV'] === 'production') {
    throw new Error(
      `db:seed mints a full-admin API key and prints its plaintext. NODE_ENV is ` +
        `"production"; refusing regardless of ${SEED_OVERRIDE_ENV}.`,
    );
  }

  const host = hostOfConnectionString(databaseUrl, 'DATABASE_URL');
  if (isLoopbackHost(host)) return;
  if (env[SEED_OVERRIDE_ENV] === '1') return;

  throw new Error(
    `db:seed creates an account and an API key scoped read+write+admin, and prints ` +
      `the plaintext to the console. It will only do that to a local database, and ` +
      `DATABASE_URL points at "${host}". If you meant to seed a remote environment, ` +
      `set ${SEED_OVERRIDE_ENV}=1 deliberately — and treat the printed key as live ` +
      `credentials for that environment.`,
  );
}
