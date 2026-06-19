// LK.6.c — LivekitConnectionBadge component tests.
//
// Pins:
//   - The 6 state labels (idle / connecting / connected / reconnecting
//     / disconnected / error) and the pulse-animation invariant
//     (animation on connecting + reconnecting only).
//   - data-state attribute reflects the discriminator (drift-guard
//     for downstream CSS selectors).
//   - role=status + aria-live=polite (screen-reader live-region).
//   - Reconnect button only renders for `disconnected` + `error` AND
//     only when onReconnect is provided (parent supplied).
//   - Error-state message renders alongside the badge.
//
// These tests run in jsdom under the gui-client vitest project
// (apps/gui-client/vitest.config.ts).

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LivekitConnectionBadge } from '../../src/components/LivekitConnectionBadge';
import type { LivekitConnectionState } from '../../src/lib/livekit';

describe('LK.6.c LivekitConnectionBadge', () => {
  it('renders Idle badge for { kind: "idle" } with no pulse + no reconnect button', () => {
    render(<LivekitConnectionBadge state={{ kind: 'idle' }} />);
    const pill = screen.getByText('Idle');
    expect(pill).toBeInTheDocument();
    // The dot inside the pill should NOT carry animate-pulse.
    const dot = pill.querySelector('span:first-child');
    expect(dot?.className).not.toContain('animate-pulse');
    // No reconnect button on idle.
    expect(screen.queryByRole('button', { name: /reconnect/i })).toBeNull();
  });

  it('renders Connecting… badge with pulse animation for { kind: "connecting" }', () => {
    render(<LivekitConnectionBadge state={{ kind: 'connecting' }} />);
    const pill = screen.getByText('Connecting…');
    const dot = pill.querySelector('span:first-child');
    expect(dot?.className).toContain('animate-pulse');
  });

  it('renders Live badge for { kind: "connected" } with no pulse', () => {
    render(<LivekitConnectionBadge state={{ kind: 'connected' }} />);
    const pill = screen.getByText('Live');
    expect(pill).toBeInTheDocument();
    expect(pill.className).toContain('status-ready'); // ready (success) token on connected
    const dot = pill.querySelector('span:first-child');
    expect(dot?.className).not.toContain('animate-pulse');
  });

  it('renders Reconnecting… badge with pulse animation for { kind: "reconnecting" }', () => {
    render(<LivekitConnectionBadge state={{ kind: 'reconnecting' }} />);
    const pill = screen.getByText('Reconnecting…');
    const dot = pill.querySelector('span:first-child');
    expect(dot?.className).toContain('animate-pulse');
  });

  it('renders Disconnected badge for { kind: "disconnected" }', () => {
    render(<LivekitConnectionBadge state={{ kind: 'disconnected' }} />);
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });

  it('renders Error badge + message + Reconnect button for { kind: "error" }', () => {
    const onReconnect = vi.fn();
    render(
      <LivekitConnectionBadge
        state={{ kind: 'error', message: 'WebSocket signal timeout' }}
        onReconnect={onReconnect}
      />,
    );
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('WebSocket signal timeout')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /reconnect/i });
    expect(button).toBeInTheDocument();
    button.click();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('Reconnect button renders on disconnected when onReconnect is supplied', () => {
    const onReconnect = vi.fn();
    render(<LivekitConnectionBadge state={{ kind: 'disconnected' }} onReconnect={onReconnect} />);
    const button = screen.getByRole('button', { name: /reconnect/i });
    button.click();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('Reconnect button does NOT render on connected state even if onReconnect is supplied', () => {
    const onReconnect = vi.fn();
    render(<LivekitConnectionBadge state={{ kind: 'connected' }} onReconnect={onReconnect} />);
    expect(screen.queryByRole('button', { name: /reconnect/i })).toBeNull();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('Reconnect button does NOT render on disconnected when onReconnect is omitted', () => {
    render(<LivekitConnectionBadge state={{ kind: 'disconnected' }} />);
    // No callback → no affordance to render.
    expect(screen.queryByRole('button', { name: /reconnect/i })).toBeNull();
  });

  it('data-state attribute mirrors the discriminator across all 6 kinds (CSS selector contract)', () => {
    const kinds: LivekitConnectionState[] = [
      { kind: 'idle' },
      { kind: 'connecting' },
      { kind: 'connected' },
      { kind: 'reconnecting' },
      { kind: 'disconnected' },
      { kind: 'error', message: 'fail' },
    ];
    for (const state of kinds) {
      const { container, unmount } = render(<LivekitConnectionBadge state={state} />);
      const pill = container.querySelector(`[data-state="${state.kind}"]`);
      expect(pill, `expected data-state="${state.kind}" on the badge pill`).not.toBeNull();
      unmount();
    }
  });

  it('container carries role=status + aria-live=polite (screen-reader live region)', () => {
    const { container } = render(<LivekitConnectionBadge state={{ kind: 'connected' }} />);
    const root = container.querySelector('[data-component="livekit-connection-badge"]');
    expect(root?.getAttribute('role')).toBe('status');
    expect(root?.getAttribute('aria-live')).toBe('polite');
  });
});
