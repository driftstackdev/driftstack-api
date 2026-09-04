import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SOURCE_ROOTS = [
  'apps/marketing-site/src',
  'apps/docs/src',
  'apps/customer-dashboard/src',
  'apps/status-site/src',
].map((path) => resolve(REPO_ROOT, path));
const SOURCE_EXTENSIONS = new Set(['.astro', '.md', '.mdx', '.ts', '.tsx']);
const STATIC_HOSTS = new Set([
  'driftstack.io',
  'app.driftstack.io',
  'admin.driftstack.io',
  'docs.driftstack.io',
  'status.driftstack.io',
]);

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (SOURCE_EXTENSIONS.has(extname(entry))) files.push(path);
  }
  return files;
}

function needsCanonicalSlash(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (!STATIC_HOSTS.has(url.hostname) || url.pathname === '/' || url.pathname.endsWith('/')) {
    return false;
  }
  const finalSegment = url.pathname.split('/').at(-1) ?? '';
  return !finalSegment.includes('.');
}

function clickableOwnedUrls(source: string, markdown: boolean): string[] {
  const urls = Array.from(
    source.matchAll(/\b(?:href|[A-Za-z]+Href)=["'](https:\/\/[^"']+)["']/g),
    (match) => String(match[1]),
  );
  urls.push(
    ...Array.from(source.matchAll(/\bhref\s*:\s*["'](https:\/\/[^"']+)["']/g), (match) =>
      String(match[1]),
    ),
  );
  if (markdown) {
    urls.push(
      ...Array.from(source.matchAll(/\]\((https:\/\/[^)\s]+)\)/g), (match) => String(match[1])),
      ...Array.from(source.matchAll(/<(https:\/\/[^>\s]+)>/g), (match) => String(match[1])),
    );
  }
  return urls;
}

describe('owned cross-origin static links', () => {
  it('requests canonical trailing-slash routes directly', () => {
    const violations: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of walk(root)) {
        const source = readFileSync(file, 'utf8');
        const markdown = /\.mdx?$/.test(file);
        for (const href of clickableOwnedUrls(source, markdown)) {
          if (needsCanonicalSlash(href)) {
            violations.push(`${relative(REPO_ROOT, file)} -> ${href}`);
          }
        }
      }
    }
    expect(
      violations,
      `Owned static links must append / before query or fragment to avoid an extra redirect:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('distinguishes static-route regressions from roots, API-style files, and other hosts', () => {
    expect(needsCanonicalSlash('https://app.driftstack.io/signup?next=%2Fbilling#choose')).toBe(
      true,
    );
    expect(needsCanonicalSlash('https://app.driftstack.io/signup/?next=%2Fbilling#choose')).toBe(
      false,
    );
    expect(needsCanonicalSlash('https://docs.driftstack.io')).toBe(false);
    expect(needsCanonicalSlash('https://driftstack.io/.well-known/security.txt')).toBe(false);
    expect(needsCanonicalSlash('https://api.driftstack.dev/v1/status')).toBe(false);
    expect(needsCanonicalSlash('https://errors.driftstack.dev/forbidden')).toBe(false);
    expect(needsCanonicalSlash('https://example.com/path')).toBe(false);
  });

  it('turns red for every clickable source form when a slash is removed', () => {
    const mutatedSource = [
      '<a href="https://app.driftstack.io/signup">Sign up</a>',
      '<CtaBand primaryHref="https://app.driftstack.io/settings" />',
      "cta: { href: 'https://driftstack.io/pricing' }",
      '[Privacy](https://driftstack.io/legal/privacy)',
      '<https://docs.driftstack.io/quickstart>',
    ].join('\n');
    const violations = clickableOwnedUrls(mutatedSource, true).filter(needsCanonicalSlash);
    expect(violations).toEqual([
      'https://app.driftstack.io/signup',
      'https://app.driftstack.io/settings',
      'https://driftstack.io/pricing',
      'https://driftstack.io/legal/privacy',
      'https://docs.driftstack.io/quickstart',
    ]);
  });
});
