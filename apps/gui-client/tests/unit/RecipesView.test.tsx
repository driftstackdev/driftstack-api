import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const listRecipes = vi.fn(() => new Promise<never>(() => {}));
const STABLE_CLIENT = { recipes: { list: listRecipes } };

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client: STABLE_CLIENT }),
}));

const { RecipesView } = await import('../../src/views/RecipesView');

describe('RecipesView initial loading state', () => {
  it('matches the loaded master/detail layout while the recipe list is pending', async () => {
    const { container } = render(<RecipesView />);

    const status = await screen.findByRole('status', { name: 'Loading saved tasks' });
    expect(status).toHaveClass('flex', 'min-h-0', 'flex-1', 'gap-4');
    expect(status.className).toBe('flex min-h-0 flex-1 gap-4');

    expect(container.querySelectorAll('[data-component="recipes-skeleton-row"]')).toHaveLength(6);
    expect(
      container.querySelectorAll('[data-component="recipes-skeleton-row"] > .animate-pulse'),
    ).toHaveLength(12);

    const master = container.querySelector('[data-component="recipes-skeleton-master"]');
    expect(master?.parentElement).toHaveClass('w-80');
    expect(master?.parentElement?.firstElementChild).toHaveClass('h-9', 'w-full');

    const detail = container.querySelector('[data-component="recipes-skeleton-detail"]');
    expect(detail).toHaveClass('flex-1', 'border', 'border-surface-divider');
  });
});
