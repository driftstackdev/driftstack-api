// W280.B — drift guard for customer-dashboard pages. No production
// dashboard page or layout may bake in `localhost:` or `127.0.0.1`
// host literals — runtime base URLs come from PUBLIC_API_BASE_URL +
// PUBLIC_DASHBOARD_ORIGIN. Catches the regression class where a
// debug fixture leaks into a real page during a refactor.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/customer-dashboard/src');

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

const pages = walk(SRC).filter((f) => /\.astro$/.test(f));

/**
 * The page body a host literal would have to appear in.
 *
 * Strip Astro frontmatter so doc-comment examples don't trip. The api-base-url
 * library helper docstring may reference localhost — that lives outside
 * src/pages and src/layouts. Any hit here is genuine drift.
 *
 * Shared with the reachability check below deliberately: a floor exercising a
 * separate copy of this would prove that copy works, not this one.
 */
const pageBody = (text: string): string => text.replace(/^---[\s\S]*?\n---\n/, '');

const hasLocalhostHost = (text: string): boolean => /localhost:[0-9]/.test(pageBody(text));
const hasLoopbackHost = (text: string): boolean => /\b127\.0\.0\.1\b/.test(pageBody(text));

describe('W280.B customer-dashboard hard-coded-host sweep', () => {
  it('CRITICAL the sweep read real pages and both matchers still fire. `walk` returns silently when its directory is missing, so a renamed or moved src/ leaves both assertions below vacuously true — reporting every page free of hard-coded hosts because it read none.', () => {
    expect(pages.length, '.astro pages found under customer-dashboard/src').toBeGreaterThan(15);
    expect(hasLocalhostHost('<p>http://localhost:8080/v1</p>'), 'a localhost host is seen').toBe(
      true,
    );
    expect(hasLoopbackHost('<p>http://127.0.0.1:8080/v1</p>'), 'a loopback host is seen').toBe(
      true,
    );
    expect(
      hasLocalhostHost('---\nconst example = "http://localhost:8080";\n---\n<p>ok</p>'),
      'and a frontmatter-only mention is still ignored, so the strip has not become a blanket',
    ).toBe(false);
  });

  it('no .astro page or layout contains a localhost:* host literal', () => {
    const offenders = pages
      .filter((f) => hasLocalhostHost(read(f)))
      .map((f) => f.slice(REPO_ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it('no .astro page or layout contains a 127.0.0.1 host literal', () => {
    const offenders = pages
      .filter((f) => hasLoopbackHost(read(f)))
      .map((f) => f.slice(REPO_ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});
