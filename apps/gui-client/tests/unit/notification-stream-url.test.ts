// Regression guard for the notifications SSE auth contract.
//
// GUI audit #15 — the key used to ride in the URL (`?ds_token=`) because a
// browser EventSource cannot set headers, so every intermediary that logs URLs
// saw it. The stream is now read with a header-capable reader and the key goes
// as `Authorization: Bearer …`, which the server's requireAuthEventSource reads
// FIRST (apps/server/src/middleware/auth.ts). The URL carries no credential.

import { describe, expect, it } from 'vitest';
import {
  notificationStreamHeaders,
  notificationStreamUrl,
} from '../../src/lib/notification-stream-url';

describe('notificationStreamUrl', () => {
  it('carries no credential of any kind', () => {
    const url = notificationStreamUrl('https://api.driftstack.dev');
    expect(url).toBe('https://api.driftstack.dev/v1/account/me/notifications');
    expect(url).not.toContain('ds_token');
    expect(url).not.toContain('token=');
  });

  it('strips trailing slashes from the base URL', () => {
    expect(notificationStreamUrl('https://api.driftstack.dev///')).toBe(
      'https://api.driftstack.dev/v1/account/me/notifications',
    );
  });

  it('sends the key as a bearer header', () => {
    expect(notificationStreamHeaders('tok-abc123')).toEqual({
      authorization: 'Bearer tok-abc123',
    });
  });
});
