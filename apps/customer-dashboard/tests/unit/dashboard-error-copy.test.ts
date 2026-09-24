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

const responseHelperBody = layout.match(
  /window\.driftstackResponseError = function \(response, body\) \{[\s\S]*?\n        \};(?=\n        window\.driftstackFetchWithDeadline)/,
)?.[0];
if (!responseHelperBody) throw new Error('dashboard response-error helper not found');
new Function('window', responseHelperBody)(scope.window);
const responseError = scope.window.driftstackResponseError as (
  response: { status: number },
  body: unknown,
) => Error & { customerSafe?: boolean; problemType?: string };

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

  it('maps stable response types to fixed copy and retains the branchable type', () => {
    const error = responseError(
      { status: 403 },
      {
        type: 'https://errors.driftstack.dev/email-not-verified',
        detail: 'internal host=api.private token=secret',
        title: 'DO NOT SHOW',
      },
    );
    expect(error.message).toBe('Verify your email address before signing in.');
    expect(error.customerSafe).toBe(true);
    expect(error.problemType).toBe('https://errors.driftstack.dev/email-not-verified');
    expect(error.message).not.toMatch(/internal|private|secret|DO NOT SHOW/i);
  });

  it('shows the sign-in messages the server writes as customer copy, word for word', () => {
    const rate = 'https://errors.driftstack.dev/rate-limited';
    const token = 'https://errors.driftstack.dev/invalid-auth-token';
    const shown = [
      [
        rate,
        'Too many incorrect passwords for this email. Try again in 15 minutes, or reset your password.',
      ],
      [
        rate,
        'Too many incorrect passwords for this email. Try again in 1 minute, or reset your password.',
      ],
      [
        rate,
        'Too many incorrect two-factor codes for this account. Two-factor sign-in is paused — try again in 12 minutes.',
      ],
      [
        rate,
        'Too many incorrect two-factor codes after signing in with GitHub. Two-factor sign-in with GitHub is paused — try again in 15 minutes, or sign in another way.',
      ],
      [
        rate,
        'Too many incorrect two-factor codes after signing in with an email link. Two-factor sign-in with an email link is paused — try again in 1 minute, or sign in another way.',
      ],
      [
        rate,
        'Your password was changed. Two-factor sign-in for this account is paused after too many incorrect codes — sign in with your new password in 3 minutes.',
      ],
      [token, 'Code is invalid. Try again or use a recovery code.'],
      [token, 'Too many incorrect codes for this sign-in. Sign in again to retry.'],
      [token, 'Challenge token was issued from a different IP. Sign in again.'],
      [token, 'Challenge token was already used. Sign in again.'],
    ] as const;
    for (const [type, detail] of shown) {
      const status = type === rate ? 429 : 400;
      const error = responseError({ status }, { type, detail });
      expect(error.message).toBe(detail);
      expect(error.customerSafe).toBe(true);
    }
  });

  it('reflects nothing beyond an exact whole match of a known sign-in message', () => {
    const rate = 'https://errors.driftstack.dev/rate-limited';
    const near = [
      // extra text after a known message
      'Too many incorrect passwords for this email. Try again in 15 minutes, or reset your password. host=db.private',
      // extra text before it
      'x Code is invalid. Try again or use a recovery code.',
      // the per-IP limiter's own wording is not on the list
      'Too many requests from this IP. Retry in 42s.',
      // the two method names must agree — a mismatched pair is not a message the server writes
      'Too many incorrect two-factor codes after signing in with GitHub. Two-factor sign-in with Google is paused — try again in 15 minutes, or sign in another way.',
      // a provider name outside the three the server names is not on the list
      'Too many incorrect two-factor codes after signing in with evil.example. Two-factor sign-in with evil.example is paused — try again in 15 minutes, or sign in another way.',
    ];
    for (const detail of near) {
      expect(responseError({ status: 429 }, { type: rate, detail }).message).toBe(
        'A usage limit was reached. Wait a moment or review your plan, then try again.',
      );
    }
    // A known message under a different problem type is not shown either.
    const other = responseError(
      { status: 403 },
      {
        type: 'https://errors.driftstack.dev/forbidden',
        detail: 'Code is invalid. Try again or use a recovery code.',
      },
    );
    expect(other.message).toBe('You do not have permission to perform this action.');
  });

  it('lists only sign-in messages the server still writes', () => {
    const server = readFileSync(
      resolve(HERE, '..', '..', '..', 'server', 'src', 'services', 'auth-flows.ts'),
      'utf8',
    );
    for (const fragment of [
      'Too many incorrect passwords for this email. Try again in ${minutes.toString()} minute',
      ', or reset your password.',
      'Too many incorrect two-factor codes for this account. Two-factor sign-in is paused — try again in ${wait}.',
      'Your password was changed. Two-factor sign-in for this account is paused after too many incorrect codes — sign in with your new password in ${wait}.',
      'Too many incorrect two-factor codes after signing in with ${name}. Two-factor sign-in with ${name} is paused — try again in ${wait}, or sign in another way.',
      "'Code is invalid. Try again or use a recovery code.'",
      "'Too many incorrect codes for this sign-in. Sign in again to retry.'",
      "'Challenge token is unknown or expired. Sign in again.'",
      "'Challenge token is invalid. Sign in again.'",
      "'Challenge token was issued from a different IP. Sign in again.'",
      "'Challenge token was already used. Sign in again.'",
    ]) {
      expect(server, fragment).toContain(fragment);
    }
  });

  it('maps unknown and untyped responses by status without reflecting prose', () => {
    const unknown = responseError(
      { status: 500 },
      { type: 'https://attacker.invalid/internal', detail: '/private/db password=secret' },
    );
    expect(unknown.message).toBe('The service is temporarily unavailable. Try again shortly.');
    expect(unknown.problemType).toBeUndefined();

    const untyped = responseError({ status: 400 }, { detail: 'SQLSTATE 23505' });
    expect(untyped.message).toBe(
      'The request could not be completed. Check your input and try again.',
    );
  });

  it('is consumed by Settings and Audit instead of page-local raw-message fallbacks', () => {
    for (const page of ['settings.astro', 'audit-log.astro']) {
      const body = readFileSync(resolve(HERE, '..', '..', 'src', 'pages', page), 'utf8');
      expect(body).toContain('window.driftstackRequestErrorMessage(err, fallback)');
      expect(body).not.toMatch(/err && err\.message\s*\?\s*err\.message/);
    }
  });

  it('is consumed across every DashboardLayout account surface', () => {
    const pages = [
      'billing.astro',
      'usage.astro',
      'webhooks.astro',
      'api-keys.astro',
      'index.astro',
      'team.astro',
      'select-tier.astro',
    ];
    for (const page of pages) {
      const body = readFileSync(resolve(HERE, '..', '..', 'src', 'pages', page), 'utf8');
      expect(body).toContain('window.driftstackRequestErrorMessage(');
      expect(body).not.toMatch(/err && err\.message\s*\?\s*err\.message/);
      expect(body).not.toMatch(/new Error\((?:b|body)\.detail\s*\|\|/);
    }
  });

  it('protects recovery, account-link, and invite failure copy', () => {
    const pages = [
      'forgot-password.astro',
      'auth/magic-link-request.astro',
      'auth/oauth-client/confirm-merge.astro',
      'team/accept.astro',
    ];
    for (const page of pages) {
      const body = readFileSync(resolve(HERE, '..', '..', 'src', 'pages', page), 'utf8');
      expect(body).toContain('window.driftstackRequestErrorMessage(');
      expect(body).toContain('window.driftstackResponseError(');
      expect(body).not.toMatch(/err && err\.message\s*\?\s*err\.message/);
      expect(body).not.toMatch(/new Error\((?:b|body)\.detail\s*\|\|/);
    }
  });
});
