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

describe('W283.C marketing/docs inline-script CSP sweep', () => {
  it('no marketing/docs .astro page contains an inline <script> with body content', () => {
    const offenders: string[] = [];
    for (const f of allFiles) {
      const body = read(f);
      // Strip Astro frontmatter — that's TS, not browser JS.
      const stripped = body.replace(/^---[\s\S]*?\n---\n/, '');
      // Look for <script> open tag immediately followed by non-empty
      // body content (not <script src="...">).
      const matches = [...stripped.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
      for (const m of matches) {
        const inner = m[1]!.trim();
        // Astro client:* directives compile into hoisted modules — they
        // appear as <script> with no src in source but get treated
        // safely. Allow `<script type="module">` (Astro processes
        // these) and skip empty bodies.
        if (inner.length === 0) continue;
        if (/type=["']module["']/.test(m[0])) continue;
        // Astro's `is:inline` directive is the explicit opt-in for
        // genuinely-inline scripts; the build wires nonces/hashes
        // into the CSP for these. Treat them as approved.
        if (/\bis:inline\b/.test(m[0])) continue;
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
