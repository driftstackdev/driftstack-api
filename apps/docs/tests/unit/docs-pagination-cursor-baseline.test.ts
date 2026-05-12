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

const mdFiles = walk(DOCS_API).filter((f) => /\.md$/.test(f));

describe('W290.C docs/api pagination convention sweep', () => {
  it('no docs/api page cites a `?page=` query param (we use cursor pagination)', () => {
    const offenders: string[] = [];
    for (const f of mdFiles) {
      const body = read(f);
      // The convention is `?cursor=` + `?limit=`. `?page=` would be
      // page-number pagination, which we don't implement.
      if (/\?page=\d/.test(body)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no docs/api page cites a `?offset=` query param', () => {
    const offenders: string[] = [];
    for (const f of mdFiles) {
      const body = read(f);
      if (/\?offset=\d/.test(body)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
