import { describe, expect, it } from 'vitest';
import { redactStepForResult, redactMetadata, REDACTED, MockRecipeRunner } from '../src/index.js';
import type { RecipeStep } from '../src/types.js';

describe('redactStepForResult', () => {
  it('redacts type-step text (the credential vector) without mutating the input', () => {
    const step: RecipeStep = { kind: 'type', selector: '#password', text: 'hunter2' };
    const out = redactStepForResult(step);
    expect(out).toEqual({ kind: 'type', selector: '#password', text: REDACTED });
    expect(step.text).toBe('hunter2'); // original untouched
  });

  it('returns non-secret steps unchanged (same reference)', () => {
    const nav: RecipeStep = { kind: 'navigate', url: 'https://example.com' };
    expect(redactStepForResult(nav)).toBe(nav);
    const tap: RecipeStep = { kind: 'tap', selector: '#go' };
    expect(redactStepForResult(tap)).toBe(tap);
  });

  it('strips basic-auth userinfo from a navigate URL', () => {
    const nav: RecipeStep = { kind: 'navigate', url: 'https://user:s3cret@host.example/path' };
    const out = redactStepForResult(nav);
    expect(out).toEqual({ kind: 'navigate', url: 'https://host.example/path' });
    expect((nav as { url: string }).url).toBe('https://user:s3cret@host.example/path'); // input untouched
  });

  it('redacts secret-bearing query params in a navigate URL, keeps the rest', () => {
    const nav: RecipeStep = {
      kind: 'navigate',
      url: 'https://host.example/cb?token=abc123&page=2&api_key=zzz',
    };
    const out = redactStepForResult(nav) as { kind: 'navigate'; url: string };
    expect(out.url).toContain('page=2'); // non-secret param preserved
    expect(out.url).not.toContain('abc123'); // token value gone
    expect(out.url).not.toContain('zzz'); // api_key value gone
    expect(out.url).toContain(encodeURIComponent(REDACTED));
  });

  // V-1717 — this list is explicitly a "redact-the-known-secrets posture, not a
  // fail-closed allowlist", so a name absent from it is a credential printed in
  // clear rather than a near-miss. It had grown independently of the server's
  // central redactor and had never acquired this product's OWN token parameters —
  // `ds_token` most of all, which the account notification stream publishes as a
  // query parameter, so a recipe navigating a Driftstack URL carried it into a
  // step result verbatim. Behavioural rather than a list assertion: a name added
  // to the Set with the matcher broken would still pass a membership check.
  it("redacts this product's own token query parameters, ds_token included", () => {
    for (const name of [
      'ds_token',
      'session_token',
      'challenge_token',
      'debug_token',
      'code_verifier',
    ]) {
      const step: RecipeStep = {
        kind: 'navigate',
        url: `https://app.driftstack.dev/stream?${name}=SUPERSECRETVALUE123&page=2`,
      };
      const out = redactStepForResult(step) as { url: string };
      expect(out.url, `${name} was left in clear`).not.toContain('SUPERSECRETVALUE123');
      // The marker is written through `URLSearchParams`, which percent-encodes the
      // brackets — `ds_token=%5Bredacted%5D`. Decoding first asserts the marker is
      // present rather than asserting the serializer's spelling of it.
      expect(decodeURIComponent(out.url), `${name} was not replaced with the marker`).toContain(
        REDACTED,
      );
      expect(out.url, 'a non-secret param must survive').toContain('page=2');
    }
  });

  it('redacts a URL credential in a wait url-condition, leaves other wait conditions alone', () => {
    const waitUrl: RecipeStep = {
      kind: 'wait',
      condition: 'url',
      value: 'https://host.example/done?access_token=leakme',
    };
    const out = redactStepForResult(waitUrl) as { kind: 'wait'; value: string };
    expect(out.value).not.toContain('leakme');
    const waitTime: RecipeStep = { kind: 'wait', condition: 'time', value: 5000 };
    expect(redactStepForResult(waitTime)).toBe(waitTime); // non-URL wait unchanged
  });

  it('redacts credentials in RELATIVE URLs too (path token / JWT / query / fragment) — closes the absolute-only bypass — but leaves a clean relative URL byte-for-byte unchanged', () => {
    // Clean relative path → unchanged (same reference; no structured cred).
    const clean: RecipeStep = { kind: 'navigate', url: '/relative/path' };
    expect(redactStepForResult(clean)).toBe(clean);

    // Path-embedded reset token in a RELATIVE wait:url — previously bypassed
    // redaction entirely because `new URL` throws on a relative string.
    const waitReset: RecipeStep = {
      kind: 'wait',
      condition: 'url',
      value: '/account/reset-password/aLongResetToken16plusChars/edit',
    };
    const outReset = redactStepForResult(waitReset) as { kind: 'wait'; value: string };
    expect(outReset.value).not.toContain('aLongResetToken16plusChars');
    expect(outReset.value).toContain('/account/reset-password/'); // context kept

    // JWT-shaped segment in a relative confirm path.
    const navJwt: RecipeStep = {
      kind: 'navigate',
      url: '/confirm/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigpart',
    };
    const outJwt = redactStepForResult(navJwt) as { kind: 'navigate'; url: string };
    expect(outJwt.url).not.toContain('eyJhbGciOiJIUzI1NiJ9');

    // Secret query param + secret fragment in a relative navigate URL.
    const navQ: RecipeStep = { kind: 'navigate', url: '/callback?access_token=leakme&page=2' };
    const outQ = redactStepForResult(navQ) as { kind: 'navigate'; url: string };
    expect(outQ.url).not.toContain('leakme');
    expect(outQ.url).toContain('page=2'); // non-secret param preserved
  });

  it('redacts secret-bearing FRAGMENT params (OAuth implicit post-auth redirect), keeps non-secret fragment params', () => {
    // OAuth implicit/hybrid returns the token in the fragment, which searchParams
    // does not cover — the token must not survive into the result.
    const nav: RecipeStep = {
      kind: 'navigate',
      url: 'https://app.example/callback#access_token=leaktok&id_token=leakid&state=xyz',
    };
    const out = redactStepForResult(nav) as { kind: 'navigate'; url: string };
    expect(out.url).not.toContain('leaktok'); // access_token value gone
    expect(out.url).not.toContain('leakid'); // id_token value gone
    expect(out.url).toContain('state=xyz'); // non-secret fragment param preserved
    expect(out.url).toContain(encodeURIComponent(REDACTED));
  });

  it('redacts a token in a wait url-condition FRAGMENT too', () => {
    const waitUrl: RecipeStep = {
      kind: 'wait',
      condition: 'url',
      value: 'https://app.example/done#access_token=leakme',
    };
    const out = redactStepForResult(waitUrl) as { kind: 'wait'; value: string };
    expect(out.value).not.toContain('leakme');
  });

  it('leaves a non-param fragment (anchor / SPA route) byte-for-byte unchanged', () => {
    // A fragment with no secret param must not be re-encoded by the redactor —
    // same-reference (nothing to redact) contract holds.
    const anchor: RecipeStep = { kind: 'navigate', url: 'https://docs.example/page#section-two' };
    expect(redactStepForResult(anchor)).toBe(anchor);
    const spaRoute: RecipeStep = { kind: 'navigate', url: 'https://app.example/#/dashboard/home' };
    expect(redactStepForResult(spaRoute)).toBe(spaRoute);
  });

  it('redacts a token in a hash-ROUTER fragment (`#/route?access_token=…`), preserving the route', () => {
    // SPA hash-router shape: the token query sits AFTER a `?` INSIDE the
    // fragment. A flat `new URLSearchParams(fragment)` treats the whole
    // `/dashboard?access_token` run as one key, so the secret VALUE survived
    // into the result — this is the leak. The route prefix must be preserved
    // and the token redacted.
    const nav: RecipeStep = {
      kind: 'navigate',
      url: 'https://app.example/#/dashboard?access_token=leaktok',
    };
    const out = redactStepForResult(nav) as { kind: 'navigate'; url: string };
    expect(out.url).not.toContain('leaktok'); // token value gone
    expect(out.url).toContain('/dashboard'); // route prefix preserved
    expect(out.url).toContain(encodeURIComponent(REDACTED));
  });

  it('redacts every secret in a nested hash-router fragment, keeping route + non-secret params', () => {
    const nav: RecipeStep = {
      kind: 'navigate',
      url: 'https://app.example/#/auth/callback?id_token=leakid&access_token=leaktok&code=leakcode&state=xyz',
    };
    const out = redactStepForResult(nav) as { kind: 'navigate'; url: string };
    expect(out.url).not.toContain('leakid');
    expect(out.url).not.toContain('leaktok');
    expect(out.url).not.toContain('leakcode');
    expect(out.url).toContain('/auth/callback'); // route prefix preserved
    expect(out.url).toContain('state=xyz'); // non-secret param preserved
  });

  it('redacts a token in a wait url-condition hash-router fragment too', () => {
    const waitUrl: RecipeStep = {
      kind: 'wait',
      condition: 'url',
      value: 'https://app.example/#/callback?access_token=leakme',
    };
    const out = redactStepForResult(waitUrl) as { kind: 'wait'; value: string };
    expect(out.value).not.toContain('leakme');
    expect(out.value).toContain('/callback');
  });

  it('leaves a hash-router fragment with only non-secret params byte-for-byte unchanged', () => {
    const route: RecipeStep = {
      kind: 'navigate',
      url: 'https://app.example/#/route?foo=bar&page=2',
    };
    expect(redactStepForResult(route)).toBe(route);
  });

  // RECIPE-1: path-embedded credentials (Devise/Rails password-reset +
  // confirmation links, magic-link/passwordless-login JWTs) — the URL has no
  // query-param KEY to match against, so `redactUrlCredentials` never
  // inspected `parsed.pathname` at all and the secret leaked in full.
  describe('path-embedded credentials (RECIPE-1)', () => {
    it('redacts a Devise-style reset-password token embedded as a path segment', () => {
      const nav: RecipeStep = {
        kind: 'navigate',
        url: 'https://example.com/reset-password/abc123SECRETTOKEN',
      };
      const out = redactStepForResult(nav) as { kind: 'navigate'; url: string };
      expect(out.url).not.toContain('abc123SECRETTOKEN');
      expect(out.url).toContain('/reset-password/');
      expect(out.url).toContain(encodeURIComponent(REDACTED));
    });

    it('redacts a JWT-shaped path segment (magic-link / passwordless-login) anywhere in the path', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const nav: RecipeStep = { kind: 'navigate', url: `https://example.com/magic/${jwt}` };
      const out = redactStepForResult(nav) as { kind: 'navigate'; url: string };
      expect(out.url).not.toContain(jwt);
      expect(out.url).toContain(encodeURIComponent(REDACTED));
    });

    it('redacts a confirm/verify-prefixed path token too (extended sensitive-segment list)', () => {
      const nav: RecipeStep = {
        kind: 'navigate',
        url: 'https://example.com/confirm/aVeryLongOpaqueConfirmationToken123',
      };
      const out = redactStepForResult(nav) as { kind: 'navigate'; url: string };
      expect(out.url).not.toContain('aVeryLongOpaqueConfirmationToken123');
    });

    it('does NOT redact a bare short numeric id in a normal path (no false positive)', () => {
      const nav: RecipeStep = { kind: 'navigate', url: 'https://example.com/users/123/profile' };
      expect(redactStepForResult(nav)).toBe(nav);
    });

    it('does NOT redact a normal slug-style path segment (no false positive)', () => {
      const nav: RecipeStep = { kind: 'navigate', url: 'https://example.com/products/blue-shirt' };
      expect(redactStepForResult(nav)).toBe(nav);
    });

    it('does NOT redact a long token-looking segment when NOT preceded by a sensitive segment name', () => {
      // Same shape as the Devise example, but the preceding segment isn't
      // credential-suggestive — should be left alone (context, not just shape).
      const nav: RecipeStep = {
        kind: 'navigate',
        url: 'https://example.com/articles/abc123NotASecretSlug',
      };
      expect(redactStepForResult(nav)).toBe(nav);
    });

    it('does not false-positive on a segment that merely CONTAINS a sensitive word (e.g. "authentic-leather")', () => {
      const nav: RecipeStep = {
        kind: 'navigate',
        url: 'https://example.com/products/authentic-leather/wallet',
      };
      expect(redactStepForResult(nav)).toBe(nav);
    });

    it('applies the same path redaction to a wait url-condition value', () => {
      const waitUrl: RecipeStep = {
        kind: 'wait',
        condition: 'url',
        value: 'https://example.com/reset-password/abc123SECRETTOKEN',
      };
      const out = redactStepForResult(waitUrl) as { kind: 'wait'; value: string };
      expect(out.value).not.toContain('abc123SECRETTOKEN');
    });
  });

  // RECIPE-2: SECRET_QUERY_PARAMS missed common real-world credential param
  // names, and matched keys by exact string only (bypassable via a PHP/Rails
  // array-suffix like `token[]`).
  describe('expanded secret query-param names + array-suffix bypass (RECIPE-2)', () => {
    it.each(['reset_token', 'confirmation_token', 'jwt', 'otp'])(
      'redacts the previously-missing %s query param',
      (paramName) => {
        const nav: RecipeStep = {
          kind: 'navigate',
          url: `https://host.example/cb?${paramName}=leakvalue`,
        };
        const out = redactStepForResult(nav) as { kind: 'navigate'; url: string };
        expect(out.url).not.toContain('leakvalue');
        expect(out.url).toContain(encodeURIComponent(REDACTED));
      },
    );

    it('redacts an array-suffixed secret param (`token[]=…`) — was bypassed by exact-string matching', () => {
      const nav: RecipeStep = {
        kind: 'navigate',
        url: 'https://host.example/cb?token[]=leak1&token[]=leak2',
      };
      const out = redactStepForResult(nav) as { kind: 'navigate'; url: string };
      expect(out.url).not.toContain('leak1');
      expect(out.url).not.toContain('leak2');
    });

    it('redacts an indexed array-suffixed secret param (`token[0]=…`)', () => {
      const nav: RecipeStep = {
        kind: 'navigate',
        url: 'https://host.example/cb?token[0]=leak1&token[1]=leak2',
      };
      const out = redactStepForResult(nav) as { kind: 'navigate'; url: string };
      expect(out.url).not.toContain('leak1');
      expect(out.url).not.toContain('leak2');
    });

    it('does NOT redact ordinary benign query params (no regression / over-redaction)', () => {
      const nav: RecipeStep = {
        kind: 'navigate',
        url: 'https://host.example/search?page=2&sort=asc&q=shoes',
      };
      expect(redactStepForResult(nav)).toBe(nav);
    });
  });
});

describe('MockRecipeRunner result never carries plaintext type-step text', () => {
  it('redacts the login recipe credentials in the RecipeResult', async () => {
    const result = await new MockRecipeRunner().run('login_form_demo', { sessionId: 'ses_test' });
    const typeSteps = result.steps.filter((s) => s.step.kind === 'type');
    expect(typeSteps.length).toBeGreaterThan(0);
    for (const s of typeSteps) {
      // narrowed: type-step
      if (s.step.kind === 'type') {
        expect(s.step.text).toBe(REDACTED);
      }
    }
    // belt-and-suspenders: the demo plaintext must not appear anywhere in the result
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('demo_user');
    expect(serialized).not.toContain('demo_pass');
  });
});

// RECIPE-3: RecipeContext.metadata sits entirely outside redactStepForResult
// (which only ever sees a RecipeStep) — redactMetadata is the parallel
// chokepoint the module header now documents alongside it.
describe('redactMetadata', () => {
  it('redacts the value of a credential-suggestively-named key regardless of shape', () => {
    const out = redactMetadata({ authToken: 'plaintext-secret', apiKey: 12345 });
    expect(out).toEqual({ authToken: REDACTED, apiKey: REDACTED });
  });

  it('leaves ordinary per-run tags unchanged (no over-redaction)', () => {
    const meta = { retries: 2, region: 'us' };
    expect(redactMetadata(meta)).toBe(meta); // same reference — nothing to redact
  });

  it('redacts a metadata value that is itself a credential-bearing URL via the shared URL redactor', () => {
    const out = redactMetadata({
      lastRedirect: 'https://app.example/callback?access_token=leaktok&state=xyz',
    });
    expect(out.lastRedirect).not.toContain('leaktok');
    expect(out.lastRedirect).toContain('state=xyz');
  });

  it('does not mutate the input bag and returns a fresh object when something changed', () => {
    const meta = { authToken: 'hunter2', tag: 'ok' };
    const out = redactMetadata(meta);
    expect(meta.authToken).toBe('hunter2'); // original untouched
    expect(out).not.toBe(meta);
    expect(out).toEqual({ authToken: REDACTED, tag: 'ok' });
  });
});
