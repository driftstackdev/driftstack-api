// W267.B — workspace-wide sweep guard. Every tier-slug-shaped token
// in marketing-site + apps/docs pages must be a real AccountTier enum
// value. Catches fictional slugs like `team_growth` / `solo_pro` /
// `enterprise_plus` that the AI loves to invent.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema } from '@driftstack/api-types';

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

/**
 * The pages this sweep is about, with the walk's roots asserted.
 *
 * ⛔ Both arms below assert `offenders` is empty, and `[]` is ALSO what a walk over a
 * MISSING root produces — `walk` opens with `if (!existsSync(dir)) return out;`. So a
 * renamed or moved pages directory turns these guards silent and green in the same
 * instant, reporting every page clean because it read none.
 *
 * ⚠️ The root check lives HERE rather than inside `walk`, deliberately. `walk`
 * recurses, so its existsSync guards every descent and not just the entry — making it
 * throw would also kill the walk on a subdirectory that vanishes mid-iteration or a
 * broken symlink, neither of which is the failure being caught. Assert the roots once,
 * at the call site; leave the recursive tolerance alone.
 */
function collectPages(): string[] {
  const targets = [
    resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
    resolve(REPO_ROOT, 'apps/docs/src/pages'),
  ];
  for (const dir of targets) {
    expect(existsSync(dir), `walk root missing, this sweep would pass over nothing: ${dir}`).toBe(
      true,
    );
  }
  const files = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));
  // A floor as well as a root check: a root that exists but yields nothing — a broken
  // extension filter, an emptied directory — is the same silent pass by another route.
  expect(
    files.length,
    'the page walk found nothing — an empty sweep is not a clean one',
  ).toBeGreaterThan(20);
  return files;
}

// Narrowly target only `*_growth`, `*_pro`, `*_plus`, `*_premium`, and
// `*_starter|builder|scale` paired with team/solo/agency/enterprise —
// suffix patterns that look like a tier slug but are NOT in the live enum.
const fictionalTierLike =
  /\b(?:team_(?:growth|pro|premium|plus)|solo_(?:pro|premium|plus)|agency_(?:plus|premium)|enterprise_(?:plus|premium)|api_(?:premium|plus|pro))\b/g;
const liveTiers = new Set(AccountTierSchema.options);

describe('W267.B workspace-wide tier-slug sweep', () => {
  it('no marketing-site / docs page resurrects a fictional tier-suffix pattern', () => {
    const allFiles = collectPages();

    const offenders: { file: string; slug: string }[] = [];
    for (const f of allFiles) {
      const body = read(f);
      const stripped = body.replace(/^---[\s\S]*?\n---\n/, '').replace(/\/\/[^\n]*/g, '');
      for (const m of stripped.matchAll(fictionalTierLike)) {
        const slug = m[0];
        if (liveTiers.has(slug as never)) continue;
        offenders.push({ file: f.slice(REPO_ROOT.length + 1), slug });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no page resurrects the fictional team_growth / solo_pro / enterprise_plus slugs', () => {
    const allFiles = collectPages();
    const offenders: string[] = [];
    for (const f of allFiles) {
      const body = read(f);
      if (/\bteam_growth\b/.test(body))
        offenders.push(`${f.slice(REPO_ROOT.length + 1)}: team_growth`);
      if (/\bsolo_pro\b/.test(body)) offenders.push(`${f.slice(REPO_ROOT.length + 1)}: solo_pro`);
      if (/\benterprise_plus\b/.test(body))
        offenders.push(`${f.slice(REPO_ROOT.length + 1)}: enterprise_plus`);
    }
    expect(offenders).toEqual([]);
  });
});
