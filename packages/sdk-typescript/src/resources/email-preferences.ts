// EmailPreferencesResource — typed methods for /v1/account/email-preferences (V-204).
//
// Per-event opt-in/opt-out toggles for non-critical customer emails
// (signup-welcome, session-failed-first, billing-receipt, etc).
// Critical emails — signup-verification, password-reset,
// billing-failure, subscription-cancellation, support-ack — are
// never opt-outable; they're absent from the OptOutableEmailEvent
// enum on purpose so the API surface matches the policy.

import type {
  EmailPreference,
  ListEmailPreferencesResponse,
  OptOutableEmailEvent,
  SetEmailPreferenceRequest,
} from '@driftstack/api-types';
import type { HttpClient } from '../http.js';

export class EmailPreferencesResource {
  constructor(private readonly http: HttpClient) {}

  /** Read all opt-out toggles for the calling account. Defaults to opted-in for unset rows. */
  list(): Promise<ListEmailPreferencesResponse> {
    return this.http.request<ListEmailPreferencesResponse>({
      method: 'GET',
      path: '/v1/account/email-preferences',
    });
  }

  /** Set opt-in/opt-out for a single email event type. */
  set(body: SetEmailPreferenceRequest): Promise<EmailPreference> {
    return this.http.request<EmailPreference>({
      method: 'PUT',
      path: '/v1/account/email-preferences',
      body,
    });
  }

  /** Convenience: opt out of a single event type. */
  optOut(eventType: OptOutableEmailEvent): Promise<EmailPreference> {
    return this.set({ event_type: eventType, opted_in: false });
  }

  /** Convenience: opt back in to a single event type. */
  optIn(eventType: OptOutableEmailEvent): Promise<EmailPreference> {
    return this.set({ event_type: eventType, opted_in: true });
  }
}
