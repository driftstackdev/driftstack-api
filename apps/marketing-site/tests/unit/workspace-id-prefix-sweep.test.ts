// W267.D — workspace-wide sweep guard. Each resource has a fixed
// id prefix from the route serialisers. Fail if any page surfaces a
// fictional prefix (`prf_`, `sn_`, `dlv_`, `oauth_`, etc.) where the
// live prefix is the one in CANONICAL_PREFIXES.

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

// Fictional prefixes that the AI tends to invent; the canonical
// counterpart is listed in the test message for the failure mode.
const FICTIONAL_PREFIXES: { pattern: RegExp; canonical: string }[] = [
  // sessions: live is `ses_`. Legacy / typos: `sess_`, `sn_`.
  { pattern: /\bsess_[a-zA-Z0-9_-]+/g, canonical: 'ses_' },
  // profiles: live is `prof_`. Legacy: `prf_`.
  { pattern: /\bprf_[a-zA-Z0-9_-]+/g, canonical: 'prof_' },
  // profile snapshots: live is `psnap_`. Legacy: `snap_<uuid>`.
  { pattern: /\bsnap_<uuid>/g, canonical: 'psnap_<uuid>' },
  // webhook delivery: live is `wdl_`. Legacy: `dlv_`.
  { pattern: /\bdlv_[a-zA-Z0-9_-]+/g, canonical: 'wdl_' },
  // webhook endpoint: live is `whk_`. Legacy: `wh_`.
  { pattern: /\bwh_[a-zA-Z0-9_-]{4,}/g, canonical: 'whk_' },
  // crypto order: live is `ord_`. Legacy: `co_`, `cryp_`.
  { pattern: /\bcryp_[a-zA-Z0-9_-]+/g, canonical: 'ord_' },
];

describe('W267.D workspace-wide id-prefix sweep', () => {
  // ⛔ Non-vacuity floor, added 2026-08-26. `walk` returns [] for a missing
  // root, so a renamed corpus directory turns this entire sweep green while
  // examining nothing. Mutation-proved: with both roots repointed at paths
  // that do not exist, the verdict was byte-identical to the clean run.
  //
  // Asserted PER ROOT on purpose. A floor on the combined count still passes
  // when ONE of the two directories disappears — which is the likelier
  // accident — because the survivor alone clears any threshold worth setting.
  // No count is pinned, so this cannot rot as pages are added or removed.
  it('every corpus root contributes files to the sweep', () => {
    for (const d of targets) {
      expect(walk(d).filter((f) => /\.(astro|md)$/.test(f)).length, d).toBeGreaterThan(0);
    }
  });

  for (const { pattern, canonical } of FICTIONAL_PREFIXES) {
    it(`no page uses a fictional id prefix — expected ${canonical}`, () => {
      const offenders: string[] = [];
      for (const f of allFiles) {
        const body = read(f);
        // Strip Astro frontmatter and inline JS comments.
        const stripped = body.replace(/^---[\s\S]*?\n---\n/, '').replace(/\/\/[^\n]*/g, '');
        if (pattern.test(stripped)) {
          offenders.push(f.slice(REPO_ROOT.length + 1));
        }
        // Reset regex state between iterations.
        pattern.lastIndex = 0;
      }
      expect(offenders).toEqual([]);
    });
  }
});
