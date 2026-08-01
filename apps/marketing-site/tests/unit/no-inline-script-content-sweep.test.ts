// W283.C — drift guard for marketing-site / docs CSP posture.
// Inline <script> blocks that contain JS body content require an
// 'unsafe-inline' CSP directive. The marketing-site CSP is strict
// (no 'unsafe-inline'); ensure no page introduces an inline script
// without going through the Astro client-script path. Catches drift
// where a doc copies a third-party embed verbatim.

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
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.astro$/.test(f));

/**
 * Inline `<script>` blocks in `text` that CSP would refuse.
 *
 * Shared with the reachability check below deliberately: a floor exercising a
 * separate copy of the matcher would prove that copy works, not this one.
 */
function unapprovedInlineScripts(text: string): string[] {
  // Strip Astro frontmatter — that's TS, not browser JS.
  const stripped = text.replace(/^---[\s\S]*?\n---\n/, '');
  // Look for <script> open tag immediately followed by non-empty
  // body content (not <script src="...">).
  const matches = [...stripped.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  return matches
    .filter((m) => {
      // Astro client:* directives compile into hoisted modules — they
      // appear as <script> with no src in source but get treated
      // safely. Allow `<script type="module">` (Astro processes
      // these) and skip empty bodies.
      if (m[1]!.trim().length === 0) return false;
      if (/type=["']module["']/.test(m[0])) return false;
      // Astro's `is:inline` directive is the explicit opt-in for
      // genuinely-inline scripts; the build wires nonces/hashes
      // into the CSP for these. Treat them as approved.
      if (/\bis:inline\b/.test(m[0])) return false;
      return true;
    })
    .map((m) => m[0].slice(0, 80));
}

describe('W283.C marketing/docs inline-script CSP sweep', () => {
  it('CRITICAL the sweep read real pages and can still see a violation. `walk` returns silently when its directory is missing, so renaming either scanned root leaves the assertion below vacuously true — reporting every page CSP-clean because it read none.', () => {
    expect(allFiles.length, '.astro pages found across marketing-site and docs').toBeGreaterThan(
      20,
    );
    expect(
      unapprovedInlineScripts('<script>window.x = 1;</script>'),
      'a known-bad inline script is still detected by the matcher above',
    ).toHaveLength(1);
    expect(
      unapprovedInlineScripts('<script is:inline>window.x = 1;</script>'),
      'and the approved is:inline opt-in is not reported',
    ).toEqual([]);
  });

  it('no marketing/docs .astro page contains an inline <script> with body content', () => {
    const offenders: string[] = [];
    for (const f of allFiles) {
      for (const _ of unapprovedInlineScripts(read(f))) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
