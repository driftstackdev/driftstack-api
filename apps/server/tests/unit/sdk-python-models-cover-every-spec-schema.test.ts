// Every schema in the committed spec must have a generated Pydantic class.
//
// `packages/sdk-python/openapi.json` is the codegen input and
// `_generated/models.py` is its output, produced by datamodel-codegen through
// `npm run sdk:python:generate`. Nothing verified the second was current with
// the first. The existing W622 guard is a CONTENT-PARITY test: it pins text
// that happens to be in both files, which cannot notice that the spec grew a
// schema the models never got.
//
// That is not hypothetical. The layer above went stale on 2026-08-11 — V-753
// narrowed the /v1/oauth/token 401 description and the committed spec was not
// resynced, leaving main red. The spec-to-models step has the same shape and
// had no equivalent check.
//
// WHY THIS IS A CORRESPONDENCE AND NOT A REGENERATE-AND-DIFF, stated plainly
// because that would be the stronger guard: datamodel-codegen stamps
// `# timestamp: <now>` into its own output, so regenerating always differs and
// a diff-based guard would either be permanently red or need the very
// exclusion that makes it weak. Regenerating also needs the Python venv, which
// the node CI job does not have. This compares names, deterministically, from
// files alone.
//
// Direction matters. schema -> class is asserted; class -> schema is NOT,
// because datamodel-codegen legitimately emits inline models for per-path
// request and response bodies — 206 classes against 81 component schemas
// today. Asserting the reverse would fail on correct output.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const MODELS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/_generated/models.py');

/**
 * Compare on alphanumerics only, lowercased.
 *
 * datamodel-codegen rewrites a schema name into a Python class name, dropping
 * separators a JSON key may carry. Every one of the 81 current schemas matches
 * its class under this normalisation, so it is loose enough to avoid false
 * positives and tight enough that a genuinely absent model still shows up.
 */
function normalise(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function specSchemaNames(specJson: string): string[] {
  const spec = JSON.parse(specJson) as { components?: { schemas?: Record<string, unknown> } };
  return Object.keys(spec.components?.schemas ?? {});
}

function generatedClassNames(modelsPy: string): string[] {
  return [...modelsPy.matchAll(/^class (\w+)\(/gm)].map((m) => m[1] ?? '');
}

/** Schemas the generated module has no class for. */
function schemasWithoutModel(specJson: string, modelsPy: string): string[] {
  const classes = new Set(generatedClassNames(modelsPy).map(normalise));
  return specSchemaNames(specJson).filter((s) => !classes.has(normalise(s)));
}

const specJson = existsSync(SPEC) ? readFileSync(SPEC, 'utf8') : '';
const modelsPy = existsSync(MODELS) ? readFileSync(MODELS, 'utf8') : '';

describe('the generated Pydantic models cover every schema in the committed spec', () => {
  it('CRITICAL both artefacts were found and both parsed. The assertion below reports an ABSENCE, so a spec that parsed to zero schemas, or a models file that parsed to zero classes, would satisfy it having compared nothing.', () => {
    expect(existsSync(SPEC), 'openapi.json at the canonical path').toBe(true);
    expect(existsSync(MODELS), '_generated/models.py at the canonical path').toBe(true);
    expect(specSchemaNames(specJson).length, 'component schemas in the spec').toBeGreaterThan(50);
    expect(generatedClassNames(modelsPy).length, 'classes in the generated module').toBeGreaterThan(
      100,
    );

    // The detector must report a schema whose class is genuinely absent, and
    // must not report one that is merely spelled differently.
    const fakeSpec = JSON.stringify({ components: { schemas: { WidgetThing: {}, GoneAway: {} } } });
    const fakeModels = 'class WidgetThing(BaseModel):\n    pass\n';
    expect(
      schemasWithoutModel(fakeSpec, fakeModels),
      'an absent class is reported, a present one is not',
    ).toEqual(['GoneAway']);

    // Normalisation is what makes the real comparison work; if it stopped
    // stripping separators, every hyphenated schema would report as missing.
    expect(
      schemasWithoutModel(
        JSON.stringify({ components: { schemas: { 'Agent.Intent_5': {} } } }),
        'class AgentIntent5(BaseModel):\n    pass\n',
      ),
      'a renamed-by-codegen schema is matched, not reported',
    ).toEqual([]);
  });

  it('CRITICAL every component schema has a generated class. A schema added to the spec without re-running `npm run sdk:python:generate` ships a Python SDK that cannot represent part of its own API, and the existing content-parity guard cannot see it.', () => {
    expect(
      schemasWithoutModel(specJson, modelsPy),
      'spec schema(s) with no generated model — run `npm run sdk:python:generate` and commit the result:',
    ).toEqual([]);
  });
});
