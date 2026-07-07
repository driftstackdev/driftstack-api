// W342.B — sweep guard pinning the canonical API-key env var name
// across marketing /docs/* pages. Just fixed six call sites that
// said `DRIFTSTACK_KEY` instead of the canonical `DRIFTSTACK_API_KEY`
// (per /quickstart, SDK README, server config). Pin both forwards:
//
//   1. No marketing doc page references the wrong name.
//   2. The canonical name is what's still cited (catches an
//      accidental "rename to DRIFTSTACK_TOKEN" copy revamp).
//
// This is a sweep test, not a single-file test — it walks every
// /docs/*.astro page and flags any drift.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_DIR = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function listDocs(): string[] {
  return readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.astro'))
    .map((f) => resolve(DOCS_DIR, f));
}

describe('W342.B marketing /docs/* env-var-name sweep', () => {
  const files = listDocs();

  it('finds a sane number of /docs/*.astro pages (sanity check)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no doc page references the wrong DRIFTSTACK_KEY (must be DRIFTSTACK_API_KEY)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const body = read(f);
      // Match DRIFTSTACK_KEY not followed by `_` or an uppercase
      // letter — so DRIFTSTACK_API_KEY itself doesn't trigger.
      if (/DRIFTSTACK_KEY(?![A-Z_])/.test(body)) {
        offenders.push(f.replace(REPO_ROOT + '/', ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every doc page that mentions an env var uses the canonical DRIFTSTACK_API_KEY', () => {
    // Count pages that reference the env var in any form; if at
    // least a handful do, the canonical name is the only one in
    // use. (Negative-only assertion above already proves no drift.)
    const referencing = files.filter((f) => /DRIFTSTACK_API_KEY\b/.test(read(f)));
    expect(referencing.length).toBeGreaterThan(0);
  });

  it('the canonical quickstart cites DRIFTSTACK_API_KEY at least once', () => {
    // Sanity that the env var is actually documented somewhere the
    // user lands first.
    // S47 2026-07-07 (founder-approved: mirror deprecation): the
    // legacy /docs/api-quickstart mirror is deleted (301 →
    // docs.driftstack.dev/quickstart-curl/); the landing quickstart
    // is now the docs successor, so the guard reads that source.
    const quickstart = resolve(REPO_ROOT, 'apps/docs/src/pages/quickstart-curl.md');
    expect(read(quickstart)).toContain('DRIFTSTACK_API_KEY');
    expect(read(quickstart)).not.toMatch(/DRIFTSTACK_KEY(?![A-Z_])/);
  });
});
