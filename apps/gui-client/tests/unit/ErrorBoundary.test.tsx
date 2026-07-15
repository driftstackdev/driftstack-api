// Behavioral test for the recoverable per-view ErrorBoundary. A single
// view render-throw must be CONFINED to the boundary's fallback (with a
// Retry that re-mounts the children) instead of bubbling to the app-level
// RootErrorBoundary and blanking the whole window. Previously the boundary
// was imported by nothing (dead code); App.tsx now wraps <CurrentView/>
// with it. This pins the recover contract the wiring depends on.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';

// Reads the throw decision from a live ref each render so a re-mount after
// Retry sees the updated value (a captured prop would stay stale).
function Boom({ throwRef }: { throwRef: { current: boolean } }): JSX.Element {
  if (throwRef.current) throw new Error('view exploded');
  return <div>recovered child</div>;
}

describe('ErrorBoundary — recoverable per-view fallback', () => {
  it('renders the fallback (not the crash) when a child throws, and retry re-mounts', () => {
    // React logs the caught error to console.error; silence it for a clean run.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // `throwRef` flips to false before retry so the re-mount succeeds.
    const throwRef = { current: true };
    render(
      <ErrorBoundary
        fallback={(retry) => (
          <button type="button" onClick={retry}>
            Retry
          </button>
        )}
      >
        <Boom throwRef={throwRef} />
      </ErrorBoundary>,
    );

    // The throw was contained — the fallback's Retry is shown, no rethrow.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('recovered child')).not.toBeInTheDocument();

    // Clear the throw, click Retry → children re-mount cleanly.
    throwRef.current = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('recovered child')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('passes children through untouched when nothing throws', () => {
    render(
      <ErrorBoundary fallback={() => <div>fallback</div>}>
        <div>happy path</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('happy path')).toBeInTheDocument();
    expect(screen.queryByText('fallback')).not.toBeInTheDocument();
  });

  it('clears a failed destination when resetKey changes without replacing the boundary', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const throwRef = { current: true };
    const boundaryRef = { current: null as ErrorBoundary | null };

    const { rerender } = render(
      <ErrorBoundary
        ref={(value) => {
          boundaryRef.current = value;
        }}
        resetKey="profiles"
        fallback={() => <div>failed profiles</div>}
      >
        <Boom throwRef={throwRef} />
      </ErrorBoundary>,
    );
    const originalBoundary = boundaryRef.current;
    expect(screen.getByText('failed profiles')).toBeInTheDocument();

    throwRef.current = false;
    rerender(
      <ErrorBoundary
        ref={(value) => {
          boundaryRef.current = value;
        }}
        resetKey="settings"
        fallback={() => <div>failed settings</div>}
      >
        <Boom throwRef={throwRef} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('recovered child')).toBeInTheDocument();
    expect(screen.queryByText('failed profiles')).not.toBeInTheDocument();
    expect(boundaryRef.current).toBe(originalBoundary);

    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
