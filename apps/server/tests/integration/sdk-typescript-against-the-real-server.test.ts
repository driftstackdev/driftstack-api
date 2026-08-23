// The published TypeScript SDK, driven over real HTTP against the real server.
//
// Nothing did this before. The SDK has 22 test files and every one of them
// mocks fetch; the ~200 cross-SDK parity tests pin SOURCE TEXT; and no e2e spec
// constructs the client. So the package customers `npm install` had never once
// spoken to the API it wraps.
//
// That is a specific blind spot, not a general one. A mocked test asserts the
// SDK sends what the test author believed the server wants. It cannot catch the
// SDK and the server disagreeing — a path the server does not route, an auth
// header it does not read, a response envelope the SDK unwraps at the wrong
// level. Every one of those passes 22 mocked suites and fails on the customer's
// first call.
//
// The envelope case is not hypothetical: both list responses here key their rows
// under `data`, and an SDK reading `items` would return undefined against a
// perfectly healthy server. Only a real round-trip can tell those apart.
//
// Imported by PACKAGE NAME rather than from src/, so this exercises the built
// artifact from dist/ — the bytes customers actually get. If the SDK is not
// built, this fails loudly, which is the correct outcome: an unbuilt SDK is
// exactly what would ship broken.

import type { AddressInfo } from 'node:net';
import { Driftstack, FeatureUnavailableError } from '@driftstack/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let sdk: Driftstack;
let baseUrl: string;

beforeAll(async () => {
  fx = await buildTestApp({ scopes: ['read', 'write', 'account_owner'] });
  // A real listener, not app.inject(): the point is to exercise the SDK's own
  // fetch, URL building and header assembly, none of which inject() touches.
  await fx.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = fx.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  sdk = new Driftstack({ apiKey: fx.plaintext, baseUrl });
});

afterAll(async () => {
  await fx.app.close();
});

describe('the published SDK works against the real server', () => {
  it('CRITICAL authenticates on an AUTHED route. The SDK assembles its own Authorization header, and no mocked test can prove the server reads the header the SDK actually sends.', async () => {
    const me = await sdk.account.me();
    expect(me, 'account.me() returns a profile').toBeDefined();
    // The wire id is the PREFIXED public form (`acc_<uuid>`), not the bare row
    // id. Asserted by containment rather than equality so this pins the thing
    // that matters — the key resolved to the RIGHT account — without also
    // freezing the prefix convention, which is not this test's subject.
    expect(me.id, 'the profile carries the account the key belongs to').toContain(fx.accountId);
  });

  it('CRITICAL a rejected key is surfaced as an error rather than parsed as success. Asserted against an AUTHED route on purpose — /v1/archetypes is deliberately public, so a bogus key resolves there and would have proved nothing.', async () => {
    const wrong = new Driftstack({ apiKey: 'ds_live_definitely_not_a_real_key', baseUrl });
    await expect(wrong.account.me()).rejects.toThrow();
  });

  it('CRITICAL unwraps the paginated envelope at the level the server actually sends it. The rows live under `data`; an SDK reading `items` would hand the customer undefined from a healthy 200.', async () => {
    const page = await sdk.sessions.list();
    expect(Array.isArray(page.data), 'rows come back under `data`').toBe(true);
    expect(typeof page.has_more, 'the envelope carries has_more').toBe('boolean');
    expect(page, 'the envelope carries a cursor field').toHaveProperty('next_cursor');
  });

  it('CRITICAL parses the public archetype catalogue, envelope and all', async () => {
    const catalogue = await sdk.archetypes.list();
    expect(Array.isArray(catalogue.data), 'archetypes come back under `data`').toBe(true);
    expect(catalogue.data.length, 'the roster is non-empty').toBeGreaterThan(0);
    expect(catalogue.default_archetype_id, 'a default is named').toBeTruthy();
  });

  it('CRITICAL unwraps the PROFILES page — the resource customers reach for first. The envelope arm above proves the shape on one listing; this proves the SDK applies it to the listing most customers call, because `data` versus `items` is a per-resource mistake, not a global one.', async () => {
    const page = await sdk.profiles.list();
    expect(Array.isArray(page.data), 'profile rows come back under `data`').toBe(true);
    expect(typeof page.has_more, 'the envelope carries has_more').toBe('boolean');
    expect(page, 'the envelope carries a cursor field').toHaveProperty('next_cursor');
  });

  it('CRITICAL parses the usage SERIES, whose envelope is NOT the paginated one. Every other list here keys its rows under `data`; this response keys them under `buckets` and carries `from_date`/`to_date` instead of a cursor. An SDK that applied the pagination shape to it would hand the customer undefined for their billing chart from a perfectly healthy 200 — the exact failure this file exists to catch, in the one response where the shape differs.', async () => {
    const series = await sdk.usage.series({ days: 7 });
    expect(Array.isArray(series.buckets), 'daily rows come back under `buckets`').toBe(true);
    expect(series, 'the window start is surfaced').toHaveProperty('from_date');
    expect(series, 'the window end is surfaced').toHaveProperty('to_date');
    expect(series, 'the paginated envelope is NOT what this endpoint returns').not.toHaveProperty(
      'has_more',
    );
  });

  it('CRITICAL parses the current-period usage summary, totals and quotas included. `totals` and `quotas` are records keyed by record type rather than arrays, so an SDK that treated either as a list would read length undefined off an object and report zero usage against a real bill.', async () => {
    const summary = await sdk.usage.current();
    expect(summary, 'the period start is surfaced').toHaveProperty('period_start');
    expect(summary, 'the period end is surfaced').toHaveProperty('period_end');
    expect(
      Array.isArray(summary.totals),
      'totals is a RECORD keyed by record type, not a list',
    ).toBe(false);
    expect(
      Array.isArray(summary.quotas),
      'quotas is a RECORD keyed by record type, not a list',
    ).toBe(false);
    expect(typeof summary.totals, 'totals is an object').toBe('object');
    expect(typeof summary.quotas, 'quotas is an object').toBe('object');
    expect(summary.tier, 'the summary names the tier it priced against').toBeTruthy();
  });

  it("CRITICAL a route the deployment has switched OFF surfaces as the SDK's typed FeatureUnavailableError, not a parse failure. This app registers the recipes disabled-stub, so the 503 and its problem type are real rather than a mocked body — and the mapping from `https://errors.driftstack.dev/feature-unavailable` to the exported class is what makes the documented recovery path reachable. A customer catching that class on a deployment without recipes is the whole point; a raw parse error would miss every one of them.", async () => {
    await expect(sdk.recipes.list()).rejects.toBeInstanceOf(FeatureUnavailableError);
  });

  it('CRITICAL reads the webhook endpoint list, which is a BARE data list — the third envelope shape in this API. It carries no has_more and no next_cursor at all, so a customer looping until has_more goes false reads undefined on the first pass. That is correct by accident here, and would be wrong the day this route learns to paginate; pinning the shape is what makes that day visible.', async () => {
    const list = await sdk.webhooks.list();
    expect(Array.isArray(list.data), 'endpoints come back under `data`').toBe(true);
    expect(list, 'this listing does NOT carry the paginated has_more').not.toHaveProperty(
      'has_more',
    );
    expect(list, 'nor a cursor').not.toHaveProperty('next_cursor');
  });

  it('CRITICAL round-trips a PROFILE write and reads it back through the SDK that made it. Profiles are the resource customers create first, and its create response is built by its own route — the api-keys write above proves nothing about this one.', async () => {
    const created = await sdk.profiles.create({ name: 'sdk-write-probe' });
    expect(created.id, 'the created profile has an id').toBeTruthy();
    expect(created.name, 'and the name the caller sent came back').toBe('sdk-write-probe');

    const page = await sdk.profiles.list();
    expect(
      page.data.some((p) => p.id === created.id),
      'the profile the SDK created is visible through the SDK that listed it',
    ).toBe(true);
  });

  it('CRITICAL a webhook create surfaces the signing secret, which is returned ONCE and never again. This is the webhook analogue of the api-key plaintext: an SDK that dropped or renamed it hands the customer an endpoint whose deliveries they can never verify, and no retry recovers it because the server does not store it back. The endpoint is created successfully either way, so nothing else in the system would report the loss.', async () => {
    const created = await sdk.webhooks.create({
      url: 'https://hooks.test.local/sdk-write-probe',
      events: ['session.completed'],
    });
    expect(created.id, 'the created endpoint has an id').toBeTruthy();
    expect(typeof created.secret, 'the one-time signing secret is surfaced').toBe('string');
    expect(created.secret.length, 'and it is a real secret, not an empty string').toBeGreaterThan(
      20,
    );

    const list = await sdk.webhooks.list();
    expect(
      list.data.some((w) => w.id === created.id),
      'the endpoint the SDK created is visible through the SDK that listed it',
    ).toBe(true);
  });

  it('CRITICAL round-trips a WRITE through the SDK and reads it back. A create the server accepts but the SDK cannot parse looks identical to a failure from the caller.', async () => {
    const created = await sdk.apiKeys.create({ name: 'sdk-integration-probe', scopes: ['read'] });
    expect(created.id, 'the created key has an id').toBeTruthy();
    // Surfaced exactly once, on create, under `plaintext`. This is the single
    // highest-consequence field in the SDK: it is unrecoverable after this
    // response, so an SDK that dropped or renamed it would hand the customer a
    // key they can never use and no retry could recover.
    expect(typeof created.plaintext, 'the one-time plaintext is surfaced').toBe('string');
    expect(created.plaintext.length, 'and it is a real key, not an empty string').toBeGreaterThan(
      20,
    );

    const listed = await sdk.apiKeys.list();
    expect(
      listed.data.some((k) => k.id === created.id),
      'the key the SDK created is visible through the SDK that listed it',
    ).toBe(true);
  });
});
