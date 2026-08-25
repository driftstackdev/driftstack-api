import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { NotificationEvent } from '../../src/lib/notifications';
import { NotificationBell } from '../../src/components/NotificationBell';

/**
 * V-1611 #18 — the bell.
 *
 * ⛔ It takes `events` as a PROP and must never call `useNotifications()`: that
 * hook opens an SSE subscription on mount, so a second caller means a second
 * stream to the same account for the same events. `Shell` owns the one
 * subscription.
 */

const errored = (at: string): NotificationEvent => ({
  kind: 'session.errored',
  accountId: 'acc_1',
  sessionId: 'as_1',
  errorClass: 'harness_unreachable',
  at,
});
const outage: NotificationEvent = {
  kind: 'incident.broadcast',
  accountId: 'acc_1',
  incidentId: 'inc_1',
  severity: 'outage',
  title: 'Regional outage',
  at: '2026-08-25T12:00:00.000Z',
};
const resolved: NotificationEvent = {
  kind: 'cost.threshold_alert',
  accountId: 'acc_1',
  severity: 'resolved',
  billingCycle: '2026-08',
  previousState: 'over-hard',
  currentState: 'under-soft',
  totalCents: 400,
  thresholdSoftCents: 1000,
  thresholdHardCents: 5000,
  at: '2026-08-25T12:00:00.000Z',
};

describe('NotificationBell', () => {
  it('shows an unread count before the panel has ever been opened', () => {
    render(<NotificationBell events={[errored('2026-08-25T11:00:00.000Z'), outage]} />);
    expect(screen.getByTestId('notification-bell-badge').textContent).toBe('2');
  });

  it('⛔ clears the badge when the panel is OPENED, not when it is closed', () => {
    // Marking on close would leave the badge lit while the customer is looking
    // at the very thing it points to.
    render(<NotificationBell events={[outage]} />);
    expect(screen.getByTestId('notification-bell-badge').textContent).toBe('1');
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(screen.queryByTestId('notification-bell-badge')).toBeNull();
    expect(screen.getByTestId('notification-panel')).toBeTruthy();
  });

  it('caps the badge rather than rendering a wide number', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      errored(`2026-08-25T1${String(i)}:00:00.000Z`),
    );
    render(<NotificationBell events={many} />);
    expect(screen.getByTestId('notification-bell-badge').textContent).toBe('9+');
  });

  it('renders no badge at all when there is nothing', () => {
    render(<NotificationBell events={[]} />);
    expect(screen.queryByTestId('notification-bell-badge')).toBeNull();
  });

  it('says what happened, not the event kind', () => {
    render(<NotificationBell events={[outage, resolved]} />);
    fireEvent.click(screen.getByTestId('notification-bell'));
    const panel = screen.getByTestId('notification-panel');
    expect(panel.textContent).toContain('Regional outage');
    // ⛔ the resolved cost alert is GOOD news and must not read as an alert
    expect(panel.textContent).toMatch(/back under/i);
    expect(panel.textContent).not.toContain('threshold_alert');
    expect(panel.textContent).not.toContain('incident.broadcast');
  });

  it('names the unread count for screen readers', () => {
    render(<NotificationBell events={[outage]} />);
    expect(screen.getByTestId('notification-bell').getAttribute('aria-label')).toBe(
      'Notifications, 1 unread',
    );
  });

  it('offers an explanation rather than an empty box when there is nothing', () => {
    render(<NotificationBell events={[]} />);
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(screen.getByTestId('notification-panel').textContent).toMatch(/nothing yet/i);
  });
});

describe('NotificationBell — local notices', () => {
  it('⛔ shows a pending update in the bell even with an EMPTY server feed', () => {
    // Dismissing the update BANNER means "stop interrupting me", not "forget
    // this happened". Losing it from history is the complaint #18 exists for.
    render(
      <NotificationBell
        events={[]}
        notices={[
          {
            id: 'update-1.2.3',
            level: 'info',
            title: 'Update 1.2.3 is ready to install',
            at: '2026-08-25T12:00:00.000Z',
          },
        ]}
      />,
    );
    expect(screen.getByTestId('notification-bell-badge').textContent).toBe('1');
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(screen.getByTestId('notification-panel').textContent).toContain('Update 1.2.3');
  });

  it('counts local notices and stream events together', () => {
    render(
      <NotificationBell
        events={[outage]}
        notices={[
          { id: 'u', level: 'info', title: 'Update ready', at: '2026-08-25T12:00:00.000Z' },
        ]}
      />,
    );
    expect(screen.getByTestId('notification-bell-badge').textContent).toBe('2');
  });
});
