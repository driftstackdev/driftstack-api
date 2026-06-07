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
