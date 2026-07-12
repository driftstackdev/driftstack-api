import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const listRecipes = vi.fn<() => Promise<{ data: never[] }>>(
  () => new Promise<{ data: never[] }>(() => {}),
);
const STABLE_CLIENT = { recipes: { list: listRecipes } };
let currentClient: typeof STABLE_CLIENT | null = STABLE_CLIENT;

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client: currentClient }),
}));

const { RecipesView } = await import('../../src/views/RecipesView');

describe('RecipesView initial loading state', () => {
  beforeEach(() => {
    currentClient = STABLE_CLIENT;
    listRecipes.mockReset();
    listRecipes.mockImplementation(() => new Promise<{ data: never[] }>(() => {}));
  });

  it('matches the loaded master/detail layout while the recipe list is pending', async () => {
    const { container } = render(<RecipesView onGoToAI={vi.fn()} onGoToSettings={vi.fn()} />);

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

  it('links the signed-out recovery state directly to Settings', () => {
    currentClient = null;
    const onGoToSettings = vi.fn();

    render(<RecipesView onGoToAI={vi.fn()} onGoToSettings={onGoToSettings} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(onGoToSettings).toHaveBeenCalledOnce();
  });

  it('links an empty library directly to AI Browser Automation', async () => {
    listRecipes.mockResolvedValueOnce({ data: [] });
    const onGoToAI = vi.fn();

    render(<RecipesView onGoToAI={onGoToAI} onGoToSettings={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open AI Browser Automation' }));
    expect(onGoToAI).toHaveBeenCalledOnce();
  });
});
