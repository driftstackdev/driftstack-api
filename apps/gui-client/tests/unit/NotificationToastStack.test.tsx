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

const hookState: {
  events: NotificationEvent[];
  connection: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
} = {
  events: [],
  connection: 'idle',
};

vi.mock('../../src/lib/use-notifications', () => ({
  useNotifications: () => ({
    events: hookState.events,
    connection: hookState.connection,
    dismiss: dismissMock,
  }),
}));

const { NotificationToastStack } = await import('../../src/components/NotificationToastStack');

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
    const { container } = render(<NotificationToastStack />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one toast per event, newest-first', () => {
    setHookState([
      { ...baseEvent, at: '2026-05-20T23:00:00.000Z' },
      { ...baseEvent, severity: 'critical', at: '2026-05-20T22:00:00.000Z' },
    ]);
    render(<NotificationToastStack />);
    const toasts = screen.getAllByTestId('notification-toast');
    expect(toasts).toHaveLength(2);
    // First (newest) card carries the Dismiss CTA.
    expect(toasts[0]?.textContent).toContain('Cost warn:');
    expect(toasts[1]?.textContent).toContain('Cost critical:');
  });

  it("clicking Dismiss invokes the hook's dismiss callback", () => {
    setHookState([baseEvent]);
    dismissMock.mockClear();
    render(<NotificationToastStack />);
    fireEvent.click(screen.getByLabelText('Dismiss all notifications'));
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it("connection 'reconnecting' surfaces the amber banner even with zero events", () => {
    setHookState([], 'reconnecting');
    render(<NotificationToastStack />);
    expect(screen.getByTestId('notification-connection-banner').textContent).toMatch(
      /reconnecting/i,
    );
  });

  it("connection 'closed' + at least one event surfaces the rose banner with Settings hint", () => {
    setHookState([baseEvent], 'closed');
    render(<NotificationToastStack />);
    expect(screen.getByTestId('notification-connection-banner').textContent).toMatch(
      /closed.*Settings to reconnect/i,
    );
  });

  it("connection 'closed' with zero events stays hidden (no banner spam after sign-out)", () => {
    setHookState([], 'closed');
    const { container } = render(<NotificationToastStack />);
    expect(container.firstChild).toBeNull();
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
    render(<NotificationToastStack />);
    const card = screen.getByTestId('notification-toast');
    expect(card.getAttribute('data-notification-kind')).toBe('incident.broadcast');
    expect(card.textContent).toContain('Incident: API degraded');
  });
});
