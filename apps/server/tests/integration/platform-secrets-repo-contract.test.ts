// V-1211 — one contract, executed against BOTH implementations of `PlatformSecretsRepo`.
//
// The sixth of the twenty-nine, and the last of the four ordering divergences the V-1209 sweep
// measured:
//
//   DrizzlePlatformSecretsRepo.listMeta   -> .orderBy(platformSecrets.name)
//   InMemoryPlatformSecretsRepo.listMeta  -> [...this.meta.values()]      // Map insertion order
//
// WHY THE ORDERING ARM WRITES OUT OF ALPHABETICAL ORDER. Writing `a…` then `z…` makes Map order and
// name order coincide, and the arm then passes against a double that never sorts. Writing `z…`
// first is what makes the two disagree. That is the third time this session the DIRECTION of a
// fixture decided whether an ordering arm could fail at all.
//
// THE SECOND ARM IS THE ONE THAT MATTERS MORE. This double's own header claims `listMeta` never
// exposes ciphertext, "same contract as the drizzle repo's metadata-only select". That is a claim
// about RUNTIME SHAPE, and `PlatformSecretMeta` not declaring a ciphertext field does not enforce
// it: a `.select()` with no projection returns every column, and the extra key rides along
// invisibly behind a type that says it cannot be there. `platform_secrets.ciphertext` holds the
// decryptable platform credentials, so the arm inspects the actual keys of the returned objects
// rather than trusting the annotation — the same reason V-1204 distrusts `sql<number>`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { PlatformSecretsRepo } from '../../src/services/platform-secrets.js';
import { DrizzlePlatformSecretsRepo } from '../../src/db/platform-secrets-repo.js';
import { InMemoryPlatformSecretsRepo } from './_helpers/in-memory-platform-secrets-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/** Anything resembling the encrypted payload must not appear in metadata. */
const SECRET_ISH = /cipher|secret|blob|payload|plaintext/i;

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM platform_secrets LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const name of seeded) {
      await client`DELETE FROM platform_secrets WHERE name = ${name}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: PlatformSecretsRepo;
  /** Unique per arm: `platform_secrets` is keyed by name and shared across the whole database. */
  name: (suffix: string) => string;
  mine: (all: { name: string }[]) => { name: string }[];
}

function makeNamer(): Pick<Subject, 'name' | 'mine'> {
  const run = randomUUID().slice(0, 8);
  const prefix = `contract-${run}-`;
  return {
    name: (suffix) => {
      const n = `${prefix}${suffix}`;
      seeded.push(n);
      return n;
    },
    // The table is global — no account scoping exists here at all — so every assertion filters to
    // the names this arm wrote. Without it the arms would be decided by whatever else is stored.
    mine: (all) => all.filter((m) => m.name.startsWith(prefix)),
  };
}

function inMemorySubject(): Subject {
  return { repo: new InMemoryPlatformSecretsRepo(), ...makeNamer() };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return { repo: new DrizzlePlatformSecretsRepo({ db }), ...makeNamer() };
}

function platformSecretsContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`PlatformSecretsRepo contract — ${label}`, () => {
    it('CRITICAL listMeta is ordered by name, in both. The fixture writes the z-name FIRST, because writing them alphabetically makes Map insertion order coincide with name order and the arm would pass against an implementation that never sorts.', async () => {
      if (!enabled()) return;
      const s = make();
      const zed = s.name('zzz-last');
      const first = s.name('aaa-first');
      await s.repo.upsert({
        name: zed,
        ciphertext: Buffer.from('z'),
        description: null,
        updatedByKeyId: null,
      });
      await s.repo.upsert({
        name: first,
        ciphertext: Buffer.from('a'),
        description: null,
        updatedByKeyId: null,
      });

      expect(
        s.mine(await s.repo.listMeta()).map((m) => m.name),
        'listMeta returned write order, not name order',
      ).toEqual([first, zed]);
    });

    it('CRITICAL listMeta never carries the ciphertext, in both. PlatformSecretMeta not declaring the field does not enforce it — a select with no projection returns every column and the key rides along behind a type that says it cannot. This table holds the decryptable platform credentials, so the arm reads the actual keys rather than trusting the annotation.', async () => {
      if (!enabled()) return;
      const s = make();
      const name = s.name('shape');
      await s.repo.upsert({
        name,
        ciphertext: Buffer.from('super-secret-bytes'),
        description: 'meta only',
        updatedByKeyId: null,
      });

      const rows = s.mine(await s.repo.listMeta());
      expect(rows.length, 'the arm found no row of its own to inspect').toBe(1);
      const leaked = Object.keys(rows[0] ?? {}).filter((k) => SECRET_ISH.test(k));
      expect(leaked, 'listMeta exposed a secret-bearing field').toEqual([]);
    });

    it('CRITICAL upsert reports created then updated for the same name, in both. The outcome is what tells an operator whether they added a secret or silently replaced one that was already in use.', async () => {
      if (!enabled()) return;
      const s = make();
      const name = s.name('outcome');

      const created = await s.repo.upsert({
        name,
        ciphertext: Buffer.from('one'),
        description: null,
        updatedByKeyId: null,
      });
      const updated = await s.repo.upsert({
        name,
        ciphertext: Buffer.from('two'),
        description: null,
        updatedByKeyId: null,
      });

      expect(created, 'the first write did not report created').toBe('created');
      expect(updated, 'the second write did not report updated').toBe('updated');
      expect(
        (await s.repo.getCiphertext(name))?.toString('utf8'),
        'the second write did not replace the stored ciphertext',
      ).toBe('two');
    });

    it('CRITICAL remove reports whether it actually removed something, in both. An operator deleting a secret that was never there must not be told it is gone, and the row must stop resolving through getCiphertext.', async () => {
      if (!enabled()) return;
      const s = make();
      const name = s.name('remove');
      await s.repo.upsert({
        name,
        ciphertext: Buffer.from('bye'),
        description: null,
        updatedByKeyId: null,
      });

      expect(await s.repo.remove(name), 'removing an existing secret reported false').toBe(true);
      expect(await s.repo.getCiphertext(name), 'the ciphertext outlived its row').toBeNull();
      expect(await s.repo.remove(name), 'removing an absent secret reported true').toBe(false);
    });
  });
}

platformSecretsContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'PlatformSecretsRepo contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    platformSecretsContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
