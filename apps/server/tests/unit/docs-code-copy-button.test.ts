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

describe('docs code-block copy button', () => {
  const body = readFileSync(LAYOUT, 'utf8');

  it('DocLayout exists', () => {
    expect(existsSync(LAYOUT)).toBe(true);
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
