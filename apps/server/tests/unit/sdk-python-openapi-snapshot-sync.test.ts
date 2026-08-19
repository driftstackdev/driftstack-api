// Drift guard: the committed packages/sdk-python/openapi.json snapshot
// (the spec datamodel-codegen reads) must stay STRUCTURALLY in sync with
// the live spec generated from apps/server/src/lib/openapi.ts.
//
// Why this exists: the 2026-05-31 audit found the snapshot had silently
// drifted by the entire operationId + examples arc (0 operationIds / 151
// paths committed vs 38 / 154 live) because NOTHING compared them — the
// W622 content-parity test only string-matches a few pinned properties,
// and route-coverage checks path↔route, not snapshot↔spec.
//
// V-952 — the structural scope below was deliberate, and both reasons given for it
// have been measured and do not hold. The arms are kept, because they name the
// common drift precisely, but a full CONTENT comparison now runs alongside them.
//
// What the structural scope missed: everything inside an operation. Changing a
// published bound in `openapi.ts` from `.max(2048)` to `.max(77)` without
// re-dumping leaves paths, methods, operationIds, response statuses and schema keys
// all identical, so every arm below passed — measured, 6 of 6 green on that exact
// edit. Thirty-one test files read this snapshot, including guards that assert
// published bounds, declared response headers and request-body property lists. A
// stale snapshot does not just go unnoticed; it becomes the thing those guards
// validate against, so they report agreement with a document the server no longer
// generates.
//
// On "immune to prettier formatting": both sides are JSON.parse'd, so formatting was
// never comparable in the first place.
// On "example-value churn": there is none. The generator takes no arguments and
// reads no env, no clock and no randomness, and a full walk of 40 582 comparable
// nodes to depth 18 finds the snapshot and the live build identical.
//
// Scope was STRUCTURAL (paths, per-path methods, operationIds,
// response-status sets, component-schema keys) — not a byte-for-byte compare.
// That catches the real drift class (added/removed endpoints, operations,
// operationIds, documented outcomes, schemas). If this fails, the fix is almost always:
//   npm run sdk:python:dump-spec && npx prettier --write packages/sdk-python/openapi.json
// committed in the SAME change as the openapi.ts edit. (A new schema here
// also implies a pending datamodel-codegen run for models.py — see
// docs/internal/2026-05-31-autopilot-findings-and-open-decisions.md.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SNAPSHOT = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

const FIX =
  'run `npm run sdk:python:dump-spec` + prettier, committed alongside the openapi.ts change';

interface MinimalSpec {
  info: { version: string };
  paths: Record<
    string,
    Record<string, { operationId?: string; responses?: Record<string, unknown> }>
  >;
  components?: { schemas?: Record<string, unknown> };
}

function methodsOf(spec: MinimalSpec): Set<string> {
  const out = new Set<string>();
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const method of Object.keys(ops)) out.add(`${method.toUpperCase()} ${path}`);
  }
  return out;
}

function operationIdsOf(spec: MinimalSpec): Set<string> {
  const out = new Set<string>();
  for (const ops of Object.values(spec.paths)) {
    for (const op of Object.values(ops)) if (op.operationId) out.add(op.operationId);
  }
  return out;
}

function responseStatusSetsOf(spec: MinimalSpec): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (operation.responses === undefined) continue;
      out[`${method.toUpperCase()} ${path}`] = Object.keys(operation.responses).sort(
        (left, right) => Number(left) - Number(right),
      );
    }
  }
  return out;
}

/** How many differing paths to report before stopping — enough to diagnose. */
const MAX_REPORTED_DIFFS = 25;

interface DeepCompare {
  readonly diffs: string[];
  /** Nodes actually compared. A walk that descends nowhere reports no diffs. */
  readonly visited: number;
}

/**
 * Every value at which the two documents disagree, as JSON paths.
 *
 * Deliberately NOT `expect(snapshot).toEqual(live)`: on a 40 000-node document that
 * prints a diff nobody reads, and the failure this guards against is usually one
 * edited bound or one dropped header. A path list says which.
 *
 * There is no depth cap. An earlier throwaway version of this walk capped at 14 and
 * reported "no differences" — the document reaches depth 18, so four levels were
 * never compared and the clean result was partly unearned.
 */
function deepCompare(snapshot: unknown, live: unknown): DeepCompare {
  const diffs: string[] = [];
  let visited = 0;

  const walk = (a: unknown, b: unknown, path: string): void => {
    if (diffs.length >= MAX_REPORTED_DIFFS) return;
    visited += 1;
    if (a === b) return;

    const aObj = a !== null && typeof a === 'object';
    const bObj = b !== null && typeof b === 'object';
    if (!aObj || !bObj) {
      diffs.push(`${path}: snapshot=${JSON.stringify(a)} live=${JSON.stringify(b)}`);
      return;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
      diffs.push(`${path}: one side is an array and the other is not`);
      return;
    }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in a)) {
        diffs.push(`${path}.${key}: present live, absent from the snapshot — re-dump`);
        continue;
      }
      if (!(key in b)) {
        diffs.push(`${path}.${key}: present in the snapshot, no longer generated — re-dump`);
        continue;
      }
      walk(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
    }
  };

  walk(snapshot, live, '$');
  return { diffs, visited };
}

describe('sdk-python openapi.json snapshot ↔ live spec structural sync', () => {
  const live = generateOpenApiSpec() as unknown as MinimalSpec;
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as MinimalSpec;

  const compared = deepCompare(snapshot, JSON.parse(JSON.stringify(live)));

  it(`CRITICAL the walk actually descended, so an empty difference list means agreement rather than a comparison that never happened. The arm below reports an ABSENCE — the shape this repo keeps finding green and blind — and an earlier draft of the same walk capped its depth and reported "no differences" over a document four levels deeper than the cap. (${FIX})`, () => {
    expect(compared.visited, 'nodes compared between snapshot and live spec').toBeGreaterThan(
      35_000,
    );
  });

  it(`CRITICAL the snapshot matches the live spec in CONTENT, not only in shape. Thirty-one test files read this file; a stale one is not merely unnoticed, it is what those guards then validate against. Measured: changing a published bound from .max(2048) to .max(77) in openapi.ts left every structural arm below green. (${FIX})`, () => {
    expect(
      compared.diffs,
      'the committed snapshot and the live spec disagree at these paths. Each is a published fact a ' +
        'generated client and every spec-reading guard now has wrong',
    ).toEqual([]);
  });

  it(`info.version matches (${FIX})`, () => {
    expect(snapshot.info.version).toBe(live.info.version);
  });

  it(`path set matches — no endpoint added/removed without re-dumping (${FIX})`, () => {
    expect([...Object.keys(snapshot.paths)].sort()).toEqual([...Object.keys(live.paths)].sort());
  });

  it(`operation set (method × path) matches (${FIX})`, () => {
    expect([...methodsOf(snapshot)].sort()).toEqual([...methodsOf(live)].sort());
  });

  it(`operationId set matches — SDK-aligned ids stay dumped (${FIX})`, () => {
    expect([...operationIdsOf(snapshot)].sort()).toEqual([...operationIdsOf(live)].sort());
  });

  it(`response status sets match for every operation (${FIX})`, () => {
    expect(responseStatusSetsOf(snapshot)).toEqual(responseStatusSetsOf(live));
  });

  it(`component-schema key set matches — a new schema also implies a models.py codegen run (${FIX})`, () => {
    const liveSchemas = Object.keys(live.components?.schemas ?? {}).sort();
    const snapSchemas = Object.keys(snapshot.components?.schemas ?? {}).sort();
    expect(snapSchemas).toEqual(liveSchemas);
  });
});
