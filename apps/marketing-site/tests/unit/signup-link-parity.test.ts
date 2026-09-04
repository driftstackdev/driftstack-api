// V-293 — signup/login link parity test.
//
// Catches the V-293-class regression: relative `/signup` links on the
// marketing site (driftstack.io) resolve to driftstack.io/signup
// (404 — signup lives at app.driftstack.io/signup). Source-grep
// asserts every signup/login href on the marketing surface points at
// the absolute `https://app.driftstack.io/...` URL, OR to an in-page
// anchor (`#trial-pack` etc.) that doesn't reach the dashboard.
//
// Pattern matches V-292 — brittle-by-design source-grep. Drift surfaces
// loudly, fixed in the same commit. Customer-facing 404 prevention.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MARKETING_SRC = resolve(REPO_ROOT, 'apps/marketing-site/src');
const DOCS_SRC = resolve(REPO_ROOT, 'apps/docs/src');

function walkFiles(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkFiles(full, extensions));
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const marketingFiles = walkFiles(MARKETING_SRC, ['.astro', '.md', '.mdx']);
const docsFiles = walkFiles(DOCS_SRC, ['.astro', '.md', '.mdx']);

// Bare `/signup`, `/login`, `/forgot-password`, `/reset-password` hrefs
// resolve to driftstack.io/X or docs.driftstack.io/X in production —
// both are 404. Match `href=` followed by these paths (string + template).
const RELATIVE_DASHBOARD_LINK_RE =
  /href=(?:"|'|\{`?)\/(?:signup|login|forgot-password|reset-password)(?:["'`?#]|$)/;

describe('V-293 — signup/login link parity (marketing-site + docs)', () => {
  it.each(marketingFiles)('marketing file %s has no relative dashboard-route hrefs', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(RELATIVE_DASHBOARD_LINK_RE);
  });

  it.each(docsFiles)('docs file %s has no relative dashboard-route hrefs', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(RELATIVE_DASHBOARD_LINK_RE);
  });

  it('marketing Header.astro surfaces both Sign in (returning) + Start free (new) CTAs', () => {
    const src = readFileSync(resolve(MARKETING_SRC, 'components/Header.astro'), 'utf8');
    expect(src).toMatch(/https:\/\/app\.driftstack\.io\/login/);
    expect(src).toContain('Sign in');
    expect(src).toContain('Start free'); // existing trial-pack CTA
  });

  it('marketing Footer.astro lists Sign up + Sign in under Product', () => {
    const src = readFileSync(resolve(MARKETING_SRC, 'components/Footer.astro'), 'utf8');
    expect(src).toMatch(/https:\/\/app\.driftstack\.io\/signup/);
    expect(src).toMatch(/https:\/\/app\.driftstack\.io\/login/);
  });

  it('docs/quickstart.md has clickable signup + signin links (not bare text)', () => {
    const src = readFileSync(resolve(DOCS_SRC, 'pages/quickstart.md'), 'utf8');
    expect(src).toMatch(/\[sign up\]\(https:\/\/app\.driftstack\.io\/signup\/\)/);
    expect(src).toMatch(/\[sign in\]\(https:\/\/app\.driftstack\.io\/login\/\)/);
  });
});
