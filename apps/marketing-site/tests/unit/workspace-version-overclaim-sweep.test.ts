// W280.C — workspace-wide sweep guard for product version / GA
// overclaims. We are pre-launch (v1.0 in active development) — copy
// must not claim "GA", "v1.0 released", "production-ready" in ways
// that imply public availability. Acceptable framings: "v1 launch",
// "in development", "beta", "preview", "limited release".

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
const allFiles = targets
  .flatMap((d) => walk(d))
  .filter((f) => /\.(astro|md)$/.test(f))
  // legal/* pages are contract text; "production-grade automation"
  // there describes customer use-cases, not claims about us.
  .filter((f) => !/\/legal\//.test(f));

// Affirmative overclaims. Each pattern must not appear in any page.
const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\bgenerally available\b/i,
    reason: 'No GA claim — we are pre-launch',
  },
  {
    pattern: /\bgeneral availability\b/i,
    reason: 'No GA claim — we are pre-launch',
  },
  {
    pattern: /\bbattle-?tested\b/i,
    reason: 'Avoid "battle-tested" — overclaim for pre-launch product',
  },
  {
    pattern: /\b(industry-leading|world-class) (security|reliability|infrastructure)\b/i,
    reason: 'Avoid "industry-leading X" / "world-class X" — generic overclaim',
  },
];

describe('W280.C workspace-wide product-version overclaim sweep', () => {
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    it(`no page uses an overclaim — ${reason}`, () => {
      const offenders: string[] = [];
      for (const f of allFiles) {
        const body = read(f);
        if (pattern.test(body)) {
          offenders.push(f.slice(REPO_ROOT.length + 1));
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
