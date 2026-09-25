// W843 — public-facing app V-211 personal-name sweep. One-hundred-
// sixty-ninth in the drift-guard series. Pins that public-visible
// apps contain ZERO personal-name strings anywhere in their source.
//
// The names are not written here, nor anywhere in the repo: the list lives
// outside it (DRIFTSTACK_PERSONAL_NAMES, or ~/.config/driftstack/
// personal-names.txt — see scripts/personal-names.mjs, the one matcher every
// V-211 guard shares). A sweep that spelled the names out, or hashed them,
// would itself publish them. With no list configured this sweep checks the
// canary word only and the matcher says so once (a GitHub warning in CI).
//
// The app roster is DERIVED from scripts/deploy-frontend.sh rather than
// listed here. It was listed here, as five names, and errors-site — deployed
// to errors.driftstack.dev and linked from every problem+json the API emits —
// was not among them. Nothing was wrong in it; nothing was checking either.
//
// Note: 'founder' as a role descriptor (not personal name) is
// allowed in internal-team code (gui-client, server, scripts). The
// V-527 commit-msg hook DOES catch 'founder' in commits, but here
// we focus on the public-app source where the rule is strictest.

import { PUBLIC_APP_EXTS, publicAppDirs } from './_helpers/public-apps.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANARY_WORD, personalNameHits } from '../../../../scripts/personal-names.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })) return out;
  for (const entry of readdirSync(dir)) {
    if (
      entry === 'node_modules' ||
      entry === 'dist' ||
      entry === '.astro' ||
      entry === 'test-results' ||
      entry === '__pycache__'
    )
      continue;
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listFiles(full, exts));
    } else if (exts.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

describe('W843 public-app V-211 personal-name sweep', () => {
  // ─── Public-app source scan ──────────────────────────────────

  it('CRITICAL ZERO personal-name strings in public-visible apps. Public apps SHIP customer-facing content — drift would silently publish founder identity to every customer who loads the page. Matching is per word (a run of letters), so a longer word that contains a name is not a hit.', () => {
    // Derived from the deploy script, not listed here: a hand-listed roster is
    // exactly how errors-site — deployed, and linked from every problem+json
    // the API emits — sat outside this sweep while it claimed to cover the
    // public apps.
    const dirs = publicAppDirs();
    const files: string[] = [];
    for (const d of dirs) {
      files.push(...listFiles(d, [...PUBLIC_APP_EXTS]));
    }
    expect(files.length, 'the public-app walk found files to sweep').toBeGreaterThan(0);

    const leaks: string[] = [];
    for (const f of files) {
      for (const { word } of personalNameHits(read(f))) {
        leaks.push(`${relative(REPO_ROOT, f)}: '${word}'`);
      }
    }
    expect(leaks, 'V-211 personal name(s) in public-app source').toEqual([]);
  });

  // ─── 'founder' role descriptor is allowed in internal code ────

  it("CRITICAL 'founder' as a role descriptor is intentionally allowed in INTERNAL apps (gui-client + scripts + internal docs). Drift to banning 'founder' in source would force false 'team' renames that lose meaning. The V-527 commit-msg hook DOES reject 'founder' in commit messages — that's the line.", () => {
    // gui-client/README + PACKAGING legitimately mention 'founder' as role.
    const guiReadme = read(resolve(REPO_ROOT, 'apps/gui-client/README.md'));
    expect(guiReadme).toMatch(/[Ff]ounder/);
  });

  // ─── V-211 sweep coordinates with W807 hook policy ────────────

  it('CRITICAL the V-527 commit-msg hook + this test together implement defense-in-depth — the hook stops new violators from being committed; this test stops existing violators from drifting INTO public-facing apps. Both read the SAME digest list, so the two cannot disagree about who is named. Drift to dropping the hook OR this test would leave a single-line-of-defense gap.', () => {
    const hook = read(resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg'));
    expect(hook).toMatch(/V-211 anonymity/);
    expect(hook).toMatch(/PERSONAL_NAMES="\$HOOK_DIR\/\.\.\/personal-names\.mjs"/);
    expect(hook).toMatch(/node "\$PERSONAL_NAMES" "\$MSG_FILE"/);
  });

  // ─── Sanity check: the matcher finds names and spares compounds ─

  it('CRITICAL the canary word is always on the list and drives the real matcher end to end — capitalised, upper-case, beside digits, inside an address. Drift would lose detection.', () => {
    const cap = CANARY_WORD[0]!.toUpperCase() + CANARY_WORD.slice(1);
    for (const text of [
      CANARY_WORD,
      cap,
      CANARY_WORD.toUpperCase(),
      `foo-${CANARY_WORD}-bar`,
      `${CANARY_WORD}89`,
      `${CANARY_WORD}@example.com`,
    ]) {
      expect(personalNameHits(text).length, `missed the canary in '${text}'`).toBeGreaterThan(0);
    }
  });

  it("CRITICAL the matcher tolerates compounds and folds accents and case — a name plus 'ine' is a different word, while an accented or capitalised spelling is the same one. Checked with a made-up list so no real name is needed. The per-word discrimination is what makes the sweep safe.", () => {
    const list = ['alexandra', 'zorbu42', 'zorbu42@example.org'];
    expect(personalNameHits('Alexandrine', list)).toEqual([]);
    expect(personalNameHits('alexandraville', list)).toEqual([]);
    expect(personalNameHits('Álexandra', list)).toEqual([{ index: 0, word: 'Álexandra' }]);
    expect(personalNameHits('Ale\u0301xandra', list)).toHaveLength(1);
    expect(personalNameHits('ALEXANDRA', list)).toHaveLength(1);
    // A hyphen or a digit ends a name — this is the desired behaviour
    // (catches hyphenated drift and handles like name89).
    expect(personalNameHits('alexandra-bar', list)).toHaveLength(1);
    expect(personalNameHits('alexandra89', list)).toHaveLength(1);
    // A handle or an address matches as a whole — the longest listed form — and not inside a longer one.
    expect(personalNameHits('mail zorbu42@example.org now', list)).toEqual([
      { index: 5, word: 'zorbu42@example.org' },
    ]);
    expect(personalNameHits('zorbu420', list)).toEqual([]);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/public-app-v211-personal-name-sweep.test.ts'),
      ),
    ).toBe(true);
  });
});
