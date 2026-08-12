// Responses on `/{id}` routes conform to the schema documenting them.
//
// The population sweep in `openapi-responses-conform-to-the-spec` can only
// reach paths with no parameters, because a synthetic id exercises the 404
// branch rather than the real object. That left 103 templated operations
// unchecked — including the ones that return the CORE shapes every SDK models:
// a Session, a Profile, a Webhook. A list endpoint returning `data: []` on a
// fresh account validates an empty array and proves nothing about the objects
// inside it; these routes are where those objects actually appear.
//
// So the fixtures are created through the API first and the real ids are
// substituted in. That is also why this is a separate file: it MUTATES state,
// while the parameterless sweep is read-only and should stay that way.
//
// Only customer-reachable families are covered. Admin routes need a staff
// credential and answer 403 here, and `/v1/agent-sessions/*` answers 503
// because that service is not wired into this fixture — neither would validate
// an object shape, which is the entire point of this file.

import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let spec: SpecDocument;
let ajvInstance: Ajv | null = null;
let ids: Record<string, string> = {};

const DEFS_ID = 'https://driftstack.test/templated-components';

interface SpecDocument {
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown> };
}
interface CreatedResource {
  id?: string;
}
interface Operation {
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

function toDraft07(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toDraft07);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'nullable') continue;
    out[k] =
      k === '$ref' && typeof v === 'string'
        ? v.replace('#/components/schemas/', `${DEFS_ID}#/definitions/`)
        : toDraft07(v);
  }
  if ((node as { nullable?: boolean }).nullable === true && typeof out['type'] === 'string') {
    out['type'] = [out['type'], 'null'];
  }
  return out;
}

function ajv(): Ajv {
  if (ajvInstance) return ajvInstance;
  ajvInstance = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  ajvInstance.addSchema({ $id: DEFS_ID, definitions: toDraft07(spec.components?.schemas ?? {}) });
  return ajvInstance;
}

/** Both media types — errors are published as problem+json. */
function lookup(path: string, status: string): unknown {
  const content = spec.paths?.[path]?.['get']?.responses?.[status]?.content;
  return content?.['application/json']?.schema ?? content?.['application/problem+json']?.schema;
}

function validate(schema: unknown, body: unknown): string[] {
  const check = ajv().compile(toDraft07(schema) as object);
  return check(body)
    ? []
    : (check.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
}

const auth = (): { authorization: string } => ({ authorization: `Bearer ${fx.plaintext}` });

/**
 * True when an operation streams rather than returning a body.
 *
 * `GET /v1/agent-sessions/{id}/transcript` declares `text/event-stream` and
 * holds the connection open by design, so requesting it hangs the sweep — which
 * is exactly what happened the moment the agent-session family was added: two
 * arms timed out at 120s and 60s with no failure message worth reading. Read
 * off the spec so a stream added later is skipped automatically.
 */
function isStreaming(op: Operation | undefined): boolean {
  return Object.values(op?.responses ?? {}).some(
    (r) => r.content?.['text/event-stream'] !== undefined,
  );
}

/** The id family a templated path belongs to, or null if unreachable here. */
function familyOf(path: string): string | null {
  if (path.startsWith('/v1/profiles/')) return 'profile';
  if (path.startsWith('/v1/sessions/')) return 'session';
  if (path.startsWith('/v1/webhooks/')) return 'webhook';
  if (path.startsWith('/v1/agent-sessions/')) return 'agent';
  return null;
}

beforeAll(async () => {
  // The gated surfaces are wired, which is what makes the agent-session family
  // reachable at all: without `enableAgentRuntime` every one of those routes
  // answers 503 and the whole family is invisible here.
  fx = await buildTestApp({
    scopes: ['read', 'write', 'account_owner'],
    withOauthStore: true,
    enableAgentRuntime: true,
    enableByokAnthropic: true,
  });
  spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<SpecDocument>();

  const create = async (url: string, payload: Record<string, unknown>): Promise<string> => {
    const res = await fx.app.inject({ method: 'POST', url, headers: auth(), payload });
    try {
      const body = res.json<CreatedResource>();
      return body.id ?? '';
    } catch {
      // A non-JSON body means the create failed; the empty id is caught by the
      // fixtures-exist assertion rather than silently degrading the sweep.
      return '';
    }
  };
  ids = {
    profile: await create('/v1/profiles', { name: 'conformance-fixture' }),
    session: await create('/v1/sessions', {}),
    // `events` must be non-empty; an empty array is a 400, which would leave
    // this family silently uncovered.
    webhook: await create('/v1/webhooks', {
      url: 'https://example.com/hook',
      events: ['session.completed'],
    }),
    agent: await create('/v1/agent-sessions', {}),
  };
}, 60_000);

afterAll(async () => {
  await fx.app.close();
});

describe('templated-path responses conform to the spec', () => {
  it('CRITICAL the fixtures were really created. Every id feeds a path substitution, so an empty one silently turns its whole family into 404s that conform to the 404 schema and report success.', () => {
    for (const [family, id] of Object.entries(ids)) {
      expect(id, `${family} fixture created`).toBeTruthy();
    }
    // Prefixed public ids, so a substitution cannot be a bare uuid by accident.
    expect(ids['profile'], 'profile id shape').toMatch(/^prof_/);
    expect(ids['session'], 'session id shape').toMatch(/^ses_/);
    expect(ids['webhook'], 'webhook id shape').toMatch(/^whk_/);
    expect(ids['agent'], 'agent-session id shape').toMatch(/^agt_/);
  });

  it('CRITICAL the validator still rejects a body that violates a real schema. Everything below reports an absence of errors, so a validator that could not fail would satisfy it having checked nothing.', () => {
    const schema = lookup('/v1/profiles/{id}', '200');
    expect(schema, 'the profile schema is published').toBeDefined();
    expect(validate(schema, { id: 12345 }), 'a wrongly-typed field is reported').not.toEqual([]);
  });

  it('CRITICAL no /{id} route serves a caller with NO credentials, and every one is rate limited. Both population sweeps that assert these — security-declaration-matches-enforcement and the status-snapshot work — can only reach PARAMETERLESS paths, so the 29 operations behind a real id had neither property checked anywhere.', async () => {
    const servedAnonymously: string[] = [];
    const unlimited: string[] = [];
    let reached = 0;

    for (const path of Object.keys(spec.paths ?? {})) {
      if (!path.includes('{')) continue;
      const family = familyOf(path);
      if (family === null) continue;
      for (const method of ['get', 'post', 'patch', 'delete'] as const) {
        if (spec.paths?.[path]?.[method] === undefined) continue;
        if (isStreaming(spec.paths[path]?.[method])) continue;
        // Skip routes this fixture does not REGISTER. `livekit-token` is wired
        // only on a complete LiveKit config ("Partial config = unregistered
        // route", app.ts), so it answers 404 here and carries no rate-limit
        // headers — because the route does not exist, not because a gate is
        // missing. Asked of fastify directly rather than inferred from a 404,
        // which a real missing resource also produces.
        if (
          !fx.app.hasRoute({
            method: method.toUpperCase(),
            url: path.replace(/\{([^}]+)\}/g, ':$1'),
          })
        ) {
          continue;
        }
        const url = path.replace(/\{[^}]+\}/, ids[family] ?? '');
        if (url.includes('{')) continue;
        const payload = method === 'get' ? {} : { payload: {} };

        const anon = await fx.app.inject({
          method: method.toUpperCase() as 'GET',
          url,
          ...payload,
        });
        if (anon.statusCode >= 200 && anon.statusCode < 300) {
          servedAnonymously.push(`${method.toUpperCase()} ${path}`);
        }

        const authed = await fx.app.inject({
          method: method.toUpperCase() as 'GET',
          url,
          headers: auth(),
          ...payload,
        });
        reached += 1;
        if (authed.headers['x-ratelimit-limit'] === undefined) {
          unlimited.push(`${method.toUpperCase()} ${path} -> ${String(authed.statusCode)}`);
        }
      }
    }

    // MEASURED: 45 templated operations exercised, up from 29 with the
    // agent-session family.
    // Floored, because both assertions below report an ABSENCE and a sweep that
    // substituted a broken id would reach nothing and report both as clean.
    //
    // On which arm catches what, measured rather than assumed: stripping BOTH
    // the auth and the rate-limit preHandler from GET /v1/webhooks/:id reds the
    // rate-limit arm, and does NOT red the anonymous arm — the handler throws
    // on the missing account context and answers 500 instead of serving data.
    // That is defence in depth working, and it is why the anonymous assertion
    // is written against the OUTCOME (2xx reached an anonymous caller) rather
    // than against any particular gate being present. The same predicate is
    // mutation-proved on the parameterless population in
    // security-declaration-matches-enforcement, where a route that really does
    // serve anonymously exists to trip it.
    expect(reached, 'templated operations exercised').toBeGreaterThanOrEqual(40);
    expect(servedAnonymously, '/{id} route(s) served without credentials:').toEqual([]);
    expect(unlimited, '/{id} route(s) with no rate-limit headers:').toEqual([]);
  }, 120_000);

  it('CRITICAL every reachable /{id} response conforms, on whatever status it returns. These are the routes that return a real Session, Profile and Webhook — the shapes every SDK models, and the ones a list endpoint on a fresh account never exercises.', async () => {
    const violations: string[] = [];
    const undocumented: string[] = [];
    let validated = 0;

    for (const path of Object.keys(spec.paths ?? {})) {
      if (!path.includes('{') || spec.paths?.[path]?.['get'] === undefined) continue;
      if (isStreaming(spec.paths[path]?.['get'])) continue;
      const family = familyOf(path);
      if (family === null) continue;
      const url = path.replace(/\{[^}]+\}/, ids[family] ?? '');
      // A second parameter means this needs an id we did not create.
      if (url.includes('{')) continue;

      const res = await fx.app.inject({ method: 'GET', url, headers: auth() });
      const status = String(res.statusCode);
      const schema = lookup(path, status);
      if (schema === undefined) {
        undocumented.push(`${path} -> ${status}`);
        continue;
      }
      validated += 1;
      const errors = validate(schema, res.json());
      if (errors.length > 0) violations.push(`${path} -> ${status}: ${errors.join('; ')}`);
    }

    // MEASURED: 14 templated GETs validate, up from 7 — the agent-session
    // family became reachable once `enableAgentRuntime` was wired, and it had
    // never been conformance-checked by anything. Pinned so a regression that
    // stops creating fixtures, stops matching families, or quietly loses the
    // runtime wiring fails loudly instead of sweeping less and reporting
    // success.
    expect(validated, 'templated endpoints actually validated').toBeGreaterThanOrEqual(12);
    expect(violations, 'templated response(s) that violate their own schema:').toEqual([]);
    // Surfaced rather than asserted: a status with no schema for this media
    // type is usually a fixture-disabled dependency (503), not a contract fault.
    expect(undocumented.length, 'statuses reached with no documented schema').toBeLessThan(4);
  }, 60_000);
});
