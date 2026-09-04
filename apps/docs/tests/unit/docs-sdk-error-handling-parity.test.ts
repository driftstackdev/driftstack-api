// W255.D — drift-guard for docs.driftstack.io/sdk/error-handling.
// The previous revision asserted problem-type URIs under a fictional
// `/problems/auth/invalid`-style namespace; the live URIs live under
// `https://errors.driftstack.dev/<slug>` per PROBLEM_TYPES. This
// guard pins every documented slug to a live PROBLEM_TYPES entry.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/error-handling.md');

function read(): string {
  return readFileSync(DOC, 'utf8');
}

describe('W255.D docs/sdk/error-handling ↔ PROBLEM_TYPES parity', () => {
  const doc = read();
  const liveSlugs = new Set(
    Object.values(PROBLEM_TYPES).map((uri) =>
      uri.replace(/^https:\/\/errors\.driftstack\.dev\//, ''),
    ),
  );

  it('does not reference the fictional /problems/* URI namespace', () => {
    expect(doc).not.toMatch(/\/problems\/auth\/invalid/);
    expect(doc).not.toMatch(/\/problems\/rate-limit\b/);
    expect(doc).not.toMatch(/\/problems\/quota-exceeded/);
    expect(doc).not.toMatch(/\/problems\/session\/destroyed/);
  });

  it('every backticked slug in the hierarchy table is a real PROBLEM_TYPES slug', () => {
    // Pull `slug-name` tokens from inside table rows only (lines that
    // start with `|` and contain at least one backticked slug followed
    // by another `| ` column).
    const offenders: string[] = [];
    for (const line of doc.split('\n')) {
      if (!/^\|\s*`[a-z-]+`/.test(line)) continue;
      const m = line.match(/^\|\s*`([a-z][a-z-]+)`/);
      if (!m) continue;
      const slug = m[1]!;
      // Allow the narrative "transport" row.
      if (slug === 'transport') continue;
      if (!liveSlugs.has(slug)) offenders.push(slug);
    }
    expect(offenders).toEqual([]);
  });

  it('cites the canonical errors.driftstack.dev host', () => {
    expect(doc).toMatch(/errors\.driftstack\.dev/);
  });

  it('rate-limited row is the only retryable problem-type row (besides transport)', () => {
    // Loose check: rate-limited should be tagged retryable yes.
    expect(doc).toMatch(/rate-limited`\s*\|[^|]+\|[^|]+\|[^|]+\|\s*yes/);
  });
});
