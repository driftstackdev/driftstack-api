// W843 — public-facing app V-211 personal-name sweep. One-hundred-
// sixty-ninth in the drift-guard series. Pins that public-visible
// apps contain ZERO personal-name strings (Joel / Theunissen /
// Joeltheunissen) anywhere in their source.
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

// V-211 PERSONAL-NAME patterns (the strictest subset — not 'founder'
// which is a role descriptor used in internal code).
const PERSONAL_NAME_PATTERNS = [
  { name: 'Joel', regex: /\b[Jj]oel\b/ },
  { name: 'Theunissen', regex: /\b[Tt]heunissen\b/ },
  { name: 'Joeltheunissen', regex: /\b[Jj]oeltheunissen\b/ },
];

describe('W843 public-app V-211 personal-name sweep', () => {
  // ─── Public-app source scan ──────────────────────────────────

  it('CRITICAL ZERO personal-name strings (Joel / Theunissen / Joeltheunissen) in public-visible apps. Public apps SHIP customer-facing content — drift would silently publish founder identity to every customer who loads the page. Word-boundary regex allows compounds like Joeline through.', () => {
    // Derived from the deploy script, not listed here: a hand-listed roster is
    // exactly how errors-site — deployed, and linked from every problem+json
    // the API emits — sat outside this sweep while it claimed to cover the
    // public apps.
    const dirs = publicAppDirs();
    const files: string[] = [];
    for (const d of dirs) {
      files.push(...listFiles(d, [...PUBLIC_APP_EXTS]));
    }

    for (const f of files) {
      const p = read(f);
      const rel = relative(REPO_ROOT, f);
      for (const { name, regex } of PERSONAL_NAME_PATTERNS) {
        const m = p.match(regex);
        expect(m, `${rel} contains V-211 personal-name '${name}': '${m?.[0] ?? ''}'`).toBeNull();
      }
    }
  });

  // ─── 'founder' role descriptor is allowed in internal code ────

  it("CRITICAL 'founder' as a role descriptor is intentionally allowed in INTERNAL apps (gui-client + scripts + docs/internal). Drift to banning 'founder' in source would force false 'team' renames that lose meaning. The V-527 commit-msg hook DOES reject 'founder' in commit messages — that's the line.", () => {
    // gui-client/README + PACKAGING legitimately mention 'founder' as role.
    const guiReadme = read(resolve(REPO_ROOT, 'apps/gui-client/README.md'));
    expect(guiReadme).toMatch(/[Ff]ounder/);
  });

  // ─── V-211 sweep coordinates with W807 hook policy ────────────

  it('CRITICAL the V-527 commit-msg hook + this test together implement defense-in-depth — the hook stops new violators from being committed; this test stops existing violators from drifting INTO public-facing apps. Drift to dropping the hook OR this test would leave a single-line-of-defense gap.', () => {
    const hook = read(resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg'));
    expect(hook).toMatch(/V-211 anonymity/);
    expect(hook).toMatch(/\[Jj\]oel/);
    expect(hook).toMatch(/\[Tt\]heunissen/);
  });

  // ─── Sanity check: regex matches violators ────────────────────

  it("CRITICAL regex matches canonical personal-name violators — 'Joel' / 'joel' / 'Theunissen' / 'theunissen' / 'Joeltheunissen'. Drift would lose detection.", () => {
    const violators = ['Joel', 'joel', 'Theunissen', 'theunissen', 'Joeltheunissen'];
    for (const v of violators) {
      let matched = false;
      for (const { regex } of PERSONAL_NAME_PATTERNS) {
        if (regex.test(v)) {
          matched = true;
          break;
        }
      }
      expect(matched, `regex failed to match '${v}'`).toBe(true);
    }
  });

  it("CRITICAL regex tolerates compounds — 'Joeline' / 'theunissenia' / 'foo-joel-bar' (no — 'joel' in 'foo-joel-bar' is bounded by hyphens which ARE word-boundaries; pinned NOT to match arbitrary compound). The word-boundary discrimination is what makes the regex safe.", () => {
    // Compounds that should NOT match.
    expect(/\b[Jj]oel\b/.test('Joeline')).toBe(false);
    expect(/\b[Tt]heunissen\b/.test('theunissenia')).toBe(false);
    // 'joel-bar' DOES match because hyphen is a word-boundary — this
    // is the desired behavior (catches hyphenated drift).
    expect(/\b[Jj]oel\b/.test('joel-bar')).toBe(true);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/public-app-v211-personal-name-sweep.test.ts'),
      ),
    ).toBe(true);
  });
});
