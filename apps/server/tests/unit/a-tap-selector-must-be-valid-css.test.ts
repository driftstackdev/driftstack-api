import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateCssSelector } from '../../src/services/agent-selector-validation.js';

/**
 * Measured LIVE against production on 2026-09-02, using the owner's own prompt
 * ("go to driftstack.dev, create an account with my email…"). The AI produced a
 * correct plan whose tap step carried:
 *
 *     a[href*='signup'], a[href*='sign-up'], button:has-text('Sign up')
 *
 * `:has-text()` is Playwright syntax, not CSS. `mapInteract` dispatches a tap as
 * `{ strategy: 'css selector' }` to W3C WebDriver, so the harness rejected it and
 * the step surfaced as an opaque **HTTP 500**, diagnosis "unknown",
 * `retryable: false`. Navigate, wait and capture all succeeded in the same run —
 * only interaction failed, which is most real tasks.
 */
describe('a tap selector must be valid CSS', () => {
  it('⛔ refuses the exact selector that produced the live HTTP 500', () => {
    const v = validateCssSelector(
      "a[href*='signup'], a[href*='sign-up'], a[href*='register'], button:has-text('Sign up')",
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/has-text/);
    // The reason must be actionable, not just a rejection.
    expect(v.reason).toMatch(/attribute or structure/);
  });

  it('is an ALLOWLIST — it refuses a Playwright pseudo it was never told about', () => {
    // The point of allowlisting standard pseudo-classes rather than denylisting
    // known-bad ones: the next engine-specific pseudo is caught without anyone
    // having heard of it.
    for (const sel of [
      'button:has-text("x")',
      'div:contains("x")',
      'a:visible',
      'li:nth-match(2)',
      'span:react(Foo)',
      'p:text-is("x")',
    ]) {
      expect(validateCssSelector(sel).ok, sel).toBe(false);
    }
  });

  it('refuses XPath and Playwright engine prefixes', () => {
    for (const sel of [
      '//button[text()="Sign up"]',
      'text=Sign up',
      'div >> button',
      'xpath=//a',
    ]) {
      expect(validateCssSelector(sel).ok, sel).toBe(false);
    }
  });

  it('⛔ POSITIVE CONTROL — accepts the CSS the model should emit instead', () => {
    // A refusal that also blocks valid selectors is worse than the bug: it stops
    // work the customer asked for, where the bug only failed a step already lost.
    for (const sel of [
      "a[href*='signup'], a[href*='register']",
      'button[type="submit"]',
      'input[type="email"], input[name="email"], input#email',
      '[aria-label="Sign up"]',
      '[data-testid="signup"]',
      'form > button:first-child',
      'input:not([disabled])',
      'li:nth-child(2)',
      'button:has(span)',
      'a:hover',
      'p::first-line',
    ]) {
      const v = validateCssSelector(sel);
      expect(v.ok, `${sel} → ${String(v.reason)}`).toBe(true);
    }
  });

  it('refuses an empty selector with a reason', () => {
    expect(validateCssSelector('   ').ok).toBe(false);
    expect(validateCssSelector('   ').reason).toMatch(/empty/);
  });

  it('bounds what reaches customer copy', () => {
    // A selector may be 4096 chars; the reason must not carry all of it.
    const v = validateCssSelector(`${'a'.repeat(500)}:has-text("x")`);
    expect(v.ok).toBe(false);
    expect((v.reason ?? '').length).toBeLessThan(300);
  });
});

describe('the decomposer knows it is driving a phone', () => {
  const prompt = readFileSync(
    resolve(__dirname, '../../src/services/agent-decomposer-claude.ts'),
    'utf8',
  );

  it('⛔ states the device, because the model plans a desktop layout otherwise', () => {
    // Measured live 2026-09-02 AFTER the CSS fix landed: the model emitted
    // perfectly valid `a[href*="signup"]` and still failed "element not found"
    // — driftstack.dev DOES carry that link, but these are phone viewports where
    // the header nav collapses behind a toggle (the live page serves
    // aria-label="Open navigation menu"). The prompt said only "a driftstack
    // browser session"; it never said iPhone, Safari, mobile or viewport.
    expect(prompt).toMatch(/REAL iPHONE RUNNING SAFARI/);
    expect(prompt).toMatch(/viewport is phone-width and portrait/);
  });

  it('tells it to open a collapsed menu FIRST, since plans do not branch', () => {
    // The decomposer emits an ordered plan up front with no conditionals, so
    // "retry if not found" is not expressible — the menu tap must be planned.
    expect(prompt).toMatch(/COLLAPSED behind a menu toggle/);
    expect(prompt).toMatch(/aria-label\*="menu" i/);
    expect(prompt).toMatch(/no', \n?\s*'\s*branching|no',\s*$|branching/m);
  });

  it('covers the other two phone-layout reach problems', () => {
    expect(prompt).toMatch(/below the fold needs a scroll/);
    expect(prompt).toMatch(/Footers are long on phones/);
  });
});
