// W277.C — drift guard for customer-dashboard error surfacing.
// Pages that fetch the API should propagate problem+json `detail`
// strings into the visible banner, not generic "request failed"
// fallbacks. Per W151 / W152 we made detail-surfacing a baseline
// requirement — this guard catches regressions where a new page
// skips that pattern.

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

// Pages that make a real /v1/* fetch call. Filter on the call-site
// pattern (fetch(... + '/v1/' or authedFetch('/v1/...) so we don't
// false-positive on comments that mention an endpoint URL.
const fetchingPages = pages.filter((f) => {
  const body = read(f);
  return /\b(authedFetch|fetch)\s*\([^)]*\/v1\//.test(body);
});

describe('W277.C customer-dashboard problem+json detail surfacing sweep', () => {
  it('every page that fetches /v1/* reads body.detail somewhere in its error path', () => {
    const offenders: string[] = [];
    for (const f of fetchingPages) {
      const body = read(f);
      // Either: parses problem+json body for detail, surfaces err.message
      // from an auth wrapper, or passes the parsed body to the shared
      // response helper that explicitly marks server detail customer-safe.
      const hasDetailRead =
        /\b(body|json|payload|data|err)\.(detail|message)\b/.test(body) ||
        /window\.driftstackResponseError\s*\(/.test(body);
      if (!hasDetailRead) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
