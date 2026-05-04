import { describe, expect, it } from 'vitest';
import {
  MockRecipeRegistry,
  MockRecipeRunner,
  type Recipe,
  type RecipeContext,
} from '../src/index.js';

const CTX: RecipeContext = { sessionId: 'ses_test' };

describe('MockRecipeRegistry', () => {
  it('returns the default catalogue when no override is supplied', () => {
    const reg = new MockRecipeRegistry();
    expect(reg.list().length).toBeGreaterThan(0);
    expect(reg.get('noop_smoke_test')).toBeDefined();
  });

  it('returns undefined for unknown recipe id', () => {
    const reg = new MockRecipeRegistry();
    expect(reg.get('does_not_exist')).toBeUndefined();
  });

  it('listByCategory filters correctly', () => {
    const reg = new MockRecipeRegistry();
    const diagnostic = reg.listByCategory('diagnostic');
    expect(diagnostic.length).toBeGreaterThan(0);
    expect(diagnostic.every((r) => r.category === 'diagnostic')).toBe(true);
  });

  it('honors an injected catalogue', () => {
    const custom: Recipe = {
      id: 'custom',
      name: 'custom',
      steps: [{ kind: 'navigate', url: 'https://example.com' }],
    };
    const reg = new MockRecipeRegistry([custom]);
    expect(reg.list()).toEqual([custom]);
    expect(reg.get('custom')).toEqual(custom);
  });
});

describe('MockRecipeRunner', () => {
  it('runs the noop smoke test and reports ok per step', async () => {
    const runner = new MockRecipeRunner();
    const result = await runner.run('noop_smoke_test', CTX);
    expect(result.recipeId).toBe('noop_smoke_test');
    expect(result.status).toBe('ok');
    expect(result.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(result.steps).toHaveLength(2); // navigate + capture
    expect(result.durationMs).toBe(2 * 50);
  });

  it('rejects with an Error for unknown recipe', async () => {
    const runner = new MockRecipeRunner();
    await expect(runner.run('not_a_recipe', CTX)).rejects.toThrow('recipe not found');
  });

  it('produces deterministic output for identical inputs', async () => {
    const runner = new MockRecipeRunner();
    const a = await runner.run('login_form_demo', CTX);
    const b = await runner.run('login_form_demo', CTX);
    expect(a).toEqual(b);
  });

  it('honors an injected registry', async () => {
    const onlyRecipe: Recipe = {
      id: 'only',
      name: 'only',
      steps: [
        { kind: 'navigate', url: 'https://example.com' },
        { kind: 'tap', selector: '#x' },
        { kind: 'capture', what: 'screenshot' },
      ],
    };
    const runner = new MockRecipeRunner(new MockRecipeRegistry([onlyRecipe]));
    const result = await runner.run('only', CTX);
    expect(result.steps).toHaveLength(3);
    expect(result.durationMs).toBe(3 * 50);
  });
});
