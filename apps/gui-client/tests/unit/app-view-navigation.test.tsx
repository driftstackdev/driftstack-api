// Founder regression: sidebar navigation must not look like a full-page reload.
// A held first-load lazy chunk keeps the current view visible; the main panel and
// error boundary remain mounted, while the old view itself still unmounts once
// the destination commits so hidden polling/live media cannot continue.

import { lazy, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    get(): Promise<null> {
      return Promise.resolve(null);
    }
    set(): Promise<void> {
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(() => Promise.resolve(() => undefined)),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(() => Promise.resolve()) }));
vi.mock('@sentry/browser', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
  Replay: class {},
  BrowserTracing: class {},
}));

const { StableViewPanel, useViewNavigation, viewScrollKey } = await import('../../src/App');

describe('stable App view navigation', () => {
  it('keeps revealed content during first lazy load, preserves main + scroll, and unmounts inactive views', async () => {
    const homeCleanup = vi.fn();
    const settingsCleanup = vi.fn();
    let resolveSettings!: () => void;

    function Home(): JSX.Element {
      useEffect(() => homeCleanup, []);
      return <div>Home continuity proof</div>;
    }

    function Settings(): JSX.Element {
      useEffect(() => settingsCleanup, []);
      return <div>Settings continuity proof</div>;
    }

    const LazySettings = lazy(
      () =>
        new Promise<{ default: typeof Settings }>((resolve) => {
          resolveSettings = () => resolve({ default: Settings });
        }),
    );

    function Harness(): JSX.Element {
      const [view, navigate] = useViewNavigation({ kind: 'home' });
      return (
        <>
          <button type="button" onClick={() => navigate({ kind: 'home' })}>
            Home
          </button>
          <button type="button" onClick={() => navigate({ kind: 'settings' })}>
            Settings
          </button>
          <StableViewPanel
            destinationKey={viewScrollKey(view)}
            loadingFallback={<div>Full-panel loading fallback</div>}
            errorFallback={() => <div>View failed</div>}
          >
            {view.kind === 'home' ? <Home /> : <LazySettings />}
          </StableViewPanel>
        </>
      );
    }

    render(<Harness />);
    const main = screen.getByRole('main');
    main.scrollTop = 137;
    fireEvent.scroll(main);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText('Home continuity proof')).toBeInTheDocument();
    expect(screen.queryByText('Full-panel loading fallback')).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toBe(main);
    expect(homeCleanup).not.toHaveBeenCalled();

    await act(async () => {
      resolveSettings();
      await Promise.resolve();
    });
    expect(await screen.findByText('Settings continuity proof')).toBeInTheDocument();
    expect(homeCleanup).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('main')).toBe(main);
    expect(main.scrollTop).toBe(0);

    main.scrollTop = 29;
    fireEvent.scroll(main);
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(screen.getByText('Home continuity proof')).toBeInTheDocument());
    expect(settingsCleanup).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('main')).toBe(main);
    expect(main.scrollTop).toBe(137);
  });
});
