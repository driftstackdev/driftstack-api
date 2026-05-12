// W288.A — drift guard for the TypeScript SDK README's method
// reference list. The README enumerates `client.<resource>.<method>`
// signatures; each one must correspond to a real exported method
// in packages/sdk-typescript/src/resources/<resource>.ts. Catches
// drift where the README documents a method that was renamed or
// deleted from the SDK.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const README = resolve(REPO_ROOT, 'packages/sdk-typescript/README.md');
const RESOURCES = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// `client.foo.bar(...)` → resource = foo, method = bar.
// Map camelCase resource names to their resource file slug.
const RESOURCE_FILE: Record<string, string> = {
  sessions: 'sessions.ts',
  profiles: 'profiles.ts',
  profileSnapshots: 'profile-snapshots.ts',
  apiKeys: 'api-keys.ts',
  webhooks: 'webhooks.ts',
  team: 'team.ts',
  account: 'account.ts',
  emailPreferences: 'email-preferences.ts',
  cryptoOrders: 'crypto-orders.ts',
  billing: 'billing.ts',
  usage: 'usage.ts',
  auditLog: 'audit-log.ts',
  mfa: 'mfa.ts',
  auth: 'auth.ts',
  legal: 'legal.ts',
};

describe('W288.A SDK TS README ↔ resource methods parity', () => {
  it('every client.<resource>.<method>(...) cited in README maps to a real method', () => {
    const readme = read(README);
    // Match `client.<resource>.<method>(`
    const cites = [...readme.matchAll(/\bclient\.(\w+)\.(\w+)\s*\(/g)].map((m) => ({
      resource: m[1]!,
      method: m[2]!,
    }));
    expect(cites.length).toBeGreaterThan(10);

    const offenders: { resource: string; method: string; reason: string }[] = [];
    for (const { resource, method } of cites) {
      const file = RESOURCE_FILE[resource];
      if (!file) {
        offenders.push({ resource, method, reason: 'unknown resource' });
        continue;
      }
      const src = read(resolve(RESOURCES, file));
      // Each public method appears as `^\s+<method>\s*[(<]` on a line.
      const methodRe = new RegExp(`^\\s+${method}\\s*[(<]`, 'm');
      if (!methodRe.test(src) && !new RegExp(`\\b${method}\\(`).test(src)) {
        offenders.push({ resource, method, reason: 'method not found in resource' });
      }
    }
    expect(offenders).toEqual([]);
  });
});
