// What a customer actually receives is what the spec says they receive.
//
// Twenty-nine object schemas in the committed spec have no `api-types`
// counterpart, so `api-types-shapes-match-the-spec` cannot see them: they are
// declared inline in `lib/openapi.ts`. For those, the published contract and the
// server's real output have nothing joining them, and the shapes multiply
// instead. `AccountMeResponse` exists three times — in the spec, built up across
// the route handler, and restated as a local `interface` inside
// `integration/account-me.test.ts`. That local copy lists FOURTEEN fields where
// the spec declares SIXTEEN; it is simply behind, which is what a fourth
// hand-maintained copy does.
//
// A static comparison was tried and does not work here. The handler does not
// return one object literal — it assembles the body across branches — so there
// is no key list to read. That is the same wall the check-constraint predicates
// hit: when the source cannot be compared, compare the RESULT instead.
//
// So this drives the real app and reads the real body. Both directions matter
// and they fail differently:
//
//   undocumented field   the server returns something the spec never mentions.
//                        A customer cannot rely on it, a generated client drops
//                        it, and it is now shipped anyway — the expensive kind
//                        of accident, because removing it later breaks whoever
//                        found it.
//   missing required     the spec promises a field the server does not send. A
//                        generated client types it as present; the customer
//                        reads undefined.
//
// Optional fields are allowed to be absent, which is what optional means. Only
// the spec's own `required` list is demanded.
//
// Eight of the twenty-nine, each an authenticated GET whose whole body is one
// unpaired schema: the account profile a dashboard reads on every load, the cost
// summary, the audit-log page and its export, the bundled-LLM status and
// settings, the profile organization tree and the proxy list. The table takes a
// row per endpoint, so the cost of the next one is that row.
//
// The four added second were picked by listing every GET in the spec whose whole
// 200 body is a `$ref` to one component schema, subtracting the ones already
// here, and keeping those the default fixture can reach. `read` satisfies
// `read:profiles` (V-481 broad-satisfies-granular), so the organization endpoint
// needs no extra scope, and the export defaults to `format: json` rather than
// csv. Each carries a non-empty `required` list — 2, 1, 2 and 5 fields — so none
// of them is a row that compares an empty set to an empty set.
//
// The last three unpaired GETs are owner/admin surfaces, and the note here used
// to say the fixture could not issue their credentials. That was true and is no
// longer: `requireOwner` admits exactly one email and fails CLOSED when unset,
// so the fixture simply never passed one. It threads `ownerEmail` now, and the
// three are compared below on the same terms as the rest.
//
// TWO CANDIDATES ARE DELIBERATELY ABSENT, and the reasons differ.
//
// `GET /v1/account/me/byok-anthropic-key` returns ByokAnthropicMetadata and was
// tried here: it answers 503 on a default fixture, because BYOK is
// activation-gated and stays in its stub posture until a fallback key is
// configured. That is not a contract gap — the spec documents 503 on that path
// alongside 200 — it simply cannot be compared without a fixture that activates
// the feature.
//
// ELEMENT-LEVEL rows exist because the top-level comparison is nearly empty for
// a list endpoint. `AccountProxyList` declares exactly ONE property, `data`, so
// comparing top-level keys compares {data} against {data} and learns nothing;
// the contract a customer actually consumes is the shape of the items. Three of
// the rows above are list-shaped and were being checked at the envelope only.
//
// Every list endpoint returns ZERO items on a fresh fixture — measured, all five
// of them — so an element comparison added without seeding would compare nothing
// and pass. LIST_CASES therefore seeds first, and an explicit arm asserts each
// element row actually had an item to read.
//
// The team rows used to be excluded here with a note saying the fixture could
// not seed a team. That was wrong: one POST /v1/team/invites is enough, and the
// same call also writes the audit row that gives AccountAuditEntry its coverage.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '..', '..', '..', '..', 'packages', 'sdk-python', 'openapi.json');

interface SpecSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

/** The committed spec's declaration for one component schema. */
function declaredSchema(name: string): SpecSchema {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    components?: { schemas?: Record<string, SpecSchema> };
  };
  const schema = spec.components?.schemas?.[name];
  expect(schema, `the spec declares ${name}`).toBeDefined();
  return schema!;
}

/** Endpoints whose live response body is compared to its published schema. */
const CASES = [
  { schema: 'AccountMeResponse', method: 'GET' as const, url: '/v1/account/me' },
  { schema: 'AccountCostResponse', method: 'GET' as const, url: '/v1/account/cost' },
  { schema: 'ListAccountAuditResponse', method: 'GET' as const, url: '/v1/account/audit-log' },
  {
    schema: 'BundledLlmStatus',
    method: 'GET' as const,
    url: '/v1/account/me/bundled-llm-status',
  },
  { schema: 'AccountOrganization', method: 'GET' as const, url: '/v1/account/me/organization' },
  { schema: 'AccountProxyList', method: 'GET' as const, url: '/v1/account/me/proxies' },
  {
    schema: 'BundledLlmSettings',
    method: 'GET' as const,
    url: '/v1/account/me/bundled-llm-settings',
  },
  {
    schema: 'ExportAccountAuditResponse',
    method: 'GET' as const,
    url: '/v1/account/audit-log/export',
  },
];

/**
 * Endpoints behind the requireOwner gate. Same comparison, different fixture:
 * that gate admits exactly one email and fails CLOSED when unset, so every
 * fixture-built app forbade this surface and these three schemas could not be
 * reached at all. The fixture now threads `ownerEmail`, and passing the test
 * account's own address is what opens the door.
 */
const OWNER_CASES = [
  {
    schema: 'OwnerPlatformStatusResponse',
    method: 'GET' as const,
    url: '/v1/admin/owner/platform-status',
  },
  { schema: 'OwnerPricingResponse', method: 'GET' as const, url: '/v1/admin/owner/pricing' },
  {
    schema: 'AdminSubscriptionStatsResponse',
    method: 'GET' as const,
    url: '/v1/admin/billing/subscriptions/stats',
  },
];

/**
 * Endpoints whose body is `{data: [...]}`. The envelope carries no contract worth
 * checking; the item schema does, so these are compared element-first.
 */
const LIST_CASES = [
  { schema: 'TeamInvite', method: 'GET' as const, url: '/v1/team/invites' },
  { schema: 'AccountAuditEntry', method: 'GET' as const, url: '/v1/account/audit-log' },
];

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

async function bodyFor(method: 'GET', url: string): Promise<Record<string, unknown>> {
  fx = await buildTestApp({ tier: 'api_builder' });
  const res = await fx.app.inject({ method, url, headers: auth(fx) });
  expect(res.statusCode, `${method} ${url} answered 200`).toBe(200);
  return res.json<Record<string, unknown>>();
}

async function ownerBodyFor(method: 'GET', url: string): Promise<Record<string, unknown>> {
  const email = 'owner-probe@driftstack.local';
  fx = await buildTestApp({ tier: 'api_builder', email, ownerEmail: email });
  const res = await fx.app.inject({ method, url, headers: auth(fx) });
  expect(res.statusCode, `${method} ${url} answered 200`).toBe(200);
  return res.json<Record<string, unknown>>();
}

/**
 * A fixture with one team invite already created. That single POST seeds BOTH
 * list endpoints compared below — the invite itself, and the audit row the
 * server writes for it — so one action covers two item schemas.
 */
async function seededListItems(url: string): Promise<Record<string, unknown>[]> {
  fx = await buildTestApp({ tier: 'api_builder' });
  const created = await fx.app.inject({
    method: 'POST',
    url: '/v1/team/invites',
    headers: auth(fx),
    payload: { email: 'invitee@driftstack.local', role: 'admin' },
  });
  expect(created.statusCode, 'the seeding invite was accepted').toBe(202);

  const res = await fx.app.inject({ method: 'GET', url, headers: auth(fx) });
  expect(res.statusCode, `GET ${url} answered 200`).toBe(200);
  return res.json<{ data?: Record<string, unknown>[] }>().data ?? [];
}

describe('a live response body matches its published schema', () => {
  it('CRITICAL the spec was read and the endpoint answered with a real body. Both assertions below compare SETS, and two empty sets agree perfectly — a spec that failed to parse or a body that came back empty would report the contract satisfied having compared nothing.', async () => {
    const schema = declaredSchema('AccountMeResponse');
    expect(
      Object.keys(schema.properties ?? {}).length,
      'properties declared by the spec',
    ).toBeGreaterThanOrEqual(16);
    expect(schema.required?.length ?? 0, 'fields the spec marks required').toBeGreaterThanOrEqual(
      16,
    );

    const body = await bodyFor('GET', '/v1/account/me');
    expect(Object.keys(body).length, 'keys on the live response body').toBeGreaterThanOrEqual(16);
  });

  it.each(CASES)(
    'CRITICAL $method $url returns no field its schema does not declare. An undocumented field is shipped anyway — a customer who finds it cannot rely on it, a generated client drops it, and removing it later breaks whoever came to depend on it.',
    async ({ schema: name, method, url }) => {
      const declared = new Set(Object.keys(declaredSchema(name).properties ?? {}));
      const body = await bodyFor(method, url);
      const undocumented = Object.keys(body)
        .filter((k) => !declared.has(k))
        .sort();
      expect(undocumented, `field(s) returned by ${url} that ${name} does not declare:`).toEqual(
        [],
      );
    },
  );

  it.each(CASES)(
    'CRITICAL $method $url returns every field its schema marks required. The spec is what a generated client types from, so a promised-but-absent field is read as undefined by code the compiler said was safe.',
    async ({ schema: name, method, url }) => {
      const schema = declaredSchema(name);
      const body = await bodyFor(method, url);
      const present = new Set(Object.keys(body));
      const missing = (schema.required ?? []).filter((k) => !present.has(k)).sort();
      expect(missing, `required field(s) ${name} promises that ${url} did not send:`).toEqual([]);
    },
  );
  it('CRITICAL the owner gate is REACHED, not bypassed. It fails closed when ownerEmail is unset, so a fixture that forgot to pass it would 403 — and a 403 body has none of the fields the schema declares, which would make the two comparisons below agree about nothing.', async () => {
    const email = 'owner-probe@driftstack.local';
    fx = await buildTestApp({ tier: 'api_builder', email, ownerEmail: email });
    const admitted = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/owner/pricing',
      headers: auth(fx),
    });
    expect(admitted.statusCode, 'the owner is admitted when the email matches').toBe(200);
  });

  it('CRITICAL a NON-owner is still refused. The fixture change opens this surface deliberately; if passing any account made the gate admit, these rows would be testing an authorization hole rather than a response shape.', async () => {
    fx = await buildTestApp({ tier: 'api_builder', email: 'not-the-owner@driftstack.local' });
    const refused = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/owner/pricing',
      headers: auth(fx),
    });
    expect(refused.statusCode, 'a non-owner does not reach the owner surface').not.toBe(200);
  });

  it.each(OWNER_CASES)(
    'CRITICAL $method $url returns no field its schema does not declare. Owner surfaces drift the same way customer ones do, and they are read by the operator console rather than by a customer, so nothing complains when they do.',
    async ({ schema: name, method, url }) => {
      const declared = new Set(Object.keys(declaredSchema(name).properties ?? {}));
      const body = await ownerBodyFor(method, url);
      const undocumented = Object.keys(body)
        .filter((k) => !declared.has(k))
        .sort();
      expect(undocumented, `field(s) returned by ${url} that ${name} does not declare:`).toEqual(
        [],
      );
    },
  );

  it.each(OWNER_CASES)(
    'CRITICAL $method $url returns every field its schema marks required.',
    async ({ schema: name, method, url }) => {
      const schema = declaredSchema(name);
      const body = await ownerBodyFor(method, url);
      const present = new Set(Object.keys(body));
      const missing = (schema.required ?? []).filter((k) => !present.has(k)).sort();
      expect(missing, `required field(s) ${name} promises that ${url} did not send:`).toEqual([]);
    },
  );
  it.each(LIST_CASES)(
    'CRITICAL $url returns at least one item to compare. Every list endpoint answers with an empty array on a fresh fixture — all five, measured — so the two element comparisons below would read undefined and agree perfectly, reporting the item contract verified having never seen an item.',
    async ({ url }) => {
      const items = await seededListItems(url);
      expect(items.length, `items returned by ${url} after seeding`).toBeGreaterThan(0);
    },
  );

  it.each(LIST_CASES)(
    'CRITICAL an item from $url carries no field its schema does not declare. The envelope for a list endpoint is one `data` key, so the top-level comparison passes on {data} vs {data}; everything a customer actually reads is in here.',
    async ({ schema: name, url }) => {
      const declared = new Set(Object.keys(declaredSchema(name).properties ?? {}));
      const [item] = await seededListItems(url);
      const undocumented = Object.keys(item ?? {})
        .filter((k) => !declared.has(k))
        .sort();
      expect(
        undocumented,
        `field(s) on an item from ${url} that ${name} does not declare:`,
      ).toEqual([]);
    },
  );

  it.each(LIST_CASES)(
    'CRITICAL an item from $url carries every field its schema marks required. A generated client types these as present on each element of the array, so a promised-but-absent one is read as undefined inside a loop the compiler said was safe.',
    async ({ schema: name, url }) => {
      const schema = declaredSchema(name);
      const [item] = await seededListItems(url);
      const present = new Set(Object.keys(item ?? {}));
      const missing = (schema.required ?? []).filter((k) => !present.has(k)).sort();
      expect(
        missing,
        `required field(s) ${name} promises that an item from ${url} omitted:`,
      ).toEqual([]);
    },
  );
});
