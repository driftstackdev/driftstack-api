// A step-failure category added after a customer's SDK was built must not make
// that SDK reject the response.
//
// Categories are added over time (element_covered and target_unverified both
// arrived after the first release). While the published spec declared
// `diagnosis.category` as a closed enum, every SDK generated from it rejected a
// category newer than itself: the Python SDK's generated `Diagnosis.category` was
// a closed Literal, so a new value raised a pydantic ValidationError on the WHOLE
// turn response, for every customer who had not upgraded. The api-types comment
// above the enum said older SDK consumers were unaffected; for Python that was
// false.
//
// The published category is now "one of the known values, or any other string".
// This file pins that at every layer a reader can meet it: the live spec the
// server serves, the committed snapshot the Python SDK is generated from, the
// published api-types schema, the generated Python model, and the hand-written
// TypeScript SDK type. The Python behaviour itself is exercised by
// packages/sdk-python/tests/test_a_failure_category_newer_than_the_sdk_still_parses.py.
//
// Each layer is also checked to still LIST the known values, because an open
// field that dropped them ("category: string") would pass the acceptance arms
// and lose every editor suggestion and every generated Literal.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FailureDiagnosisCategorySchema, IntentResultSchema } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';
import { createSpecAjv } from '../integration/_helpers/ajv.js';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const NEWER_CATEGORY = 'a_category_added_after_this_reader_was_built';
const KNOWN = [...FailureDiagnosisCategorySchema.options];

interface DiagnosisSite {
  path: string;
  schema: { properties: { category: Record<string, unknown> } };
}

/** Every schema node shaped like a failure diagnosis: an object with a
 *  `category` and a `retryable`. Found by shape so a site added later is
 *  covered without editing this file. */
function diagnosisSites(node: unknown, path = ''): DiagnosisSite[] {
  if (Array.isArray(node)) return node.flatMap((v, i) => diagnosisSites(v, `${path}/${i}`));
  if (node === null || typeof node !== 'object') return [];
  const here: DiagnosisSite[] = [];
  const props = (node as { properties?: Record<string, unknown> }).properties;
  if (props !== undefined && 'category' in props && 'retryable' in props) {
    here.push({ path, schema: node as DiagnosisSite['schema'] });
  }
  return [...here, ...Object.entries(node).flatMap(([k, v]) => diagnosisSites(v, `${path}/${k}`))];
}

/** The enum values the category node still lists, wherever it lists them. */
function listedValues(category: Record<string, unknown>): unknown[] {
  const arms = Array.isArray(category.anyOf) ? (category.anyOf as unknown[]) : [category];
  return arms.flatMap((arm) => {
    const values = (arm as { enum?: unknown }).enum;
    return Array.isArray(values) ? (values as unknown[]) : [];
  });
}

const DOCUMENTS: ReadonlyArray<readonly [string, () => unknown]> = [
  ['the spec the server publishes', () => generateOpenApiSpec()],
  [
    'the committed snapshot the Python SDK is generated from',
    () =>
      JSON.parse(
        readFileSync(resolve(REPO_ROOT, 'packages/sdk-python/openapi.json'), 'utf8'),
      ) as unknown,
  ],
];

describe('a failure category newer than the reader is still a valid response', () => {
  describe.each(DOCUMENTS)('%s', (_label, load) => {
    const sites = diagnosisSites(load());

    it('has a diagnosis at every place a turn reports its steps (the finder matched something)', () => {
      // IntentResult, the two turn results that list steps, and the conflict
      // problem's settled steps. A finder that matches nothing proves nothing.
      expect(sites.length, sites.map((s) => s.path).join('\n')).toBeGreaterThanOrEqual(4);
    });

    it('accepts a category it does not list, and still refuses one that is not text', () => {
      const ajv = createSpecAjv();
      for (const site of sites) {
        const validate = ajv.compile(site.schema);
        expect(
          validate({ category: NEWER_CATEGORY, retryable: false }),
          `${site.path} rejects a newer category: ${JSON.stringify(validate.errors)}`,
        ).toBe(true);
        expect(validate({ category: 'target_unverified', retryable: false }), site.path).toBe(true);
        expect(validate({ category: 42, retryable: false }), site.path).toBe(false);
      }
    });

    it('still lists every category the server emits, so generated SDKs keep them', () => {
      for (const site of sites) {
        expect(listedValues(site.schema.properties.category), site.path).toEqual(KNOWN);
      }
    });
  });

  it('the published api-types schema parses a step result carrying a newer category', () => {
    const parsed = IntentResultSchema.safeParse({
      kind: 'failure',
      intent: { kind: 'interact', action: 'tap', selector: '#buy' },
      reason: 'the tap was not made',
      diagnosis: { category: NEWER_CATEGORY, retryable: false },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('the generated Python Diagnosis model admits any string beside the known values', () => {
    const models = readFileSync(
      resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/_generated/models.py'),
      'utf8',
    );
    const body = models.match(/^class Diagnosis\(BaseModel\):\n([\s\S]*?)\n {4}retryable:/m)?.[1];
    expect(body, 'class Diagnosis not found in the generated models').toBeDefined();
    expect(body).toMatch(
      /category: \(\s*Literal\[[\s\S]*?"target_unverified",[\s\S]*?\]\s*\| str\s*\)/,
    );
  });

  it('the TypeScript SDK type admits any string beside the known values', () => {
    const source = codeOnly(
      readFileSync(
        resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/agent-sessions.ts'),
        'utf8',
      ),
    );
    const block = source.match(/export interface AgentFailureDiagnosis \{([\s\S]*?)\n\}/)?.[1];
    expect(block, 'AgentFailureDiagnosis not found').toBeDefined();
    const category = block?.match(/category:([\s\S]*?);/)?.[1] ?? '';
    // `string & {}`, not `string`: a bare string absorbs the literals and
    // editors stop suggesting them.
    expect(category).toMatch(/\|\s*\(string & \{\}\)\s*$/);
    for (const known of KNOWN) expect(category).toContain(`'${known}'`);
  });
});
