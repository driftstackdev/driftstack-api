import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

describe('OAuth provider retention production wiring', () => {
  const service = read('apps/server/src/services/oauth.ts');
  const store = read('apps/server/src/db/oauth-store.ts');
  const sweeper = read('apps/server/src/services/oauth-retention-sweeper.ts');
  const bootstrap = read('apps/server/src/lib/bootstrap.ts');
  const scheduledJobsRepo = read('apps/server/src/db/scheduled-jobs-repo.ts');

  it('makes exact provider deletion counts part of every OAuthStore implementation', () => {
    expect(service).toMatch(/export interface OAuthPruneResult \{/);
    expect(service).toMatch(/authorizations: number;\s*codes: number;\s*tokens: number;/);
    expect(service).toMatch(/pruneExpired\(now: number\): Promise<OAuthPruneResult>;/);
    expect(service).toMatch(/async pruneExpired\(now: number\): Promise<OAuthPruneResult> \{/);
  });

  it('deletes only expired provider rows and retains backing API-key actors', () => {
    expect(store).toMatch(/const codeCutoff = new Date\(nowMs - AUTHORIZATION_CODE_TTL_MS\);/);
    expect(store).toMatch(
      /\.delete\(oauthAuthorizations\)[\s\S]{0,140}lt\(oauthAuthorizations\.createdAt, codeCutoff\)/,
    );
    expect(store).toMatch(
      /\.delete\(oauthAuthorizationCodes\)[\s\S]{0,140}lt\(oauthAuthorizationCodes\.createdAt, codeCutoff\)/,
    );
    expect(store).toMatch(
      /\.delete\(oauthAccessTokens\)[\s\S]{0,140}lte\(oauthAccessTokens\.expiresAt, now\)/,
    );
    const pruneMethod = store.split('async pruneExpired(nowMs: number)')[1] ?? '';
    expect(pruneMethod).not.toMatch(/\.delete\(apiKeys\)/);
    expect(pruneMethod).toMatch(/backing api_keys row remains/);
  });

  it('uses one hourly fail-surviving chain with crash-safe current-row exclusion', () => {
    expect(sweeper).toMatch(/OAUTH_RETENTION_SWEEP_INTERVAL_MS = 60 \* 60 \* 1000/);
    expect(sweeper).toMatch(/await opts\.sweeper\.tickOnce\(new Date\(now\(\)\)\)/);
    expect(sweeper).toMatch(/error_type: err instanceof Error \? err\.name\.slice\(0, 80\)/);
    expect(sweeper).not.toMatch(/err\.message|String\(err\)/);
    expect(sweeper).toMatch(/currentRunAt: job\.runAt/);
    expect(sweeper).toMatch(/dedupOnAccountAndType: true/);
    expect(sweeper).toMatch(/dedupAfterRunAt: opts\.currentRunAt/);
  });

  it('constructs, registers and bootstrap-deduplicates the production store sweep', () => {
    expect(bootstrap).toMatch(
      /const oauthRetentionSweeper = new OAuthRetentionSweeperService\(oauthStore\);/,
    );
    expect(bootstrap).toMatch(
      /registerOAuthRetentionSweepJob\(\{\s*scheduledJobs: scheduledJobsService,\s*sweeper: oauthRetentionSweeper,\s*logger,/,
    );
    expect(bootstrap).toMatch(
      /await enqueueNextOAuthRetentionSweep\(\{ scheduledJobs: scheduledJobsService \}\);/,
    );
  });

  it('serializes bootstrap dedup across replicas before checking and inserting', () => {
    expect(scheduledJobsRepo).toMatch(/const dedupLockTuple = JSON\.stringify\(\[/);
    expect(scheduledJobsRepo).toMatch(/return this\.database\.db\.transaction\(async \(tx\) => \{/);
    expect(scheduledJobsRepo).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\(\$\{dedupLockTuple\}, 0\)\)/,
    );
    expect(scheduledJobsRepo).toMatch(/gt\(scheduledJobs\.runAt, input\.dedupAfterRunAt\)/);
    const dedupTransaction = scheduledJobsRepo.split('const dedupLockTuple')[1] ?? '';
    expect(dedupTransaction.indexOf('await tx.execute')).toBeLessThan(
      dedupTransaction.indexOf('const existing = await tx'),
    );
    expect(dedupTransaction.indexOf('const existing = await tx')).toBeLessThan(
      dedupTransaction.indexOf('await tx.insert(scheduledJobs)'),
    );
  });
});
