import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { NotificationEvent } from '../../src/lib/notifications';
import { NotificationBell } from '../../src/components/NotificationBell';
import { historyOutcomeFromError, type HistoryOutcome } from '../../src/lib/notification-digest';

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

describe('NotificationBell — durable history (V-2145)', () => {
  const ROWS: HistoryOutcome = {
    kind: 'ok',
    items: [
      {
        key: 'audit-1',
        level: 'info',
        title: 'profile.created — prof_1',
        at: '2026-08-20T09:00:00.000Z',
      },
      {
        key: 'audit-2',
        level: 'warn',
        title: 'api_key.revoked — key_9',
        at: '2026-08-19T09:00:00.000Z',
      },
    ],
  };

  it('OPEN fetches once and renders the audit rows under their own labelled section', async () => {
    const loadHistory = vi.fn<() => Promise<HistoryOutcome>>(() => Promise.resolve(ROWS));
    render(<NotificationBell events={[outage]} loadHistory={loadHistory} />);
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(loadHistory).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('profile.created — prof_1')).toBeInTheDocument());
    expect(screen.getByText(/Earlier — from the account audit log/)).toBeInTheDocument();
    expect(screen.getByText('api_key.revoked — key_9')).toBeInTheDocument();
  });

  it('a key without read:audit gets the explanation, not an error', async () => {
    const loadHistory = (): Promise<HistoryOutcome> => Promise.resolve({ kind: 'forbidden' });
    render(<NotificationBell events={[]} loadHistory={loadHistory} />);
    fireEvent.click(screen.getByTestId('notification-bell'));
    await waitFor(() => expect(screen.getByText(/needs the read:audit scope/)).toBeInTheDocument());
  });

  it('a failed fetch degrades to a quiet line and leaves the live feed alone', async () => {
    const loadHistory = (): Promise<HistoryOutcome> => Promise.reject(new Error('boom'));
    render(<NotificationBell events={[outage]} loadHistory={loadHistory} />);
    fireEvent.click(screen.getByTestId('notification-bell'));
    await waitFor(() =>
      expect(screen.getByText(/Couldn't load older history/)).toBeInTheDocument(),
    );
    expect(screen.getByText('Regional outage')).toBeInTheDocument();
  });

  it('without a loadHistory callback the panel renders exactly as before — no section', () => {
    render(<NotificationBell events={[outage]} />);
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(screen.queryByTestId('notification-history')).toBeNull();
  });

  it('history rows never light the badge — unread is the LIVE feed contract', async () => {
    const loadHistory = (): Promise<HistoryOutcome> => Promise.resolve(ROWS);
    render(<NotificationBell events={[]} loadHistory={loadHistory} />);
    expect(screen.queryByTestId('notification-bell-badge')).toBeNull();
    fireEvent.click(screen.getByTestId('notification-bell'));
    await waitFor(() => expect(screen.getByText('profile.created — prof_1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(screen.queryByTestId('notification-bell-badge')).toBeNull();
  });
});

describe('historyOutcomeFromError — the one status with a meaning', () => {
  it('403 is the missing-scope explanation', () => {
    expect(historyOutcomeFromError({ status: 403 })).toEqual({ kind: 'forbidden' });
  });
  it('any other status is a plain load failure', () => {
    expect(historyOutcomeFromError({ status: 500 })).toEqual({ kind: 'error' });
    expect(historyOutcomeFromError({ status: 401 })).toEqual({ kind: 'error' });
  });
  it('a thrown non-HTTP error (no status at all) is a plain load failure too', () => {
    expect(historyOutcomeFromError(new Error('network down'))).toEqual({ kind: 'error' });
    expect(historyOutcomeFromError(null)).toEqual({ kind: 'error' });
  });
});
