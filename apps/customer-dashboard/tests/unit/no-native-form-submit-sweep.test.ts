// W289.C — drift guard for customer-dashboard <form> usage. Pages
// drive POST/DELETE through `fetch(apiBaseUrl + '/v1/...')` rather
// than native form submissions. Catches drift where a new form
// declares `action="..."` and `method="POST"`, which would skip the
// auth header injection in the JS handlers and hit the wrong host.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

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

const pages = walk(PAGES).filter((f) => /\.astro$/.test(f));

/**
 * Native form submissions in `text` — an `action` plus a mutating `method`.
 *
 * Shared with the reachability check below deliberately: this guard hunts a
 * VIOLATION, so zero matches across the pages is the expected, correct state.
 * That makes a subject count useless as a floor — it would read zero forever —
 * and a synthetic known-bad the only thing that can show the matcher still
 * works.
 */
function nativeSubmittingForms(text: string): string[] {
  // Strip frontmatter so doc-comment examples don't trip.
  const stripped = text.replace(/^---[\s\S]*?\n---\n/, '');
  return [...stripped.matchAll(/<form\b([^>]*)>/gi)]
    .filter(
      (m) =>
        /\baction=["'][^"']+["']/.test(m[1]!) &&
        /\bmethod=["'](post|put|patch|delete)["']/i.test(m[1]!),
    )
    .map((m) => m[0].slice(0, 100));
}

describe('W289.C customer-dashboard <form action="..." method="POST"> sweep', () => {
  it('CRITICAL the sweep read real pages and the matcher still recognises a native submit. This hunts a violation, so it is GREEN when it finds nothing — which is also exactly what it looks like when the pattern has stopped matching or the walk has stopped walking. A count of offenders can never tell those apart; a known-bad input can.', () => {
    expect(pages.length, '.astro pages under dashboard pages/').toBeGreaterThan(15);

    expect(
      nativeSubmittingForms('<form action="/v1/account" method="POST"><input/></form>'),
      'a native POST form is detected',
    ).toHaveLength(1);
    expect(
      nativeSubmittingForms('<form action="/v1/account" method="DELETE"></form>'),
      'and so is a DELETE, case-insensitively',
    ).toHaveLength(1);
    expect(
      nativeSubmittingForms('<form id="filters"><input/></form>'),
      'while a form with no action/method is not — those are the ones the dashboard actually uses',
    ).toEqual([]);
    expect(
      nativeSubmittingForms(
        '---\nconst example = \'<form action="/x" method="POST">\';\n---\n<p>ok</p>',
      ),
      'and a frontmatter example is still ignored, so the strip has not become a blanket',
    ).toEqual([]);
  });

  it('no .astro page declares a native form action+method POST/DELETE/PATCH', () => {
    const offenders = pages
      .filter((f) => nativeSubmittingForms(read(f)).length > 0)
      .map((f) => f.slice(REPO_ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});
