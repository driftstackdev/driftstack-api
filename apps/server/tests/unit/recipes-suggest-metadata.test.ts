// Doc-132 §5.2 (recipe auto-generation) v1.0 slice — unit tests for the
// deterministic suggestRecipeMetadata() pure function. See services/
// recipes.ts for why this is deliberately NOT a real ML/training
// pipeline (that's a Tier-3 customer-data-handling call): this derives
// a label + description from the customer's OWN intent_log only.

import { describe, expect, it } from 'vitest';
import { suggestRecipeMetadata } from '../../src/services/recipes.js';

describe('suggestRecipeMetadata', () => {
  it('derives a "Fill form on <host>" label + description when the log navigates + types', () => {
    const s = suggestRecipeMetadata([
      { kind: 'navigate', url: 'https://www.example.com/login' },
      { kind: 'interact', action: 'type', selector: '#email', value: 'x' },
      { kind: 'interact', action: 'type', selector: '#password', value: 'y' },
      { kind: 'interact', action: 'tap', selector: '#submit' },
      { kind: 'interact', action: 'press', value: 'Enter' },
    ]);
    // www. is stripped for a cleaner suggested label/description.
    expect(s.suggestedLabel).toBe('Fill form on example.com');
    expect(s.suggestedDescription).toBe(
      'Navigates to example.com, fills 2 fields, taps 1 element, submits.',
    );
  });

  it('derives an "Automation on <host>" label when there is no typing (tap-only flow)', () => {
    const s = suggestRecipeMetadata([
      { kind: 'navigate', url: 'https://shop.example.com/catalog' },
      { kind: 'interact', action: 'tap', selector: '.product' },
      { kind: 'scroll', direction: 'down', amount_px: 400 },
    ]);
    expect(s.suggestedLabel).toBe('Automation on shop.example.com');
    expect(s.suggestedDescription).toBe('Navigates to shop.example.com, taps 1 element.');
  });

  it('uses the FIRST distinct host when the log navigates across multiple hosts', () => {
    const s = suggestRecipeMetadata([
      { kind: 'navigate', url: 'https://a.example.com/' },
      { kind: 'navigate', url: 'https://b.example.com/' },
    ]);
    expect(s.suggestedLabel).toContain('a.example.com');
  });

  it('falls back to a generic label + step-count description for a non-navigate log', () => {
    const s = suggestRecipeMetadata([
      { kind: 'wait', condition: 'idle' },
      { kind: 'capture', capture: 'dom_snapshot' },
    ]);
    expect(s.suggestedLabel).toBe('Untitled automation');
    expect(s.suggestedDescription).toBe('Replays 2 recorded steps.');
  });

  it('handles an empty intent_log without throwing', () => {
    const s = suggestRecipeMetadata([]);
    expect(s.suggestedLabel.length).toBeGreaterThan(0);
    expect(s.suggestedDescription).toBe('Replays 0 recorded steps.');
  });

  it('skips a malformed navigate URL instead of throwing', () => {
    const s = suggestRecipeMetadata([
      { kind: 'navigate', url: 'not a valid url' },
      { kind: 'interact', action: 'tap', selector: '#x' },
    ]);
    expect(s.suggestedLabel).toBe('Untitled automation');
  });

  it('never exceeds the label (120) / description (2000) length caps', () => {
    const hugeUrl = 'https://' + 'a'.repeat(200) + '.example.com/';
    const s = suggestRecipeMetadata([{ kind: 'navigate', url: hugeUrl }]);
    expect(s.suggestedLabel.length).toBeLessThanOrEqual(120);
    expect(s.suggestedDescription.length).toBeLessThanOrEqual(2000);
  });

  it('singular-vs-plural wording: exactly 1 field/element reads "field"/"element" not "fields"/"elements"', () => {
    const s = suggestRecipeMetadata([
      { kind: 'navigate', url: 'https://example.com' },
      { kind: 'interact', action: 'type', selector: '#q', value: 'x' },
      { kind: 'interact', action: 'tap', selector: '#go' },
    ]);
    expect(s.suggestedDescription).toContain('1 field');
    expect(s.suggestedDescription).not.toContain('1 fields');
    expect(s.suggestedDescription).toContain('1 element');
    expect(s.suggestedDescription).not.toContain('1 elements');
  });
});
