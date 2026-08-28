import { describe, expect, it } from 'vitest';
import { selectorImpliesSensitiveInput } from '../../src/services/agent-sensitive-input.js';

describe('selectorImpliesSensitiveInput', () => {
  it.each([
    'input[type=password]',
    'input[autocomplete="current-password"]',
    '[autocomplete=one-time-code]',
    '#password',
    '#login_passwd',
    'input[name="otp"]',
    '.totp-input',
    '#mfa-code',
    '#2fa_pin',
    '[name=cvv]',
    '[data-field="cvc"]',
    '#cc-number',
    '#card-security',
    '#api-key',
    '[name="client_secret"]',
    '#ｐａｓｓｗｏｒｄ',
    // A CSS combinator directly after the token. Every fixture above places the
    // token at the end of the string or before one of the delimiters the old
    // boundary list happened to contain, so none of them reached the branch that
    // was broken: all five of these returned FALSE, and a `type` intent with such
    // a selector kept its `value` in the public copy.
    '#password>input',
    '#password,#email',
    '#password+label',
    '#password~span',
    ':is(#password)',
    '#otp,#submit',
  ])('classifies obvious secret selector %s', (selector) => {
    expect(selectorImpliesSensitiveInput(selector)).toBe(true);
  });

  it.each([
    '#display-name',
    '#email',
    '#shipping-address',
    '#coupon-code',
    '#search-tokenizer',
    '[autocomplete=name]',
    'input[type=text]',
    // Alphanumeric on either side must still block a substring hit — widening the
    // boundary to any non-alphanumeric must not turn these into secrets.
    '#spin',
    '#pinboard',
    '#tokenizer',
    '#weaponstore',
  ])('leaves ordinary selector %s unchanged', (selector) => {
    expect(selectorImpliesSensitiveInput(selector)).toBe(false);
  });
});
