// W443 — threshold_action_detected v1.0-minimal classifier.
import { describe, it, expect } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import { classifyConsequentialAction } from '../../src/services/agent-consequential-action.js';

const tap = (selector: string, value?: string): AgentIntent => ({
  kind: 'interact',
  action: 'tap',
  selector,
  ...(value !== undefined ? { value } : {}),
});

describe('W443 classifyConsequentialAction', () => {
  it('flags purchase taps with the purchase category', () => {
    for (const s of [
      'Buy Now',
      'button:has-text("Place Order")',
      'Complete Purchase',
      'Confirm Order',
      'Proceed to Checkout',
      'Place Bid',
    ]) {
      const v = classifyConsequentialAction(tap(s));
      expect(v.requiresConfirmation, s).toBe(true);
      expect(v.category, s).toBe('purchase');
      expect(v.matchedText, s).toBeTruthy();
    }
  });

  it('flags payment taps with the payment category', () => {
    for (const s of [
      'Confirm Payment',
      'Pay Now',
      'Submit Payment',
      'Authorize Payment',
      'Add payment method',
    ]) {
      const v = classifyConsequentialAction(tap(s));
      expect(v.requiresConfirmation, s).toBe(true);
      expect(v.category, s).toBe('payment');
    }
  });

  it('flags account-deletion taps with the account_deletion category', () => {
    for (const s of [
      'Delete Account',
      'Delete my account',
      'Close Account',
      'Permanently delete',
      'Deactivate account',
    ]) {
      const v = classifyConsequentialAction(tap(s));
      expect(v.requiresConfirmation, s).toBe(true);
      expect(v.category, s).toBe('account_deletion');
    }
  });

  it('matches the consequential text in value too, not just selector', () => {
    const v = classifyConsequentialAction(tap('#submit-btn', 'Buy Now'));
    expect(v.requiresConfirmation).toBe(true);
    expect(v.category).toBe('purchase');
  });

  it('does NOT flag benign taps (high precision — avoid spurious prompts)', () => {
    for (const s of [
      'Add to cart',
      'Search',
      'Login',
      'Next',
      'Sign in',
      'View payment history',
      'Account settings',
      'Buy',
      'Apply coupon',
    ]) {
      expect(classifyConsequentialAction(tap(s)).requiresConfirmation, s).toBe(false);
    }
  });

  it('does NOT flag non-tap / non-interact intents', () => {
    const cases: AgentIntent[] = [
      { kind: 'navigate', url: 'https://shop.example.com/checkout' },
      { kind: 'interact', action: 'type', selector: '#card', value: 'Buy Now' },
      { kind: 'interact', action: 'scroll' },
      { kind: 'wait', condition: 'idle' },
      { kind: 'capture', capture: 'screenshot' },
      { kind: 'scroll', direction: 'down' },
      { kind: 'behavioral_pause' },
    ];
    for (const intent of cases) {
      expect(
        classifyConsequentialAction(intent).requiresConfirmation,
        intent.kind + ('action' in intent ? `:${intent.action}` : ''),
      ).toBe(false);
    }
  });

  it('defeats unicode evasion (W808): zero-width split, no-break space, bidi wrap, fullwidth', () => {
    const zwsp = String.fromCharCode(0x200b);
    const nbsp = String.fromCharCode(0x00a0);
    const rlo = String.fromCharCode(0x202e);
    // zero-width space splitting the keyword
    expect(classifyConsequentialAction(tap('Dele' + zwsp + 'te Account')).category).toBe(
      'account_deletion',
    );
    // no-break space (NFKC folds → regular space)
    expect(classifyConsequentialAction(tap('Delete' + nbsp + 'Account')).category).toBe(
      'account_deletion',
    );
    // bidi right-to-left override prefix
    expect(classifyConsequentialAction(tap(rlo + 'Confirm Payment')).category).toBe('payment');
    // fullwidth "Buy Now" (NFKC folds → ASCII)
    const fullwidth = (s: string) =>
      s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/ /g, ' ');
    expect(classifyConsequentialAction(tap(fullwidth('Buy Now'))).category).toBe('purchase');
  });
});
