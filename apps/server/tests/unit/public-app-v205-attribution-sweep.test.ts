// W844 — public-app V-205 attribution sweep. One-hundred-seventieth
// in the drift-guard series. Pins that public-visible apps — the roster
// DERIVED from scripts/deploy-frontend.sh, because listing five names inline
// is how errors-site sat outside this sweep while it claimed to cover the
// public apps — contain ZERO V-205 attribution-leak tokens (Claude/
// Anthropic/Copilot/GPT Co-Authored-By trailers + 🤖 robot + Generated
// with [Claude + noreply@anthropic.com + noreply@github.com).

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

// V-205 attribution patterns. Mirror W842 SDK sweep patterns.
const V205_PATTERNS = [
  { name: 'Co-Authored-By Claude', regex: /Co-Authored-By: Claude/i },
  { name: 'Co-Authored-By anthropic', regex: /Co-Authored-By:.*anthropic/i },
  { name: 'Co-Authored-By GPT', regex: /Co-Authored-By:.*GPT/i },
  { name: 'Co-Authored-By Copilot', regex: /Co-Authored-By:.*Copilot/i },
  { name: 'robot emoji', regex: /🤖/ },
  { name: 'Generated with [Claude', regex: /Generated with \[Claude/i },
  { name: 'noreply@anthropic.com', regex: /noreply@anthropic\.com/i },
  { name: 'noreply@github.com', regex: /noreply@github\.com/i },
];

describe('W844 public-app V-205 attribution sweep', () => {
  // ─── Public-app source scan ──────────────────────────────────

  it('CRITICAL ZERO V-205 attribution-leak tokens in every publicly deployed app, the roster derived from the deploy script. Public apps SHIP customer-facing content — attribution to AI tooling would publish that fact to every customer who loads the page. Matches V-527 hook (W807) + W842 SDK sweep.', () => {
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
      for (const { name, regex } of V205_PATTERNS) {
        const m = p.match(regex);
        expect(m, `${rel} contains V-205 attribution leak '${name}': '${m?.[0] ?? ''}'`).toBeNull();
      }
    }
  });

  // ─── server source scan ──────────────────────────────────────

  it('CRITICAL ZERO V-205 attribution-leak tokens in apps/server source (excluding tests). Server source is build-output of the API + ships in container images — attribution would leak into infrastructure-as-code/SRE tooling.', () => {
    const files = listFiles(resolve(REPO_ROOT, 'apps/server/src'), ['.ts']);

    for (const f of files) {
      const p = read(f);
      const rel = relative(REPO_ROOT, f);
      for (const { name, regex } of V205_PATTERNS) {
        const m = p.match(regex);
        expect(m, `${rel} contains V-205 attribution leak '${name}': '${m?.[0] ?? ''}'`).toBeNull();
      }
    }
  });

  // ─── public-facing docs scan ─────────────────────────────────

  it('CRITICAL ZERO V-205 attribution-leak tokens in docs/* (excluding internal/ private workflow notes). Public docs are intended for customer reading — drift would publish to docs.driftstack.dev.', () => {
    const docsDirs = [
      'docs/api',
      'docs/architecture',
      'docs/deployment',
      'docs/legal',
      'docs/marketing',
      'docs/operations',
      'docs/runbooks',
      'docs/launch',
      'docs/benchmarks',
      'docs/load-test',
    ];
    for (const d of docsDirs) {
      const dir = resolve(REPO_ROOT, d);
      if (!statSync(dir, { throwIfNoEntry: false })) continue;
      const files = listFiles(dir, ['.md']);
      for (const f of files) {
        const p = read(f);
        const rel = relative(REPO_ROOT, f);
        for (const { name, regex } of V205_PATTERNS) {
          const m = p.match(regex);
          expect(
            m,
            `${rel} contains V-205 attribution leak '${name}': '${m?.[0] ?? ''}'`,
          ).toBeNull();
        }
      }
    }
  });

  // ─── README.md + AGENTS.md + status.md root sweep ────────────

  it('CRITICAL root README.md + AGENTS.md + status.md contain ZERO V-205 attribution leaks. These are the canonical first-read documents — drift would attribute the project to AI tooling at the front door.', () => {
    for (const f of ['README.md', 'AGENTS.md', 'status.md']) {
      const p = read(resolve(REPO_ROOT, f));
      // AGENTS.md mentions the V-205 rule explicitly so 'Co-Authored-By' may
      // appear in policy framing — skip THAT specific file from the
      // strict-pattern scan, but require the rule wording is present.
      if (f === 'AGENTS.md') {
        expect(p).toMatch(/co-authored-by/i);
        continue;
      }
      for (const { name, regex } of V205_PATTERNS) {
        const m = p.match(regex);
        expect(m, `${f} contains V-205 attribution leak '${name}': '${m?.[0] ?? ''}'`).toBeNull();
      }
    }
  });

  // ─── Sanity check ────────────────────────────────────────────

  it("CRITICAL regex correctly matches canonical V-205 violators. Sanity-check that the pattern hasn't degraded.", () => {
    const violators = [
      'Co-Authored-By: Claude <noreply@anthropic.com>',
      'Co-Authored-By: anthropic-claude-3-opus',
      '🤖 generated',
      'Generated with [Claude Code]',
      'noreply@github.com',
    ];
    for (const v of violators) {
      let matched = false;
      for (const { regex } of V205_PATTERNS) {
        if (regex.test(v)) {
          matched = true;
          break;
        }
      }
      expect(matched, `regex missed V-205 violator '${v}'`).toBe(true);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/public-app-v205-attribution-sweep.test.ts'),
      ),
    ).toBe(true);
  });
});
