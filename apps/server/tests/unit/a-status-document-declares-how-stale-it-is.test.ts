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
// `v294-feature-catalog.md` states a CHECKABLE basis rather than a date: its
// Source line records the verification-record range its classifications were
// checked against, and its V-872 note says how far behind that basis is. The
// arms that measured the gap against the live verification log were retired
// when that log moved to the internal records; what remains here pins that the
// catalog keeps stating a basis at all.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const CATALOG = resolve(REPO_ROOT, 'docs/architecture/v294-feature-catalog.md');
const QUEUE = resolve(REPO_ROOT, 'docs/founder-action-queue.md');

describe('V-872 a status document declares how stale it is', () => {
  it('CRITICAL the catalog still states a checkable basis at all. Its Source line is the only freshness signal this document has, and it is better than a date because it can be measured — losing it would leave 119 status rows with nothing to check them against, which is the state the action queue was in.', () => {
    expect(readFileSync(CATALOG, 'utf8'), 'the Source line naming the record range').toMatch(
      /Cross-referenced against the internal verification records \(V-001 → V-\d+\)/,
    );
    expect(readFileSync(CATALOG, 'utf8'), 'and the note saying how stale that basis is').toMatch(
      /⚠ V-872 — every classification below was made against a verification log/,
    );
  });

  it('CRITICAL the action queue warns that it has no roll-up date. It is the list somebody works from, it carries per-item statuses, and "updated as items resolve" is an intention rather than a record — V-871 found an item that outlived its work by six weeks. If a dated roll-up is ever added, replace the warning with it and delete this arm.', () => {
    expect(readFileSync(QUEUE, 'utf8'), 'the missing-roll-up warning').toMatch(
      /⚠ V-872 — this queue carries no roll-up date/,
    );
  });
});
