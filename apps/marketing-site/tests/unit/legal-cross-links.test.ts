import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LEGAL_DIR = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal');
const PAGES = [
  'terms.md',
  'privacy.md',
  'dpa.md',
  'aup.md',
  'refunds.md',
  'sub-processors.md',
  'vulnerability-disclosure.md',
] as const;

function markdownLinks(source: string): string[] {
  return Array.from(source.matchAll(/\]\(([^)]+)\)/g), (match) => match[1]!);
}

describe('marketing legal-document cross-links', () => {
  it.each(PAGES)('%s never emits a source .md URL', (page) => {
    const links = markdownLinks(readFileSync(resolve(LEGAL_DIR, page), 'utf8'));
    const localMarkdownLinks = links.filter((href) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
      return href.split('#', 1)[0]!.endsWith('.md');
    });
    expect(localMarkdownLinks).toEqual([]);
  });

  it.each(PAGES)('%s canonical legal links resolve to a source page', (page) => {
    const links = markdownLinks(readFileSync(resolve(LEGAL_DIR, page), 'utf8'));
    const legalLinks = links.filter((href) => href.startsWith('/legal/'));
    for (const href of legalLinks) {
      const route = href
        .split('#', 1)[0]!
        .replace(/^\/legal\//, '')
        .replace(/\/$/, '');
      expect(existsSync(resolve(LEGAL_DIR, `${route}.md`)), href).toBe(true);
    }
  });
});
