// W841 — cross-SDK V-211 anonymity check on SDK source. One-hundred-
// sixty-seventh in the drift-guard series. Pins that no SDK source
// contains V-211 anonymity-violator tokens (founder framing, or a
// personal name). Matches V-527 commit-msg hook enforcement (W807) but
// at the source-tree level — SDK source is public-facing, so a slip
// would publish founder identity globally.
//
// Two checks, the same two the V-527 hook applies:
//   - (^|[^[:alnum:]])[Ff]ounder([^[:alpha:]]|$) — word-boundary guarded
//     so compounds like 'foundered' / 'foundation' pass;
//   - personal names, matched by scripts/personal-names.mjs against a list
//     that lives outside the repo (never spelled out or hashed here), so a
//     longer word containing a name passes and a name beside digits or an
//     `@` does not.

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
      entry === '.venv' ||
      entry === '__pycache__' ||
      entry === '.mypy_cache' ||
      entry === '.pytest_cache' ||
      entry === '.ruff_cache'
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

// V-211 founder pattern (mirrors the V-527 hook from W807). JavaScript regex
// syntax — \b handles the [^[:alnum:]] + start/end-of-string equivalents.
const FOUNDER = /\b[Ff]ounder\b/;

/** Every V-211 violation in `text`: founder framing, then personal names. */
function violations(text: string): string[] {
  const out: string[] = [];
  const m = text.match(FOUNDER);
  if (m) out.push(`founder framing '${m[0]}'`);
  for (const { word } of personalNameHits(text)) out.push(`personal name '${word}'`);
  return out;
}

describe('W841 cross-SDK V-211 anonymity source check', () => {
  // ─── SDK source scan ─────────────────────────────────────────

  it('CRITICAL no SDK source (runtime + examples + tests) contains V-211 anonymity-violator tokens (founder framing, or a personal name from the out-of-repo list). SDK source is public-facing — a slip would publish founder identity globally. Matches V-527 commit-msg hook patterns (W807).', () => {
    const dirs = [
      resolve(REPO_ROOT, 'packages/sdk-typescript'),
      resolve(REPO_ROOT, 'packages/sdk-python'),
      resolve(REPO_ROOT, 'packages/sdk-go'),
    ];
    const files: string[] = [];
    for (const d of dirs) {
      files.push(...listFiles(d, ['.ts', '.py', '.go', '.md', '.toml', '.json']));
    }
    // Skip lockfiles + generated dist/.
    const filtered = files.filter(
      (f) =>
        !f.endsWith('package-lock.json') &&
        !f.includes('/dist/') &&
        !f.includes('/.venv/') &&
        !f.includes('_pycache__'),
    );

    expect(filtered.length, 'the SDK walk found files to sweep').toBeGreaterThan(0);
    const leaks: string[] = [];
    for (const f of filtered) {
      for (const v of violations(read(f))) leaks.push(`${relative(REPO_ROOT, f)}: ${v}`);
    }
    expect(leaks, 'V-211 anonymity violator(s) in SDK source').toEqual([]);
  });

  // ─── Word-boundary guard does NOT catch compounds ─────────────

  it("CRITICAL the V-211 checks correctly allow compounds — 'foundered' / 'foundation', and a listed name plus 'ine'. Drift to a check without word boundaries would create false positives that block legit text.", () => {
    for (const compound of ['foundation', 'foundered', `${CANARY_WORD}ine`, `x${CANARY_WORD}`]) {
      expect(violations(compound), `falsely flagged compound '${compound}'`).toEqual([]);
    }
  });

  it('CRITICAL the V-211 checks DO match the canonical violators — founder in either case, and a listed name in any casing or beside digits (driven through the real matcher by its canary word).', () => {
    const cap = CANARY_WORD[0]!.toUpperCase() + CANARY_WORD.slice(1);
    for (const v of ['Founder', 'founder', CANARY_WORD, cap, `${CANARY_WORD}89`]) {
      expect(violations(v).length, `failed to match V-211 violator '${v}'`).toBeGreaterThan(0);
    }
  });

  // ─── V-527 hook reject-pattern source consistency ─────────────

  it('CRITICAL V-527 commit-msg hook (scripts/git-hooks/commit-msg) applies the SAME two checks — the founder pattern and the shared personal-name matcher. Drift between this test and the hook would create an inconsistency where commits get rejected but source slips through (or vice versa).', () => {
    const hook = read(resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg'));
    expect(hook).toMatch(/\[Ff\]ounder/);
    expect(hook).toMatch(/PERSONAL_NAMES="\$HOOK_DIR\/\.\.\/personal-names\.mjs"/);
    expect(hook).toMatch(/node "\$PERSONAL_NAMES" "\$MSG_FILE"/);
  });

  // ─── Both commit policies live in the hook ───────────────────

  it('CRITICAL the V-211 anonymity rule + V-205 attribution rule are both in V-527 hook. The dual-policy enforcement is what W807 + this test together pin — drift to dropping either would let a class of leak through.', () => {
    const hook = read(resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg'));
    expect(hook).toMatch(/V-205 attribution/);
    expect(hook).toMatch(/V-211 anonymity/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-v211-anonymity-source-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
