// Account B cannot touch account A's resources, across every family this
// fixture can create — and A's records are still intact afterwards.
//
// Six family-specific isolation tests already exist (profiles, sessions,
// snapshots, agent sessions, proxies, crypto orders) and
// `cross-account-404-anti-enumeration` states the policy: a cross-account
// reference must answer 404, never 403, because 403 confirms the resource
// exists and turns a guessed id into an existence oracle.
//
// Two families had no isolation coverage at all: WEBHOOKS and API KEYS. Both
// carry parameterised writes whose success would be severe rather than merely
// leaky — `POST /v1/api-keys/{id}/rotate` mints a successor key and returns its
// plaintext, so a working cross-account rotation is simultaneously a takeover
// and a denial of service against the victim's live key. `POST
// /v1/webhooks/{id}/rotate-secret` is the same shape against a signing secret.
// Nothing had ever asked whether that worked.
//
// It does not. Every probe below answers 404 on current source. This file
// exists so that stays true, and so the next family added gets covered by
// construction rather than by someone remembering to write a seventh
// family-specific file.
//
// TWO things are asserted about each attempt, because the status alone is not
// the property that matters. A 404 says the caller was told nothing. It does
// NOT say the write was refused — a handler that mutates and then fails to find
// a row to return would answer 404 having already done the damage. So every
// resource A owns is re-read at the end and compared byte-for-byte against what
// it looked like before B started.
//
// The valid-body PATCH is deliberate. An empty body 400s on validation before
// ownership is ever consulted, so probing with `{}` proves nothing about the
// boundary — it exercises the request parser. That is the same trap as mutating
// an unexecuted branch: the probe reports a refusal it never actually tested.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, seedAdditionalAccount } from './_helpers/build-test-app.js';

/**
 * V-1470 — the family list below is hand-maintained, and this is what keeps it
 * honest.
 *
 * The describe is named "in any creatable family" and the header says the next
 * family gets covered by construction. Both were true of the harness and neither
 * was true of the ROSTER: seven `OWNED.push` lines and a literal `probes` array,
 * with nothing asking whether they still span what the API lets a customer
 * create. Measured when this landed: 7 collection-level creates in the route
 * table, 6 customer-facing and all 6 probed.
 *
 * A create gated by `driftstack_internal_admin` is excluded WITH ITS REASON, not
 * silently: staff-only fleet resources have no owning customer account, so there
 * is no tenant boundary for one account to cross.
 *
 * Scope, stated because it bounds the claim: this derives COLLECTION-level
 * creates (`POST /v1/<family>`), which are unambiguous. Nested creates like
 * `POST /v1/profiles/{id}/snapshots` cannot be told apart from actions like
 * `POST /v1/api-keys/{id}/rotate` by shape alone, so `snapshot` is carried in
 * the covered list by hand and this arm does not police that half.
 */
const STAFF_ONLY_CREATES: Record<string, string> = {
  '/v1/mac-nodes':
    'fleet infrastructure, gated by driftstack_internal_admin. No customer account owns a mac node, so there is no tenant boundary to cross.',
};

/** Collection-level creates this file actually probes. `snapshot` is nested. */
const PROBED_CREATES = [
  '/v1/agent-sessions',
  '/v1/api-keys',
  '/v1/profiles',
  '/v1/recipes',
  '/v1/sessions',
  '/v1/webhooks',
];

function collectionLevelCreates(): { path: string; staffOnly: boolean }[] {
  const routesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'routes');
  const out: { path: string; staffOnly: boolean }[] = [];
  for (const file of readdirSync(routesDir)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(resolve(routesDir, file), 'utf8');
    for (const m of src.matchAll(/app\.post[^(]*\(\s*\n?\s*'(\/v1\/[^']*)'/g)) {
      const path = m[1] ?? '';
      if (path.includes('{') || path.includes(':')) continue;
      if (path.split('/').length !== 3) continue;
      // The registration options follow the path; read far enough to see the gate.
      const options = src.slice(m.index ?? 0, (m.index ?? 0) + 600);
      out.push({ path, staffOnly: options.includes("requireScope('driftstack_internal_admin')") });
    }
  }
  return out;
}

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let bToken = '';

/**
 * Deletes that answer 204 whether or not the row existed.
 *
 * `DELETE /v1/profiles/{id}` is one: the service does `if (!ok) return`, so a
 * foreign id is a no-op that still reports success. That is deliberate and
 * recorded as 404-free in parameterised-routes-document-404.
 *
 * Demanding 404 from these would be wrong, but exempting them in prose would be
 * worse — "204 is safe here" is a claim, and this file's whole subject is
 * claims nobody checked. So they are excluded from the 404 rule and subjected
 * to a sharper one instead: the response to a foreign id must be
 * INDISTINGUISHABLE from the response to an id that never existed. That is the
 * property which makes a 204 leak nothing, and it is asserted rather than
 * assumed.
 */
const IDEMPOTENT_DELETE: ReadonlySet<string> = new Set(['DELETE /v1/profiles/:id']);

/**
 * Status plus body, with the per-request nonce removed.
 *
 * RFC 7807 bodies carry an `instance` correlation id that is different on every
 * request, so a raw body comparison reports two identical refusals as different
 * and the check below would fire on any error-bodied route forever. Caught
 * while mutation-proving: the mutant "failed" on nothing but the nonce, which
 * would have been a proof of nothing.
 */
function fingerprint(status: number, body: string): string {
  return `${String(status)}|${body.replace(/"instance":"[^"]*"/g, '"instance":"<nonce>"')}`;
}

interface Attempt {
  op: string;
  status: number;
}

/** Foreign-vs-nonexistent responses for each idempotent delete. */
const indistinguishability = new Map<string, { foreign: string; absent: string }>();

/** family -> the id its create returned. '' means the create failed. */
const created = new Map<string, string>();

const attempts: Attempt[] = [];
/** `label -> body A sees` before B interferes, and again after. */
const before = new Map<string, string>();
const after = new Map<string, string>();

const OWNED: { label: string; read: string }[] = [];

beforeAll(async () => {
  fx = await buildTestApp({
    tier: 'api_builder',
    scopes: ['read', 'write', 'account_owner'],
    withOauthStore: true,
    enableAgentRuntime: true,
    enableByokAnthropic: true,
  });
  const aAuth = { authorization: `Bearer ${fx.plaintext}` };

  const create = async (url: string, payload: Record<string, unknown>): Promise<string> => {
    const res = await fx.app.inject({ method: 'POST', url, headers: aAuth, payload });
    try {
      const v = res.json<Record<string, unknown>>()['id'];
      return typeof v === 'string' ? v : '';
    } catch {
      return '';
    }
  };

  const track = (family: string, id: string): string => {
    created.set(family, id);
    return id;
  };

  const profile = track('profile', await create('/v1/profiles', { name: 'a-profile' }));
  const session = track('session', await create('/v1/sessions', { label: 'a-session' }));
  const webhook = track(
    'webhook',
    await create('/v1/webhooks', {
      url: 'https://example.com/a-hook',
      events: ['session.completed'],
    }),
  );
  const apiKey = track('apiKey', await create('/v1/api-keys', { name: 'a-key', scopes: ['read'] }));
  const agent = track('agent', await create('/v1/agent-sessions', {}));
  const snapshot = track(
    'snapshot',
    profile === '' ? '' : await create(`/v1/profiles/${profile}/snapshots`, { label: 'a-snap' }),
  );
  // 2026-08-15 — recipes were on the isolation census's unmentioned list: 70
  // customer-facing parameterised routes, 63 mentioned by some cross-account
  // test, 7 not. A recipe is a saved navigation flow lifted from a session's
  // intent log and transcript, so reading one back is reading what that browser
  // actually did.
  //
  // It is derived FROM an agent session, so it can only be created once `agent`
  // exists; the empty-string guard keeps a failed prerequisite from silently
  // becoming a skipped probe, and the created-families assertion below turns that
  // into a red instead.
  //
  // LEDGER — control 5/5:
  //
  //   getById stops scoping by account      2 red
  //   deleteById stops scoping by account   3 red
  //
  // The delete mutation reddens one arm the read mutation does not: the
  // byte-identity check on A's resources afterwards. That is the whole reason
  // this file re-reads everything at the end — a handler that deletes and THEN
  // fails to find a row to return answers 404 having already done the damage, so
  // the status alone would report the boundary held.
  const recipe = track(
    'recipe',
    agent === '' ? '' : await create('/v1/recipes', { agent_session_id: agent, label: 'a-recipe' }),
  );

  // Read-back routes for the resources whose integrity is checked at the end.
  if (webhook !== '') OWNED.push({ label: 'webhook', read: `/v1/webhooks/${webhook}` });
  if (profile !== '') OWNED.push({ label: 'profile', read: `/v1/profiles/${profile}` });
  if (session !== '') OWNED.push({ label: 'session', read: `/v1/sessions/${session}` });
  if (snapshot !== '') OWNED.push({ label: 'snapshot', read: `/v1/profile-snapshots/${snapshot}` });
  if (agent !== '') OWNED.push({ label: 'agent-session', read: `/v1/agent-sessions/${agent}` });
  if (recipe !== '') OWNED.push({ label: 'recipe', read: `/v1/recipes/${recipe}` });
  // API keys have no detail route; the list is what proves the key survived.
  OWNED.push({ label: 'api-key list', read: '/v1/api-keys' });

  for (const { label, read } of OWNED) {
    const res = await fx.app.inject({ method: 'GET', url: read, headers: aAuth });
    before.set(label, `${String(res.statusCode)} ${res.body}`);
  }

  const b = await seedAdditionalAccount(fx, {
    email: 'b@cross-family-isolation.test',
    tier: 'api_builder',
    scopes: ['read', 'write', 'account_owner'],
  });
  bToken = b.plaintext;
  const bAuth = { authorization: `Bearer ${bToken}` };

  // Every parameterised operation B could aim at A, including the destructive
  // ones. A valid body where the route needs one.
  const probes: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; body?: unknown }[] = [
    { method: 'GET', url: `/v1/webhooks/${webhook}` },
    { method: 'GET', url: `/v1/webhooks/${webhook}/deliveries` },
    { method: 'PATCH', url: `/v1/webhooks/${webhook}`, body: { description: 'taken over by B' } },
    { method: 'POST', url: `/v1/webhooks/${webhook}/rotate-secret`, body: {} },
    { method: 'POST', url: `/v1/webhooks/${webhook}/test`, body: {} },
    { method: 'DELETE', url: `/v1/webhooks/${webhook}` },
    { method: 'POST', url: `/v1/api-keys/${apiKey}/rotate`, body: {} },
    { method: 'DELETE', url: `/v1/api-keys/${apiKey}` },
    { method: 'GET', url: `/v1/profiles/${profile}` },
    { method: 'PATCH', url: `/v1/profiles/${profile}`, body: { name: 'b-took-it' } },
    { method: 'DELETE', url: `/v1/profiles/${profile}` },
    { method: 'GET', url: `/v1/sessions/${session}` },
    { method: 'DELETE', url: `/v1/sessions/${session}` },
    { method: 'GET', url: `/v1/profile-snapshots/${snapshot}` },
    { method: 'DELETE', url: `/v1/profile-snapshots/${snapshot}` },
    { method: 'GET', url: `/v1/agent-sessions/${agent}` },
    { method: 'DELETE', url: `/v1/agent-sessions/${agent}` },
    // A recipe is a saved navigation flow lifted from a session's intent log and
    // transcript, so reading one back is reading what that browser actually did.
    { method: 'GET', url: `/v1/recipes/${recipe}` },
    { method: 'DELETE', url: `/v1/recipes/${recipe}` },
  ];

  for (const p of probes) {
    if (p.url.includes('//v1') || p.url.endsWith('/')) continue; // a create failed
    const res = await fx.app.inject({
      method: p.method,
      url: p.url,
      headers: bAuth,
      ...(p.body === undefined ? {} : { payload: p.body as Record<string, unknown> }),
    });
    const op = `${p.method} ${p.url.replace(/\/[a-z]+_[0-9a-f-]+/g, '/:id')}`;
    attempts.push({ op, status: res.statusCode });

    // For an idempotent delete, ask the same question about an id that never
    // existed. If the two answers differ, the 204 IS an existence oracle and
    // the exemption above would be covering a real leak.
    if (IDEMPOTENT_DELETE.has(op)) {
      const absent = await fx.app.inject({
        method: p.method,
        url: p.url.replace(/_[0-9a-f-]+$/, '_00000000-0000-4000-8000-0000000000ff'),
        headers: bAuth,
      });
      indistinguishability.set(op, {
        foreign: fingerprint(res.statusCode, res.body),
        absent: fingerprint(absent.statusCode, absent.body),
      });
    }
  }

  for (const { label, read } of OWNED) {
    const res = await fx.app.inject({ method: 'GET', url: read, headers: aAuth });
    after.set(label, `${String(res.statusCode)} ${res.body}`);
  }
}, 180_000);

afterAll(async () => {
  await fx.app.close();
});

describe('no account can reach another account resource, in any creatable family', () => {
  it('CRITICAL every customer-creatable family is in the probe roster. The list below is written by hand, and nothing asked whether it still spans what the API lets a customer create — a new family would be absent from this sweep and from the six family-specific files, with no test saying so, on the one class of bug where a miss is another customer reading your data.', () => {
    const creates = collectionLevelCreates();
    expect(
      creates.length,
      'no collection-level POST /v1/<family> routes found — the scan stopped matching and this arm would pass over an empty set',
    ).toBeGreaterThan(5);

    const uncovered = creates
      .filter((c) => !c.staffOnly)
      .map((c) => c.path)
      .filter((p) => !PROBED_CREATES.includes(p))
      .sort();
    expect(
      uncovered,
      'customer-creatable famil(ies) no cross-account probe reaches — add them to the sweep or, if staff-only, record why:',
    ).toEqual([]);

    // Both directions: an entry naming a route that no longer exists exempts
    // nothing and reads as reviewed.
    const known = new Set(creates.map((c) => c.path));
    expect(
      [...PROBED_CREATES, ...Object.keys(STAFF_ONLY_CREATES)].filter((p) => !known.has(p)).sort(),
      'roster entr(ies) naming a create route that no longer exists:',
    ).toEqual([]);
  });

  it('CRITICAL both accounts and every resource were really created, and B holds a working credential of its own. Every assertion below reports an ABSENCE, so a sweep whose creates all failed — or whose second token was never issued — would pass having attempted nothing.', async () => {
    // EVERY family must have produced a real id. A failed create yields '' and
    // its probes are skipped, so the family silently leaves the sweep — and the
    // floors below cannot see it: losing snapshots costs 2 of 17 attempts and
    // one of six owned resources, which both floors still clear. Measured on
    // this very file: breaking the snapshot create left it reporting 5 of 5
    // green with that family entirely unprobed. The same defect was fixed in
    // no-response-leaks-a-credential one commit earlier and did not propagate
    // here on its own.
    expect(
      [...created.entries()]
        .filter(([, id]) => id === '')
        .map(([family]) => family)
        .sort(),
      'famil(ies) whose resource was never created — their cross-account probes never ran:',
    ).toEqual([]);

    expect(attempts.length, 'cross-account attempts made').toBeGreaterThanOrEqual(17);
    expect(OWNED.length, 'resources owned by A and re-read afterwards').toBeGreaterThanOrEqual(5);
    for (const [label, body] of before) {
      expect(body.startsWith('200'), `A could read its own ${label} before the sweep`).toBe(true);
    }
    // B's credential must actually work, or every 404 below is just an unusable
    // token being rejected and proves nothing about ownership.
    const bOwn = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${bToken}` },
    });
    expect(bOwn.statusCode, "B's own credential is valid and authorised").toBe(200);
  });

  it('CRITICAL not one cross-account attempt succeeded. A 2xx here is the resource itself crossing an account boundary — and for the two rotations it is worse than a read: a successor key or signing secret minted into the wrong hands, with the victim key invalidated.', () => {
    expect(
      attempts
        .filter((a) => !IDEMPOTENT_DELETE.has(a.op))
        .filter((a) => a.status >= 200 && a.status < 300)
        .map((a) => a.op),
      'operation(s) that served account B a resource belonging to account A:',
    ).toEqual([]);
  });

  it('CRITICAL every refusal is 404, never 403. A 403 confirms the resource exists, which turns a guessed id into an existence oracle — the policy cross-account-404-anti-enumeration states and, until now, checked on exactly one route.', () => {
    expect(
      attempts
        .filter((a) => !IDEMPOTENT_DELETE.has(a.op))
        .filter((a) => a.status !== 404)
        .map((a) => `${a.op} -> ${String(a.status)}`),
      'cross-account attempt(s) answering something other than 404:',
    ).toEqual([]);
  });

  it('CRITICAL each idempotent delete answers a foreign id EXACTLY as it answers an id that never existed. This is what makes its 204 safe: the caller learns nothing about whether the resource is real. If these ever diverge, the 204 becomes an existence oracle and excluding it from the 404 rule would be hiding a leak.', () => {
    expect(indistinguishability.size, 'idempotent deletes probed both ways').toBe(
      IDEMPOTENT_DELETE.size,
    );
    expect(
      [...indistinguishability.entries()]
        .filter(([, v]) => v.foreign !== v.absent)
        .map(([op, v]) => `${op}: foreign=${v.foreign} absent=${v.absent}`),
      'idempotent delete(s) whose answer reveals whether the resource exists:',
    ).toEqual([]);
  });

  it("CRITICAL A's resources are byte-identical after B's attempts. Status is not the property that matters: a handler that mutates and only then fails to find a row would answer 404 having already done the damage, and every assertion above would still pass.", () => {
    const changed: string[] = [];
    for (const [label, was] of before) {
      const now = after.get(label) ?? '<missing>';
      if (now !== was) changed.push(label);
    }
    expect(changed.sort(), "resource(s) of A altered by B's attempts:").toEqual([]);
  });
});
