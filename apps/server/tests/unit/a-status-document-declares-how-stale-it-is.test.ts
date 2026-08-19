// V-872 — six findings in a row were status documents describing shipped work as
// outstanding. This guards the property that made all six possible.
//
// V-866 (a P0 launch-blocker built months earlier), V-867 (a runbook telling
// operators to wait for a landed driver), V-868 (a launch-checklist row calling a
// shipped feature deferred), V-869 (an ADR whose decision production does not
// run), V-870 (a checkpoint read as current state) and V-871 (an action item
// asking for an asset that shipped six weeks earlier). The code was correct every
// time. The document describing it was not.
//
// The common cause is not carelessness, it is that a reader had no way to know
// how much to distrust. So the rule here is narrow and mechanical: a document
// that asserts per-item status must say what its statuses were checked against,
// and if that basis has fallen far behind, it must say so where a reader meets it
// before the rows.
//
// `v294-feature-catalog.md` is the interesting case because its basis is
// CHECKABLE rather than a date. Its Source line records cross-referencing against
// the verification log at V-293. This guard reads that number, reads the log's
// highest entry, and requires the staleness note while the gap is wide. Re-verify
// the catalog, move its basis line forward, and the requirement lifts on its own
// — the guard cannot outlive the condition it exists for.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const LOG = resolve(REPO_ROOT, 'docs/verification-log.md');
const CATALOG = resolve(REPO_ROOT, 'docs/architecture/v294-feature-catalog.md');
const QUEUE = resolve(REPO_ROOT, 'docs/founder-action-queue.md');

/**
 * How far a classification basis may fall behind the log before the document has
 * to admit it. Generous on purpose: this is meant to catch a document that has
 * stopped being maintained, not one that is a few entries behind.
 */
const MAX_DRIFT = 200;

/** Highest `## V-NNN` entry in the verification log. */
function latestEntry(): number {
  const ns = [...readFileSync(LOG, 'utf8').matchAll(/^## V-(\d+)/gm)].map((m) => Number(m[1]));
  return Math.max(...ns);
}

/** The log entry the catalog says its classifications were checked against. */
function catalogBasis(): number {
  const m = /Cross-referenced against `docs\/verification-log\.md` \(V-001 → V-(\d+)\)/.exec(
    readFileSync(CATALOG, 'utf8'),
  );
  return m === null ? Number.NaN : Number(m[1]);
}

describe('V-872 a status document declares how stale it is', () => {
  it('CRITICAL both the log and the catalog basis really parse. The arms below compare two numbers, so a failed parse would produce NaN and quietly satisfy or skip the comparison — the false-green shape this sweep kept finding in other guards.', () => {
    expect(latestEntry(), 'highest verification-log entry').toBeGreaterThan(800);
    // A RANGE, not the current value. The first draft asserted the basis equals
    // 293 and the mutation proof caught it: moving the Source line forward is
    // exactly the fix this guard exists to encourage, and pinning today's number
    // made re-verifying the catalog fail. A guard that fights its own remedy is
    // the defect V-794 names, and it appeared here in the guard written to
    // generalise six instances of it.
    expect(catalogBasis(), 'the basis the catalog states for its classifications').toBeGreaterThan(
      0,
    );
    expect(
      catalogBasis(),
      'and it cannot claim to be checked against unwritten entries',
    ).toBeLessThanOrEqual(latestEntry());
  });

  it('CRITICAL the feature catalog admits its classifications are stale while its stated basis lags the log. This is derived, not pinned: re-verify the catalog, move its Source line forward, and the requirement disappears by itself. A note that had to be deleted by hand would just become the next stale claim.', () => {
    const drift = latestEntry() - catalogBasis();
    if (drift <= MAX_DRIFT) return;

    expect(
      readFileSync(CATALOG, 'utf8'),
      `the catalog is ${String(drift)} log entries behind its own stated basis and must say so above the tables`,
    ).toMatch(/⚠ V-872 — every classification below was made against a verification log/);
  });

  it('CRITICAL the catalog still states a checkable basis at all. Its Source line is the only freshness signal this document has, and it is better than a date because it can be measured — losing it would leave 119 status rows with nothing to check them against, which is the state the action queue was in.', () => {
    expect(readFileSync(CATALOG, 'utf8'), 'the Source line naming the log range').toMatch(
      /Cross-referenced against `docs\/verification-log\.md` \(V-001 → V-\d+\)/,
    );
  });

  it('CRITICAL the action queue warns that it has no roll-up date. It is the list somebody works from, it carries per-item statuses, and "updated as items resolve" is an intention rather than a record — V-871 found an item that outlived its work by six weeks. If a dated roll-up is ever added, replace the warning with it and delete this arm.', () => {
    expect(readFileSync(QUEUE, 'utf8'), 'the missing-roll-up warning').toMatch(
      /⚠ V-872 — this queue carries no roll-up date/,
    );
  });
});
