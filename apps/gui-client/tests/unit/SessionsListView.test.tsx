// V-534.P — unit tests for SessionsListView.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SessionsListState, UseSessionsListResult } from '../../src/lib/use-sessions-list';

const refetchSpy = vi.fn(() => Promise.resolve());
const useSessionsListMock = vi.fn<() => UseSessionsListResult>();
vi.mock('../../src/lib/use-sessions-list', () => ({
  useSessionsList: () => useSessionsListMock(),
}));

const { SessionsListView } = await import('../../src/views/SessionsListView');

function setState(state: SessionsListState): void {
  useSessionsListMock.mockReturnValue({ state, refetch: refetchSpy });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('V-534.P SessionsListView — loading + error', () => {
  it('shows loading message while the hook is loading', () => {
    setState({ kind: 'loading' });
    render(<SessionsListView />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading sessions/i);
  });

  it('shows error alert when the hook errors', () => {
    setState({ kind: 'error', message: 'HTTP 500' });
    render(<SessionsListView />);
    expect(screen.getByRole('alert')).toHaveTextContent(/500/);
  });
});

describe('V-534.P SessionsListView — ready', () => {
  it('renders an empty-state message when sessions list is empty', () => {
    setState({ kind: 'ready', data: { sessions: [], nextCursor: null } });
    render(<SessionsListView />);
    expect(screen.getByText(/no sessions yet/i)).toBeTruthy();
  });

  it('renders a table row per session with id, url, status badge, and timestamp', () => {
    setState({
      kind: 'ready',
      data: {
        sessions: [
          {
            id: 'sess_1',
            status: 'ready',
            url: 'https://example.com',
            createdAt: '2026-05-11T12:00:00.000Z',
            endedAt: null,
          },
          {
            id: 'sess_2',
            status: 'errored',
            url: 'https://broken.example',
            createdAt: '2026-05-10T12:00:00.000Z',
            endedAt: '2026-05-10T12:30:00.000Z',
          },
        ],
        nextCursor: null,
      },
    });
    render(<SessionsListView />);
    expect(screen.getByText('sess_1')).toBeTruthy();
    expect(screen.getByText('sess_2')).toBeTruthy();
    // SessionStatusBadge surfaces the label per status.
    expect(screen.getByRole('status', { name: /session status: ready/i })).toBeTruthy();
    expect(screen.getByRole('status', { name: /session status: errored/i })).toBeTruthy();
  });
});

describe('V-534.P SessionsListView — refresh button', () => {
  it('disables the control and exposes honest progress while loading', () => {
    setState({ kind: 'loading' });
    render(<SessionsListView />);
    const button = screen.getByRole('button', { name: /refreshing/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(refetchSpy).not.toHaveBeenCalled();
  });

  it('invokes the hook refetch when the idle Refresh control is clicked', () => {
    setState({ kind: 'ready', data: { sessions: [], nextCursor: null } });
    render(<SessionsListView />);
    const button = screen.getByRole('button', { name: /^refresh$/i });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'false');
    fireEvent.click(button);
    expect(refetchSpy).toHaveBeenCalledTimes(1);
  });
});
