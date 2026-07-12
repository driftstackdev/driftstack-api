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
  ])('leaves ordinary selector %s unchanged', (selector) => {
    expect(selectorImpliesSensitiveInput(selector)).toBe(false);
  });
});
