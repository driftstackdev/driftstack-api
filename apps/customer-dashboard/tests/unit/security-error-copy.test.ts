import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, '..', '..', 'src', 'pages', 'security.astro');
const body = readFileSync(SOURCE, 'utf8');
const helperSource = body.match(
  /function securityErrorMessage\(err, fallback\) \{[\s\S]*?\n      \}(?=\n      function responseError)/,
)?.[0];

if (!helperSource) throw new Error('securityErrorMessage helper not found');

const securityErrorMessage = new Function(`${helperSource}; return securityErrorMessage;`)() as (
  error: unknown,
  fallback: string,
) => string;

describe('Security dashboard error copy', () => {
  it('maps native transport and HTTP failures without exposing internals', () => {
    expect(
      securityErrorMessage(
        new TypeError('fetch failed: getaddrinfo ENOTFOUND internal-auth.private'),
        'Fallback',
      ),
    ).toBe('Check your connection and try again.');
    expect(securityErrorMessage(new Error('HTTP 503'), 'Fallback')).toBe(
      'The service is temporarily unavailable. Try again shortly.',
    );
    expect(
      securityErrorMessage(new Error('Unexpected token at /private/secret.json'), 'Fallback'),
    ).toBe('Fallback');
  });

  it('preserves response details only when explicitly marked customer-safe', () => {
    const error = Object.assign(new Error('That authenticator code is invalid.'), {
      userSafe: true,
    });
    expect(securityErrorMessage(error, 'Fallback')).toBe('That authenticator code is invalid.');
  });

  it('does not concatenate arbitrary caught messages into visible banners', () => {
    expect(body).not.toContain("err.message || 'Enroll failed.'");
    expect(body).not.toContain("err.message || 'Verify failed.'");
    expect(body).not.toContain("err.message || 'Step-up failed.'");
    expect(body).not.toMatch(/showBanner\([^\n]*\+\s*\(err\s*&&\s*err\.message/);
  });
});
