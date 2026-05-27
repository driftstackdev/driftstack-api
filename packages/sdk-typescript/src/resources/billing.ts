// BillingResource — typed methods for /v1/billing (V-082).
//
// `getState` returns the current subscription mirror.
// `createCheckoutSession` returns a Stripe Checkout URL the customer
// redirects to. `createPortalSession` returns a Stripe Customer Portal
// URL. (The one-time trial_pack flow was retired 2026-05-27.)

import type {
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
  CreatePortalSessionResponse,
  GetBillingStateResponse,
} from '@driftstack/api-types';
import type { HttpClient } from '../http.js';

export class BillingResource {
  constructor(private readonly http: HttpClient) {}

  getState(): Promise<GetBillingStateResponse> {
    return this.http.request<GetBillingStateResponse>({
      method: 'GET',
      path: '/v1/billing',
    });
  }

  createCheckoutSession(
    body: CreateCheckoutSessionRequest,
  ): Promise<CreateCheckoutSessionResponse> {
    return this.http.request<CreateCheckoutSessionResponse>({
      method: 'POST',
      path: '/v1/billing/checkout-session',
      body,
    });
  }

  createPortalSession(): Promise<CreatePortalSessionResponse> {
    return this.http.request<CreatePortalSessionResponse>({
      method: 'POST',
      path: '/v1/billing/portal-session',
    });
  }
}
