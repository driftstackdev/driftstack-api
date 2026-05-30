// Drift guard: the docs layout must mount a copy-to-clipboard button on
// every code block. Developers copy SDK snippets constantly, so this is
// table-stakes docs DX; a regression that drops the script would silently
// remove it from every docs page.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/docs/src/layouts/DocLayout.astro');

describe('docs layout DX affordances (copy button + section anchors)', () => {
  const body = readFileSync(LAYOUT, 'utf8');

  it('DocLayout exists', () => {
    expect(existsSync(LAYOUT)).toBe(true);
  });

  it('adds a hover/focus section-anchor link to every article heading with an id (deep-link discoverability + copies the URL)', () => {
    expect(body).toMatch(/querySelectorAll\(['"]article h2\[id\], article h3\[id\]['"]\)/);
    expect(body).toMatch(/aria-label['"], ['"]Link to this section/);
    expect(body).toMatch(/a\.href = ['"]#['"] \+ h\.id/);
    // clicking copies the absolute section URL.
    expect(body).toMatch(/window\.location\.origin \+ window\.location\.pathname/);
  });

  it('builds an "On this page" TOC from the h2 sections (only on pages with enough sections), inserted before the first section', () => {
    expect(body).toMatch(/querySelectorAll\(['"]h2\[id\]['"]\)/);
    expect(body).toMatch(/headings\.length < 3/); // skip short docs
    expect(body).toMatch(/On this page/);
    expect(body).toMatch(/aria-label['"], ['"]On this page/);
    expect(body).toMatch(/article\.insertBefore\(nav, firstH2\)/);
  });

  it('mounts a clipboard-copy button on every article <pre> (Clipboard-API-guarded, keyboard-accessible)', () => {
    // Guarded on Clipboard API availability.
    expect(body).toMatch(/navigator\.clipboard/);
    // Targets the code blocks in the rendered article.
    expect(body).toMatch(/querySelectorAll\(['"]article pre['"]\)/);
    // A real <button> with an accessible label, not a bare clickable.
    expect(body).toMatch(/createElement\(['"]button['"]\)/);
    expect(body).toMatch(/aria-label['"], ['"]Copy code to clipboard/);
    // Writes the code text + gives "Copied" feedback.
    expect(body).toMatch(/clipboard\.writeText/);
    expect(body).toMatch(/'Copied'/);
  });
});
