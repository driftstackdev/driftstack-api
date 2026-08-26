import { describe, expect, it } from 'vitest';
import {
  buildFillFormRecipe,
  buildLoginRecipe,
  CONTACT_FORM_GENERIC,
  LOGIN_FLOW_GENERIC,
  MockRecipeRegistry,
  MockRecipeRunner,
  V532B_FORM_RECIPES,
  type FormField,
} from '../src/index.js';

describe('V-532.B buildLoginRecipe', () => {
  it('produces a recipe with navigate + wait + 2 types + tap + wait + capture sequence', () => {
    const recipe = buildLoginRecipe({
      id: 'test_login',
      name: 'Test Login',
      loginUrl: 'https://example.com/login',
      usernameSelector: '#u',
      passwordSelector: '#p',
      submitSelector: '#submit',
      successSelector: '.dashboard',
      username: 'alice',
      password: 's3cret',
    });

    expect(recipe.id).toBe('test_login');
    expect(recipe.category).toBe('login');

    const kinds = recipe.steps.map((s) => s.kind);
    expect(kinds).toEqual(['navigate', 'wait', 'type', 'type', 'tap', 'wait', 'capture']);

    // Verify credentials made it into the type steps in order.
    const typeSteps = recipe.steps.filter((s) => s.kind === 'type');
    expect(typeSteps).toHaveLength(2);
    if (typeSteps[0]!.kind === 'type') expect(typeSteps[0]!.text).toBe('alice');
    if (typeSteps[1]!.kind === 'type') expect(typeSteps[1]!.text).toBe('s3cret');
  });

  it('username and password selectors land on their respective type steps', () => {
    const recipe = buildLoginRecipe({
      id: 'test_sel',
      name: 'Test Selectors',
      loginUrl: 'https://example.com/login',
      usernameSelector: '#username-field',
      passwordSelector: '#password-field',
      submitSelector: '#go',
      successSelector: '.main',
      username: 'u',
      password: 'p',
    });
    const typeSteps = recipe.steps.filter((s) => s.kind === 'type');
    if (typeSteps[0]!.kind === 'type') expect(typeSteps[0]!.selector).toBe('#username-field');
    if (typeSteps[1]!.kind === 'type') expect(typeSteps[1]!.selector).toBe('#password-field');
  });
});

describe('V-532.B buildFillFormRecipe', () => {
  it('produces one type step per field plus the navigate + tap + capture envelope', () => {
    const fields: FormField[] = [
      { selector: '#a', value: 'A' },
      { selector: '#b', value: 'B' },
      { selector: '#c', value: 'C' },
      { selector: '#d', value: 'D' },
    ];
    const recipe = buildFillFormRecipe({
      id: 'test_form',
      name: 'Test Form',
      formUrl: 'https://example.com/form',
      fields,
      submitSelector: '#go',
      successSelector: '.ok',
    });
    const typeSteps = recipe.steps.filter((s) => s.kind === 'type');
    expect(typeSteps).toHaveLength(4);

    const kinds = recipe.steps.map((s) => s.kind);
    expect(kinds[0]).toBe('navigate');
    expect(kinds[1]).toBe('wait'); // wait for first field selector
    expect(kinds[kinds.length - 3]).toBe('tap');
    expect(kinds[kinds.length - 2]).toBe('wait');
    expect(kinds[kinds.length - 1]).toBe('capture');
  });

  it('preserves field order in the type-step sequence', () => {
    const fields: FormField[] = [
      { selector: '#first', value: 'first-val' },
      { selector: '#second', value: 'second-val' },
      { selector: '#third', value: 'third-val' },
    ];
    const recipe = buildFillFormRecipe({
      id: 'order',
      name: 'Order test',
      formUrl: 'https://example.com/form',
      fields,
      submitSelector: '#go',
      successSelector: '.ok',
    });
    const typeSteps = recipe.steps.filter((s) => s.kind === 'type');
    // One type step per field, asserted before the loop. Previously the body was
    // wrapped in `if (step.kind === 'type')`, so a step of any other kind — or a
    // shifted sequence — skipped the comparison and the arm passed having
    // checked nothing.
    expect(typeSteps.length, 'one type step per field').toBe(fields.length);
    for (let i = 0; i < fields.length; i += 1) {
      const step = typeSteps[i];
      expect(step?.kind, `type step ${String(i)} exists`).toBe('type');
      if (step?.kind !== 'type') throw new Error('unreachable — asserted above');
      expect(step.selector).toBe(fields[i]!.selector);
      expect(step.text).toBe(fields[i]!.value);
    }
  });

  it('rejects empty fields', () => {
    expect(() =>
      buildFillFormRecipe({
        id: 'no-fields',
        name: 'No fields',
        formUrl: 'https://example.com',
        fields: [],
        submitSelector: '#go',
        successSelector: '.ok',
      }),
    ).toThrow(/at least 1 entry/);
  });

  it('first wait barrier targets the first field selector', () => {
    const recipe = buildFillFormRecipe({
      id: 'first-wait',
      name: 'First wait test',
      formUrl: 'https://example.com/x',
      fields: [
        { selector: '.first-input', value: 'a' },
        { selector: '.second-input', value: 'b' },
      ],
      submitSelector: '#go',
      successSelector: '.ok',
    });
    const firstWait = recipe.steps[1];
    // Asserted, not assumed: `if (firstWait.kind === 'wait')` passed whenever
    // step 1 was anything else, which is exactly the regression this arm names.
    expect(firstWait?.kind, 'step 1 is the first wait barrier').toBe('wait');
    if (firstWait?.kind !== 'wait') throw new Error('unreachable — asserted above');
    expect(firstWait.value).toBe('.first-input');
  });
});

describe('V-532.B reference recipes', () => {
  it('catalogue contains both reference recipes', () => {
    expect(V532B_FORM_RECIPES).toHaveLength(2);
    expect(V532B_FORM_RECIPES.map((r) => r.id)).toEqual([
      'login_flow_generic',
      'contact_form_generic',
    ]);
  });

  it('LOGIN_FLOW_GENERIC has login shape', () => {
    expect(LOGIN_FLOW_GENERIC.id).toBe('login_flow_generic');
    expect(LOGIN_FLOW_GENERIC.category).toBe('login');
    const kinds = LOGIN_FLOW_GENERIC.steps.map((s) => s.kind);
    expect(kinds).toEqual(['navigate', 'wait', 'type', 'type', 'tap', 'wait', 'capture']);
  });

  it('CONTACT_FORM_GENERIC has form shape with 3 fields', () => {
    expect(CONTACT_FORM_GENERIC.id).toBe('contact_form_generic');
    expect(CONTACT_FORM_GENERIC.category).toBe('form');
    const typeSteps = CONTACT_FORM_GENERIC.steps.filter((s) => s.kind === 'type');
    expect(typeSteps).toHaveLength(3);
  });

  it('MockRecipeRunner executes both reference recipes deterministically', async () => {
    const registry = new MockRecipeRegistry([...V532B_FORM_RECIPES]);
    const runner = new MockRecipeRunner(registry);
    for (const recipe of V532B_FORM_RECIPES) {
      const result = await runner.run(recipe.id, { sessionId: 'test-session' });
      expect(result.status).toBe('ok');
      expect(result.steps.length).toBe(recipe.steps.length);
      expect(result.steps.every((s) => s.status === 'ok')).toBe(true);
    }
  });
});
