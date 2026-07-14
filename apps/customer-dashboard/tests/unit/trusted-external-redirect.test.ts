import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const LAYOUT = resolve(process.cwd(), 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');
const layout = readFileSync(LAYOUT, 'utf8');
const helperBody = layout.match(
  /window\.driftstackTrustedRedirectUrl = function \(value, allowedOrigins\) \{[\s\S]*?\n        \};/,
)?.[0];

if (!helperBody) throw new Error('trusted external redirect helper not found');

const scope = { window: {} as Record<string, unknown> };
new Function('window', helperBody)(scope.window);
const trustedRedirectUrl = scope.window.driftstackTrustedRedirectUrl as (
  value: unknown,
  allowedOrigins: unknown,
) => string | null;

describe('trusted external redirect URL', () => {
  it('allows only credential-free HTTPS URLs on an exact origin allowlist', () => {
    expect(
      trustedRedirectUrl('https://checkout.stripe.com/c/session?x=1#done', [
        'https://checkout.stripe.com',
      ]),
    ).toBe('https://checkout.stripe.com/c/session?x=1#done');
    expect(
      trustedRedirectUrl('https://accounts.google.com/o/oauth2/v2/auth?state=abc', [
        'https://accounts.google.com',
        'https://github.com',
      ]),
    ).toBe('https://accounts.google.com/o/oauth2/v2/auth?state=abc');
  });

  it.each([
    'javascript:window.__redirectExecuted=true',
    'data:text/html,<script>alert(1)</script>',
    'http://checkout.stripe.com/c/session',
    'https://checkout.stripe.com.evil.test/c/session',
    'https://checkout.stripe.com:444/c/session',
    'https://user:secret@checkout.stripe.com/c/session',
    '//checkout.stripe.com/c/session',
    'not a URL',
  ])('rejects unsafe or malformed target %s', (value) => {
    expect(trustedRedirectUrl(value, ['https://checkout.stripe.com'])).toBeNull();
  });

  it('fails closed for non-string values and malformed allowlists', () => {
    expect(trustedRedirectUrl(null, ['https://checkout.stripe.com'])).toBeNull();
    expect(trustedRedirectUrl({ toString: () => 'https://checkout.stripe.com' }, [])).toBeNull();
    expect(
      trustedRedirectUrl('https://checkout.stripe.com', 'https://checkout.stripe.com'),
    ).toBeNull();
  });

  it('requires HTTPS independently of the supplied origin list', () => {
    expect(trustedRedirectUrl('javascript:window.__redirectExecuted=true', ['null'])).toBeNull();
    expect(
      trustedRedirectUrl('http://checkout.stripe.com/c/session', ['http://checkout.stripe.com']),
    ).toBeNull();
  });
});

describe('customer external redirect call sites', () => {
  const pages = {
    signup: readFileSync(
      resolve(process.cwd(), 'apps/customer-dashboard/src/pages/signup.astro'),
      'utf8',
    ),
    login: readFileSync(
      resolve(process.cwd(), 'apps/customer-dashboard/src/pages/login.astro'),
      'utf8',
    ),
    billing: readFileSync(
      resolve(process.cwd(), 'apps/customer-dashboard/src/pages/billing.astro'),
      'utf8',
    ),
    selectTier: readFileSync(
      resolve(process.cwd(), 'apps/customer-dashboard/src/pages/select-tier.astro'),
      'utf8',
    ),
  };

  it('gates OAuth redirects on the exact Google and GitHub origins', () => {
    for (const source of [pages.signup, pages.login]) {
      expect(source).toMatch(
        /driftstackTrustedRedirectUrl\(body\.authorize_url, \[\s*'https:\/\/accounts\.google\.com',\s*'https:\/\/github\.com',\s*\]\)/,
      );
      expect(source).not.toMatch(/window\.location\.href = body\.authorize_url/);
    }
  });

  it('gates Stripe portal and checkout redirects on their exact origins', () => {
    expect(pages.billing).toMatch(
      /driftstackTrustedRedirectUrl\(body && body\.portal_url, \[\s*'https:\/\/billing\.stripe\.com',\s*\]\)/,
    );
    expect(pages.selectTier).toMatch(
      /driftstackTrustedRedirectUrl\(body\.portal_url, \[\s*'https:\/\/billing\.stripe\.com',\s*\]\)/,
    );
    expect(pages.selectTier).toMatch(
      /driftstackTrustedRedirectUrl\(body\.checkout_url, \[\s*'https:\/\/checkout\.stripe\.com',\s*\]\)/,
    );
    for (const source of [pages.billing, pages.selectTier]) {
      expect(source).not.toMatch(/window\.location\.href = body\.(?:portal|checkout)_url/);
    }
  });
});
