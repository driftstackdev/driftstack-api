// The e2e harness may only destroy a local throwaway database.
//
// `startTestServer` executes `DROP SCHEMA IF EXISTS "public" CASCADE` before any
// test body runs, and `resetState()` TRUNCATEs accounts, api_keys, profiles,
// sessions and eleven more tables RESTART IDENTITY CASCADE, then flushes Redis.
// The target came from `process.env.DATABASE_URL` with no check of any kind,
// falling back to the shared local dev database.
//
// The accident that guards against is specific and easy: a shell exporting a
// remote DATABASE_URL — sourced from a profile, an .env, or a pasted command —
// and someone runs the e2e suite. The whole database is gone, with no
// confirmation prompt and nothing to roll back to, as a side effect of running
// tests.
//
// Loopback-or-nothing costs nothing here, which is why it is the rule rather
// than a warning: CI sets localhost for both URLs, docker-compose publishes both
// on localhost, and the per-agent scratch databases are localhost. Managed
// Postgres and Redis are never on loopback, so the rule cannot fire on a
// legitimate run and cannot fail to fire on the accident.
//
// These cases drive the real function. A source-text pin on the DROP statement
// would not notice the check being removed, and a pin on the check itself passes
// while it sits in a branch that no longer runs.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OVERRIDE_ENV,
  SHARED_DEV_OVERRIDE_ENV,
  assertLocalDestructiveTarget,
} from '../e2e/helpers/destructive-target-guard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, '..', 'e2e', 'helpers', 'server.ts');

// V-1495 — these two ARE the shared development instances, which is the whole
// point of the arms below: loopback says where, not what. `server.ts` falls back
// to exactly this pair when DATABASE_URL is unset, so it is the configuration a
// clean shell produces, not a hypothetical.
const LOCAL_DB = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const LOCAL_REDIS = 'redis://localhost:6379';
// A disposable pair — loopback AND not the developer's working instances.
const SCRATCH_DB = 'postgres://driftstack:driftstack@localhost:5432/driftstack_e2e_local';
const SCRATCH_REDIS = 'redis://localhost:6379/15';
const IN_CI = { CI: '1' } as const;
const REMOTE_DB = 'postgres://user:pw@ep-cool-name-123.eu-central-1.aws.neon.tech/main';
const REMOTE_REDIS = 'rediss://default:pw@fly-driftstack.upstash.io:6379';

describe('e2e destructive-target guard', () => {
  it('POSITIVE CONTROL the configuration CI and docker-compose actually use is allowed. Without this, a guard that refused everything would satisfy every rejection case below and quietly break the suite instead of protecting it.', () => {
    expect(() => assertLocalDestructiveTarget(LOCAL_DB, LOCAL_REDIS, IN_CI)).not.toThrow();
  });

  it('POSITIVE CONTROL the other loopback spellings are allowed too, so the rule does not depend on the string "localhost".', () => {
    for (const host of ['127.0.0.1', '[::1]', '0.0.0.0']) {
      expect(
        () =>
          assertLocalDestructiveTarget(
            `postgres://u:p@${host}:5432/driftstack_e2e_local`,
            `redis://${host}:6379/15`,
            {},
          ),
        `${host} must be treated as local`,
      ).not.toThrow();
    }
  });

  it("CRITICAL a remote Postgres is refused. This is the accident: a shell exporting a managed DATABASE_URL, and the suite DROPs that database's public schema before a single test body runs.", () => {
    expect(() => assertLocalDestructiveTarget(REMOTE_DB, SCRATCH_REDIS, {})).toThrow(
      /not loopback/i,
    );
  });

  it('CRITICAL a remote Redis is refused even when Postgres is local. resetState calls flushdb, so Redis is independently destructive and checking only the database would leave half the blast radius unguarded.', () => {
    expect(() => assertLocalDestructiveTarget(SCRATCH_DB, REMOTE_REDIS, {})).toThrow(
      /not loopback/i,
    );
  });

  it('CRITICAL the refusal names which target was remote, so an operator can fix the right variable instead of guessing between two.', () => {
    let message = '';
    try {
      assertLocalDestructiveTarget(SCRATCH_DB, REMOTE_REDIS, {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/REDIS_URL/);
    expect(message, 'and must not blame the variable that was fine').not.toMatch(/DATABASE_URL →/);
  });

  it('CRITICAL an unparseable URL is refused rather than assumed safe. A guard that cannot identify its target must not conclude the target is harmless — otherwise malformed input becomes the bypass.', () => {
    expect(() => assertLocalDestructiveTarget('not-a-url', SCRATCH_REDIS, {})).toThrow(
      /not a parseable URL/,
    );
  });

  it('CRITICAL the override lets a deliberate non-loopback topology through, because a compose-network runner may reach Postgres only by service name. Setting an environment variable is a decision; the accident this guards is not.', () => {
    expect(() =>
      assertLocalDestructiveTarget(REMOTE_DB, `${REMOTE_REDIS}/15`, { [OVERRIDE_ENV]: '1' }),
    ).not.toThrow();
  });

  it('CRITICAL the override is exact — any value other than "1" still refuses, so an empty or "false" setting cannot read as consent.', () => {
    for (const value of ['', '0', 'false', 'true', 'yes']) {
      expect(
        () => assertLocalDestructiveTarget(REMOTE_DB, SCRATCH_REDIS, { [OVERRIDE_ENV]: value }),
        `${OVERRIDE_ENV}=${JSON.stringify(value)} must not authorize a remote drop`,
      ).toThrow();
    }
  });

  it('CRITICAL NODE_ENV=production is refused even WITH the override set. The override exists for an unusual local topology; no legitimate use of it coincides with a production environment flag, and that combination is the one that ends a company.', () => {
    expect(() =>
      assertLocalDestructiveTarget(REMOTE_DB, REMOTE_REDIS, {
        [OVERRIDE_ENV]: '1',
        NODE_ENV: 'production',
      }),
    ).toThrow(/NODE_ENV is "production"/);
  });

  it('CRITICAL the harness calls the guard BEFORE it opens a connection. Behaviour cannot see this: every case above passes whether the call sits before the DROP or after it, and a caller that has already connected has pointed real credentials at a real host.', () => {
    const src = readFileSync(HARNESS, 'utf8');
    const guardAt = src.indexOf('assertLocalDestructiveTarget(dbUrl, redisUrl');
    const connectAt = src.indexOf('postgres(dbUrl');
    const dropAt = src.indexOf('DROP SCHEMA IF EXISTS');
    expect(guardAt, 'the harness must call the guard').toBeGreaterThan(-1);
    expect(connectAt, 'and must open a connection').toBeGreaterThan(-1);
    expect(dropAt, 'and must still be the thing that drops the schema').toBeGreaterThan(-1);
    expect(guardAt, 'guard must precede the connection').toBeLessThan(connectAt);
    expect(guardAt, 'and therefore the DROP').toBeLessThan(dropAt);
  });
  // V-1495 — the arms below exist because the first version of this rule was
  // DEAD CODE and every test above still passed. It was placed after
  // `if (remote.length === 0) return;`, so a local target returned before
  // reaching it. A rule with no arm asserting it fires is indistinguishable from
  // one that does not exist.
  it('CRITICAL the shared development instances are refused by default. Loopback says WHERE, not WHAT: with DATABASE_URL unset, server.ts falls back to the driftstack database and Redis db 0, playwright.config.ts sets nothing, and the documented command then DROPs that schema and flushes that Redis without asking.', () => {
    expect(() => assertLocalDestructiveTarget(LOCAL_DB, LOCAL_REDIS, {})).toThrow(/SHARED/);
  });

  it('CRITICAL each shared target is refused on its own, so a scratch database does not launder a shared Redis and the reverse. The reset is two destructive operations, not one.', () => {
    expect(() => assertLocalDestructiveTarget(LOCAL_DB, SCRATCH_REDIS, {})).toThrow(/driftstack/);
    expect(() => assertLocalDestructiveTarget(SCRATCH_DB, LOCAL_REDIS, {})).toThrow(/db 0/);
  });

  it('POSITIVE CONTROL a scratch pair is allowed with no environment at all — otherwise the rule above would be satisfied by refusing everything, and the suite could not run anywhere.', () => {
    expect(() => assertLocalDestructiveTarget(SCRATCH_DB, SCRATCH_REDIS, {})).not.toThrow();
  });

  it('CRITICAL CI is exempt, because there `driftstack` IS the ephemeral service container the header describes. The same name means different things in the two places, which is why the name alone cannot decide it.', () => {
    expect(() => assertLocalDestructiveTarget(LOCAL_DB, LOCAL_REDIS, IN_CI)).not.toThrow();
  });

  it('CRITICAL the shared-dev opt-in is its own variable, not the non-loopback one. They answer different questions, and overloading one would let a reader granting a compose topology silently also grant a reset of their working database.', () => {
    expect(() =>
      assertLocalDestructiveTarget(LOCAL_DB, LOCAL_REDIS, { [SHARED_DEV_OVERRIDE_ENV]: '1' }),
    ).not.toThrow();
    expect(() =>
      assertLocalDestructiveTarget(LOCAL_DB, LOCAL_REDIS, { [OVERRIDE_ENV]: '1' }),
    ).toThrow(/SHARED/);
  });
});
