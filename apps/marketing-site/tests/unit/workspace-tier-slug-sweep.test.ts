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

// Narrowly target only `*_growth`, `*_pro`, `*_plus`, `*_premium`, and
// `*_starter|builder|scale` paired with team/solo/agency/enterprise —
// suffix patterns that look like a tier slug but are NOT in the live enum.
const fictionalTierLike =
  /\b(?:team_(?:growth|pro|premium|plus)|solo_(?:pro|premium|plus)|agency_(?:plus|premium)|enterprise_(?:plus|premium)|api_(?:premium|plus|pro))\b/g;
const liveTiers = new Set(AccountTierSchema.options);

describe('W267.B workspace-wide tier-slug sweep', () => {
  it('no marketing-site / docs page resurrects a fictional tier-suffix pattern', () => {
    const targets = [
      resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
      resolve(REPO_ROOT, 'apps/docs/src/pages'),
    ];
    const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

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
    const targets = [
      resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
      resolve(REPO_ROOT, 'apps/docs/src/pages'),
    ];
    const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));
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
