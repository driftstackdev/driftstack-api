// 2026-05-20 — jsdom integration test for the panel-level notification
// toast UI. Mocks useNotifications() directly so the test focuses on
// the render shape (cards stack newest-first, dismiss button on the
// top card, reconnecting/closed banners surface, hidden when idle).
// The hook itself is tested separately via FakeEventSource in
// notifications.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { NotificationEvent } from '../../src/lib/notifications';

const dismissMock = vi.fn();
const reconnectMock = vi.fn();

const hookState: {
  events: NotificationEvent[];
  connection: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
} = {
  events: [],
  connection: 'idle',
};

// ⛔ V-1611 #18 — the module mock is GONE. The component used to call
// `useNotifications()` itself, so a test could only reach it by replacing the
// module. It now takes the feed as props, because that hook opens an SSE
// subscription per caller and a second reader (the notification bell) would
// have opened a second stream to the same account.
//
// So this renders the real component with real props. Nothing is doubled, and
// the arms below assert on the thing that ships rather than on a stand-in.
const { NotificationToastStack } = await import('../../src/components/NotificationToastStack');

/** The feed the component receives, assembled from the same `hookState` the
 *  mocked hook used to serve. */
function feed(): Parameters<typeof NotificationToastStack>[0] {
  return {
    events: hookState.events,
    connection: hookState.connection,
    dismiss: dismissMock,
    reconnect: reconnectMock,
  };
}

function setHookState(
  events: NotificationEvent[],
  connection: typeof hookState.connection = 'open',
): void {
  hookState.events = events;
  hookState.connection = connection;
}

const baseEvent: NotificationEvent = {
  kind: 'cost.threshold_alert',
  accountId: 'acc_a',
  severity: 'warn',
  billingCycle: '2026-05',
  previousState: 'under-soft',
  currentState: 'between-soft-and-hard',
  totalCents: 12_500,
  thresholdSoftCents: 10_000,
  thresholdHardCents: 25_000,
  at: '2026-05-20T22:00:00.000Z',
};

describe('NotificationToastStack', () => {
  it('renders nothing when idle + no events', () => {
    setHookState([], 'idle');
    const { container } = render(<NotificationToastStack {...feed()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one toast per event, newest-first', () => {
    setHookState([
      { ...baseEvent, at: '2026-05-20T23:00:00.000Z' },
      { ...baseEvent, severity: 'critical', at: '2026-05-20T22:00:00.000Z' },
    ]);
    render(<NotificationToastStack {...feed()} />);
    const toasts = screen.getAllByTestId('notification-toast');
    expect(toasts).toHaveLength(2);
    // First (newest) card carries the Dismiss CTA.
    expect(toasts[0]?.textContent).toContain('Cost warn:');
    expect(toasts[1]?.textContent).toContain('Cost critical:');
  });

  it("clicking a single toast's Dismiss invokes the hook's dismiss callback", () => {
    setHookState([baseEvent]);
    dismissMock.mockClear();
    render(<NotificationToastStack {...feed()} />);
    // A single queued toast carries its own per-card Dismiss (the "Clear all"
    // header only appears once >1 toast is queued).
    fireEvent.click(screen.getByLabelText('Dismiss notification'));
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a "Clear all" header (with the count) when more than one toast is queued', () => {
    setHookState([
      { ...baseEvent, at: '2026-05-20T23:00:00.000Z' },
      { ...baseEvent, severity: 'critical', at: '2026-05-20T22:00:00.000Z' },
    ]);
    dismissMock.mockClear();
    render(<NotificationToastStack {...feed()} />);
    expect(screen.getByText('2 notifications')).toBeTruthy();
    // No per-card Dismiss when the "Clear all" header is present.
    expect(screen.queryByLabelText('Dismiss notification')).toBeNull();
    fireEvent.click(screen.getByLabelText('Clear all notifications'));
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it("connection 'reconnecting' surfaces the amber banner even with zero events", () => {
    setHookState([], 'reconnecting');
    render(<NotificationToastStack {...feed()} />);
    expect(screen.getByTestId('notification-connection-banner').textContent).toMatch(
      /reconnecting/i,
    );
  });

  it("connection 'closed' + at least one event surfaces the rose banner with a working Reconnect button", () => {
    setHookState([baseEvent], 'closed');
    reconnectMock.mockClear();
    render(<NotificationToastStack {...feed()} />);
    expect(screen.getByTestId('notification-connection-banner').textContent).toMatch(
      /disconnected/i,
    );
    fireEvent.click(screen.getByTestId('notification-reconnect'));
    expect(reconnectMock).toHaveBeenCalledTimes(1);
  });

  it("connection 'closed' with zero events STILL surfaces the banner + Reconnect (the subscriber actively gave up; a silent death is the bug we're fixing — sign-out is 'idle', not 'closed')", () => {
    setHookState([], 'closed');
    reconnectMock.mockClear();
    render(<NotificationToastStack {...feed()} />);
    // The degraded state is visible even with an empty ring…
    expect(screen.getByTestId('notification-connection-banner').textContent).toMatch(
      /disconnected/i,
    );
    // …and the only affordance is a Reconnect that actually re-subscribes.
    fireEvent.click(screen.getByTestId('notification-reconnect'));
    expect(reconnectMock).toHaveBeenCalledTimes(1);
  });

  it("connection 'idle' with zero events stays hidden (sign-out / no key → no banner spam)", () => {
    setHookState([], 'idle');
    const { container } = render(<NotificationToastStack {...feed()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an empty footer (not "Invalid Date") when the event timestamp is malformed', () => {
    setHookState([{ ...baseEvent, at: 'not-a-date' }]);
    render(<NotificationToastStack {...feed()} />);
    const card = screen.getByTestId('notification-toast');
    expect(card.textContent).not.toContain('Invalid Date');
  });

  it('each card carries a data-notification-kind discriminator attribute for downstream styling', () => {
    setHookState([
      {
        kind: 'incident.broadcast',
        accountId: 'acc_a',
        incidentId: 'inc_x',
        severity: 'major',
        title: 'API degraded',
        at: '2026-05-20T22:00:00.000Z',
      },
    ]);
    render(<NotificationToastStack {...feed()} />);
    const card = screen.getByTestId('notification-toast');
    expect(card.getAttribute('data-notification-kind')).toBe('incident.broadcast');
    expect(card.textContent).toContain('Incident: API degraded');
  });
});
