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
  if (!existsSync(dir)) return out;
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

describe('W288.B workspace-wide forbidden-field sweep', () => {
  for (const { pattern, reason } of FORBIDDEN_FIELDS) {
    it(`no page uses the fictional field — ${reason}`, () => {
      const offenders: string[] = [];
      for (const f of allFiles) {
        const body = read(f);
        if (pattern.test(body)) {
          offenders.push(f.slice(REPO_ROOT.length + 1));
        }
        pattern.lastIndex = 0;
      }
      expect(offenders).toEqual([]);
    });
  }
});
