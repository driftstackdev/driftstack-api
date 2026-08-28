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

/**
 * The forbidden attributes present in `text`, by the rule the sweep uses.
 *
 * Shared with the reachability check below deliberately: a floor that exercised
 * a *separate* copy of the matcher would prove that copy works, which is not
 * the question.
 */
function offendingAttrs(text: string): string[] {
  // Strip frontmatter + JS-context tokens so we only catch HTML attributes.
  const stripped = text.replace(/^---[\s\S]*?\n---\n/, '');
  // Require the attr to be preceded by whitespace, ", or '
  return FORBIDDEN_ATTRS.filter((attr) => new RegExp(`[\\s"']${attr}`, 'i').test(stripped));
}

describe('W283.B customer-dashboard no-inline-event-handler sweep', () => {
  it('CRITICAL the sweep read real pages and can still see a violation. `walk` returns silently when its directory is missing, so a renamed or moved src/ leaves the assertion below vacuously true — reporting every page clean because it read none.', () => {
    expect(astroFiles.length, '.astro pages found under customer-dashboard/src').toBeGreaterThan(
      15,
    );
    expect(
      offendingAttrs('<button type="button" onclick="doThing()">Go</button>'),
      'a known-bad page is still detected by the matcher above',
    ).toEqual(['onclick=']);
  });

  it('no .astro file uses an inline DOM event handler attribute', () => {
    const offenders: { file: string; attr: string }[] = [];
    for (const f of astroFiles) {
      for (const attr of offendingAttrs(read(f))) {
        offenders.push({ file: f.slice(REPO_ROOT.length + 1), attr });
      }
    }
    expect(offenders).toEqual([]);
  });
});
