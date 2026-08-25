import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

describe('V-590 web-session credential epoch', () => {
  const migration = read('apps/server/src/db/migrations/0105_web_session_auth_epoch.sql');
  const schema = read('apps/server/src/db/schema.ts');
  const flowsRepo = read('apps/server/src/db/auth-flows-repo.ts');
  const authRepo = read('apps/server/src/db/auth-repo.ts');
  const service = read('apps/server/src/services/auth-flows.ts');
  const auth = read('apps/server/src/services/auth.ts');
  const authCache = read('apps/server/src/services/auth-cache.ts');
  const memoryRepo = read('apps/server/tests/integration/_helpers/in-memory-auth-flows-repo.ts');

  it('migrates existing accounts and sessions together at epoch zero', () => {
    expect(migration).toMatch(
      /ALTER TABLE "accounts"\s*\n\s*ADD COLUMN "auth_epoch" integer DEFAULT 0 NOT NULL;/,
    );
    expect(migration).toMatch(
      /ALTER TABLE "web_sessions"\s*\n\s*ADD COLUMN "auth_epoch" integer DEFAULT 0 NOT NULL;/,
    );
    expect(
      schema.match(/authEpoch: integer\('auth_epoch'\)\.notNull\(\)\.default\(0\),/g),
    ).toHaveLength(2);
  });

  it('bumps password authority only on an active account', () => {
    expect(flowsRepo).toMatch(/authEpoch: sql`\$\{accounts\.authEpoch\} \+ 1`,/);
    expect(flowsRepo).toMatch(
      /\.where\(and\(eq\(accounts\.id, accountId\), eq\(accounts\.status, 'active'\)\)\)/,
    );
    expect(flowsRepo).toMatch(/return row \? toAccountRow\(row\) : null;/);
  });

  it('locks and matches account state plus epoch before session insertion', () => {
    expect(flowsRepo).toMatch(/return this\.database\.db\.transaction\(async \(tx\) => \{/);
    expect(flowsRepo).toMatch(/eq\(accounts\.status, 'active'\),/);
    expect(flowsRepo).toMatch(/eq\(accounts\.authEpoch, args\.authEpoch\),/);
    expect(flowsRepo).toMatch(/\.for\('update'\)/);
    expect(flowsRepo).toMatch(/if \(!authority\) return null;/);
    expect(flowsRepo).toMatch(/authEpoch: args\.authEpoch,/);
  });

  it('inherits the old session epoch on refresh and never returns a failed mint plaintext', () => {
    expect(service).toMatch(
      /this\.issueWebSession\(\s*account,\s*args\.issuedFromIp,\s*args\.userAgent,\s*old\.authEpoch,/,
    );
    expect(service).toMatch(/authEpoch: authorityEpoch,/);
    expect(service).toMatch(/if \(row === null\) throw new AuthFlowError\('invalid_auth_token'\);/);
  });

  it('invalidates cached session authority even when the physical sweep reports zero rows', () => {
    expect(service).toMatch(
      /Password change increments auth_epoch even when the physical sweep finds\s*\/\/ no live rows\./,
    );
    expect(service).toMatch(/if \(this\.authCache\) \{\s*try \{/);
    expect(service).not.toMatch(/if \(revoked > 0 && this\.authCache\)/);
  });

  it('prevents a pre-reset slow path from repopulating a current cache entry after invalidation', () => {
    expect(auth).toMatch(/capturedVersions = await cache\.captureVersions/);
    expect(auth).toMatch(/const revalidated = await repo\.findActiveWebSession/);
    expect(auth).toMatch(/revalidated\.id !== session\.id/);
    expect(auth).toMatch(/ctx, ttl, capturedVersions/);
    expect(authCache).toMatch(/capturedVersions\?: AuthCacheVersions/);
    expect(authCache).toMatch(/capturedVersions\?\.accountVersion/);
  });

  it('requires epoch equality on refresh/list and runtime authentication reads', () => {
    for (const source of [flowsRepo, authRepo]) {
      expect(source).toMatch(/eq\(accounts\.authEpoch, webSessions\.authEpoch\)/);
    }
    expect(flowsRepo.match(/eq\(accounts\.authEpoch, webSessions\.authEpoch\)/g)).toHaveLength(2);
  });

  it('keeps the in-memory integration seam behaviorally faithful', () => {
    expect(memoryRepo).toMatch(/authEpoch: slot\.account\.authEpoch \+ 1,/);
    expect(memoryRepo).toMatch(/account\.authEpoch !== args\.authEpoch/);
    expect(memoryRepo).toMatch(/authEpoch: args\.authEpoch,/);
    expect(memoryRepo).toMatch(/account\.authEpoch !== row\.authEpoch/);
  });
});
