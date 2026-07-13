// W337.B — drift guard for marketing Footer nav. Every internal
// href in the footer must resolve to a real marketing page. The
// footer is on every page; a broken link is high-blast-radius.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const FOOTER = resolve(REPO_ROOT, 'apps/marketing-site/src/components/Footer.astro');
const HEADER = resolve(REPO_ROOT, 'apps/marketing-site/src/components/Header.astro');
const PAGES_DIR = resolve(REPO_ROOT, 'apps/marketing-site/src/pages');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const full = resolve(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function buildPageUrls(): Set<string> {
  const urls = new Set<string>();
  for (const f of walk(PAGES_DIR)) {
    if (!/\.(astro|md)$/.test(f)) continue;
    const rel = f.slice(PAGES_DIR.length).replace(/\\/g, '/');
    let route = rel.replace(/\.(astro|md)$/, '');
    if (route.endsWith('/index')) route = route.slice(0, -'/index'.length);
    if (route === '') route = '/';
    urls.add(route);
  }
  return urls;
}

describe('W337.B BaseLayout (Header + Footer) nav baseline', () => {
  const footer = read(FOOTER);
  const header = read(HEADER);
  const pageUrls = buildPageUrls();

  it('Footer contains the canonical product nav (F-3 — /roadmap removed per Issue 5; 2026-07-03 S11 — /roadmap returned as a COMPANY-column link, so the not-in-Product check is scoped to the Product column)', () => {
    expect(footer).toContain('href="/pricing/"');
    expect(footer).toContain('href="/comparison/"');
    expect(footer).toContain('href="/self-hosted/"');
    const productStart = footer.indexOf('>Product</h3>');
    const companyStart = footer.indexOf('>Company</h3>');
    expect(productStart).toBeGreaterThan(-1);
    expect(companyStart).toBeGreaterThan(productStart);
    const productColumn = footer.slice(productStart, companyStart);
    expect(productColumn).not.toContain('href="/roadmap"');
  });

  it('Footer Company column links /roadmap (2026-07-03 S11 — roadmap is reachable from every page via the footer; it stays out of the header nav on purpose)', () => {
    const companyStart = footer.indexOf('>Company</h3>');
    expect(companyStart).toBeGreaterThan(-1);
    expect(footer.slice(companyStart)).toContain('href="/roadmap/"');
  });

  it('Footer contains the canonical trust nav', () => {
    expect(footer).toContain('href="/trust/"');
    expect(footer).toContain('href="/security/"');
    expect(footer).toContain('href="/trust/sub-processors/"');
  });

  it('Footer contains the canonical company nav', () => {
    expect(footer).toContain('href="/about/"');
    expect(footer).toContain('href="/faq/"');
    expect(footer).toContain('href="/changelog/"');
  });

  it('every internal href in the Footer resolves to a real marketing page', () => {
    const hrefs = [...footer.matchAll(/href="(\/[A-Za-z0-9/_-]*)"/g)].map((m) => m[1]!);
    const offenders = hrefs.filter(
      (h) => h !== '/' && !pageUrls.has(h.endsWith('/') ? h.slice(0, -1) : h),
    );
    expect(offenders).toEqual([]);
  });

  it('every internal href in the Header resolves to a real marketing page', () => {
    const hrefs = [...header.matchAll(/href="(\/[A-Za-z0-9/_-]*)"/g)].map((m) => m[1]!);
    const offenders = hrefs
      // Strip anchors for the existence check.
      .map((h) => h.split('#')[0]!)
      .filter((h) => h !== '/' && h !== '' && !pageUrls.has(h));
    expect(offenders).toEqual([]);
  });
});
