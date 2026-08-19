// V-926 — the MFA bodies published in the OpenAPI document permitted requests
// the routes always refuse.
//
// `POST /v1/auth/mfa/step-up` and `POST /v1/auth/mfa/challenge` validate with
// `MfaStepUpRequestSchema` / `MfaChallengeRequestSchema`, both of which refine
// "either `code` or `recovery_code` must be provided". Per V-924 a refine is a
// runtime predicate JSON Schema cannot express — and here the spec did not even
// carry the fields' `min(1)` bounds, because the request bodies in openapi.ts are
// hand-written MIRRORS of the real schemas rather than the schemas themselves.
//
// The step-up body published no `required` array at all. A customer generating a
// client from the document would see every field optional and `{}` as a valid
// request, on an endpoint that answers 400 for it. Both bodies are now unions,
// which render as `anyOf` with one `required` set per branch — a form JSON Schema
// keeps.
//
// SCOPE, stated because a narrower check that looks broad is the failure this
// sweep keeps finding: this compares the REQUIRED-KEY dimension only. It asks
// whether the published document would admit a body by presence of keys, and
// whether the real schema accepts it. It is not a JSON Schema validator and does
// not check formats, patterns or bounds — the sample bodies below are all
// format-valid on purpose, so any disagreement is about presence and nothing
// else. (ajv is present in the tree only as a transitive dependency of eslint, so
// depending on it here would make this guard fail for an unrelated reason.)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';

import { MfaChallengeRequestSchema, MfaStepUpRequestSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

interface JsonSchemaish {
  required?: string[];
  anyOf?: JsonSchemaish[];
  oneOf?: JsonSchemaish[];
  properties?: Record<string, unknown>;
}

interface SpecShape {
  paths: Record<
    string,
    { post?: { requestBody?: { content: { 'application/json': { schema: JsonSchemaish } } } } }
  >;
}

function publishedBody(path: string): JsonSchemaish | undefined {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
  return spec.paths[path]?.post?.requestBody?.content['application/json'].schema;
}

/** Branches a body may satisfy: the alternatives, or the schema itself. */
function branches(schema: JsonSchemaish): JsonSchemaish[] {
  return schema.anyOf ?? schema.oneOf ?? [schema];
}

/** Would the DOCUMENT admit this body, judged on required-key presence alone? */
function specAdmits(schema: JsonSchemaish, body: Record<string, unknown>): boolean {
  return branches(schema).some((b) => (b.required ?? []).every((k) => k in body));
}

interface Case {
  readonly label: string;
  readonly body: Record<string, unknown>;
}

const CHALLENGE_CASES: readonly Case[] = [
  { label: 'neither code nor recovery_code', body: { challenge_token: 'ct_abc' } },
  { label: 'code only', body: { challenge_token: 'ct_abc', code: '123456' } },
  { label: 'recovery_code only', body: { challenge_token: 'ct_abc', recovery_code: 'r-1' } },
  {
    label: 'both',
    body: { challenge_token: 'ct_abc', code: '123456', recovery_code: 'r-1' },
  },
  { label: 'empty body', body: {} },
];

const STEP_UP_CASES: readonly Case[] = [
  { label: 'empty body', body: {} },
  { label: 'code only', body: { code: '123456' } },
  { label: 'recovery_code only', body: { recovery_code: 'r-1' } },
  { label: 'both', body: { code: '123456', recovery_code: 'r-1' } },
];

const ENDPOINTS: readonly {
  path: string;
  schema: ZodTypeAny;
  cases: readonly Case[];
}[] = [
  { path: '/v1/auth/mfa/challenge', schema: MfaChallengeRequestSchema, cases: CHALLENGE_CASES },
  { path: '/v1/auth/mfa/step-up', schema: MfaStepUpRequestSchema, cases: STEP_UP_CASES },
];

describe('V-926 the published body admits what the route admits', () => {
  it('CRITICAL both bodies are really published, and as alternatives. Every arm below compares two verdicts, and a missing schema would make the comparison meaningless rather than failing — so the shape is asserted first.', () => {
    for (const { path } of ENDPOINTS) {
      const schema = publishedBody(path);
      expect(schema, `${path} publishes a JSON request body`).toBeDefined();
      expect(
        branches(schema as JsonSchemaish).length,
        `${path} publishes the either-or as alternatives, not one flat object`,
      ).toBeGreaterThan(1);
    }
  });

  it('CRITICAL a request the route refuses is not described as valid. This is the defect: step-up published no `required` at all, so `{}` read as a legal request against an endpoint that answers 400 for it, and challenge said a body with neither code nor recovery_code was fine. A refine cannot carry that rule into the document; alternatives can.', () => {
    const disagreements: string[] = [];
    for (const { path, schema, cases } of ENDPOINTS) {
      const published = publishedBody(path) as JsonSchemaish;
      for (const { label, body } of cases) {
        const routeAccepts = schema.safeParse(body).success;
        const documentAdmits = specAdmits(published, body);
        if (routeAccepts !== documentAdmits) {
          disagreements.push(
            `${path} [${label}] route=${routeAccepts ? 'accepts' : 'refuses'} document=${
              documentAdmits ? 'admits' : 'refuses'
            }`,
          );
        }
      }
    }
    expect(disagreements, 'the document and the route disagree about these bodies:').toEqual([]);
  });

  it('CRITICAL the cases actually exercise both verdicts. If every sample were accepted by both, the arm above would agree having proven nothing — so at least one refusal and one acceptance is required on each endpoint.', () => {
    for (const { path, schema, cases } of ENDPOINTS) {
      const verdicts = cases.map((c) => schema.safeParse(c.body).success);
      expect(verdicts, `${path} has an accepted sample`).toContain(true);
      expect(verdicts, `${path} has a refused sample`).toContain(false);
    }
  });
});
