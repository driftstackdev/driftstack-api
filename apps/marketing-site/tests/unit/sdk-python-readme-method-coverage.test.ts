// W289.A — drift guard for Python SDK README method-coverage table.
// Each `client.<resource>` row enumerates method names; every one
// must correspond to a real `def <name>` in the matching resource
// module. Catches drift where the README documents a renamed/
// removed method.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const README = resolve(REPO_ROOT, 'packages/sdk-python/README.md');
const RESOURCES = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Map client.<resource> → resource module filename.
const RESOURCE_FILE: Record<string, string> = {
  sessions: 'sessions.py',
  profiles: 'profiles.py',
  profile_snapshots: 'profile_snapshots.py',
  recipes: 'recipes.py',
  api_keys: 'api_keys.py',
  usage: 'usage.py',
  webhooks: 'webhooks.py',
  team: 'team.py',
  billing: 'billing.py',
  auth: 'auth.py',
  account: 'account.py',
  crypto_orders: 'crypto_orders.py',
};

describe('W289.A SDK Python README ↔ resource methods parity', () => {
  it('every method named in the README table is defined on its resource', () => {
    const body = read(README);
    // Pull `| `client.<resource>` | `... `<methods>` ... |` row contents.
    const rowRe = /\|\s*`client\.(\w+)`\s*\|\s*(.*?)\s*\|/g;
    const offenders: { resource: string; method: string; reason: string }[] = [];
    let any = false;
    for (const m of body.matchAll(rowRe)) {
      const resource = m[1]!;
      const methodsCell = m[2]!;
      const file = RESOURCE_FILE[resource];
      if (!file) continue;
      const path = resolve(RESOURCES, file);
      if (!existsSync(path)) {
        offenders.push({ resource, method: '(file)', reason: 'resource file missing' });
        continue;
      }
      const src = read(path);
      // Pull `name` tokens out of the methods cell (backtick-quoted).
      const names = [...methodsCell.matchAll(/`(\w+)`/g)].map((mm) => mm[1]!);
      for (const name of names) {
        any = true;
        const re = new RegExp(`^\\s+def\\s+${name}\\s*\\(`, 'm');
        if (!re.test(src)) {
          offenders.push({ resource, method: name, reason: 'def not found' });
        }
      }
    }
    expect(any).toBe(true);
    expect(offenders).toEqual([]);
  });
});
