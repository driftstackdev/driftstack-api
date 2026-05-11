import { describe, expect, it } from 'vitest';
import {
  buildWizardRecipe,
  SIGNUP_WIZARD_GENERIC,
  V532D_WIZARD_RECIPES,
  type FormField,
  type WizardStep,
} from '../src/index.js';

describe('V-532.D buildWizardRecipe — basic shape', () => {
  it('produces navigate→wait then per-step body then capture', () => {
    const recipe = buildWizardRecipe({
      id: 'w',
      name: 'W',
      startUrl: 'https://x/',
      startWaitSelector: '#first',
      steps: [
        {
          id: 'one',
          fields: [{ selector: '#a', value: '1' }],
          advanceSelector: '#next1',
          nextWaitSelector: '#second',
        },
        {
          id: 'two',
          fields: [{ selector: '#b', value: '2' }],
          advanceSelector: '#next2',
          nextWaitSelector: '.done',
        },
      ],
    });

    expect(recipe.category).toBe('wizard');
    expect(recipe.steps.map((s) => s.kind)).toEqual([
      'navigate',
      'wait',
      'type', // step1 field
      'tap', // step1 advance
      'wait', // step1 → step2
      'type', // step2 field
      'tap', // step2 advance
      'wait', // step2 → done
      'capture',
    ]);
  });

  it('rejects empty steps', () => {
    expect(() =>
      buildWizardRecipe({
        id: 'x',
        name: 'X',
        startUrl: 'https://x',
        startWaitSelector: '#a',
        steps: [],
      }),
    ).toThrow(/steps/);
  });
});

describe('V-532.D buildWizardRecipe — branch-on-state mechanics', () => {
  it('inserts beforeAdvanceTap before the advance tap when provided', () => {
    const recipe = buildWizardRecipe({
      id: 'w',
      name: 'W',
      startUrl: 'https://x',
      startWaitSelector: '#first',
      steps: [
        {
          id: 'consent',
          beforeAdvanceTap: '#consent-checkbox',
          advanceSelector: '#advance',
          nextWaitSelector: '#done',
        },
      ],
    });
    const taps = recipe.steps.filter((s) => s.kind === 'tap');
    expect(taps).toHaveLength(2);
    if (taps[0]?.kind === 'tap') expect(taps[0].selector).toBe('#consent-checkbox');
    if (taps[1]?.kind === 'tap') expect(taps[1].selector).toBe('#advance');
  });

  it('omits beforeAdvanceTap when not provided', () => {
    const recipe = buildWizardRecipe({
      id: 'w',
      name: 'W',
      startUrl: 'https://x',
      startWaitSelector: '#first',
      steps: [
        {
          id: 'plain',
          advanceSelector: '#advance',
          nextWaitSelector: '#done',
        },
      ],
    });
    const taps = recipe.steps.filter((s) => s.kind === 'tap');
    expect(taps).toHaveLength(1);
    if (taps[0]?.kind === 'tap') expect(taps[0].selector).toBe('#advance');
  });

  it('handles a step with empty fields', () => {
    const recipe = buildWizardRecipe({
      id: 'w',
      name: 'W',
      startUrl: 'https://x',
      startWaitSelector: '#first',
      steps: [
        {
          id: 'no-fields',
          fields: [],
          advanceSelector: '#advance',
          nextWaitSelector: '#done',
        },
      ],
    });
    const types = recipe.steps.filter((s) => s.kind === 'type');
    expect(types).toHaveLength(0);
  });

  it('post-tap wait targets nextWaitSelector', () => {
    const recipe = buildWizardRecipe({
      id: 'w',
      name: 'W',
      startUrl: 'https://x',
      startWaitSelector: '#first',
      steps: [
        {
          id: 'one',
          advanceSelector: '#go',
          nextWaitSelector: '.target-page',
        },
      ],
    });
    const waits = recipe.steps.filter((s) => s.kind === 'wait');
    // 2 waits: initial start wait + post-advance wait.
    expect(waits).toHaveLength(2);
    if (waits[1]?.kind === 'wait') {
      expect(waits[1].value).toBe('.target-page');
    }
  });
});

describe('V-532.D buildWizardRecipe — multi-step composition', () => {
  it('walks 4 steps with multiple fields each', () => {
    const fields: readonly FormField[] = [
      { selector: '#a', value: '1' },
      { selector: '#b', value: '2' },
    ];
    const steps: readonly WizardStep[] = [
      { id: 's1', fields, advanceSelector: '#n1', nextWaitSelector: '#p2' },
      { id: 's2', fields, advanceSelector: '#n2', nextWaitSelector: '#p3' },
      { id: 's3', fields, advanceSelector: '#n3', nextWaitSelector: '#p4' },
      { id: 's4', fields, advanceSelector: '#n4', nextWaitSelector: '.done' },
    ];
    const recipe = buildWizardRecipe({
      id: 'big',
      name: 'big',
      startUrl: 'https://x',
      startWaitSelector: '#a',
      steps,
    });
    const types = recipe.steps.filter((s) => s.kind === 'type');
    const taps = recipe.steps.filter((s) => s.kind === 'tap');
    const waits = recipe.steps.filter((s) => s.kind === 'wait');
    expect(types).toHaveLength(8); // 4 steps × 2 fields
    expect(taps).toHaveLength(4); // 4 advance taps
    expect(waits).toHaveLength(5); // start wait + 4 post-advance waits
  });
});

describe('V-532.D reference recipes', () => {
  it('SIGNUP_WIZARD_GENERIC is a 3-step signup wizard', () => {
    expect(SIGNUP_WIZARD_GENERIC.category).toBe('wizard');
    const taps = SIGNUP_WIZARD_GENERIC.steps.filter((s) => s.kind === 'tap');
    // 3 advance taps + 1 consent-checkbox tap = 4 total.
    expect(taps).toHaveLength(4);
  });

  it('SIGNUP_WIZARD_GENERIC types email + password + name + org', () => {
    const types = SIGNUP_WIZARD_GENERIC.steps.filter((s) => s.kind === 'type');
    expect(types).toHaveLength(4);
    const selectors = types
      .map((s) => (s.kind === 'type' ? s.selector : null))
      .filter((s): s is string => s !== null);
    expect(selectors).toContain('#step-1-email');
    expect(selectors).toContain('#step-1-password');
    expect(selectors).toContain('#step-2-name');
    expect(selectors).toContain('#step-2-org');
  });

  it('V532D_WIZARD_RECIPES catalog includes SIGNUP_WIZARD_GENERIC', () => {
    expect(V532D_WIZARD_RECIPES).toContain(SIGNUP_WIZARD_GENERIC);
  });
});
