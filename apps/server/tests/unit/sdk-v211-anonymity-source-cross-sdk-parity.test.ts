// W841 — cross-SDK V-211 anonymity check on SDK source. One-hundred-
// sixty-seventh in the drift-guard series. Pins that no SDK source
// contains V-211 anonymity-violator tokens (founder / Joel /
// Theunissen / Joeltheunissen). Matches V-527 commit-msg hook
// enforcement (W807) but at the source-tree level — SDK source is
// public-facing, so a slip would publish founder identity globally.
//
// The V-211 reject patterns from V-527 (with word-boundary guards
// to allow compounds like 'foundered' / 'foundation' / 'Joeline'):
//   - (^|[^[:alnum:]])[Ff]ounder([^[:alnum:]]|$)
//   - (^|[^[:alnum:]])[Jj]oel([^[:alnum:]]|$)
//   - (^|[^[:alnum:]])[Tt]heunissen([^[:alnum:]]|$)
//   - (^|[^[:alnum:]])[Jj]oeltheunissen([^[:alnum:]]|$)

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

// V-211 reject patterns (mirror V-527 hook from W807).
// JavaScript regex syntax — \b word boundary handles the [^[:alnum:]]
// + start/end-of-string equivalents.
const V211_PATTERNS = [
  { name: 'Founder', regex: /\b[Ff]ounder\b/ },
  { name: 'Joel', regex: /\b[Jj]oel\b/ },
  { name: 'Theunissen', regex: /\b[Tt]heunissen\b/ },
  { name: 'Joeltheunissen', regex: /\b[Jj]oeltheunissen\b/ },
];

describe('W841 cross-SDK V-211 anonymity source check', () => {
  // ─── SDK source scan ─────────────────────────────────────────

  it('CRITICAL no SDK source (runtime + examples + tests) contains V-211 anonymity-violator tokens (Founder / Joel / Theunissen / Joeltheunissen). SDK source is public-facing — a slip would publish founder identity globally. Matches V-527 commit-msg hook patterns (W807).', () => {
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

    for (const f of filtered) {
      const p = read(f);
      const rel = relative(REPO_ROOT, f);
      for (const { name, regex } of V211_PATTERNS) {
        const m = p.match(regex);
        expect(
          m,
          `${rel} contains V-211 anonymity violator '${name}': '${m?.[0] ?? ''}'`,
        ).toBeNull();
      }
    }
  });

  // ─── Word-boundary guard does NOT catch compounds ─────────────

  it("CRITICAL the V-211 word-boundary regex correctly allows compounds — 'foundered' / 'foundation' / 'Joeline'. Drift to a regex without \\b would create false positives that block legit text.", () => {
    // Sanity: 'foundation' is a legit word and must NOT match the Founder pattern.
    for (const compound of ['foundation', 'foundered', 'Joeline', 'theunissenia']) {
      let matchedBadly = false;
      for (const { regex } of V211_PATTERNS) {
        if (regex.test(compound)) {
          matchedBadly = true;
          break;
        }
      }
      expect(matchedBadly, `regex falsely flagged compound '${compound}'`).toBe(false);
    }
  });

  it('CRITICAL the V-211 regex DOES match the canonical violators. Sanity-check the regex shape against the literal tokens that V-527 hook rejects.', () => {
    const violators = [
      'Founder',
      'founder',
      'Joel',
      'joel',
      'Theunissen',
      'theunissen',
      'Joeltheunissen',
    ];
    for (const v of violators) {
      let matchedSomething = false;
      for (const { regex } of V211_PATTERNS) {
        if (regex.test(v)) {
          matchedSomething = true;
          break;
        }
      }
      expect(matchedSomething, `regex failed to match V-211 violator '${v}'`).toBe(true);
    }
  });

  // ─── V-527 hook reject-pattern source consistency ─────────────

  it('CRITICAL V-527 commit-msg hook (scripts/git-hooks/commit-msg) declares the SAME 4 V-211 reject patterns. Drift between this test and the hook would create an inconsistency where commits get rejected but source slips through (or vice versa).', () => {
    const hook = read(resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg'));
    // Each of the 4 violator tokens must appear as a regex pattern in the hook.
    expect(hook).toMatch(/\[Ff\]ounder/);
    expect(hook).toMatch(/\[Jj\]oel/);
    expect(hook).toMatch(/\[Tt\]heunissen/);
    expect(hook).toMatch(/\[Jj\]oeltheunissen/);
  });

  // ─── No-public-leak invariant for AGENTS.md + memory rules ────

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
