// OpenAPI spec well-formedness invariant (2026-06-03).
//
// Guards the generated/published spec (packages/sdk-python/openapi.json, kept
// in sync with the source by sdk-python-openapi-snapshot-sync) against two
// codegen-breaking defects that the snapshot-sync + content-parity tests do
// NOT catch (they detect DRIFT — snapshot==source — not VALIDITY):
//
//   1. Duplicate operationId — SDK generators name the generated method from
//      operationId, so two operations sharing one → colliding method names /
//      a generator error. Only ~38 ops carry an explicit operationId today, so
//      a dev copy-pasting an existing operationId onto a new route is the
//      realistic trigger; the snapshot would just reflect the dup and pass.
//   2. Dangling $ref — a `$ref: "#/components/schemas/X"` to a component that
//      was removed/renamed → generators + validators choke. Not resolution-
//      checked anywhere else.
//
// Structural, build-independent (reads the committed JSON). Manually verified
// clean 2026-06-03 (38 unique operationIds, 27 $refs all resolve, OpenAPI
// 3.1.0); this pins it so a regression fails the gate.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

interface OpenApiSpec {
  openapi?: string;
  paths?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

const spec = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'packages/sdk-python/openapi.json'), 'utf8'),
) as OpenApiSpec;

describe('OpenAPI spec validity invariant (packages/sdk-python/openapi.json)', () => {
  it('declares a 3.x openapi version', () => {
    expect(spec.openapi).toMatch(/^3\.\d+\.\d+$/);
  });

  it('every operationId is globally unique (duplicates → SDK codegen method-name collisions)', () => {
    const seen = new Map<string, string[]>();
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(methods)) {
        if (!HTTP_METHODS.has(method) || typeof op !== 'object' || op === null) continue;
        const opId = (op as { operationId?: unknown }).operationId;
        if (typeof opId === 'string') {
          const list = seen.get(opId) ?? [];
          list.push(`${method.toUpperCase()} ${path}`);
          seen.set(opId, list);
        }
      }
    }
    const dupes = [...seen.entries()].filter(([, v]) => v.length > 1);
    expect(
      dupes,
      `duplicate operationId(s):\n${dupes.map(([id, ops]) => `  ${id}: ${ops.join(', ')}`).join('\n')}`,
    ).toEqual([]);
  });

  it('every internal $ref resolves to a defined node (no dangling references)', () => {
    const blob = JSON.stringify(spec);
    const refs = new Set([...blob.matchAll(/"\$ref":\s*"(#\/[^"]+)"/g)].map((m) => m[1] as string));
    const dangling: string[] = [];
    for (const ref of refs) {
      let node: unknown = spec;
      for (const rawSeg of ref.slice(2).split('/')) {
        const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
        if (typeof node === 'object' && node !== null && seg in (node as Record<string, unknown>)) {
          node = (node as Record<string, unknown>)[seg];
        } else {
          dangling.push(ref);
          break;
        }
      }
    }
    expect(dangling, `dangling $ref(s): ${dangling.join(', ')}`).toEqual([]);
  });

  it('declares exactly one required path parameter for every template expression', () => {
    const issues: string[] = [];
    for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
      const templateNames = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      const pathLevelParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

      for (const [method, rawOperation] of Object.entries(pathItem)) {
        if (
          !HTTP_METHODS.has(method) ||
          typeof rawOperation !== 'object' ||
          rawOperation === null
        ) {
          continue;
        }
        const operation = rawOperation as { parameters?: unknown };
        const operationParameters = Array.isArray(operation.parameters) ? operation.parameters : [];
        const pathParameters = [...pathLevelParameters, ...operationParameters].filter(
          (parameter): parameter is { in: string; name: string; required?: boolean } =>
            typeof parameter === 'object' &&
            parameter !== null &&
            (parameter as { in?: unknown }).in === 'path' &&
            typeof (parameter as { name?: unknown }).name === 'string',
        );
        const operationLabel = `${method.toUpperCase()} ${path}`;

        for (const name of templateNames) {
          const matches = pathParameters.filter((parameter) => parameter.name === name);
          if (matches.length !== 1) {
            issues.push(`${operationLabel}: {${name}} has ${matches.length} path parameters`);
          } else if (matches[0]?.required !== true) {
            issues.push(`${operationLabel}: {${name}} is not required`);
          }
        }
        for (const parameter of pathParameters) {
          if (!templateNames.includes(parameter.name)) {
            issues.push(`${operationLabel}: orphan path parameter ${parameter.name}`);
          }
        }
      }
    }

    expect(issues, `invalid path parameter(s):\n${issues.join('\n')}`).toEqual([]);
  });
});
