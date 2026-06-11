// V-130: Shared scenario fixtures for integration tests.
//
// Layered on top of `buildTestApp` — that helper already gives us an
// authenticated account + API key. These functions add the "with N
// profiles / sessions / webhooks / subscription" shapes that tests
// currently inline as `for (let i = 0; i < N; i++)` loops or one-off
// repo calls.
//
// Tight scope per founder direction (V-130): only the patterns
// actually duplicated in current tests. Don't speculatively expand.

import type { AccountTier } from '@driftstack/api-types';
import type { TestAppFixture } from './build-test-app.js';

// ── Profiles ─────────────────────────────────────────────────────────

export interface SeededProfile {
  id: string;
  name: string;
  archetype: string;
}

export interface SeedProfilesOpts {
  /** Per-profile name overrides; length must equal `count` if supplied. */
  names?: readonly string[];
  /** Archetype applied to every seeded profile. Default `'iphone17_ios18_7_safari26_4'`. */
  archetype?: string;
  /** Optional description applied to every profile. */
  description?: string;
}

/**
 * Seed `count` profiles for the fixture's authenticated account by
 * driving `POST /v1/profiles`. Returns the profile IDs + names in
 * insertion order.
 *
 * Goes through the HTTP layer (not direct repo writes) so tests get
 * end-to-end-validated state — same audit logging, same tier checks,
 * same shape that production traffic would create.
 */
export async function seedProfiles(
  fx: TestAppFixture,
  count: number,
  opts: SeedProfilesOpts = {},
): Promise<SeededProfile[]> {
  if (opts.names !== undefined && opts.names.length !== count) {
    throw new Error(
      `seedProfiles: names.length (${opts.names.length.toString()}) must equal count (${count.toString()})`,
    );
  }
  const out: SeededProfile[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = opts.names?.[i] ?? `profile_${i.toString()}`;
    const payload: Record<string, unknown> = { name };
    if (opts.description !== undefined) payload.description = opts.description;
    if (opts.archetype !== undefined) payload.archetype = opts.archetype;
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload,
    });
    // POST /v1/profiles returns 200 (not 201) — the route returns the
    // created profile but doesn't set a Location header, so it's treated
    // as a successful read of newly-created state rather than RFC 7231
    // 201 Created semantics.
    if (res.statusCode !== 200) {
      throw new Error(
        `seedProfiles: POST /v1/profiles returned ${res.statusCode.toString()}: ${res.body}`,
      );
    }
    const body = res.json<{ id: string; name: string; archetype: string }>();
    out.push({ id: body.id, name: body.name, archetype: body.archetype });
  }
  return out;
}

// ── Sessions ─────────────────────────────────────────────────────────

export interface SeededSession {
  id: string;
  label: string | null;
  archetype: string;
}

export interface SeedSessionsOpts {
  /** Per-session label overrides; length must equal `count` if supplied. */
  labels?: readonly string[];
  /** Archetype applied to every seeded session. */
  archetype?: string;
}

/**
 * Seed `count` sessions for the fixture's authenticated account.
 * Goes through `POST /v1/sessions`, picking up any tier-default
 * archetype + concurrency check. Caller is responsible for ensuring
 * the fixture's tier supports `count` concurrent sessions.
 */
export async function seedSessions(
  fx: TestAppFixture,
  count: number,
  opts: SeedSessionsOpts = {},
): Promise<SeededSession[]> {
  if (opts.labels !== undefined && opts.labels.length !== count) {
    throw new Error(
      `seedSessions: labels.length (${opts.labels.length.toString()}) must equal count (${count.toString()})`,
    );
  }
  const out: SeededSession[] = [];
  for (let i = 0; i < count; i += 1) {
    const payload: Record<string, unknown> = {};
    if (opts.labels?.[i] !== undefined) payload.label = opts.labels[i];
    if (opts.archetype !== undefined) payload.archetype = opts.archetype;
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload,
    });
    if (res.statusCode !== 201) {
      throw new Error(
        `seedSessions: POST /v1/sessions returned ${res.statusCode.toString()}: ${res.body}`,
      );
    }
    const body = res.json<{ id: string; label: string | null; archetype: string }>();
    out.push({ id: body.id, label: body.label, archetype: body.archetype });
  }
  return out;
}

// ── Webhook endpoints ─────────────────────────────────────────────────

export interface SeededWebhook {
  id: string;
  url: string;
  /** Plaintext signing secret (returned only once on create). */
  secret: string;
}

export interface SeedWebhookEndpointsOpts {
  /** Per-endpoint URL overrides. */
  urls?: readonly string[];
  /** Event subscription applied to every seeded endpoint. */
  events?: readonly string[];
}

/**
 * Seed `count` webhook endpoints via `POST /v1/webhooks`. Requires the
 * `admin` scope on the fixture's API key — pass `{ scopes: ['read', 'write', 'admin'] }`
 * to `buildTestApp` if the default scope set lacks admin.
 */
export async function seedWebhookEndpoints(
  fx: TestAppFixture,
  count: number,
  opts: SeedWebhookEndpointsOpts = {},
): Promise<SeededWebhook[]> {
  if (opts.urls !== undefined && opts.urls.length !== count) {
    throw new Error(
      `seedWebhookEndpoints: urls.length (${opts.urls.length.toString()}) must equal count (${count.toString()})`,
    );
  }
  const events = opts.events ?? ['session.completed'];
  const out: SeededWebhook[] = [];
  for (let i = 0; i < count; i += 1) {
    const url = opts.urls?.[i] ?? `https://hooks.example.test/wh_${i.toString()}`;
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { url, events: [...events] },
    });
    if (res.statusCode !== 201) {
      throw new Error(
        `seedWebhookEndpoints: POST /v1/webhooks returned ${res.statusCode.toString()}: ${res.body}`,
      );
    }
    const body = res.json<{ id: string; url: string; secret: string }>();
    out.push({ id: body.id, url: body.url, secret: body.secret });
  }
  return out;
}

// ── Active subscription ───────────────────────────────────────────────

export interface SeedSubscriptionOpts {
  tier?: AccountTier;
  /** Stripe-mirror subscription status. Default `'active'`. */
  status?:
    | 'incomplete'
    | 'incomplete_expired'
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'unpaid'
    | 'paused';
  stripeSubscriptionId?: string;
  stripePriceId?: string;
  /** Subscription record id. */
  id?: string;
}

/**
 * Mirror an active Stripe subscription onto the fixture's billing
 * repo without going through Stripe. Used by tests that need a
 * subscription record present without exercising the
 * checkout-session flow end to end.
 *
 * Direct-repo write rather than HTTP: there's no public endpoint for
 * "create my subscription" — production subscriptions land via the
 * Stripe webhook handler. This helper short-circuits to the same
 * post-condition.
 */
export function seedActiveSubscription(
  fx: TestAppFixture,
  opts: SeedSubscriptionOpts = {},
): { id: string; tier: AccountTier; status: string } {
  const id = opts.id ?? `sub_${fx.accountId.slice(-8)}`;
  const tier = opts.tier ?? 'api_builder';
  const status = opts.status ?? 'active';
  const stripeSubscriptionId = opts.stripeSubscriptionId ?? `sub_test_${id}`;
  const stripePriceId = opts.stripePriceId ?? `price_${tier}_monthly`;
  fx.billingRepo.upsertSubscription({
    id,
    accountId: fx.accountId,
    stripeSubscriptionId,
    stripePriceId,
    tier,
    status,
    currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-01T00:00:00Z'),
  });
  return { id, tier, status };
}
