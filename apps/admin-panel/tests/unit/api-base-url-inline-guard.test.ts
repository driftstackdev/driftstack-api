// W193 — drift guard against re-introducing the inline
// `import.meta.env.PUBLIC_API_BASE_URL ?? 'http://localhost:3000'`
// expression in any admin-panel .astro page.
//
// W193 migrated 10 pages onto the shared `resolveApiBaseUrl()` helper
// so that production builds fail fast when the env var is unset. The
// drift hazard is that someone adds a new admin page and copies the
// old inline pattern from git history — which would re-open the
// silent-prod-fallback bug for that one page.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = resolve(HERE, '..', '..', 'src', 'pages');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.astro')) {
      out.push(full);
    }
  }
  return out;
}

const FORBIDDEN = "import.meta.env.PUBLIC_API_BASE_URL ?? 'http://localhost:3000'";

describe('W193 admin-panel inline-fallback drift guard', () => {
  it('no admin-panel page reaches into PUBLIC_API_BASE_URL directly', () => {
    const offenders: string[] = [];
    for (const file of walk(PAGES_DIR)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes(FORBIDDEN)) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `Admin pages must call resolveApiBaseUrl() from src/lib/api-base-url.ts ` +
        `instead of the inline fallback expression — the inline form silently ` +
        `defaults to localhost:3000 in production if the env var is unset. ` +
        `Offending files:\n${offenders.map((f) => `  ${f}`).join('\n')}`,
    ).toEqual([]);
  });
});
