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

/**
 * V-769 — the operator-facing procedure docs. `docs/deployment/` is in scope for the same
 * reason `docs/runbooks/` is: a human follows it during an incident. `docs/internal/` is
 * deliberately NOT scanned — those are dated wave reports and design records, where a
 * reference to a since-deleted file is an accurate historical record rather than a defect.
 * (Measured: widening to docs/internal surfaced 19 such references, none operator-facing.)
 */
function procedureDocs(): string[] {
  const out: string[] = [];
  for (const dir of [RUNBOOKS_DIR, resolve(REPO_ROOT, 'docs/deployment')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.md')) out.push(join(dir, f));
    }
  }
  return out;
}

/**
 * Repo paths cited in a procedure doc that are absent ON PURPOSE, or that are known-broken and
 * awaiting their own fix. Each needs a reason. This map may only SHRINK.
 *
 * V-773 emptied the known-broken half of this map. All four entries turned out to be
 * resolvable, and three of them were WRONG PATHS rather than dead mechanisms — the drizzle
 * config is at the repo root, and the SLA policy is published at docs/sla-policy.astro, not
 * legal/sla.astro. Chasing the fourth (an SLA reference) surfaced a separate money defect: the
 * DR runbook claimed credits "apply automatically" when the published policy requires the
 * customer to email billing@ to request one.
 */
const KNOWN_ABSENT: Record<string, string> = {
  'apps/server/.env':
    'Gitignored by design — the runbook correctly instructs the operator to CREATE it.',
};

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

  it('CRITICAL every repo path cited in an operator procedure doc exists — the P-0 customer-comms step told the operator to edit apps/marketing-site/src/data/incidents.ts, a file that has never existed in this repo, so the first customer-facing action of a Sev-0 was unperformable', () => {
    // Backticked `apps|packages|scripts|infra/...` paths with a file extension. Globs are
    // skipped (a `*` is a pattern, not a path a human opens).
    const pathRe = /`((?:apps|packages|scripts|infra)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)`/g;
    const missing: string[] = [];
    let scanned = 0;
    for (const file of procedureDocs()) {
      const rel = file.slice(REPO_ROOT.length + 1);
      for (const m of readFileSync(file, 'utf8').matchAll(pathRe)) {
        const ref = m[1]!;
        if (ref.includes('*')) continue;
        scanned += 1;
        if (KNOWN_ABSENT[ref] !== undefined) continue;
        if (!existsSync(resolve(REPO_ROOT, ref))) missing.push(`${ref}  (${rel})`);
      }
    }

    expect(scanned, 'expected procedure docs to cite repo paths').toBeGreaterThan(20);
    expect(
      missing,
      `operator procedure doc(s) citing a repo path with no file on disk:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('CRITICAL the known-absent list may only SHRINK, and every entry states why. An entry whose file now exists is a fix that was made without retiring its exemption.', () => {
    const resurrected = Object.keys(KNOWN_ABSENT)
      .filter((ref) => existsSync(resolve(REPO_ROOT, ref)))
      .sort();
    expect(resurrected, 'these exist now — remove them from KNOWN_ABSENT:').toEqual([]);

    const unexplained = Object.entries(KNOWN_ABSENT)
      .filter(([, why]) => why.trim().length < 40)
      .map(([ref]) => ref)
      .sort();
    expect(unexplained, 'KNOWN_ABSENT entr(ies) without a stated reason:').toEqual([]);
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
