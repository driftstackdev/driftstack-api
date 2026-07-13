import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAYOUT = resolve(HERE, '..', '..', 'src', 'layouts', 'DashboardLayout.astro');
const layout = readFileSync(LAYOUT, 'utf8');
const helperBody = layout.match(
  /window\.driftstackRequestErrorMessage = function \(err, fallback\) \{[\s\S]*?\n        \};(?=\n        window\.driftstackResponseError)/,
)?.[0];

if (!helperBody) throw new Error('dashboard request-error helper not found');

const scope = { window: {} as Record<string, unknown> };
new Function('window', helperBody)(scope.window);
const messageFor = scope.window.driftstackRequestErrorMessage as (
  error: unknown,
  fallback: string,
) => string;

describe('Dashboard shared request error copy', () => {
  it('maps network, timeout, auth, rate, and service failures', () => {
    expect(
      messageFor(new TypeError('fetch failed: getaddrinfo internal.private'), 'Fallback'),
    ).toBe('Check your connection and try again.');
    expect(
      messageFor(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'Fallback'),
    ).toBe('Request timed out. Check your connection and try again.');
    expect(messageFor(new Error('HTTP 401'), 'Fallback')).toBe(
      'Your sign-in has expired. Sign in again and retry.',
    );
    expect(messageFor(new Error('HTTP 429'), 'Fallback')).toBe(
      'Too many attempts. Wait a moment and try again.',
    );
    expect(messageFor(new Error('HTTP 503'), 'Fallback')).toBe(
      'The service is temporarily unavailable. Try again shortly.',
    );
  });

  it('preserves only explicitly customer-safe response detail', () => {
    const safe = Object.assign(new Error('That provider key was rejected.'), {
      customerSafe: true,
    });
    expect(messageFor(safe, 'Fallback')).toBe('That provider key was rejected.');
    expect(messageFor(new Error('Unexpected token at /private/secret.json'), 'Fallback')).toBe(
      'Fallback',
    );
  });

  it('is consumed by Settings and Audit instead of page-local raw-message fallbacks', () => {
    for (const page of ['settings.astro', 'audit-log.astro']) {
      const body = readFileSync(resolve(HERE, '..', '..', 'src', 'pages', page), 'utf8');
      expect(body).toContain('window.driftstackRequestErrorMessage(err, fallback)');
      expect(body).not.toMatch(/err && err\.message\s*\?\s*err\.message/);
    }
  });
});
