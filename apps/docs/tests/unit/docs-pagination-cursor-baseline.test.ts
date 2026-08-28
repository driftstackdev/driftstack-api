// W290.C — drift guard for docs pagination conventions. Pages that
// document a list endpoint should describe `limit` + `cursor` query
// params (per the canonical pagination scheme), not `page` or
// `offset` parameters. Catches drift where docs invent a pagination
// model that doesn't exist on the server.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_API = resolve(REPO_ROOT, 'apps/docs/src/pages/api');

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

const mdFiles = walk(DOCS_API).filter((f) => /\.md$/.test(f));

/**
 * Page/offset pagination cited in `text`.
 *
 * The convention is `?cursor=` + `?limit=`. `?page=` or `?offset=` would be
 * page-number pagination, which the API does not implement — so docs citing it
 * describe a model that does not exist.
 *
 * Shared with the reachability check below deliberately: this hunts a
 * VIOLATION, so zero matches is the correct state and a subject count is
 * useless as a floor. Only a known-bad input shows the matcher still fires.
 */
const citesPageParam = (text: string): boolean => /\?page=\d/.test(text);
const citesOffsetParam = (text: string): boolean => /\?offset=\d/.test(text);

describe('W290.C docs/api pagination convention sweep', () => {
  it('CRITICAL the sweep read real pages and both matchers still fire. This hunts a violation, so finding nothing is the correct outcome — and identical to what a moved docs/api directory or a pattern that stopped matching produces. A count of offenders cannot distinguish them.', () => {
    expect(mdFiles.length, '.md pages under docs/api').toBeGreaterThan(15);

    expect(citesPageParam('GET /v1/sessions?page=2'), 'a page-number param is detected').toBe(true);
    expect(citesOffsetParam('GET /v1/sessions?offset=40'), 'an offset param is detected').toBe(
      true,
    );
    expect(
      citesPageParam('GET /v1/sessions?cursor=abc&limit=25'),
      'while the canonical cursor form is not reported',
    ).toBe(false);
    expect(citesOffsetParam('GET /v1/sessions?cursor=abc&limit=25'), 'in either matcher').toBe(
      false,
    );
  });

  it('no docs/api page cites a `?page=` query param (we use cursor pagination)', () => {
    const offenders = mdFiles
      .filter((f) => citesPageParam(read(f)))
      .map((f) => f.slice(REPO_ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it('no docs/api page cites a `?offset=` query param', () => {
    const offenders = mdFiles
      .filter((f) => citesOffsetParam(read(f)))
      .map((f) => f.slice(REPO_ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});
