/**
 * Reject a locator the AI emitted that is not a valid W3C `css selector`.
 *
 * ⛔ WHY THIS EXISTS — measured live against production on 2026-09-02. The owner's
 * own prompt ("go to driftstack.dev, create an account…") produced a plan whose
 * tap step carried:
 *
 *     a[href*='signup'], a[href*='sign-up'], button:has-text('Sign up')
 *
 * `:has-text()` is **Playwright syntax, not CSS**. `mapInteract` dispatches a tap
 * as `{ strategy: 'css selector', value: <selector> }` straight to W3C WebDriver,
 * which requires real CSS — so the harness rejected it and the step surfaced as
 * an opaque **HTTP 500** with diagnosis category "unknown", `retryable: false`.
 * Navigation, waiting and capture all worked; only interaction failed. That is
 * most real automation tasks, because "click the button that says X" is how a
 * person describes almost every step.
 *
 * ⭐ AN ALLOWLIST, NOT A DENYLIST. Listing the Playwright idioms I happen to know
 * (`:has-text`, `:contains`, `:visible`, `:nth-match`) goes blind on the next one.
 * Instead every pseudo-class in the selector must be a STANDARD one; anything
 * else is refused by construction.
 *
 * ⚠️ `css-what` PARSES `:has-text()` HAPPILY — it is permissive about unknown
 * pseudo-classes, so "it parsed" is NOT a validity check and using the parser
 * alone would have been a guard that guards nothing. What the parser is used for
 * is extracting pseudo NAMES reliably (a regex over selector text mis-handles
 * `:` inside attribute values); the allowlist is what actually decides.
 */
import { parse } from 'css-what';

/**
 * Pseudo-classes and pseudo-elements a real CSS engine accepts.
 *
 * Deliberately generous — a valid selector wrongly refused is worse than an
 * invalid one dispatched, because the refusal blocks work the customer asked
 * for while the dispatch merely fails a step that was going to fail anyway.
 */
const STANDARD_PSEUDOS = new Set<string>([
  // structural
  'root',
  'empty',
  'first-child',
  'last-child',
  'only-child',
  'first-of-type',
  'last-of-type',
  'only-of-type',
  'nth-child',
  'nth-last-child',
  'nth-of-type',
  'nth-last-of-type',
  'scope',
  // logical
  'not',
  'is',
  'where',
  'has',
  'matches',
  'any',
  // state
  'hover',
  'active',
  'focus',
  'focus-visible',
  'focus-within',
  'target',
  'target-within',
  'enabled',
  'disabled',
  'checked',
  'indeterminate',
  'default',
  'valid',
  'invalid',
  'in-range',
  'out-of-range',
  'required',
  'optional',
  'read-only',
  'read-write',
  'placeholder-shown',
  'autofill',
  'link',
  'visited',
  'any-link',
  'local-link',
  'defined',
  'playing',
  'paused',
  'muted',
  'fullscreen',
  'picture-in-picture',
  'modal',
  'popover-open',
  'open',
  'dir',
  'lang',
  'host',
  'host-context',
  // pseudo-elements
  'before',
  'after',
  'first-line',
  'first-letter',
  'selection',
  'placeholder',
  'marker',
  'backdrop',
  'file-selector-button',
  'part',
  'slotted',
  'cue',
  'cue-region',
]);

export interface SelectorVerdict {
  ok: boolean;
  /** Customer-facing reason, present only when ok === false. */
  reason?: string;
}

/**
 * PURE. Exported so the rule is unit-testable without a dispatch or a harness.
 */
export function validateCssSelector(selector: string): SelectorVerdict {
  const trimmed = selector.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'the selector is empty' };

  // XPath is a locator, just not the one this dispatch declares.
  if (trimmed.startsWith('/') || trimmed.startsWith('(/')) {
    return {
      ok: false,
      reason: `"${clip(trimmed)}" looks like XPath; taps are dispatched as a CSS selector`,
    };
  }
  // Playwright's engine prefixes and chaining combinator are not CSS.
  if (/^\s*(text|xpath|css|id|data-testid)\s*=/i.test(trimmed) || trimmed.includes('>>')) {
    return {
      ok: false,
      reason: `"${clip(trimmed)}" uses a Playwright locator engine; taps are dispatched as a CSS selector`,
    };
  }

  let pseudos: string[];
  try {
    pseudos = collectPseudos(parse(trimmed));
  } catch {
    return { ok: false, reason: `"${clip(trimmed)}" is not a parseable CSS selector` };
  }

  const unknown = pseudos.find((name) => !STANDARD_PSEUDOS.has(name.toLowerCase()));
  if (unknown !== undefined) {
    return {
      ok: false,
      reason: `":${unknown}" is not a CSS pseudo-class; taps are dispatched as a CSS selector, so match on an attribute or structure instead`,
    };
  }
  return { ok: true };
}

/** Bound what reaches customer copy — a selector may be up to 4096 chars. */
function clip(s: string): string {
  return s.length <= 80 ? s : `${s.slice(0, 80)}…`;
}

/** css-what returns a nested array of token objects; pseudos carry `name`. */
function collectPseudos(ast: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const token = node as { type?: unknown; name?: unknown };
    if (
      (token.type === 'pseudo' || token.type === 'pseudo-element') &&
      typeof token.name === 'string'
    ) {
      found.push(token.name);
    }
    for (const value of Object.values(node as Record<string, unknown>)) walk(value);
  };
  walk(ast);
  return found;
}
