// BillingResource — typed methods for /v1/billing (V-082).
//
// `getState` returns the current subscription mirror + trial-pack
// state. `createCheckoutSession` and `startTrialPack` return Stripe
// Checkout URLs the customer redirects to. `createPortalSession`
// returns a Stripe Customer Portal URL.

import type {
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
  CreatePortalSessionResponse,
  GetBillingStateResponse,
  StartTrialPackRequest,
  StartTrialPackResponse,
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

  startTrialPack(body: StartTrialPackRequest = {}): Promise<StartTrialPackResponse> {
    return this.http.request<StartTrialPackResponse>({
      method: 'POST',
      path: '/v1/billing/trial-pack',
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
