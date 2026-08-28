import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const listRecipes = vi.fn<() => Promise<{ data: never[] }>>(
  () => new Promise<{ data: never[] }>(() => {}),
);
const getRecipe = vi.fn<(id: string) => Promise<unknown>>(() => new Promise(() => {}));
const STABLE_CLIENT = { recipes: { list: listRecipes, get: getRecipe } };
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

  it('turns native list failures into safe retry copy', async () => {
    listRecipes.mockRejectedValueOnce(
      new TypeError('fetch failed: getaddrinfo ENOTFOUND internal-api.private'),
    );

    render(<RecipesView onGoToAI={vi.fn()} onGoToSettings={vi.fn()} />);

    expect(await screen.findByText('Check your connection and try again.')).toBeInTheDocument();
    expect(screen.queryByText(/internal-api\.private/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

// ── the detail half ───────────────────────────────────────────────────────────
// This view measured 28.9% BRANCH coverage — 54 of 76 uncovered — with the four
// arms above green. Every one of them stops at the list layer: the client fixture
// had no `recipes.get`, so selection, the detail state machine, cancellation on
// re-select, search, and all six intent-kind renderers ran nowhere. Reading them
// proves the shape; only execution proves the switch arms produce what they claim.
describe('RecipesView detail half', () => {
  const recipe = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'rec_1',
    label: 'Order coffee',
    description: 'Reorders the usual',
    intent_count: 2,
    agent_session_id: 'agt_src',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
    ...over,
  });
  const detailOf = (
    intent_log: Array<Record<string, unknown>>,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({ ...recipe(over), intent_log });

  beforeEach(() => {
    currentClient = STABLE_CLIENT;
    listRecipes.mockReset();
    getRecipe.mockReset();
    listRecipes.mockResolvedValue({
      data: [recipe(), recipe({ id: 'rec_2', label: 'Pay rent' })] as never[],
    });
  });

  async function selectFirst(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: /Order coffee/ }));
  }

  it("selecting a row marks it pressed and fetches ONLY that recipe's detail", async () => {
    getRecipe.mockImplementation(() => new Promise(() => {}));
    render(<RecipesView onGoToAI={vi.fn()} onGoToSettings={vi.fn()} />);
    await selectFirst();

    expect(screen.getByRole('button', { name: /Order coffee/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /Pay rent/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(getRecipe).toHaveBeenCalledTimes(1);
    expect(getRecipe).toHaveBeenCalledWith('rec_1');
    // Detail is loading, not blank and not errored.
    expect(screen.getByRole('status', { name: 'Loading saved task' })).toBeInTheDocument();
  });

  it('CRITICAL a detail fetch failure shows humanised copy, never the raw error', async () => {
    getRecipe.mockRejectedValue(
      new TypeError('fetch failed: getaddrinfo ENOTFOUND internal-api.private'),
    );
    render(<RecipesView onGoToAI={vi.fn()} onGoToSettings={vi.fn()} />);
    await selectFirst();

    expect(await screen.findByText('Check your connection and try again.')).toBeInTheDocument();
    expect(screen.queryByText(/internal-api\.private/)).toBeNull();
  });

  it('CRITICAL re-selecting before the first detail resolves discards the STALE response — the panel must show the recipe the user clicked last', async () => {
    let resolveFirst!: (v: unknown) => void;
    getRecipe.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveFirst = r;
        }),
    );
    getRecipe.mockImplementationOnce(() =>
      Promise.resolve(detailOf([], { id: 'rec_2', label: 'Pay rent' })),
    );
    render(<RecipesView onGoToAI={vi.fn()} onGoToSettings={vi.fn()} />);

    await selectFirst();
    fireEvent.click(screen.getByRole('button', { name: /Pay rent/ }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Pay rent' })).toBeInTheDocument();

    // The first (slow) response lands late. Without the cancelled flag it would
    // overwrite the panel with a recipe the user is no longer looking at.
    resolveFirst(detailOf([], { id: 'rec_1', label: 'Order coffee' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole('heading', { level: 3, name: 'Pay rent' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: 'Order coffee' })).toBeNull();
  });

  it('renders every fact, and says "removed" when the source session is gone', async () => {
    getRecipe.mockResolvedValue(detailOf([], { agent_session_id: null, description: '' }));
    render(<RecipesView onGoToAI={vi.fn()} onGoToSettings={vi.fn()} />);
    await selectFirst();

    expect(await screen.findByText('— removed')).toBeInTheDocument();
    expect(screen.getByText('This saved task has no recorded steps.')).toBeInTheDocument();
    // An empty description renders nothing rather than an empty paragraph.
    expect(screen.queryByText('Reorders the usual')).toBeNull();
  });

  // ⭐ The six intent kinds, each with its optional-field forks. The union is
  // exhaustive in the source; these prove each arm renders what it claims to.
  it('CRITICAL renders every intent kind with its optional fields present and absent', async () => {
    getRecipe.mockResolvedValue(
      detailOf([
        { kind: 'navigate', url: 'https://shop.example/cart' },
        { kind: 'interact', action: 'tap', selector: '#buy' },
        { kind: 'interact', action: 'type', selector: '#qty', value: '2' },
        { kind: 'interact', action: 'scroll' },
        { kind: 'wait', condition: 'visible', selector: '#done', timeoutMs: 5000 },
        { kind: 'wait', condition: 'idle' },
        { kind: 'capture', capture: 'screenshot' },
        { kind: 'scroll', direction: 'down', amount_px: 400 },
        { kind: 'scroll', direction: 'up' },
        { kind: 'behavioral_pause', duration_ms: 1200 },
        { kind: 'behavioral_pause', reading_word_count: 80 },
        { kind: 'behavioral_pause' },
      ]),
    );
    render(<RecipesView onGoToAI={vi.fn()} onGoToSettings={vi.fn()} />);
    await selectFirst();

    expect(await screen.findByText('https://shop.example/cart')).toBeInTheDocument();
    expect(screen.getByText('tap #buy')).toBeInTheDocument();
    expect(screen.getByText('type #qty = “2”')).toBeInTheDocument();
    // 'scroll' appears as the interact summary AND as the scroll kind chip (x2),
    // so an exact-text count is the assertion, not a single-match lookup.
    expect(screen.getAllByText('scroll', { exact: true })).toHaveLength(3);
    expect(screen.getByText('until visible #done (5000ms)')).toBeInTheDocument();
    expect(screen.getByText('until idle')).toBeInTheDocument();
    expect(screen.getByText('screenshot')).toBeInTheDocument();
    expect(screen.getByText('down 400px')).toBeInTheDocument();
    expect(screen.getByText('up')).toBeInTheDocument();
    expect(screen.getByText('pause 1200ms')).toBeInTheDocument();
    expect(screen.getByText('read ~80 words')).toBeInTheDocument();
    expect(screen.getByText('pause')).toBeInTheDocument();
    // The kind chips: interact carries its action, everything else is bare.
    expect(screen.getAllByText('interact · tap')).toHaveLength(1);
    expect(screen.getAllByText('navigate')).toHaveLength(1);
  });

  it('search filters on label and description, and says so when nothing matches', async () => {
    listRecipes.mockResolvedValue({
      data: [
        recipe(),
        recipe({ id: 'rec_2', label: 'Pay rent', description: 'monthly transfer' }),
      ] as never[],
    });
    render(<RecipesView onGoToAI={vi.fn()} onGoToSettings={vi.fn()} />);
    const box = await screen.findByRole('searchbox', { name: 'Search saved tasks' });

    fireEvent.change(box, { target: { value: 'TRANSFER' } }); // description, case-insensitive
    expect(screen.getByRole('button', { name: /Pay rent/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Order coffee/ })).toBeNull();

    fireEvent.change(box, { target: { value: 'nothing-here' } });
    expect(screen.getByText(/No saved tasks match/)).toBeInTheDocument();
  });
});
