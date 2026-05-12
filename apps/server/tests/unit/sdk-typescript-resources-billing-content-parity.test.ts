// W428.C — drift guard for packages/sdk-typescript/src/resources/billing.ts.
// V-082 BillingResource — subscription mirror + Stripe Checkout +
// Trial Pack + Customer Portal. Drift here either breaks the trial-
// pack POST (signup flow blocked) or strips a Stripe redirect URL
// (customers can't upgrade or manage billing).
//
//   • Framing pinned: V-082 typed methods for /v1/billing.
//   • Resource behavior pinned: getState returns subscription mirror
//     + trial-pack state; createCheckoutSession + startTrialPack
//     return Stripe Checkout URLs to redirect to;
//     createPortalSession returns Stripe Customer Portal URL.
//   • 4 verbs: getState (GET) + createCheckoutSession (POST) +
//     startTrialPack (POST, default {}) + createPortalSession
//     (POST no body).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/billing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W428.C packages/sdk-typescript/src/resources/billing.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: V-082 typed methods for /v1/billing + getState mirror behavior + Stripe Checkout / Portal redirect URLs', () => {
    expect(body).toMatch(/\/\/ BillingResource — typed methods for \/v1\/billing \(V-082\)\./);
    expect(body).toMatch(
      /\/\/ `getState` returns the current subscription mirror \+ trial-pack\s*\n?\s*\/\/ state\. `createCheckoutSession` and `startTrialPack` return Stripe\s*\n?\s*\/\/ Checkout URLs the customer redirects to\. `createPortalSession`\s*\n?\s*\/\/ returns a Stripe Customer Portal URL\./,
    );
  });

  it('imports: 6 api-types shapes (CreateCheckoutSessionRequest/Response + CreatePortalSessionResponse + GetBillingStateResponse + StartTrialPackRequest/Response) + HttpClient', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*CreateCheckoutSessionRequest,\s*\n?\s*CreateCheckoutSessionResponse,\s*\n?\s*CreatePortalSessionResponse,\s*\n?\s*GetBillingStateResponse,\s*\n?\s*StartTrialPackRequest,\s*\n?\s*StartTrialPackResponse,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
  });

  it('getState verb: GET /v1/billing → GetBillingStateResponse (subscription mirror + trial-pack state)', () => {
    expect(body).toMatch(
      /getState\(\): Promise<GetBillingStateResponse> \{\s*\n?\s*return this\.http\.request<GetBillingStateResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/billing',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('createCheckoutSession verb: POST /v1/billing/checkout-session → CreateCheckoutSessionResponse (Stripe Checkout URL)', () => {
    expect(body).toMatch(
      /createCheckoutSession\(\s*\n?\s*body: CreateCheckoutSessionRequest,\s*\n?\s*\): Promise<CreateCheckoutSessionResponse> \{\s*\n?\s*return this\.http\.request<CreateCheckoutSessionResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/billing\/checkout-session',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('startTrialPack verb: POST /v1/billing/trial-pack; default {} body when omitted', () => {
    expect(body).toMatch(
      /startTrialPack\(body: StartTrialPackRequest = \{\}\): Promise<StartTrialPackResponse> \{\s*\n?\s*return this\.http\.request<StartTrialPackResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/billing\/trial-pack',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('createPortalSession verb: POST /v1/billing/portal-session; no body (Stripe Customer Portal URL)', () => {
    expect(body).toMatch(
      /createPortalSession\(\): Promise<CreatePortalSessionResponse> \{\s*\n?\s*return this\.http\.request<CreatePortalSessionResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/billing\/portal-session',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
