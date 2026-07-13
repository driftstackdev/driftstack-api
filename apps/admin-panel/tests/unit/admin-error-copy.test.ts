import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..', '..');
const layout = readFileSync(resolve(APP, 'src/layouts/AdminLayout.astro'), 'utf8');
const helperBody = layout.match(
  /window\.driftstackRequestErrorMessage = function \(err, fallback\) \{[\s\S]*?\n        \};(?=\n        window\.driftstackResponseError)/,
)?.[0];

if (!helperBody) throw new Error('admin request-error helper not found');

const scope = { window: {} as Record<string, unknown> };
new Function('window', helperBody)(scope.window);
const messageFor = scope.window.driftstackRequestErrorMessage as (
  error: unknown,
  fallback: string,
) => string;

describe('Admin shared request error copy', () => {
  it('maps native network, timeout, auth, conflict, rate, and service failures', () => {
    expect(
      messageFor(new TypeError('fetch failed: getaddrinfo api.internal.private'), 'Fallback'),
    ).toBe('Check the connection and try again.');
    expect(
      messageFor(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'Fallback'),
    ).toBe('Request timed out. Check the connection and try again.');
    expect(messageFor(new Error('HTTP 401'), 'Fallback')).toBe(
      'Staff sign-in has expired. Sign in again and retry.',
    );
    expect(messageFor(new Error('HTTP 409'), 'Fallback')).toBe(
      'The resource changed. Refresh and try again.',
    );
    expect(messageFor(new Error('HTTP 429'), 'Fallback')).toBe(
      'Too many requests. Wait a moment and try again.',
    );
    expect(messageFor(new Error('HTTP 503'), 'Fallback')).toBe(
      'The admin service is temporarily unavailable. Try again shortly.',
    );
  });

  it('preserves control sentinels and only explicitly staff-safe API detail', () => {
    expect(messageFor(new Error('forbidden'), 'Fallback')).toBe('forbidden');
    expect(messageFor(new Error('not-found'), 'Fallback')).toBe('not-found');
    expect(messageFor(new Error('no admin token'), 'Fallback')).toBe(
      'Staff admin token is unavailable. Sign in again.',
    );
    expect(
      messageFor(
        Object.assign(new Error('Refund exceeds the original charge.'), { staffSafe: true }),
        'Fallback',
      ),
    ).toBe('Refund exceeds the original charge.');
    expect(messageFor(new Error('Unexpected token at /private/secret.json'), 'Fallback')).toBe(
      'Fallback',
    );
  });

  it('is installed before slotted page scripts and marks response detail explicitly', () => {
    const helper = layout.indexOf('window.driftstackRequestErrorMessage');
    const slot = layout.lastIndexOf('<slot />');
    expect(helper).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(helper);
    expect(layout).toContain('window.driftstackResponseError = function');
    expect(layout).toContain('if (detail) error.staffSafe = true');
  });

  it('is consumed by every audited AdminLayout page without raw exception fallbacks', () => {
    const pages = [
      'accounts.astro',
      'api-keys.astro',
      'audit-log.astro',
      'cost.astro',
      'fleet.astro',
      'incidents/index.astro',
      'index.astro',
      'rate-limit-overrides.astro',
      'sessions.astro',
      'status-subscribers.astro',
      'webhook-dlq.astro',
      'shells/account-detail.astro',
      'shells/incident-detail.astro',
    ];
    for (const page of pages) {
      const body = readFileSync(resolve(APP, 'src/pages', page), 'utf8');
      expect(body).toContain('window.driftstackRequestErrorMessage(');
      expect(body).not.toMatch(/err && err\.message\s*\?\s*err\.message/);
      expect(body).not.toMatch(/new Error\((?:b|body)\.detail\s*\|\|/);
    }
  });
});
