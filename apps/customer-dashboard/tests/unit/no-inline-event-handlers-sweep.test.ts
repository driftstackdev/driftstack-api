// W283.B — drift guard against inline DOM event handlers on
// customer-dashboard pages. CSP forbids `onclick=`, `onload=`, etc.
// inline attributes; all behavior should be attached via
// addEventListener in <script> blocks. Catches drift where a new
// page or component copies a Stack Overflow snippet that uses an
// inline handler.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/customer-dashboard/src');

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

const astroFiles = walk(SRC).filter((f) => /\.astro$/.test(f));

// Inline event handlers we forbid. Note: this must match the
// attribute form (token immediately preceded by whitespace or "<...")
// — not arbitrary substrings like `onclickHelper`.
const FORBIDDEN_ATTRS = [
  'onclick=',
  'onload=',
  'onsubmit=',
  'onchange=',
  'onkeydown=',
  'onkeyup=',
  'onfocus=',
  'onblur=',
  'onmouseenter=',
  'onmouseleave=',
];

describe('W283.B customer-dashboard no-inline-event-handler sweep', () => {
  it('no .astro file uses an inline DOM event handler attribute', () => {
    const offenders: { file: string; attr: string }[] = [];
    for (const f of astroFiles) {
      const body = read(f);
      // Strip frontmatter + JS-context tokens so we only catch HTML
      // attributes.
      const stripped = body.replace(/^---[\s\S]*?\n---\n/, '');
      for (const attr of FORBIDDEN_ATTRS) {
        // Require the attr to be preceded by whitespace, ", or '
        const re = new RegExp(`[\\s"']${attr.replace('=', '=')}`, 'i');
        if (re.test(stripped)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), attr });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
