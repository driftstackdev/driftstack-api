// W293.A — drift guard for customer-dashboard text casing. We use
// "API key" (capital API, lowercase key), not "Api Key" or "API
// Key" mid-sentence. Same for "API keys" (plural). Catches drift
// where a copy edit introduces inconsistent capitalisation.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

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

const pages = walk(PAGES).filter((f) => /\.astro$/.test(f));

describe('W293.A customer-dashboard text casing baseline', () => {
  it('CRITICAL the walk found the pages — every assertion below is over `pages`', () => {
    // `walk` returns [] for a missing directory, so a moved or renamed root makes
    // every arm in this file pass over an empty list: zero pages have zero
    // offenders. The named member is the part that cannot be satisfied by an
    // empty walk, and unlike a count it does not churn as pages are added.
    expect(pages.length).toBeGreaterThan(12);
    expect(
      pages.some((f) => f.endsWith('billing.astro')),
      'the dashboard pages root produced nothing — the walk did not reach it',
    ).toBe(true);
  });

  it('no page uses "Api Key" (wrong: title case both words)', () => {
    const offenders: string[] = [];
    for (const f of pages) {
      const body = read(f);
      if (/\bApi Keys?\b/.test(body)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no page uses "Webhook URL" with mixed casing — prefer "webhook URL"', () => {
    // Webhook is a common noun in our docs.
    const offenders: string[] = [];
    for (const f of pages) {
      const body = read(f);
      // Allow "Webhook" at start of sentence / heading.
      // Forbid "WebHook" (camelCase mid-sentence) which is sometimes drifted in.
      if (/\bWebHook\b/.test(body)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
