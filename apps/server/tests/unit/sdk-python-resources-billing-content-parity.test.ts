// W583.C (W641-deepened) — drift guard for packages/sdk-python/src/driftstack/resources/billing.py.
// V-082 BillingResource Python parity.
//
// W641 splits the 4 it() blocks (2 of which crammed all sync verbs
// and all async verbs into one) into 11 focused per-concept blocks +
// pins previously-implicit invariants:
//
//   • Sync + async parallel surface invariant — every sync verb has
//     a matching `async def`-prefixed twin with identical wire path,
//     same coerce_body wiring, same return shape. Drift here would
//     diverge sync/async customers off the same wire contract.
//   • coerce_body call-site invariant — both POST verbs that take a
//     body wrap it in coerce_body() so the Python SDK's pydantic-vs-
//     dict polymorphism stays transparent to callers.
//   • start_trial_pack nil-body-default substitution (`body or {}`)
//     mirrors the sdk-go &StartTrialPackRequest{} pattern.
//   • create_portal_session takes NO body (calling account identity
//     comes from the bearer; customers can never request a portal
//     URL for another account).
//   • ADR-003 $2.99 pricing reference + Stripe Customer Portal
//     framing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/billing.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W583.C packages/sdk-python/src/driftstack/resources/billing.py content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module docstring + V-082 framing + dict[str, Any] typing-pending-regen comment + imports (HttpClient + AsyncHttpClient + coerce_body)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^"""Billing resource — \/v1\/billing \(V-082\)\.\n/);
    expect(body).toMatch(/``dict\[str, Any\]`` typing pending the next regen pass\./);
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/from driftstack\.http import AsyncHttpClient, HttpClient/);
    expect(body).toMatch(/from driftstack\.resources\._common import coerce_body/);
  });

  it('BillingResource sync class with HttpClient injection (Python idiom: __init__ takes the transport so the resource module stays transport-agnostic and tests can pass a fake)', () => {
    expect(body).toMatch(/^class BillingResource:$/m);
    expect(body).toMatch(/"""Synchronous billing resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('get_state (sync) — GET /v1/billing returns the current subscription mirror + trial-pack state. Docstring framing pinned because "subscription mirror" is what tells dashboards this is a Stripe-of-record snapshot, not a live Stripe API passthrough.', () => {
    expect(body).toMatch(
      /def get_state\(self\) -> dict\[str, Any\]:\s*\n\s*"""Current subscription mirror \+ trial-pack state\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/billing"\)/,
    );
  });

  it('create_checkout_session (sync) — POST /v1/billing/checkout-session with 4-field body shape pinned: tier (required) + billing_period "monthly"|"annual" (required) + optional success_url + optional cancel_url. coerce_body wrapping. The billing_period enum closed-list invariant is load-bearing for the Stripe pricing-lookup on the server side.', () => {
    expect(body).toMatch(
      /def create_checkout_session\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/"""Start a paid-tier subscription Checkout session\./);
    expect(body).toMatch(
      /Body shape: ``\{"tier": "\.\.\.", "billing_period": "monthly"\|"annual",/,
    );
    expect(body).toMatch(/"success_url"\?: \.\.\., "cancel_url"\?: \.\.\.\}``\./);
    expect(body).toMatch(
      /"POST", "\/v1\/billing\/checkout-session", json_body=coerce_body\(body\)/,
    );
  });

  it('start_trial_pack (sync) — POST /v1/billing/trial-pack with ADR-003 $2.99 one-time purchase. Nil-body-default substitution (`body or {}`) — callers can pass None and the SDK plugs an empty dict so the wire body is "{}", not Python\'s null. Mirrors the sdk-go &StartTrialPackRequest{} pattern.', () => {
    expect(body).toMatch(
      /def start_trial_pack\(self, body: dict\[str, Any\] \| None = None\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/"""Start the \$2\.99 trial-pack one-time purchase \(per ADR-003\)\."""/);
    expect(body).toMatch(
      /"POST", "\/v1\/billing\/trial-pack", json_body=coerce_body\(body or \{\}\)/,
    );
  });

  it('create_portal_session (sync) — POST /v1/billing/portal-session with NO body. Calling-account identity comes from the bearer token, never a parameter, so customers can never request a portal URL for another account. Drift to accepting a body would silently widen the auth surface.', () => {
    expect(body).toMatch(/def create_portal_session\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""Open a Stripe Customer Portal session for the calling account\."""/);
    expect(body).toMatch(/return self\._http\.request\("POST", "\/v1\/billing\/portal-session"\)/);
  });

  it('AsyncBillingResource — class shell + AsyncHttpClient injection. Same docstring "Async billing resource." + parallel __init__ structure as sync class.', () => {
    expect(body).toMatch(/^class AsyncBillingResource:$/m);
    expect(body).toMatch(/"""Async billing resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('Async get_state — awaited GET /v1/billing twin of sync get_state. Same wire path, same return shape; the `async def` + `await self._http.request(...)` pattern keeps sync/async customers on the same contract.', () => {
    expect(body).toMatch(
      /async def get_state\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/billing"\)/,
    );
  });

  it('Async create_checkout_session + start_trial_pack — awaited POST twins with same coerce_body wrapping + same paths. Drift here would diverge sync/async customers off the same wire contract.', () => {
    expect(body).toMatch(
      /async def create_checkout_session\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\(\s*\n\s*"POST", "\/v1\/billing\/checkout-session", json_body=coerce_body\(body\)\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /async def start_trial_pack\(self, body: dict\[str, Any\] \| None = None\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\(\s*\n\s*"POST", "\/v1\/billing\/trial-pack", json_body=coerce_body\(body or \{\}\)\s*\n\s*\)/,
    );
  });

  it("Async create_portal_session — awaited POST twin with no body. Same auth-scope invariant (calling-account from bearer, never a parameter) so async customers can't request another account's portal URL either.", () => {
    expect(body).toMatch(
      /async def create_portal_session\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("POST", "\/v1\/billing\/portal-session"\)/,
    );
  });
});
