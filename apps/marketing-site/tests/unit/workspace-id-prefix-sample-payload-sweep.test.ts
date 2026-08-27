// W284.B — workspace-wide sweep guard for JSON sample-payload id
// prefixes. Many docs pages embed example payloads with literal id
// values like `"id": "ses_..."`. Pin those leading-prefix forms to
// the canonical id-prefix per resource. Catches drift where a doc
// invents `sess_` (legacy) or `sn_` (typo) for a session id.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

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

const targets = [
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
  resolve(REPO_ROOT, 'apps/docs/src/pages'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

// Canonical id prefixes per resource — keys are the JSON field name.
const RESOURCE_PREFIX: Record<string, string> = {
  session_id: 'ses_',
  webhook_id: 'whk_',
  delivery_id: 'wdl_',
  profile_id: 'prof_',
  snapshot_id: 'psnap_',
  order_id: 'ord_',
  account_id: 'acc_',
  api_key_id: 'key_',
  invite_id: 'inv_',
  member_id: 'mem_',
  endpoint_id: 'whk_',
};

const fieldRe =
  /["'](session_id|webhook_id|delivery_id|profile_id|snapshot_id|order_id|account_id|api_key_id|invite_id|member_id|endpoint_id)["']\s*:\s*["']([a-z]+_[^"']+)["']/g;

describe('W284.B workspace-wide sample-payload id-prefix sweep', () => {
  // ⛔ walk() returns [] for a MISSING root, and [] is also the pass condition for
  // every emptiness assertion below — so a renamed or moved root turns this whole
  // sweep silent and green in the same instant, reporting the corpus clean because
  // it read none of it.
  //
  // ⚠️ Asserted in its own arm rather than at the walk. `allFiles` is built at MODULE
  // scope, where a throw takes the entire file out of collection instead of failing a
  // test; and the guard inside walk() covers every recursive descent, so making THAT
  // throw would kill the walk on a vanishing subdirectory or a broken symlink — a
  // different failure from the one being caught.
  it('non-vacuous: the sweep read a real corpus, so an empty result is a finding and not a clean bill', () => {
    for (const dir of targets) {
      expect(existsSync(dir), `walk root missing — this sweep read nothing: ${dir}`).toBe(true);
    }
    expect(
      allFiles.length,
      'the walk found no files; an empty sweep is not a clean one',
    ).toBeGreaterThan(5);
  });

  it('every "<resource>_id": "<value>" sample payload uses the canonical prefix', () => {
    const offenders: { file: string; field: string; value: string; want: string }[] = [];
    for (const f of allFiles) {
      const body = read(f);
      const matches = [...body.matchAll(fieldRe)];
      for (const m of matches) {
        const field = m[1]!;
        const value = m[2]!;
        const want = RESOURCE_PREFIX[field]!;
        if (!value.startsWith(want)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), field, value, want });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
