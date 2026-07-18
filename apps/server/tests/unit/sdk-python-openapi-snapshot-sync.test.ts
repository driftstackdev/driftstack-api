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
// Scope is STRUCTURAL on purpose (paths, per-path methods, operationIds,
// response-status sets, component-schema keys) — not a byte-for-byte compare.
// That catches the real drift class (added/removed endpoints, operations,
// operationIds, documented outcomes, schemas) while staying immune to prettier
// formatting / example-value churn. If this fails, the fix is almost always:
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

describe('sdk-python openapi.json snapshot ↔ live spec structural sync', () => {
  const live = generateOpenApiSpec() as unknown as MinimalSpec;
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as MinimalSpec;

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
