// Regression guard for the notifications SSE auth contract. The GUI panel
// EventSource (NotificationToastStack → useNotifications) authenticates by
// threading the bearer in the URL's `?ds_token=` query param, because
// EventSource can't set an Authorization header. The server reads ONLY
// `?ds_token=` (requireAuthEventSource, apps/server/src/middleware/auth.ts).
// A prior `?token=` shipped and silently 401'd every notification stream —
// this pins the param name so it can't drift back.

import { describe, expect, it } from 'vitest';
import { notificationStreamUrl } from '../../src/lib/notification-stream-url';

describe('notificationStreamUrl', () => {
  it('threads the bearer via ?ds_token= (requireAuthEventSource), not ?token=', () => {
    const url = notificationStreamUrl('https://api.driftstack.dev', 'tok-abc123');
    expect(url).toBe('https://api.driftstack.dev/v1/account/me/notifications?ds_token=tok-abc123');
    expect(url).toContain('?ds_token=');
    expect(url).not.toContain('?token='); // the old, server-rejected param name
  });

  it('strips trailing slashes from the base URL and percent-encodes the token', () => {
    const url = notificationStreamUrl('https://api.driftstack.dev///', 'a/b+c=');
    expect(url).toBe(
      'https://api.driftstack.dev/v1/account/me/notifications?ds_token=a%2Fb%2Bc%3D',
    );
  });
});
