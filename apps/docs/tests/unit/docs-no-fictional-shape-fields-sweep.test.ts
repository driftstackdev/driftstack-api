// W288.B — drift guard for docs JSON sample payloads. Pin a small
// allowlist of well-known fields and forbid common fictional ones
// the AI tends to invent (`tier_slug` instead of `tier`,
// `is_active` instead of `status`, etc.). Catches drift where a
// sample payload uses a field that doesn't exist in the schema.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    throw new Error(
      `walk root is missing: ${dir} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
    );
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const targets = [
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
  resolve(REPO_ROOT, 'apps/docs/src/pages'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

// Fields that the AI tends to invent — each pattern should never
// appear in JSON-shape sample payloads. The right field is in the
// reason column.
const FORBIDDEN_FIELDS: { pattern: RegExp; reason: string }[] = [
  { pattern: /"tier_slug"\s*:/g, reason: 'Use "tier" — AccountTier enum is the live field' },
  { pattern: /"account_tier"\s*:/g, reason: 'Use "tier" — short form is canonical' },
  { pattern: /"is_active"\s*:\s*(true|false)/g, reason: 'Sessions use "status", not is_active' },
  { pattern: /"api_key_secret"\s*:/g, reason: 'Field is "key" on mint, not "api_key_secret"' },
  { pattern: /"webhook_secret"\s*:/g, reason: 'Field is "signing_secret" or "secret"' },
];

/**
 * Does `text` use this fictional field?
 *
 * The `lastIndex` reset is load-bearing and easy to lose: these patterns carry
 * the `g` flag and are shared by every generated test below, so a `.test()`
 * that matched would leave the next file's scan starting mid-string. Keeping
 * the reset inside one named function is what stops that from depending on
 * every call site remembering.
 */
function usesField(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  const hit = pattern.test(text);
  pattern.lastIndex = 0;
  return hit;
}

describe('W288.B workspace-wide forbidden-field sweep', () => {
  it('CRITICAL the sweep read real pages and every pattern still fires. Each assertion below runs INSIDE a loop over the collected pages, so a moved or renamed root leaves all of them vacuously true — reporting every page accurate because it read none.', () => {
    expect(allFiles.length, 'pages found across marketing-site and docs').toBeGreaterThan(50);
    // Each pattern against a payload it must catch. A pattern that stopped
    // matching would leave its own test permanently, silently green.
    const samples: Record<string, string> = {
      tier_slug: '{ "tier_slug": "pro" }',
      account_tier: '{ "account_tier": "pro" }',
      is_active: '{ "is_active": true }',
      api_key_secret: '{ "api_key_secret": "x" }',
      webhook_secret: '{ "webhook_secret": "x" }',
    };
    for (const { pattern, reason } of FORBIDDEN_FIELDS) {
      const key = Object.keys(samples).find((k) => pattern.source.includes(k));
      expect(key, `no sample payload written for pattern ${pattern.source}`).toBeDefined();
      expect(
        usesField(pattern, samples[key!]!),
        `pattern still matches its field — ${reason}`,
      ).toBe(true);
      expect(
        usesField(pattern, '{ "tier": "pro", "status": "active", "key": "x", "secret": "x" }'),
        `and does not flag the canonical shape — ${reason}`,
      ).toBe(false);
    }
  });

  for (const { pattern, reason } of FORBIDDEN_FIELDS) {
    it(`no page uses the fictional field — ${reason}`, () => {
      const offenders = allFiles
        .filter((f) => usesField(pattern, read(f)))
        .map((f) => f.slice(REPO_ROOT.length + 1));
      expect(offenders).toEqual([]);
    });
  }
});
