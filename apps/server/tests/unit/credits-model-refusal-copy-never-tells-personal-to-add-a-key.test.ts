// ai-entitlements.ts's creditsModelRefusalFor — §4.3 rule 6 / M11's copy
// table, for a CREDITS-funded turn (as opposed to
// services/bundled-llm.ts's deploymentKeyModelRefusalFor, whose copy always
// says "add your key" and is right only for a plan that allows one).

import { describe, expect, it } from 'vitest';
import { creditsModelRefusalFor } from '../../src/services/ai-entitlements.js';

const OWN_KEY_ONLY_MODEL = 'claude-opus-5';
const ON_CREDITS_MODEL = 'claude-sonnet-5';
const UNPRICED_MODEL = 'claude-totally-unknown-model';

describe('creditsModelRefusalFor', () => {
  it('CRITICAL returns null for a model credits may run — nothing is refused', () => {
    expect(creditsModelRefusalFor(ON_CREDITS_MODEL, true)).toBeNull();
    expect(creditsModelRefusalFor(ON_CREDITS_MODEL, false)).toBeNull();
  });

  it('CRITICAL⛔ on a plan that forbids an own key (Personal), the Opus refusal never says "key" or "add"', () => {
    const refusal = creditsModelRefusalFor(OWN_KEY_ONLY_MODEL, false);
    expect(refusal).not.toBeNull();
    expect(refusal?.reason).toBe('own_key_only');
    expect(refusal?.detail.toLowerCase()).not.toContain('key');
    expect(refusal?.detail.toLowerCase()).not.toContain('add');
    // M11's exact sentence.
    expect(refusal?.detail).toBe(
      'Claude Opus 5 isn’t included in your plan. Choose Claude Sonnet 5.',
    );
  });

  it('CRITICAL on a plan that allows an own key, the Opus refusal DOES say to add one', () => {
    const refusal = creditsModelRefusalFor(OWN_KEY_ONLY_MODEL, true);
    expect(refusal).not.toBeNull();
    expect(refusal?.reason).toBe('own_key_only');
    expect(refusal?.detail.toLowerCase()).toContain('add your key');
    expect(refusal?.detail).toBe(
      'Claude Opus 5 runs only with your own key. Add your key in Settings, or choose Claude Sonnet 5.',
    );
  });

  it('an unpriced model is refused the SAME way on every plan — an own key would not help either, since the registry has no price to meter it by', () => {
    const personal = creditsModelRefusalFor(UNPRICED_MODEL, false);
    const ownKeyAllowed = creditsModelRefusalFor(UNPRICED_MODEL, true);
    expect(personal?.reason).toBe('unpriced');
    expect(ownKeyAllowed?.reason).toBe('unpriced');
    expect(personal?.detail).toBe(ownKeyAllowed?.detail);
    expect(personal?.detail.toLowerCase()).not.toContain('key');
  });

  it('never mentions a vendor name beyond the model’s own product label', () => {
    for (const ownKeyAllowed of [true, false]) {
      const refusal = creditsModelRefusalFor(OWN_KEY_ONLY_MODEL, ownKeyAllowed);
      // "Claude" is the product name already shown elsewhere in the app; the
      // rule this guards is against naming the PROVIDER (Anthropic) or
      // internal machinery, neither of which appears here.
      expect(refusal?.detail.toLowerCase()).not.toContain('anthropic');
    }
  });
});
