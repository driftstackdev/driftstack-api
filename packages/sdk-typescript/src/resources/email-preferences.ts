// EmailPreferencesResource — typed methods for /v1/account/email-preferences (V-204).
//
// Per-event opt-in/opt-out toggles for non-critical customer emails
// (signup-welcome, session-failed-first, billing-receipt, etc).
// Critical emails — signup-verification, password-reset,
// billing-failure — are never opt-outable; they're absent from the
// OptOutableEmailEvent enum on purpose so the API surface matches
// the policy.

import type {
  ListEmailPreferencesResponse,
  OptOutableEmailEvent,
  SetEmailPreferenceRequest,
} from '@driftstack/api-types';
import type { HttpClient } from '../http.js';

export class EmailPreferencesResource {
  constructor(private readonly http: HttpClient) {}

  /** Read all opt-out toggles for the EFFECTIVE account. Defaults to opted-in for unset rows. */
  list(): Promise<ListEmailPreferencesResponse> {
    return this.http.request<ListEmailPreferencesResponse>({
      method: 'GET',
      path: '/v1/account/email-preferences',
    });
  }

  /**
   * Set opt-in/opt-out for a single email event type. The server
   * returns `204 No Content` on success — no response body. Call
   * `list()` afterwards if you need the post-update state.
   */
  set(body: SetEmailPreferenceRequest): Promise<void> {
    return this.http.request<void>({
      method: 'PUT',
      path: '/v1/account/email-preferences',
      body,
    });
  }

  /** Convenience: opt out of a single event type. */
  optOut(eventType: OptOutableEmailEvent): Promise<void> {
    return this.set({ event_type: eventType, opted_in: false });
  }

  /** Convenience: opt back in to a single event type. */
  optIn(eventType: OptOutableEmailEvent): Promise<void> {
    return this.set({ event_type: eventType, opted_in: true });
  }
}
