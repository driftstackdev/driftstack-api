import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICES = resolve(HERE, '..', '..', 'src', 'services');
const RECURRING_CONSUMERS = [
  'oauth-retention-sweeper.ts',
  'auth-flows-sweeper.ts',
  'session-duration-sweeper.ts',
  'scheduled-jobs-prune-sweeper.ts',
  'crypto-entitlement-expiry-sweeper.ts',
  'profile-trash-purge-sweeper.ts',
  'account-deletion-purge-sweeper.ts',
  'agent-session-orphan-sweeper.ts',
  'cost-nightly-job.ts',
] as const;

describe('recurring scheduled-job successor dedup invariant', () => {
  for (const filename of RECURRING_CONSUMERS) {
    it(`${filename} passes the current run-time boundary and never disables dedup`, () => {
      const body = readFileSync(resolve(SERVICES, filename), 'utf8');
      expect(body).toMatch(/currentRunAt: job\.runAt,/);
      expect(body).toMatch(/dedupOnAccountAndType: true,/);
      expect(body).toMatch(/dedupAfterRunAt: opts\.currentRunAt/);
      expect(body).not.toMatch(/dedupOnAccountAndType:\s*false/);
      expect(body).not.toMatch(/dedup:\s*false/);
    });
  }
});
