// Founder regression: sidebar navigation must not look like a full-page reload.
// A held first-load lazy chunk keeps the current view visible; the main panel and
// error boundary remain mounted, while the old view itself still unmounts once
// the destination commits so hidden polling/live media cannot continue.

import { lazy, useEffect, useState } from 'react';
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

const {
  StableViewPanel,
  useViewNavigation,
  useWorkspaceScopedView,
  viewAfterWorkspaceChange,
  viewScrollKey,
} = await import('../../src/App');

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
            contentIdentity="workspace:personal"
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

  it('remounts only workspace-scoped content and isolates/restores each workspace scroll', async () => {
    const cleanup = vi.fn();

    function ScopedChild({ workspace }: { workspace: string }): JSX.Element {
      const [draft, setDraft] = useState('');
      useEffect(() => cleanup, []);
      return (
        <label>
          {workspace} draft
          <input
            aria-label="Workspace draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
      );
    }

    function Harness(): JSX.Element {
      const [workspace, setWorkspace] = useState<'personal' | 'team-b'>('personal');
      const contentIdentity =
        workspace === 'personal' ? 'workspace:personal' : 'workspace:team:acct_b';
      return (
        <>
          <button type="button" onClick={() => setWorkspace('personal')}>
            Personal
          </button>
          <button type="button" onClick={() => setWorkspace('team-b')}>
            Team B
          </button>
          <StableViewPanel
            destinationKey="profiles"
            contentIdentity={contentIdentity}
            loadingFallback={<div>Loading workspace</div>}
            errorFallback={() => <div>Workspace failed</div>}
          >
            <ScopedChild workspace={workspace} />
          </StableViewPanel>
        </>
      );
    }

    render(<Harness />);
    const main = screen.getByRole('main');
    const draft = screen.getByRole('textbox', { name: 'Workspace draft' });
    fireEvent.change(draft, { target: { value: 'personal-only state' } });
    main.scrollTop = 83;
    fireEvent.scroll(main);

    fireEvent.click(screen.getByRole('button', { name: 'Team B' }));
    expect(screen.getByRole('main')).toBe(main);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Workspace draft' })).toHaveValue('');
    expect(main.scrollTop).toBe(0);

    fireEvent.change(screen.getByRole('textbox', { name: 'Workspace draft' }), {
      target: { value: 'team-only state' },
    });
    main.scrollTop = 29;
    fireEvent.scroll(main);

    fireEvent.click(screen.getByRole('button', { name: 'Personal' }));
    await waitFor(() => expect(main.scrollTop).toBe(83));
    expect(screen.getByRole('main')).toBe(main);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('textbox', { name: 'Workspace draft' })).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Team B' }));
    await waitFor(() => expect(main.scrollTop).toBe(29));
    expect(screen.getByRole('main')).toBe(main);
    expect(cleanup).toHaveBeenCalledTimes(3);
  });

  it('drops only stale profile entity payloads at a workspace boundary', () => {
    expect(viewAfterWorkspaceChange({ kind: 'ai', profileId: 'prof_a' })).toEqual({ kind: 'ai' });
    expect(viewAfterWorkspaceChange({ kind: 'profiles', profileId: 'prof_a' })).toEqual({
      kind: 'profiles',
    });
    const recording = { kind: 'recording-player', recordingId: 'rec_local' } as const;
    expect(viewAfterWorkspaceChange(recording)).toBe(recording);
    const profiles = { kind: 'profiles' } as const;
    expect(viewAfterWorkspaceChange(profiles)).toBe(profiles);
  });

  it('never renders or effects a stale profile id in the newly keyed workspace child', async () => {
    const rendered: Array<string | undefined> = [];
    const effected: Array<string | undefined> = [];

    function ProfileChild({ profileId }: { profileId?: string }): JSX.Element {
      rendered.push(profileId);
      useEffect(() => {
        effected.push(profileId);
      }, [profileId]);
      return <div>Profile: {profileId ?? 'none'}</div>;
    }

    function Harness(): JSX.Element {
      const [workspace, setWorkspace] = useState<string | null>(null);
      const [view, , replaceView] = useViewNavigation({
        kind: 'profiles',
        profileId: 'prof_a',
      });
      const scopedView = useWorkspaceScopedView(view, replaceView, workspace);
      const contentIdentity =
        workspace === null ? 'workspace:personal' : `workspace:team:${workspace}`;
      return (
        <>
          <button type="button" onClick={() => setWorkspace('acct_b')}>
            Team B
          </button>
          <StableViewPanel
            destinationKey={viewScrollKey(scopedView)}
            contentIdentity={contentIdentity}
            loadingFallback={<div>Loading workspace</div>}
            errorFallback={() => <div>Workspace failed</div>}
          >
            {scopedView.kind === 'profiles' ? (
              <ProfileChild profileId={scopedView.profileId} />
            ) : null}
          </StableViewPanel>
        </>
      );
    }

    render(<Harness />);
    expect(await screen.findByText('Profile: prof_a')).toBeInTheDocument();
    await waitFor(() => expect(effected).toEqual(['prof_a']));
    const renderBoundary = rendered.length;
    const effectBoundary = effected.length;

    fireEvent.click(screen.getByRole('button', { name: 'Team B' }));
    expect(await screen.findByText('Profile: none')).toBeInTheDocument();
    await waitFor(() => expect(effected.length).toBeGreaterThan(effectBoundary));
    expect(rendered.slice(renderBoundary)).not.toContain('prof_a');
    expect(effected.slice(effectBoundary)).not.toContain('prof_a');
  });
});
