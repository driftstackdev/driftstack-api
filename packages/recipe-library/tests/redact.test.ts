import { describe, expect, it } from 'vitest';
import { redactStepForResult, REDACTED, MockRecipeRunner } from '../src/index.js';
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

  it('leaves an unparseable / relative navigate URL unchanged (not a structured cred vector)', () => {
    const nav: RecipeStep = { kind: 'navigate', url: '/relative/path' };
    expect(redactStepForResult(nav)).toBe(nav);
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
