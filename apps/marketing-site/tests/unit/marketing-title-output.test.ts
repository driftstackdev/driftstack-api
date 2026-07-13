import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', '..', 'dist');

function htmlFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? htmlFiles(path) : entry.name.endsWith('.html') ? [path] : [];
  });
}

describe('marketing rendered title and error-page metadata', () => {
  it('renders the Driftstack brand at most once in every page title', () => {
    const pages = htmlFiles(DIST);
    expect(pages.length).toBeGreaterThan(50);
    for (const page of pages) {
      const html = readFileSync(page, 'utf8');
      const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
      expect(title, `missing title in ${page}`).not.toBe('');
      expect(
        title.match(/Driftstack/g)?.length ?? 0,
        `duplicated brand in ${page}: ${title}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('renders both error-only routes as noindex,nofollow', () => {
    for (const name of ['404.html', '500.html']) {
      const html = readFileSync(join(DIST, name), 'utf8');
      expect(html, name).toContain('<meta name="robots" content="noindex,nofollow">');
    }
  });
});
