import { describe, expect, it } from 'vitest';
import {
  buildAddToCartRecipe,
  buildCheckoutRecipe,
  ADD_TO_CART_GENERIC,
  ADD_TO_CART_WITH_VARIANT,
  CHECKOUT_GENERIC,
  V532C_CHECKOUT_RECIPES,
  type FormField,
} from '../src/index.js';

describe('V-532.C buildAddToCartRecipe — no variant', () => {
  it('produces navigate + wait + tap + wait + capture sequence', () => {
    const recipe = buildAddToCartRecipe({
      id: 'cart_simple',
      name: 'Simple cart',
      productUrl: 'https://example.com/products/foo',
      addToCartSelector: 'button.add',
      cartConfirmationSelector: '.confirm',
    });

    expect(recipe.id).toBe('cart_simple');
    expect(recipe.category).toBe('cart');
    expect(recipe.steps.map((s) => s.kind)).toEqual(['navigate', 'wait', 'tap', 'wait', 'capture']);
  });

  it('first step navigates to the product url', () => {
    const recipe = buildAddToCartRecipe({
      id: 'x',
      name: 'x',
      productUrl: 'https://shop.example.com/product/123',
      addToCartSelector: '.add',
      cartConfirmationSelector: '.confirm',
    });
    const first = recipe.steps[0];
    expect(first?.kind).toBe('navigate');
    if (first?.kind === 'navigate') {
      expect(first.url).toBe('https://shop.example.com/product/123');
    }
  });

  it('post-tap wait targets the cart-confirmation selector', () => {
    const recipe = buildAddToCartRecipe({
      id: 'x',
      name: 'x',
      productUrl: 'https://example.com/p',
      addToCartSelector: '.add',
      cartConfirmationSelector: '.mini-cart-drawer',
    });
    const waitSteps = recipe.steps.filter((s) => s.kind === 'wait');
    // Asserted, not assumed. This was `if (lastWait?.kind === 'wait')`, so with
    // NO wait steps at all the optional chain went undefined, the branch was
    // skipped and the arm passed — proven by deleting the wait from both
    // emitters in navigation.ts, after which this test still went green. The
    // barrier is what the arm is named for and what the source calls essential:
    // without it the recipe races between the tap and the next selector.
    expect(waitSteps.length, 'the recipe emits wait barriers').toBeGreaterThan(0);
    const lastWait = waitSteps[waitSteps.length - 1];
    expect(lastWait?.kind, 'the last wait step is a wait').toBe('wait');
    if (lastWait?.kind !== 'wait') throw new Error('unreachable — asserted above');
    expect(lastWait.value).toBe('.mini-cart-drawer');
  });
});

describe('V-532.C buildAddToCartRecipe — with variant', () => {
  it('inserts variant tap + intermediate wait before add-to-cart', () => {
    const recipe = buildAddToCartRecipe({
      id: 'cart_variant',
      name: 'With variant',
      productUrl: 'https://example.com/p',
      variantSelector: '[data-size="L"]',
      addToCartSelector: '.add',
      cartConfirmationSelector: '.confirm',
    });
    expect(recipe.steps.map((s) => s.kind)).toEqual([
      'navigate',
      'wait',
      'tap', // variant tap
      'wait', // wait for add-to-cart settle
      'tap', // add to cart
      'wait', // wait for confirmation
      'capture',
    ]);
  });

  it('first tap selects the variant, second tap is add-to-cart', () => {
    const recipe = buildAddToCartRecipe({
      id: 'x',
      name: 'x',
      productUrl: 'https://example.com/p',
      variantSelector: '[data-size="L"]',
      addToCartSelector: 'button.add',
      cartConfirmationSelector: '.confirm',
    });
    const taps = recipe.steps.filter((s) => s.kind === 'tap');
    expect(taps).toHaveLength(2);
    if (taps[0]?.kind === 'tap') expect(taps[0].selector).toBe('[data-size="L"]');
    if (taps[1]?.kind === 'tap') expect(taps[1].selector).toBe('button.add');
  });
});

describe('V-532.C buildCheckoutRecipe', () => {
  const shipping: readonly FormField[] = [
    { selector: '#name', value: 'Alice' },
    { selector: '#addr', value: '1 Street' },
  ];
  const payment: readonly FormField[] = [
    { selector: '#card', value: '4242424242424242' },
    { selector: '#cvc', value: '123' },
  ];

  it('produces navigate→tap→type×N→tap→type×N→tap→wait→capture', () => {
    const recipe = buildCheckoutRecipe({
      id: 'co',
      name: 'Checkout',
      cartUrl: 'https://example.com/cart',
      proceedToCheckoutSelector: '#to-checkout',
      shippingFields: shipping,
      proceedToPaymentSelector: '#to-payment',
      paymentFields: payment,
      placeOrderSelector: '#place',
      orderConfirmationSelector: '.confirmed',
    });
    expect(recipe.category).toBe('checkout');
    expect(recipe.steps.map((s) => s.kind)).toEqual([
      'navigate',
      'wait',
      'tap', // proceed to checkout
      'wait',
      'type', // name
      'type', // addr
      'tap', // proceed to payment
      'wait',
      'type', // card
      'type', // cvc
      'tap', // place order
      'wait',
      'capture',
    ]);
  });

  it('preserves shipping field order', () => {
    const recipe = buildCheckoutRecipe({
      id: 'co',
      name: 'x',
      cartUrl: 'https://example.com/cart',
      proceedToCheckoutSelector: '#x',
      shippingFields: shipping,
      proceedToPaymentSelector: '#y',
      paymentFields: payment,
      placeOrderSelector: '#z',
      orderConfirmationSelector: '.ok',
    });
    const types = recipe.steps.filter((s) => s.kind === 'type');
    // first 2 type steps are shipping; next 2 are payment
    if (types[0]?.kind === 'type') expect(types[0].selector).toBe('#name');
    if (types[1]?.kind === 'type') expect(types[1].selector).toBe('#addr');
    if (types[2]?.kind === 'type') expect(types[2].selector).toBe('#card');
    if (types[3]?.kind === 'type') expect(types[3].selector).toBe('#cvc');
  });

  it('rejects empty shippingFields', () => {
    expect(() =>
      buildCheckoutRecipe({
        id: 'x',
        name: 'x',
        cartUrl: 'https://example.com/cart',
        proceedToCheckoutSelector: '#x',
        shippingFields: [],
        proceedToPaymentSelector: '#y',
        paymentFields: payment,
        placeOrderSelector: '#z',
        orderConfirmationSelector: '.ok',
      }),
    ).toThrow(/shippingFields/);
  });

  it('rejects empty paymentFields', () => {
    expect(() =>
      buildCheckoutRecipe({
        id: 'x',
        name: 'x',
        cartUrl: 'https://example.com/cart',
        proceedToCheckoutSelector: '#x',
        shippingFields: shipping,
        proceedToPaymentSelector: '#y',
        paymentFields: [],
        placeOrderSelector: '#z',
        orderConfirmationSelector: '.ok',
      }),
    ).toThrow(/paymentFields/);
  });
});

describe('V-532.C reference recipes', () => {
  it('exports ADD_TO_CART_GENERIC with cart category', () => {
    expect(ADD_TO_CART_GENERIC.category).toBe('cart');
  });

  it('exports ADD_TO_CART_WITH_VARIANT with 2 tap steps', () => {
    const taps = ADD_TO_CART_WITH_VARIANT.steps.filter((s) => s.kind === 'tap');
    expect(taps).toHaveLength(2);
  });

  it('exports CHECKOUT_GENERIC with 5 shipping + 3 payment type steps', () => {
    const types = CHECKOUT_GENERIC.steps.filter((s) => s.kind === 'type');
    expect(types).toHaveLength(8);
  });

  it('V532C_CHECKOUT_RECIPES catalogues all three reference recipes', () => {
    expect(V532C_CHECKOUT_RECIPES).toHaveLength(3);
    const ids = V532C_CHECKOUT_RECIPES.map((r) => r.id);
    expect(ids).toContain('add_to_cart_generic');
    expect(ids).toContain('add_to_cart_with_variant');
    expect(ids).toContain('checkout_generic');
  });
});
