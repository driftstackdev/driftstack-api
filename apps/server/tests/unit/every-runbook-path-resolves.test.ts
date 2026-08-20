// A runbook that points at a file which does not exist fails during an incident.
//
// Runbooks are read under pressure, by someone who did not write them, looking
// for the next step. A dead path there is not the same as a dead link in a
// design doc: the reader is mid-incident, and the cost is the minutes spent
// working out whether they mistyped, whether the file moved, or whether the
// procedure was ever written down.
//
// Two were dead when this landed, both in self-hosted-mac-local.md:
//
//   docs/operations/stripe-cli-setup.md         cited from the "Stripe webhooks
//                                               don't fire" troubleshooting step
//                                               as the place the test-mode key
//                                               wiring lives. It was never
//                                               written — the content is in
//                                               docs/deployment/stripe-webhook-testing.md,
//                                               which the step now names.
//   docs/architecture/afp-harness-configuration.md
//                                               a forward-looking Agent-1
//                                               cross-reference for a WebKit
//                                               integration that has not
//                                               happened. Replaced with prose
//                                               saying so, rather than a path
//                                               that resolves to nothing.
//
// Deliberately checks repo-relative paths only. Runbooks also cite external
// URLs (stripe.com, Cloudflare dashboards) and host paths on the Hetzner boxes
// (/opt/driftstack/api/.env); neither is verifiable from here, and pretending
// otherwise would make this fail for reasons it cannot fix.

import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/**
 * Repo-relative paths a runbook names. Anchored on the workspace roots so a
 * bare word like `sessions.ts` is not mistaken for a path, and suffixed on the
 * file kinds runbooks actually cite.
 */
const REPO_PATH =
  // V-1141 — `json` MUST precede `js`, and the trailing boundary is what makes that
  // ordering safe rather than lucky. Regex alternation takes the first branch that
  // matches, so with `js` first a citation of `package.json` matched `package.js`,
  // left `on` unconsumed, and this file reported a runbook citing a file that does
  // not exist. The runbook was correct; the extractor truncated it.
  /(?:^|[\s`(])((?:apps|packages|scripts|docs|operations)\/[A-Za-z0-9_./-]+\.(?:json|mjs|ts|js|sh|sql|md))(?![A-Za-z0-9])/g;

/**
 * V-1145 — the population was `docs/runbooks/*.md`, which defines a runbook by the
 * directory it sits in rather than by what it is. Seven runbook-named documents live
 * elsewhere in `docs/` — including `deployment/dr-runbook.md`, the disaster-recovery
 * procedure, which cited a `docs/deployment/dns.md` that exists nowhere. The rationale
 * for this file is that whoever follows a runbook is mid-incident; a DR runbook is the
 * strongest case for it and was the least covered.
 *
 * Dated documents are excluded. A file named `2026-06-09-go-live-runbook.md` is a record
 * of a day, not a procedure anyone will follow again, and holding it to today's tree is
 * the same wrong bar V-1143 declined for the internal docs at large.
 */
function runbookFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.md')) out.push(full);
    }
  };
  walk(resolve(REPO_ROOT, 'docs'));
  return out.filter((f) => {
    const rel = f.slice(REPO_ROOT.length + 1);
    if (/\/20\d\d-\d\d-\d\d/.test('/' + rel)) return false;
    return rel.startsWith('docs/runbooks/') || /runbook/i.test(rel.split('/').pop() ?? '');
  });
}

/**
 * V-1146 — a citation the document itself declares unwritten is not a broken link.
 *
 * The repo has a convention for this and uses it in three places: the chaos-scenario
 * inventory writes ``docs/runbooks/hetzner-instance-down.md`` `(NOT YET WRITTEN —
 * V-547.B target)`, and the DR checklist says its results go to a fresh
 * `dr-rehearsal-history.md` `(creates if missing)`. Those are work items stated
 * honestly, and V-1145 widened this guard's population without an exemption for them —
 * so the first honest forward reference written into a runbook would have been reported
 * as a runbook citing a file that does not exist. That is the V-1141 failure again:
 * the instrument accusing the document.
 *
 * The exemption is deliberately narrow. The marker has to sit right after the path, so
 * the document has to SAY the file is unwritten; a missing file with no such note still
 * fails. "Probably future work" is not something a scan may infer on a document's behalf.
 */
const DECLARED_UNWRITTEN = /^[\s`)]*\((?:NOT YET WRITTEN|creates if missing|to be written)/i;

function citedPaths(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of runbookFiles()) {
    const body = readFileSync(file, 'utf8');
    for (const m of body.matchAll(REPO_PATH)) {
      const p = (m[1] ?? '').replace(/[.,;:`]+$/, '');
      const after = body.slice(m.index + m[0].length, m.index + m[0].length + 40);
      if (DECLARED_UNWRITTEN.test(after)) continue;
      out.set(p, [...(out.get(p) ?? []), file.slice(REPO_ROOT.length + 1)]);
    }
  }
  return out;
}

describe('every repo path a runbook cites resolves', () => {
  const cited = citedPaths();

  it('CRITICAL the scan reads the runbooks and extracts real paths', () => {
    // This asserts an absence — that no cited path is missing — which an
    // extractor finding nothing satisfies for free. Both the corpus and the
    // extraction are floored, and a known-good path is probed by name.
    expect(runbookFiles().length, 'no runbooks found').toBeGreaterThanOrEqual(10);
    expect(cited.size, 'no repo paths extracted — the pattern stopped matching').toBeGreaterThan(
      30,
    );
    expect([...cited.keys()], 'a path known to be cited is missing from the extraction').toContain(
      'docs/deployment/stripe-webhook-testing.md',
    );
  });

  it('CRITICAL every cited path exists', () => {
    const dead = [...cited.entries()]
      .filter(([p]) => !existsSync(resolve(REPO_ROOT, p)))
      .map(([p, files]) => `${p} (cited by ${[...new Set(files)].sort().join(', ')})`)
      .sort();
    expect(
      dead,
      'a runbook names a repo file that does not exist. Whoever follows it is mid-incident and ' +
        'has to work out for themselves whether the file moved, they mistyped, or the procedure ' +
        'was never written',
    ).toEqual([]);
  });
});
