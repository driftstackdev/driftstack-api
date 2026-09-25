// A step's `warning` reaches every surface a customer reads a step result
// from, or this fails.
//
// A navigation the site answered with 400 or above is a SUCCESS carrying
// `warning: { kind: 'http_error_status', status }`. The field is only useful to
// a program if the program can SEE it, and there are seven copies of the shape
// a program might be reading: the api-types schema, the spec the server
// publishes, the committed snapshot the Python SDK is generated from, the
// generated Python model, the TypeScript SDK type, the Go SDK struct, and the
// docs page. A copy that lacks the field is worse than silent — a typed reader
// built from it drops the warning without a word, and the step reads as clean.
//
// The warning KIND is published OPEN ("one of these, or any other string"),
// for the reason the failure category is: a closed Literal in a generated SDK
// rejects the whole turn response the day a second kind is added.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IntentResultWarningKindSchema } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';
import { intentResultToCustomer } from '../../src/services/agent-intent-result.js';
import { encodeWireData, parseIntentResult } from '../../src/services/harness-control-codec.js';
import { createSpecAjv } from '../integration/_helpers/ajv.js';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

const KINDS = [...IntentResultWarningKindSchema.options];
const NEWER_KIND = 'a_warning_added_after_this_reader_was_built';

interface SuccessArm {
  path: string;
  schema: { properties: Record<string, unknown> };
}

/** Every schema node shaped like a SUCCESSFUL step result: an object whose
 *  `kind` is exactly `success` and which carries a `summary`. Found by shape,
 *  so a place added later is covered without editing this file. */
function successArms(node: unknown, path = ''): SuccessArm[] {
  if (Array.isArray(node)) return node.flatMap((v, i) => successArms(v, `${path}/${i}`));
  if (node === null || typeof node !== 'object') return [];
  const here: SuccessArm[] = [];
  const props = (node as { properties?: Record<string, { enum?: unknown[] }> }).properties;
  if (
    props !== undefined &&
    'summary' in props &&
    JSON.stringify(props['kind']?.enum) === JSON.stringify(['success'])
  ) {
    here.push({ path, schema: node as SuccessArm['schema'] });
  }
  return [...here, ...Object.entries(node).flatMap(([k, v]) => successArms(v, `${path}/${k}`))];
}

const DOCUMENTS: ReadonlyArray<readonly [string, () => unknown]> = [
  ['the spec the server publishes', () => generateOpenApiSpec()],
  [
    'the committed snapshot the Python SDK is generated from',
    () => JSON.parse(read('packages/sdk-python/openapi.json')) as unknown,
  ],
];

describe('a step warning reaches every published surface', () => {
  it('POSITIVE CONTROL — the mapper really produces every kind this file checks for', () => {
    expect(KINDS).toEqual(['http_error_status']);
    const result = intentResultToCustomer(
      { kind: 'navigate', url: 'https://example.test/' },
      parseIntentResult(
        {
          type: 'intentResult',
          sessionId: 'ses_1',
          intentId: 'int_1',
          success: true,
          durationMs: 3,
          outputData: encodeWireData({ url: 'https://example.test/', http_status: 404 }),
        },
        'navigate',
      ),
    );
    expect(result).toMatchObject({ kind: 'success', warning: { kind: 'http_error_status' } });
  });

  describe.each(DOCUMENTS)('%s', (_label, load) => {
    const arms = successArms(load());

    it('finds a success arm at every place a turn reports its steps (the finder matched something)', () => {
      // IntentResult, the two turn results that list steps, and the conflict
      // problem's settled steps. A finder that matches nothing proves nothing.
      expect(arms.length, arms.map((a) => a.path).join('\n')).toBeGreaterThanOrEqual(4);
    });

    it('every success arm carries an OPTIONAL warning', () => {
      for (const arm of arms) {
        expect(arm.schema.properties, arm.path).toHaveProperty('warning');
        const required = (arm.schema as { required?: string[] }).required ?? [];
        expect(required, arm.path).not.toContain('warning');
      }
    });

    it('accepts every known kind and one newer than the reader, and refuses a kind that is not text', () => {
      const ajv = createSpecAjv();
      for (const arm of arms) {
        const validate = ajv.compile(arm.schema);
        const step = (warning: unknown): unknown => ({
          kind: 'success',
          intent: { kind: 'navigate', url: 'https://example.test/' },
          summary: 'navigated to https://example.test/ — the site answered 404',
          warning,
        });
        for (const kind of KINDS) {
          expect(
            validate(step({ kind, status: 404 })),
            `${arm.path}: ${JSON.stringify(validate.errors)}`,
          ).toBe(true);
        }
        expect(
          validate(step({ kind: NEWER_KIND })),
          `${arm.path} rejects a newer kind: ${JSON.stringify(validate.errors)}`,
        ).toBe(true);
        expect(validate(step({ kind: 42 })), arm.path).toBe(false);
      }
    });

    it('still LISTS every kind the server emits, so generated SDKs keep them', () => {
      for (const arm of arms) {
        const kind = (
          arm.schema.properties['warning'] as { properties?: { kind?: { anyOf?: unknown[] } } }
        ).properties?.kind;
        const listed = (kind?.anyOf ?? []).flatMap((a) => (a as { enum?: unknown[] }).enum ?? []);
        expect(listed, arm.path).toEqual(KINDS);
      }
    });
  });

  it('the generated Python model carries the field, with every kind listed and any string admitted', () => {
    const models = read('packages/sdk-python/src/driftstack/_generated/models.py');
    const success = models.match(/^class IntentResult1\(BaseModel\):\n([\s\S]*?)\n\n\n/m)?.[1];
    expect(success, 'the success step model was not found').toBeDefined();
    const field = success?.match(/^ {4}warning: (\w+) \| None = None$/m)?.[1];
    expect(field, 'the success step model has no optional `warning`').toBeDefined();
    const block = models.match(
      new RegExp(`^class ${field ?? '__none__'}\\(BaseModel\\):\\n([\\s\\S]*?)\\n\\n\\n`, 'm'),
    )?.[1];
    expect(block, `class ${field ?? ''} not found`).toBeDefined();
    for (const kind of KINDS) expect(block).toContain(`"${kind}"`);
    expect(block).toMatch(/kind: [\s\S]*\| str/);
    expect(block).toMatch(/status: int \| None = None/);
  });

  it('the TypeScript SDK type carries the field on a success, with every kind listed and any string admitted', () => {
    const source = codeOnly(read('packages/sdk-typescript/src/resources/agent-sessions.ts'));
    const success = source.match(/\|\s*\{\s*kind: 'success';([^}]*)\}/)?.[1] ?? '';
    expect(success).toMatch(/warning\?: AgentStepWarning/);
    const block = source.match(/export interface AgentStepWarning \{([\s\S]*?)\n\}/)?.[1];
    expect(block, 'AgentStepWarning not found').toBeDefined();
    for (const kind of KINDS) expect(block).toContain(`'${kind}'`);
    expect(block).toMatch(/\|\s*\(string & \{\}\)/);
    expect(block).toMatch(/status\?: number/);
  });

  it('the Go SDK struct carries the field and names every kind', () => {
    const raw = read('packages/sdk-go/agent_sessions.go');
    const source = codeOnly(raw);
    const result = source.match(/type AgentIntentResult struct \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(result).toMatch(/Warning\s+\*AgentStepWarning\s+`json:"warning,omitempty"`/);
    const warning = source.match(/type AgentStepWarning struct \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(warning).toMatch(/Kind\s+string\s+`json:"kind"`/);
    expect(warning).toMatch(/Status\s+\*int\s+`json:"status,omitempty"`/);
    // Go reads the kind as a plain string; the doc comment is where a Go
    // programmer finds the values, and it must say the set is open.
    for (const kind of KINDS) expect(raw).toContain(`"${kind}"`);
    expect(raw).toMatch(/AgentStepWarning[\s\S]*open set/i);
  });

  it('the Python resource docstring names the field for a programmer reading dicts', () => {
    expect(read('packages/sdk-python/src/driftstack/resources/agent_sessions.py')).toContain(
      '``warning``',
    );
  });

  it('the docs page documents the field and every kind, and says the set is open', () => {
    const docs = read('apps/docs/src/pages/api/agent-sessions.md');
    expect(docs).toContain('`warning`');
    for (const kind of KINDS) expect(docs).toContain(`\`${kind}\``);
    expect(docs).toMatch(/"warning": \{ "kind": "http_error_status", "status": 404 \}/);
  });
});
