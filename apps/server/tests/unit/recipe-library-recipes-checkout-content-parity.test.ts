// W598.C — drift guard for packages/recipe-library/src/recipes/checkout.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recipe-library/src/recipes/checkout.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W598.C packages/recipe-library/src/recipes/checkout.ts content parity', () => {
  const body = read(LIB);

  it('V-532.C framing + buildAddToCartRecipe (optional variant) + buildCheckoutRecipe (shipping → payment 2-step; payment-iframe out-of-scope) + V-532.D wizard deferral pinned', () => {
    expect(body).toMatch(/\/\/ V-532\.C — cart \+ checkout recipe builders\./);
    expect(body).toMatch(
      /\/\/\s+- buildAddToCartRecipe — navigate to a product detail page, choose/,
    );
    expect(body).toMatch(
      /\/\/\s+an optional variant \(size \/ color \/ etc\), tap the add-to-cart/,
    );
    expect(body).toMatch(
      /\/\/\s+- buildCheckoutRecipe — navigate to the cart page, type shipping \+/,
    );
    expect(body).toMatch(/\/\/\s+billing fields, tap through the checkout-step sequence, wait for/);
    expect(body).toMatch(/\/\/\s+the order-confirmation indicator, capture\./);
    expect(body).toMatch(
      /\/\/ Both follow the same "navigate → type\/tap → wait → capture" shape as/,
    );
    expect(body).toMatch(/\/\/\s+- V-532\.D — multi-step wizard with branch-on-state\./);
  });

  it('buildAddToCartRecipe: optional variantSelector + tap-then-wait-for-addToCart re-settle + cartConfirmationSelector + 2 reference recipes (single-variant + with-variant size-medium)', () => {
    expect(body).toMatch(/\* Build an add-to-cart recipe\./);
    expect(body).toMatch(/\* Variant selection is an optional click-step rather than a typed/);
    expect(body).toMatch(/\* dropdown so the recipe works for both <select> and tap-to-toggle/);
    expect(body).toMatch(/^export function buildAddToCartRecipe\(opts: \{$/m);
    expect(body).toMatch(/variantSelector\?: string;/);
    expect(body).toMatch(/addToCartSelector: string;/);
    expect(body).toMatch(/cartConfirmationSelector: string;/);
    expect(body).toMatch(/if \(opts\.variantSelector !== undefined\) \{/);
    expect(body).toMatch(/\/\/ After picking a variant the site may async-update the add-to-cart/);
    expect(body).toMatch(
      /\/\/ button \(price \/ availability\)\. Wait for it to settle before the/,
    );
    expect(body).toMatch(/category: 'cart',/);
    expect(body).toMatch(/^export const ADD_TO_CART_GENERIC: Recipe = buildAddToCartRecipe\(\{$/m);
    expect(body).toMatch(
      /^export const ADD_TO_CART_WITH_VARIANT: Recipe = buildAddToCartRecipe\(\{$/m,
    );
    expect(body).toMatch(/variantSelector: '\[data-variant="size-medium"\]',/);
    expect(body).toMatch(/cartConfirmationSelector: '\.cart-confirmation',/);
  });

  it('buildCheckoutRecipe: cartUrl + proceedToCheckoutSelector + shippingFields + proceedToPaymentSelector + paymentFields + placeOrderSelector + orderConfirmationSelector; both field arrays non-empty required; CHECKOUT_GENERIC (5 shipping + 3 payment fields incl Stripe test card 4242×4) pinned', () => {
    expect(body).toMatch(/\* Build a checkout recipe\./);
    expect(body).toMatch(/\* The `paymentFields` array runs AFTER the shipping fields and an/);
    expect(body).toMatch(/\* intervening tap on `proceedToPaymentSelector` — modelling the/);
    expect(body).toMatch(/\* shipping-then-payment two-step that's standard on most checkout/);
    expect(body).toMatch(/\* UIs \(Stripe-redirect flows and PCI-iframed flows are out of scope/);
    expect(body).toMatch(/\* here; recipes that hit a payment-provider iframe need a different/);
    expect(body).toMatch(/\* strategy and aren't covered by V-532\.C\)\./);
    expect(body).toMatch(/^export function buildCheckoutRecipe\(opts: \{$/m);
    expect(body).toMatch(/shippingFields: readonly FormField\[\];/);
    expect(body).toMatch(/paymentFields: readonly FormField\[\];/);
    expect(body).toMatch(
      /if \(firstShipping === undefined\) \{\s*\n\s*throw new Error\('buildCheckoutRecipe: shippingFields must contain at least 1 entry'\);\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /if \(firstPayment === undefined\) \{\s*\n\s*throw new Error\('buildCheckoutRecipe: paymentFields must contain at least 1 entry'\);\s*\n\s*\}/,
    );
    expect(body).toMatch(/category: 'checkout',/);
    expect(body).toMatch(/^export const CHECKOUT_GENERIC: Recipe = buildCheckoutRecipe\(\{$/m);
    expect(body).toMatch(/\{ selector: '#shipping-name', value: 'Demo User' \},/);
    expect(body).toMatch(/\{ selector: '#shipping-city', value: 'Amsterdam' \},/);
    expect(body).toMatch(/\{ selector: '#shipping-country', value: 'Netherlands' \},/);
    expect(body).toMatch(/\{ selector: '#card-number', value: '4242424242424242' \},/);
    expect(body).toMatch(/\{ selector: '#card-expiry', value: '12\/30' \},/);
    expect(body).toMatch(/\{ selector: '#card-cvc', value: '123' \},/);
    expect(body).toMatch(/orderConfirmationSelector: '\.order-confirmation',/);
    expect(body).toMatch(
      /^export const V532C_CHECKOUT_RECIPES: readonly Recipe\[\] = \[\s*\n\s*ADD_TO_CART_GENERIC,\s*\n\s*ADD_TO_CART_WITH_VARIANT,\s*\n\s*CHECKOUT_GENERIC,\s*\n\];/m,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
