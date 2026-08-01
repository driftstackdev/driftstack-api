// Client inline-escaper charset-completeness drift guard (2026-06-03).
//
// Context: customer-dashboard + admin-panel pages render API data into
// the DOM via `el.innerHTML = items.map(tpl).join('')` and HTML-escape
// free-text fields (names / emails / labels / URLs / descriptions) to
// prevent stored/reflected XSS → localStorage session-token theft.
//
// Because the pages use `<script is:inline define:vars>` — which CANNOT
// import the shared `src/lib/admin-client.escapeHtml` (see the Phase-0
// blocker: is:inline scripts aren't bundled, so no ES imports) — EACH
// page hand-duplicates its own `escapeHtml` / `escHtml` inline. As of
// 2026-06-03 a manual sweep confirmed all ~26 copies use the COMPLETE
// 5-char charset (& < > " '). There was NO automated guard against a
// future hand-copied escaper that DROPS a character — most dangerously
// `"` or `'`, which would reopen an attribute-context XSS on whichever
// page got the incomplete copy.
//
// This guard detects every inline HTML escaper (an `esc`-named function
// that produces `&amp;`) across both client apps and asserts it also
// produces the other four entities. A future incomplete copy fails the
// pre-push gate instead of shipping silently.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const CLIENT_SRC_DIRS = [
  resolve(REPO_ROOT, 'apps/customer-dashboard/src'),
  resolve(REPO_ROOT, 'apps/admin-panel/src'),
];

// The five HTML-special characters and their canonical entity encodings.
// A complete escaper for both text AND attribute contexts must cover all
// five — dropping `"` or `'` enables an attribute-context breakout.
const REQUIRED_ENTITIES = ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.astro') || full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function rel(p: string): string {
  return p.slice(REPO_ROOT.length + 1);
}

// A file defines an inline HTML escaper if it declares an `esc`-named
// function AND produces the `&amp;` entity (so non-HTML `esc*` helpers,
// e.g. a hypothetical escapeRegex, aren't falsely required to emit HTML
// entities).
function definesHtmlEscaper(src: string): boolean {
  // Both declaration forms. Every escaper today is a `function` statement, so
  // matching only that finds all 24 — but an arrow-assigned copy
  // (`const escapeHtml = (s) => …`) is the same hand-duplication with the same
  // charset risk, and the selector would silently skip it. A guard that
  // verifies a subset it chooses by pattern is only as complete as the pattern.
  const declaresEscaper =
    /function\s+\w*[eE]sc\w*\s*\(/.test(src) ||
    /(?:const|let|var)\s+\w*[eE]sc\w*\s*=\s*(?:function\b|\(|[A-Za-z_$])/.test(src);
  return declaresEscaper && src.includes('&amp;');
}

describe('client inline-escaper charset completeness (XSS drift guard)', () => {
  const escaperFiles = CLIENT_SRC_DIRS.flatMap(walk).filter((f) =>
    definesHtmlEscaper(readFileSync(f, 'utf8')),
  );

  it('finds the inline HTML escapers across both client apps (glob sanity)', () => {
    // The 2026-06-03 sweep counted ~26. A floor of 20 catches a broken
    // glob / mass-refactor without being brittle to small page churn.
    expect(escaperFiles.length).toBeGreaterThanOrEqual(20);
  });

  it('every inline HTML escaper covers the complete & < > " \' charset', () => {
    const incomplete: string[] = [];
    for (const file of escaperFiles) {
      const src = readFileSync(file, 'utf8');
      const missing = REQUIRED_ENTITIES.filter((e) => !src.includes(e));
      if (missing.length > 0) incomplete.push(`${rel(file)} — missing ${missing.join(', ')}`);
    }
    expect(
      incomplete,
      `Inline escaper(s) with an incomplete charset:\n${incomplete.join('\n')}`,
    ).toEqual([]);
  });
});
