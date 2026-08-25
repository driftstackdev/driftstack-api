// W428.C (W646-deepened) — drift guard for packages/sdk-typescript/src/resources/billing.ts.
// V-082 BillingResource — subscription mirror + Stripe Checkout +
// Trial Pack + Customer Portal.
//
// W646 splits the 7 it() blocks (one per verb + framing) into 11
// focused per-concept blocks + pins previously-implicit invariants:
//
//   • 6-shape api-types import surface — CreateCheckoutSession Req/
//     Resp + CreatePortalSessionResponse + GetBillingStateResponse +
//     StartTrialPack Req/Resp. Drift to hand-rolled types would
//     diverge from the Zod single-source-of-truth.
//   • startTrialPack `body: StartTrialPackRequest = {}` default-empty
//     parameter — callers can write `billing.startTrialPack()` for
//     the no-options case, mirroring sdk-go's nil-body-default.
//   • createPortalSession no-body POST + account-scoped via bearer
//     token (never a body parameter; can never request another
//     account's portal URL).
//   • All POST verbs return Stripe redirect URLs the customer
//     redirects to (NOT direct charge). Customer-redirect-required
//     framing is load-bearing for the buyer journey.

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

  it('file exists at canonical path + module-level V-082 framing on /v1/billing', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/\/\/ BillingResource — typed methods for \/v1\/billing \(V-082\)\./);
  });

  it('Behavioural framing — getState mirror + Stripe Checkout/Portal redirect URLs (trial_pack flow retired 2026-05-27). CRITICAL: "createCheckoutSession returns a Stripe Checkout URL the customer redirects to" — drift to direct-charge semantics would change the buyer journey from redirect-to-Stripe to inline-payment, which would break PCI scope.', () => {
    expect(body).toMatch(/\/\/ `getState` returns the current subscription mirror\./);
    expect(body).toMatch(/`createCheckoutSession` returns a Stripe Checkout URL the customer/);
    expect(body).toMatch(/`createPortalSession` returns a Stripe Customer Portal/);
  });

  it('Imports — 4 api-types shapes (multi-line braced) + HttpClient. CRITICAL: 4-shape sorted-alphabetical import block (CreateCheckoutSessionRequest → CreateCheckoutSessionResponse → CreatePortalSessionResponse → GetBillingStateResponse; StartTrialPack* removed 2026-05-27). Drift to hand-rolled types in this file would diverge from @driftstack/api-types Zod single-source-of-truth.', () => {
    expect(body).toMatch(
      /import type \{\s*CreateCheckoutSessionRequest,\s*CreateCheckoutSessionResponse,\s*CreatePortalSessionResponse,\s*GetBillingStateResponse,\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
  });

  it('BillingResource class shape — single private-readonly http constructor field. Stateless wrapper pattern shared with every other TS SDK resource.', () => {
    expect(body).toMatch(/^export class BillingResource \{$/m);
    expect(body).toMatch(/constructor\(private readonly http: HttpClient\) \{\}/);
  });

  it('getState — GET /v1/billing returns the current-account subscription mirror + trial-pack state. Stripe-of-record snapshot the dashboard uses to render plan / usage state without round-tripping to Stripe on every render.', () => {
    expect(body).toMatch(
      /getState\(\): Promise<GetBillingStateResponse> \{\s*return this\.http\.request<GetBillingStateResponse>\(\{\s*method: 'GET',\s*path: '\/v1\/billing',\s*\}\);\s*\}/,
    );
  });

  it('createCheckoutSession — POST /v1/billing/checkout-session returns a Stripe Checkout URL for a tier subscription. Customer-redirect-required: the response carries a URL the customer browser navigates to; the SDK does NOT perform the charge inline. CreateCheckoutSessionRequest body type pinned (drift to `any` would lose static checking on the tier + billing_period fields).', () => {
    expect(body).toMatch(
      /createCheckoutSession\(\s*body: CreateCheckoutSessionRequest,\s*\): Promise<CreateCheckoutSessionResponse> \{\s*return this\.http\.request<CreateCheckoutSessionResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/billing\/checkout-session',\s*body,\s*\}\);\s*\}/,
    );
  });

  it("createPortalSession — POST /v1/billing/portal-session with NO body parameter at all. Account identity comes from the bearer token, never a body field, so customers can never request a portal URL for someone else's account. Drift to accepting a body parameter (even an optional one) would silently widen the auth surface.", () => {
    expect(body).toMatch(
      /createPortalSession\(\): Promise<CreatePortalSessionResponse> \{\s*return this\.http\.request<CreatePortalSessionResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/billing\/portal-session',\s*\}\);\s*\}/,
    );
  });

  it('3-verb wire-path inventory pinned: 1× GET /v1/billing + 2× POST under /v1/billing/{checkout-session,portal-session} (trial-pack retired 2026-05-27). Drift to a 4th verb on the resource without test coverage would let an untested code path ship.', () => {
    expect(body).toMatch(/path: '\/v1\/billing'/);
    expect(body).toMatch(/path: '\/v1\/billing\/checkout-session'/);
    expect(body).toMatch(/path: '\/v1\/billing\/portal-session'/);
    // Exactly 3 distinct /v1/billing paths.
    const paths = [...body.matchAll(/'\/v1\/billing(?:\/[a-z-]+)?'/g)].map((m) => m[0]);
    expect(new Set(paths).size, 'expected exactly 3 distinct /v1/billing paths').toBe(3);
  });

  it('Method-verb pairing per-route pinned: getState→GET billing root; createCheckoutSession→POST checkout-session; createPortalSession→POST portal-session. Drift to flipping a verb (e.g. GET portal-session) would diverge from the action-side-effecting POST contract for Stripe Checkout creation.', () => {
    // GET appears exactly once (getState).
    const gets = body.match(/method: 'GET'/g) ?? [];
    expect(gets.length, 'expected exactly 1 GET verb (getState)').toBe(1);
    // POST appears exactly 2 times (the 2 Stripe-creating verbs).
    const posts = body.match(/method: 'POST'/g) ?? [];
    expect(posts.length, 'expected exactly 2 POST verbs').toBe(2);
  });
});
