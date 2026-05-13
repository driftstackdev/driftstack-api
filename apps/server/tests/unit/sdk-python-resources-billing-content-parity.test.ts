// W583.C — drift guard for packages/sdk-python/src/resources/billing.py.
// V-082 BillingResource Python parity. Drift here either drops a
// /v1/billing verb, leaks Stripe Customer Portal posture, or
// breaks the ADR-003 $2.99 trial-pack pricing reference.
//
//   • 4 verbs each: get_state / create_checkout_session /
//     start_trial_pack / create_portal_session.
//   • get_state(): current subscription mirror + trial-pack state.
//   • create_checkout_session(): tier + billing_period
//     (monthly|annual) + optional success_url/cancel_url.
//   • start_trial_pack(): ADR-003 $2.99 one-time purchase.
//   • create_portal_session(): Stripe Customer Portal handoff.

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

  it('Module docstring + V-082 framing + dict[str, Any]-pending-regen pinned', () => {
    expect(body).toMatch(/^"""Billing resource — \/v1\/billing \(V-082\)\.\n/);
    expect(body).toMatch(/``dict\[str, Any\]`` typing pending the next regen pass\./);
  });

  it('Sync BillingResource: 4 verbs — get_state (subscription mirror + trial-pack) + create_checkout_session (tier + billing_period + optional success/cancel URLs) + start_trial_pack (ADR-003 $2.99) + create_portal_session (Stripe Customer Portal)', () => {
    expect(body).toMatch(/^class BillingResource:$/m);
    expect(body).toMatch(
      /def get_state\(self\) -> dict\[str, Any\]:\s*\n\s*"""Current subscription mirror \+ trial-pack state\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/billing"\)/,
    );
    expect(body).toMatch(/def create_checkout_session\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(/"""Start a paid-tier subscription Checkout session\./);
    expect(body).toMatch(
      /Body shape: ``\{"tier": "\.\.\.", "billing_period": "monthly"\|"annual",/,
    );
    expect(body).toMatch(/"success_url"\?: \.\.\., "cancel_url"\?: \.\.\.\}``\./);
    expect(body).toMatch(
      /"POST", "\/v1\/billing\/checkout-session", json_body=coerce_body\(body\)/,
    );
    expect(body).toMatch(
      /def start_trial_pack\(self, body: dict\[str, Any\] \| None = None\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/"""Start the \$2\.99 trial-pack one-time purchase \(per ADR-003\)\."""/);
    expect(body).toMatch(
      /"POST", "\/v1\/billing\/trial-pack", json_body=coerce_body\(body or \{\}\)/,
    );
    expect(body).toMatch(/def create_portal_session\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""Open a Stripe Customer Portal session for the calling account\."""/);
    expect(body).toMatch(/return self\._http\.request\("POST", "\/v1\/billing\/portal-session"\)/);
  });

  it('Async AsyncBillingResource: mirrored awaited 4-verb surface (no portal-session body — pure POST)', () => {
    expect(body).toMatch(/^class AsyncBillingResource:$/m);
    expect(body).toMatch(
      /async def get_state\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/billing"\)/,
    );
    expect(body).toMatch(
      /async def create_checkout_session\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\(\s*\n\s*"POST", "\/v1\/billing\/checkout-session", json_body=coerce_body\(body\)\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /async def start_trial_pack\(self, body: dict\[str, Any\] \| None = None\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\(\s*\n\s*"POST", "\/v1\/billing\/trial-pack", json_body=coerce_body\(body or \{\}\)\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /async def create_portal_session\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("POST", "\/v1\/billing\/portal-session"\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
