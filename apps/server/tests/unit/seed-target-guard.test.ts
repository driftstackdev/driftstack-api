// `db:seed` may only mint an admin key into a local database.
//
// `seed.ts` creates an account and an API key scoped `['read', 'write', 'admin']`
// and prints the plaintext to the console. Correct for a local dev database, and
// a credential-issuing incident anywhere else: a working full-admin key now
// exists there, and its plaintext is in a shell scrollback or a CI log. The
// script's output never says which database it landed in, so the mistake does
// not announce itself.
//
// The target came from `config.databaseUrl` with no check at all. The accident
// needs no unusual state — an operator with a staging or production
// `DATABASE_URL` exported, running `npm run db:seed`.
//
// This is the second call site of the same rule; the e2e harness is the first.
// The host classification is shared (`lib/loopback-host.ts`) precisely so the two
// cannot drift, but the POLICY is deliberately not shared: the two failures need
// different remedies in front of an operator, so each owns its own message and
// its own override name. The last case here pins that separation, because a
// well-meaning consolidation would silently let the e2e override authorise
// seeding production.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_OVERRIDE_ENV, assertSeedTargetIsLocal } from '../../src/db/seed-target-guard.js';
import { OVERRIDE_ENV as E2E_OVERRIDE_ENV } from '../e2e/helpers/destructive-target-guard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = resolve(HERE, '..', '..', 'src', 'db', 'seed.ts');

const LOCAL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const REMOTE = 'postgres://user:pw@ep-prod-999.eu-central-1.aws.neon.tech/main';

describe('db:seed target guard', () => {
  it('POSITIVE CONTROL a local database is allowed, so the guard protects the workflow rather than breaking it. Without this every rejection below would be satisfied by a function that always throws.', () => {
    expect(() => assertSeedTargetIsLocal(LOCAL, {})).not.toThrow();
  });

  it('CRITICAL a remote database is refused. This is the accident: DATABASE_URL exported from a staging or production environment, and `npm run db:seed` mints a full-admin key there and prints its plaintext.', () => {
    expect(() => assertSeedTargetIsLocal(REMOTE, {})).toThrow(/only do that to a local database/);
  });

  it('CRITICAL the refusal names the host it refused, because the operator\'s next question is "which database did I nearly seed".', () => {
    let message = '';
    try {
      assertSeedTargetIsLocal(REMOTE, {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/ep-prod-999\.eu-central-1\.aws\.neon\.tech/);
  });

  it('CRITICAL the refusal states what would have been created. "Refusing to seed" tells an operator nothing; that the key is read+write+admin and its plaintext is printed is what makes the severity legible.', () => {
    let message = '';
    try {
      assertSeedTargetIsLocal(REMOTE, {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/read\+write\+admin/);
    expect(message).toMatch(/plaintext/);
  });

  it('CRITICAL an unparseable DATABASE_URL is refused rather than assumed local, so malformed input is not the way past the check.', () => {
    expect(() => assertSeedTargetIsLocal('not-a-url', {})).toThrow(/not a parseable URL/);
  });

  it('CRITICAL the override permits a deliberate remote seed — first-time environment setup is real — and is exact, so an empty or "false" value cannot read as consent.', () => {
    expect(() => assertSeedTargetIsLocal(REMOTE, { [SEED_OVERRIDE_ENV]: '1' })).not.toThrow();
    for (const value of ['', '0', 'false', 'true', 'yes']) {
      expect(
        () => assertSeedTargetIsLocal(REMOTE, { [SEED_OVERRIDE_ENV]: value }),
        `${SEED_OVERRIDE_ENV}=${JSON.stringify(value)} must not authorize a remote seed`,
      ).toThrow();
    }
  });

  it("CRITICAL NODE_ENV=production is refused even WITH the override. Setting up a fresh remote environment is the override's purpose and never coincides with a production flag.", () => {
    expect(() =>
      assertSeedTargetIsLocal(REMOTE, { [SEED_OVERRIDE_ENV]: '1', NODE_ENV: 'production' }),
    ).toThrow(/NODE_ENV is "production"/);
  });

  it('CRITICAL the two overrides are DISTINCT names. They share a host classifier so it cannot drift, but consolidating the policy would let someone who set the e2e override — to run tests against a compose network — silently also authorise seeding an admin key into a remote database.', () => {
    expect(SEED_OVERRIDE_ENV).not.toBe(E2E_OVERRIDE_ENV);
    expect(
      () => assertSeedTargetIsLocal(REMOTE, { [E2E_OVERRIDE_ENV]: '1' }),
      'the e2e override must not authorize a remote seed',
    ).toThrow();
  });

  it('CRITICAL seed.ts calls the guard BEFORE it opens a connection. Behaviour cannot see this: every case above passes whether the call sits before createDb or after it, and a caller that has connected has already presented real credentials to a real host.', () => {
    const src = readFileSync(SEED, 'utf8');
    const guardAt = src.indexOf('assertSeedTargetIsLocal(config.databaseUrl');
    const connectAt = src.indexOf('createDb(config.databaseUrl)');
    expect(guardAt, 'seed.ts must call the guard').toBeGreaterThan(-1);
    expect(connectAt, 'and must still open the connection it guards').toBeGreaterThan(-1);
    expect(guardAt, 'guard must precede the connection').toBeLessThan(connectAt);
  });
});
