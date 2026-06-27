// W289.B — drift guard for Go SDK README method-coverage table.
// Each `client.<Resource>` row enumerates method names; every one
// must correspond to a real `func (r *<Resource>Resource) <Name>`
// in the matching Go file. Catches drift where the README
// documents a renamed/removed method.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const README = resolve(REPO_ROOT, 'packages/sdk-go/README.md');
const SDK = resolve(REPO_ROOT, 'packages/sdk-go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Map README field name (`client.Sessions`) → resource source file.
const RESOURCE_FILE: Record<string, string> = {
  Sessions: 'sessions.go',
  Egress: 'egress.go',
  Profiles: 'profiles.go',
  ProfileSnapshots: 'profile_snapshots.go',
  Recipes: 'recipes.go',
  APIKeys: 'api_keys.go',
  Usage: 'usage.go',
  Webhooks: 'webhooks.go',
  Team: 'team.go',
  Billing: 'billing.go',
  Auth: 'auth.go',
  Account: 'account.go',
  CryptoOrders: 'crypto_orders.go',
  Mfa: 'mfa.go',
  Legal: 'legal.go',
  AuditLog: 'audit_log.go',
  EmailPreferences: 'email_preferences.go',
};

describe('W289.B SDK Go README ↔ resource methods parity', () => {
  it('every method named in the README table has a func definition in the Go file', () => {
    const body = read(README);
    const rowRe = /\|\s*`client\.(\w+)`\s*\|\s*(.*?)\s*\|/g;
    const offenders: { resource: string; method: string; reason: string }[] = [];
    let any = false;
    for (const m of body.matchAll(rowRe)) {
      const resource = m[1]!;
      const methodsCell = m[2]!;
      const file = RESOURCE_FILE[resource];
      if (!file) continue;
      const path = resolve(SDK, file);
      if (!existsSync(path)) {
        offenders.push({ resource, method: '(file)', reason: 'resource file missing' });
        continue;
      }
      const src = read(path);
      const names = [...methodsCell.matchAll(/`(\w+)`/g)].map((mm) => mm[1]!);
      for (const name of names) {
        any = true;
        const re = new RegExp(`^func\\s+\\(\\w+\\s+\\*${resource}Resource\\)\\s+${name}\\(`, 'm');
        if (!re.test(src)) {
          offenders.push({ resource, method: name, reason: 'method receiver not found' });
        }
      }
    }
    expect(any).toBe(true);
    expect(offenders).toEqual([]);
  });
});
