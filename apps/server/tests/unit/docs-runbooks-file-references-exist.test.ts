// Runbook file-reference existence guard.
//
// Operator runbooks (docs/runbooks/*.md) hand-hold a human through real
// commands. When a runbook cites a repo file that doesn't exist, the
// operator hits "no such file" / "Cannot find module" mid-procedure. Two
// such bugs were fixed on this surface: the self-hosted runbook referenced
// `docker-compose.dev.yml` (the real file is `docker-compose.yml`, fixed in
// 1d9e96ee), and the auth-token-sweeper runbook cited a one-shot script
// that was never built (resolved 2026-05-27 — that runbook section was
// rewritten to the real wired scheduled-job mechanism, so the dead
// `scripts/` reference is gone and no longer needs a known-pending
// exception). The per-runbook content-parity tests pin command TEXT but
// never check the referenced file is actually on disk — this does.
//
// Scope: `scripts/<path>` and `docker-compose*.yml` references. Both are
// concrete repo paths a runbook tells the operator to invoke.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const RUNBOOKS_DIR = resolve(REPO_ROOT, 'docs/runbooks');

// Known-pending references the founder/ops still has to resolve (build the
// file or rewrite the section). Empty as of 2026-05-27 — the only entry
// (`scripts/auth-token-sweep-once.mjs`) was retired when the auth-token-
// sweeper runbook was rewritten to the real scheduled-job mechanism.
const KNOWN_PENDING = new Set<string>([]);

function runbookFiles(): string[] {
  return readdirSync(RUNBOOKS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(RUNBOOKS_DIR, f));
}

describe('docs/runbooks file-reference existence', () => {
  const bodies = runbookFiles().map((f) => ({
    rel: f.slice(REPO_ROOT.length + 1),
    body: readFileSync(f, 'utf8'),
  }));

  it('sanity: found runbooks to scan', () => {
    expect(bodies.length).toBeGreaterThan(5);
  });

  it('every scripts/<path> referenced in a runbook exists on disk (or is a tracked known-pending)', () => {
    const scriptRe = /\bscripts\/[A-Za-z0-9_./-]+\.(?:sh|mjs|ts|js)\b/g;
    const missing: string[] = [];
    let scanned = 0;
    for (const { rel, body } of bodies) {
      for (const m of body.matchAll(scriptRe)) {
        const ref = m[0];
        scanned += 1;
        if (KNOWN_PENDING.has(ref)) continue;
        if (!existsSync(resolve(REPO_ROOT, ref))) missing.push(`${ref}  (${rel})`);
      }
    }
    expect(scanned, 'expected runbooks to cite scripts/ paths').toBeGreaterThan(5);
    expect(
      missing,
      `runbook script references with no file on disk:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('every docker-compose*.yml referenced in a runbook exists on disk', () => {
    const composeRe = /\b[A-Za-z0-9_/.-]*docker-compose[A-Za-z0-9_.-]*\.yml\b/g;
    const missing: string[] = [];
    for (const { rel, body } of bodies) {
      for (const m of body.matchAll(composeRe)) {
        const ref = m[0];
        if (!existsSync(resolve(REPO_ROOT, ref))) missing.push(`${ref}  (${rel})`);
      }
    }
    expect(
      missing,
      `runbook docker-compose references with no file on disk (e.g. the docker-compose.dev.yml bug):\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});
