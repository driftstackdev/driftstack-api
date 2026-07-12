// Team management view — invite, list, remove (founder 2026-06-16).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const invite = vi.fn((_email: string, _opts: unknown) => Promise.resolve({ message: 'ok' }));
const removeMember = vi.fn((_id: string) => Promise.resolve());
const listMembers = vi.fn(() =>
  Promise.resolve({
    data: [
      {
        id: 'mem_1',
        owner_account_id: 'o',
        member_account_id: 'a',
        member_email: 'alice@co.com',
        role: 'admin',
        invited_at: '2026-06-01T00:00:00Z',
        accepted_at: '2026-06-02T00:00:00Z',
        invited_by_account_id: null,
      },
    ],
  }),
);
const listInvites = vi.fn(() =>
  Promise.resolve({
    data: [
      {
        id: 'inv_1',
        owner_account_id: 'o',
        invitee_email: 'newhire@co.com',
        role: 'member',
        expires_at: '2026-07-01T00:00:00Z',
        invited_by_account_id: null,
        accepted_at: null,
        created_at: '2026-06-10T00:00:00Z',
      },
    ],
  }),
);

// Stable references — a fresh object each render would churn the `client`
// identity and never let the load effect settle.
const STABLE_CLIENT = { team: { invite, removeMember, listMembers, listInvites } };
const STABLE_SETTINGS = { apiKey: 'ds_x', baseUrl: 'http://localhost:3000' };
let currentClient: typeof STABLE_CLIENT | null = STABLE_CLIENT;
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client: currentClient, settings: STABLE_SETTINGS }),
}));

vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => () => Promise.resolve(true),
}));

const { TeamView } = await import('../../src/views/TeamView');

describe('TeamView', () => {
  beforeEach(() => {
    currentClient = STABLE_CLIENT;
  });

  it('lists members + pending invites, sends an invite, and removes a member', async () => {
    render(<TeamView onGoToSettings={vi.fn()} />);
    // members + pending invites render
    expect(await screen.findByText('alice@co.com')).toBeTruthy();
    expect(screen.getByText('newhire@co.com')).toBeTruthy();

    // invite flow
    fireEvent.change(screen.getByLabelText('Invitee email'), {
      target: { value: 'bob@co.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(invite).toHaveBeenCalledWith('bob@co.com', { role: 'member' }));

    // remove flow (confirm mocked → true)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith('mem_1'));
  });

  it('rejects a malformed email without calling invite', async () => {
    invite.mockClear();
    render(<TeamView onGoToSettings={vi.fn()} />);
    await screen.findByText('alice@co.com');
    fireEvent.change(screen.getByLabelText('Invitee email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(invite).not.toHaveBeenCalled();
  });

  it('resets the role select back to member after a successful invite (no admin carry-over)', async () => {
    invite.mockClear();
    render(<TeamView onGoToSettings={vi.fn()} />);
    await screen.findByText('alice@co.com');
    const roleSelect: HTMLSelectElement = screen.getByLabelText('Invitee role');
    fireEvent.change(roleSelect, { target: { value: 'admin' } });
    expect(roleSelect.value).toBe('admin');
    fireEvent.change(screen.getByLabelText('Invitee email'), { target: { value: 'bob@co.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(invite).toHaveBeenCalledWith('bob@co.com', { role: 'admin' }));
    // After the invite resolves the select snaps back to the safe default.
    await waitFor(() => expect(roleSelect.value).toBe('member'));
  });

  it('renders a failed invite as a distinct error alert (not a success status)', async () => {
    invite.mockClear();
    invite.mockRejectedValueOnce(Object.assign(new Error('seat limit reached'), { status: 402 }));
    render(<TeamView onGoToSettings={vi.fn()} />);
    await screen.findByText('alice@co.com');
    fireEvent.change(screen.getByLabelText('Invitee email'), { target: { value: 'carol@co.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/seat limit/i);
    expect(alert.className).toContain('text-status-error');
  });

  it('offers a direct Settings recovery action when signed out', () => {
    currentClient = null;
    const onGoToSettings = vi.fn();

    render(<TeamView onGoToSettings={onGoToSettings} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(onGoToSettings).toHaveBeenCalledOnce();
  });
});
