// V-532.C — cart + checkout recipe builders.
//
// Third sub-slice of V-532. V-532.A shipped navigation primitives,
// V-532.B shipped login + fill-form. V-532.C extends the catalog with
// the two recipes that drive most commerce / ticketing automation:
//
//   - buildAddToCartRecipe — navigate to a product detail page, choose
//     an optional variant (size / color / etc), tap the add-to-cart
//     control, wait for the cart-confirmation indicator, capture.
//   - buildCheckoutRecipe — navigate to the cart page, type shipping +
//     billing fields, tap through the checkout-step sequence, wait for
//     the order-confirmation indicator, capture.
//
// Both follow the same "navigate → type/tap → wait → capture" shape as
// the V-532.B recipes; they're not a new mechanism, just longer
// step-sequences for the commerce-flow shape.
//
// Sub-slice remaining:
//   - V-532.D — multi-step wizard with branch-on-state.

import type { Recipe, RecipeStep } from '../types.js';
import { navigateAndWait, tapAndWait, typeInto } from './navigation.js';
import type { FormField } from './forms.js';

/**
 * Build an add-to-cart recipe. Navigates to the product detail page,
 * optionally selects a variant (size, colour, edition — any selector
 * the site exposes), taps the add-to-cart control, waits for the
 * cart-confirmation indicator (typically a mini-cart drawer or a
 * confirmation banner), captures.
 *
 * Variant selection is an optional click-step rather than a typed
 * dropdown so the recipe works for both <select> and tap-to-toggle
 * variant pickers — the most common shape on modern commerce sites.
 */
export function buildAddToCartRecipe(opts: {
  id: string;
  name: string;
  productUrl: string;
  /** Selector for the variant chip / option (optional — skip for
   *  single-variant products). */
  variantSelector?: string;
  addToCartSelector: string;
  cartConfirmationSelector: string;
}): Recipe {
  const steps: RecipeStep[] = [...navigateAndWait(opts.productUrl, opts.addToCartSelector)];

  if (opts.variantSelector !== undefined) {
    steps.push({ kind: 'tap', selector: opts.variantSelector });
    // After picking a variant the site may async-update the add-to-cart
    // button (price / availability). Wait for it to settle before the
    // tap below.
    steps.push({ kind: 'wait', condition: 'selector', value: opts.addToCartSelector });
  }

  steps.push(...tapAndWait(opts.addToCartSelector, opts.cartConfirmationSelector));
  steps.push({ kind: 'capture', what: 'dom' });

  return {
    id: opts.id,
    name: opts.name,
    category: 'cart',
    steps,
  };
}

/** Reference add-to-cart recipe — single-variant product on example.com. */
export const ADD_TO_CART_GENERIC: Recipe = buildAddToCartRecipe({
  id: 'add_to_cart_generic',
  name: 'Generic add-to-cart (demo)',
  productUrl: 'https://example.com/products/demo-tee',
  addToCartSelector: 'button[data-action="add-to-cart"]',
  cartConfirmationSelector: '.cart-confirmation',
});

/** Reference add-to-cart recipe — variant selection (size) then add. */
export const ADD_TO_CART_WITH_VARIANT: Recipe = buildAddToCartRecipe({
  id: 'add_to_cart_with_variant',
  name: 'Generic add-to-cart with size selection (demo)',
  productUrl: 'https://example.com/products/demo-tee',
  variantSelector: '[data-variant="size-medium"]',
  addToCartSelector: 'button[data-action="add-to-cart"]',
  cartConfirmationSelector: '.cart-confirmation',
});

/**
 * Build a checkout recipe. Navigates to the cart page, fills shipping
 * fields, taps the proceed-to-payment / place-order button(s) in the
 * step sequence, waits for the order-confirmation indicator, captures.
 *
 * The `paymentFields` array runs AFTER the shipping fields and an
 * intervening tap on `proceedToPaymentSelector` — modelling the
 * shipping-then-payment two-step that's standard on most checkout
 * UIs (Stripe-redirect flows and PCI-iframed flows are out of scope
 * here; recipes that hit a payment-provider iframe need a different
 * strategy and aren't covered by V-532.C).
 */
export function buildCheckoutRecipe(opts: {
  id: string;
  name: string;
  cartUrl: string;
  proceedToCheckoutSelector: string;
  shippingFields: readonly FormField[];
  proceedToPaymentSelector: string;
  paymentFields: readonly FormField[];
  placeOrderSelector: string;
  orderConfirmationSelector: string;
}): Recipe {
  const firstShipping = opts.shippingFields[0];
  if (firstShipping === undefined) {
    throw new Error('buildCheckoutRecipe: shippingFields must contain at least 1 entry');
  }
  const firstPayment = opts.paymentFields[0];
  if (firstPayment === undefined) {
    throw new Error('buildCheckoutRecipe: paymentFields must contain at least 1 entry');
  }

  const steps: RecipeStep[] = [
    ...navigateAndWait(opts.cartUrl, opts.proceedToCheckoutSelector),
    ...tapAndWait(opts.proceedToCheckoutSelector, firstShipping.selector),
    ...opts.shippingFields.map((f) => typeInto(f.selector, f.value)),
    ...tapAndWait(opts.proceedToPaymentSelector, firstPayment.selector),
    ...opts.paymentFields.map((f) => typeInto(f.selector, f.value)),
    ...tapAndWait(opts.placeOrderSelector, opts.orderConfirmationSelector),
    { kind: 'capture', what: 'dom' },
  ];

  return {
    id: opts.id,
    name: opts.name,
    category: 'checkout',
    steps,
  };
}

/** Reference checkout recipe — shipping + payment against example.com. */
export const CHECKOUT_GENERIC: Recipe = buildCheckoutRecipe({
  id: 'checkout_generic',
  name: 'Generic checkout flow (demo)',
  cartUrl: 'https://example.com/cart',
  proceedToCheckoutSelector: 'button[data-action="proceed-to-checkout"]',
  shippingFields: [
    { selector: '#shipping-name', value: 'Demo User' },
    { selector: '#shipping-address-1', value: '1 Test Lane' },
    { selector: '#shipping-city', value: 'Amsterdam' },
    { selector: '#shipping-zip', value: '1011AB' },
    { selector: '#shipping-country', value: 'Netherlands' },
  ],
  proceedToPaymentSelector: 'button[data-action="proceed-to-payment"]',
  paymentFields: [
    { selector: '#card-number', value: '4242424242424242' },
    { selector: '#card-expiry', value: '12/30' },
    { selector: '#card-cvc', value: '123' },
  ],
  placeOrderSelector: 'button[data-action="place-order"]',
  orderConfirmationSelector: '.order-confirmation',
});

/** Catalogue of V-532.C reference recipes. */
export const V532C_CHECKOUT_RECIPES: readonly Recipe[] = [
  ADD_TO_CART_GENERIC,
  ADD_TO_CART_WITH_VARIANT,
  CHECKOUT_GENERIC,
];
