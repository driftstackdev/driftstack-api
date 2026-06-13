// V-494 follow-up — credential-bearing query params (the SSE ?ds_token=,
// the OAuth ?code=, etc.) must never reach a log line or Sentry event in
// plaintext. redactUrlQueryTokens / redactQueryString strip those values
// while preserving the path + benign params. See lib/redact-url.ts.

import { describe, expect, it } from 'vitest';
import {
  redactUrlQueryTokens,
  redactQueryString,
  redactText,
  redactUrlUserinfo,
} from '../../src/lib/redact-url.js';

describe('redactUrlQueryTokens', () => {
  it('redacts the SSE ds_token while keeping the path', () => {
    const out = redactUrlQueryTokens('/v1/agent-sessions/abc/events?ds_token=sk-live-SECRET');
    expect(out).not.toContain('sk-live-SECRET');
    expect(out).toContain('/v1/agent-sessions/abc/events');
    expect(out.toLowerCase()).toContain('ds_token=');
  });

  it('redacts the OAuth single-use code but keeps state', () => {
    const out = redactUrlQueryTokens('/v1/auth/oauth-client/callback?code=AUTHCODE123&state=xyz');
    expect(out).not.toContain('AUTHCODE123');
    expect(out).toContain('state=xyz');
  });

  it('leaves a token-free URL byte-for-byte unchanged (no needless re-encoding)', () => {
    const url = '/v1/sessions?limit=20&cursor=abc';
    expect(redactUrlQueryTokens(url)).toBe(url);
  });

  it('leaves a URL with no query unchanged', () => {
    expect(redactUrlQueryTokens('/v1/whoami')).toBe('/v1/whoami');
  });

  it('redacts multiple sensitive params (token + api_key) in one URL', () => {
    const out = redactUrlQueryTokens('/x?token=AAA&keep=1&api_key=BBB');
    expect(out).not.toContain('AAA');
    expect(out).not.toContain('BBB');
    expect(out).toContain('keep=1');
  });

  it('matches sensitive keys case-insensitively', () => {
    const out = redactUrlQueryTokens('/x?DS_TOKEN=SECRET');
    expect(out).not.toContain('SECRET');
  });

  it('handles empty / non-string input defensively', () => {
    expect(redactUrlQueryTokens('')).toBe('');
    // @ts-expect-error — defensive runtime guard for a non-string.
    expect(redactUrlQueryTokens(undefined)).toBe(undefined);
  });
});

describe('redactQueryString (bare query, no leading ?)', () => {
  it('redacts ds_token in a bare query string (Sentry query_string shape)', () => {
    const out = redactQueryString('ds_token=SECRET&foo=bar');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('foo=bar');
  });

  it('leaves a token-free bare query unchanged', () => {
    expect(redactQueryString('limit=20&cursor=abc')).toBe('limit=20&cursor=abc');
  });
});

describe('redactText — free-text (exception/breadcrumb/message) credential redaction', () => {
  it('redacts a credential query param embedded mid-sentence, preserving surrounding prose', () => {
    const out = redactText(
      'Failed to fetch https://api.driftstack.dev/v1/account/me/notifications?ds_token=ds_live_SECRET retrying',
    );
    expect(out).not.toContain('ds_live_SECRET');
    expect(out).toContain('ds_token=[redacted]');
    expect(out).toContain('Failed to fetch'); // prose intact
    expect(out).toContain('retrying'); // trailing prose intact (url-parser would have eaten it)
  });

  it('redacts a Bearer token in free text', () => {
    const out = redactText('upstream rejected: Authorization: Bearer sk-live-DEADBEEF (401)');
    expect(out).not.toContain('sk-live-DEADBEEF');
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('(401)');
  });

  it('redacts the OAuth ?code= and multiple params', () => {
    const out = redactText('cb https://x/y?code=AUTHCODE&state=ok&access_token=TT done');
    expect(out).not.toContain('AUTHCODE');
    expect(out).not.toContain('TT');
    expect(out).toContain('code=[redacted]');
    expect(out).toContain('access_token=[redacted]');
    expect(out).toContain('state=ok'); // benign param kept
    expect(out).toContain('done');
  });

  it('redacts an OAuth-implicit token in a URL FRAGMENT (the #-led first param leaks otherwise)', () => {
    // A landing URL with a fragment token can surface in an error message /
    // stack that the logger + Sentry pass through redactText. The fragment's
    // FIRST param is `#`-led, not `?`/`&`-led, so it would leak without `#` in
    // the delimiter class while `&`-joined params got redacted.
    const out = redactText(
      'navigate failed at https://app.example/cb#access_token=LEAKA&id_token=LEAKB',
    );
    expect(out).not.toContain('LEAKA'); // #-led fragment token redacted
    expect(out).not.toContain('LEAKB'); // &-joined fragment token redacted
    expect(out).toContain('access_token=[redacted]');
    expect(out).toContain('id_token=[redacted]');
    expect(out).toContain('navigate failed at'); // prose intact
  });

  it('does not redact a non-secret fragment / anchor', () => {
    expect(redactText('see https://docs.example/page#section-two for details')).toBe(
      'see https://docs.example/page#section-two for details',
    );
  });

  it('leaves token-free text unchanged', () => {
    expect(redactText('connection reset by peer (ECONNRESET)')).toBe(
      'connection reset by peer (ECONNRESET)',
    );
    expect(redactText('')).toBe('');
  });
});

describe('userinfo credential redaction (scheme://user:pass@host)', () => {
  it('redacts user:pass@ userinfo in a full URL, keeping scheme + host', () => {
    expect(redactUrlUserinfo('https://alice:hunter2@host.example/path')).toBe(
      'https://[redacted]@host.example/path',
    );
    expect(redactUrlUserinfo('socks5://u:p@proxy.internal:1080')).toBe(
      'socks5://[redacted]@proxy.internal:1080',
    );
  });

  it('redacts a bare username-only userinfo too (over-redaction in logs is safe)', () => {
    expect(redactUrlUserinfo('https://tokenish@host/x')).toBe('https://[redacted]@host/x');
  });

  it('leaves userinfo-free URLs + a query-embedded @ + mailto untouched', () => {
    expect(redactUrlUserinfo('https://host/path?x=1')).toBe('https://host/path?x=1');
    // a query-embedded @ (email) is NOT userinfo — the host's `/`/`?` stop the class
    expect(redactUrlUserinfo('https://host/?email=a@b.com')).toBe('https://host/?email=a@b.com');
    // mailto: has no `//` → not matched
    expect(redactUrlUserinfo('mailto:user@host.com')).toBe('mailto:user@host.com');
    expect(redactUrlUserinfo('')).toBe('');
  });

  it('redactText scrubs userinfo creds embedded in an error message, prose intact', () => {
    const out = redactText(
      'proxy connect failed for socks5://bob:s3cret@p.example:1080 (ETIMEDOUT)',
    );
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('bob:s3cret');
    expect(out).toContain('socks5://[redacted]@p.example:1080');
    expect(out).toContain('ETIMEDOUT'); // prose intact
  });

  it('redactUrlQueryTokens redacts BOTH userinfo and a query token in one full URL', () => {
    const out = redactUrlQueryTokens('https://u:p@host/cb?code=AUTH&state=ok');
    expect(out).not.toContain('u:p@');
    expect(out).not.toContain('AUTH');
    expect(out).toContain('https://[redacted]@host/cb'); // userinfo: plain replace
    expect(out).toContain('code=%5Bredacted%5D'); // query value: URL-encoded by URLSearchParams
    expect(out).toContain('state=ok');
  });

  it('redactUrlQueryTokens redacts userinfo even with no query present', () => {
    expect(redactUrlQueryTokens('https://u:p@host/path')).toBe('https://[redacted]@host/path');
  });
});
