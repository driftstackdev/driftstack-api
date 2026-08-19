// V-951 — the reason the unknown-field reporter skips the anonymous auth surface,
// checked against the facts it rests on.
//
// `unknown-request-fields.ts` gave two reasons for excluding unauthenticated auth
// endpoints: echoing a caller's keys back discloses schema shape on a
// probing-attractive surface, and the failure being fixed — a mistyped field
// silently changing a resource's configuration — belongs to authenticated resource
// writes, "not of login".
//
// Both were measured in V-950/951 and neither holds as stated. Every excluded route
// publishes its complete request-body property list in the OpenAPI document, so the
// shape is already public. And signup does configure a resource: `name` is optional,
// so a mistyped `nam` creates an account with no display name and answers success.
//
// The behaviour did not change — whether to report on an unauthenticated surface is
// a product decision, not a defect fix. What changed is that the rationale no longer
// reads like a settled conclusion. This file exists so that stays true in both
// directions: if the shapes are ever unpublished, the disclosure argument becomes
// live again and the comment must say so; and if `name` becomes required, the
// counter-example stops being real and the comment must stop citing it.
//
// A rationale with nothing checking it is how a stale reason survives the fact that
// contradicts it — which is exactly what happened here, for however long the spec has
// published these bodies.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SignupRequestSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const MODULE = resolve(REPO_ROOT, 'apps/server/src/lib/unknown-request-fields.ts');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/versioning.md');

/**
 * The unauthenticated routes the reporter is not applied to. Every one still
 * carries an entry in the coverage guard's backlog; this list is the same surface
 * viewed from the document's side.
 */
const EXCLUDED_ANONYMOUS_ROUTES = [
  '/v1/auth/signup',
  '/v1/auth/login',
  '/v1/auth/logout',
  '/v1/auth/refresh',
  '/v1/auth/verify-email',
  '/v1/auth/resend-verification',
  '/v1/auth/magic-link/request',
  '/v1/auth/magic-link/consume',
  '/v1/auth/password-reset/request',
  '/v1/auth/password-reset/confirm',
  '/v1/auth/cli-authorize/initiate',
  '/v1/auth/cli-authorize/exchange',
  '/v1/auth/oauth-client/start',
  '/v1/auth/oauth-client/confirm-merge',
] as const;

interface SpecShape {
  components?: { schemas?: Record<string, unknown> };
  paths: Record<
    string,
    Record<
      string,
      {
        requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }> };
      }
    >
  >;
}

const spec = (): SpecShape => JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;

/** Resolve one level of `$ref` against `components.schemas`. */
function deref(doc: SpecShape, node: Record<string, unknown> | undefined, depth = 0): unknown {
  if (node === undefined || depth > 4) return undefined;
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    const name = ref.split('/').pop() ?? '';
    return deref(doc, doc.components?.schemas?.[name] as Record<string, unknown>, depth + 1);
  }
  return node;
}

/** The declared top-level property names of a POST's JSON request body. */
function publishedBodyProperties(path: string): string[] {
  const doc = spec();
  const op = doc.paths[path]?.['post'];
  const schema = deref(doc, op?.requestBody?.content?.['application/json']?.schema);
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return props === undefined ? [] : Object.keys(props).sort();
}

describe('V-951 the anonymous exemption rests on facts, not on its own wording', () => {
  it('CRITICAL every excluded route is in the published document at all. The arms below read property lists out of the spec; a path that is simply absent would give an empty list, and "no properties published" would then look identical to "properties published and readable" in the disclosure argument. This separates the two.', () => {
    const doc = spec();
    const missing = EXCLUDED_ANONYMOUS_ROUTES.filter((p) => doc.paths[p]?.['post'] === undefined);
    expect(
      missing,
      'these excluded routes have no published POST operation, so this file cannot speak to whether ' +
        'their shape is public — either the path list is stale or the spec stopped covering them:',
    ).toEqual([]);
  });

  it('CRITICAL the shape of every excluded route is ALREADY PUBLIC. This is the fact that retires the disclosure reason: the header would echo back a key the caller themself sent, and the full field list is in a document served to anyone. If a route ever stops publishing its body, the disclosure argument becomes live again for that route and the rationale has to be rewritten rather than inherited.', () => {
    const unpublished = EXCLUDED_ANONYMOUS_ROUTES.filter(
      (p) => publishedBodyProperties(p).length === 0,
    );
    expect(
      unpublished,
      'these excluded routes publish no request-body properties, so their field names are NOT ' +
        'already public and the disclosure rationale may hold for them again:',
    ).toEqual([]);
    // Named rather than counted, so a route swapped for another cannot pass.
    expect(publishedBodyProperties('/v1/auth/signup')).toEqual(['email', 'name', 'password']);
    expect(publishedBodyProperties('/v1/auth/login')).toEqual(['email', 'password']);
  });

  it('CRITICAL signup really can silently misconfigure an account, which is the counter-example the rationale cites. `name` being optional is the whole of it: a mistyped `nam` is stripped and the account is created without a display name. Asserted from the SOURCE as well as from behaviour — `@driftstack/api-types` resolves to `dist/index.js`, so the runtime half reads compiled output and making `name` required in src did NOT fail this arm until the source pin was added. That is the shape the repo has been bitten by before: a dist-reading assertion is a false signal in both directions, green against a stale build and blind to an edit that has not been rebuilt.', () => {
    expect(
      readFileSync(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'), 'utf8'),
      'signup `name` is no longer optional in SOURCE, so the counter-example the module cites is gone ' +
        'and its rationale needs rewriting — this fires before any rebuild, which the behavioural half ' +
        'below cannot',
    ).toContain('name: z.string().min(1).max(120).optional(),');

    const shape = SignupRequestSchema.shape;
    expect(Object.keys(shape).sort(), 'the signup schema still has exactly these fields').toEqual([
      'email',
      'name',
      'password',
    ]);
    // The mechanism's own failure mode, executed: a mistyped optional field.
    const parsed = SignupRequestSchema.safeParse({
      email: 'someone@example.com',
      password: 'a-sufficiently-long-passphrase-1',
      nam: 'Alice',
    });
    expect(parsed.success, 'the mistyped field does not stop the parse').toBe(true);
    expect(
      parsed.success ? parsed.data.name : 'unset',
      'and the display name is silently absent — success, misconfigured, nothing said',
    ).toBeUndefined();
  });

  it('CRITICAL the module records that its stated reasons were measured, and the customer page no longer asserts the disclosure one. A page telling customers the header is withheld to protect a shape the same site publishes is a claim that cannot survive being checked.', () => {
    const source = readFileSync(MODULE, 'utf8');
    expect(
      source,
      'the module no longer notes that its exclusion rationale was measured and did not hold, so the ' +
        'next reader inherits the original reasons as settled',
    ).toContain('BOTH of its reasons');
    const doc = readFileSync(DOC, 'utf8');
    expect(
      doc,
      'the customer page asserts the disclosure rationale again. The field lists for these routes are ' +
        'published in the same API reference the page links to',
    ).not.toContain('discloses schema');
  });
});
