// W258.C — drift-guard for docs.driftstack.io/reference/scopes. Pins:
// 1. Every `scope` row in the table is a real ApiKeyScopeSchema enum value.
// 2. The forbidden problem-type URI is errors.driftstack.dev/forbidden.
// 3. Source-of-truth file paths cited in the doc exist on disk.
//
// Previous revision listed `read:audit-log` (real key is `read:audit`),
// invented `admin:sessions` (not in the enum), and missed `read:api-keys`,
// `read:billing`, `admin:billing`. It also cited the bogus
// `api.driftstack.dev/errors/forbidden` URI.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiKeyScopeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/scopes.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W258.C docs/reference/scopes ↔ ApiKeyScopeSchema parity', () => {
  const doc = read(DOC);
  const liveScopes = new Set(ApiKeyScopeSchema.options);

  it('every scope in the table row backticks is a real ApiKeyScopeSchema value', () => {
    // Pull the leading backticked token from every table row starting `|`.
    const seen: string[] = [];
    for (const line of doc.split('\n')) {
      if (!/^\|\s*`[a-z][\w:-]*`/.test(line)) continue;
      const m = line.match(/^\|\s*`([a-z][\w:-]*)`/);
      if (m) seen.push(m[1]!);
    }
    expect(seen.length).toBeGreaterThan(5);
    const offenders = seen.filter((s) => !liveScopes.has(s as never));
    expect(offenders).toEqual([]);
  });

  it('every live granular scope is documented', () => {
    const granular = [...liveScopes].filter((s) => s.includes(':'));
    for (const g of granular) {
      expect(doc).toMatch(new RegExp(`\`${g}\``));
    }
  });

  it('forbidden problem-type URI uses errors.driftstack.dev', () => {
    expect(doc).toMatch(/"type":\s*"https:\/\/errors\.driftstack\.dev\/forbidden"/);
    expect(doc).not.toMatch(/api\.driftstack\.dev\/errors\//);
  });

  it('does not cite the legacy read:audit-log scope', () => {
    expect(doc).not.toMatch(/`read:audit-log`/);
  });

  it('does not cite the fictional admin:sessions scope', () => {
    expect(doc).not.toMatch(/`admin:sessions`/);
  });

  it('Source-of-truth file paths exist on disk', () => {
    // Pull `packages/...ts` and `apps/...ts` paths from the source-of-truth section.
    const paths = [
      ...doc.matchAll(/`(packages\/[\w./-]+\.ts)`/g),
      ...doc.matchAll(/`(apps\/server\/[\w./-]+\.ts)`/g),
    ].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(0);
    const missing = paths
      .map((p) => p.replace(/:.*$/, '')) // strip "filename:Symbol" suffixes
      .filter((p) => !existsSync(resolve(REPO_ROOT, p)));
    expect(missing).toEqual([]);
  });
});
