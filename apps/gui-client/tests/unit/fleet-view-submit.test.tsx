import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetView } from '../../src/views/FleetView';
import * as fleet from '../../src/lib/fleet-members';

vi.mock('../../src/lib/fleet-members', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    addFleetMember: vi.fn(),
    listFleetMembers: vi.fn(),
    pingFleetMember: vi.fn(),
    removeFleetMember: vi.fn(),
    updateFleetMember: vi.fn(),
  };
});

vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => vi.fn().mockResolvedValue(true),
}));

describe('FleetView form submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fleet.listFleetMembers).mockResolvedValue([]);
  });

  it('single-flights Add and exposes a disabled Saving state until persistence settles', async () => {
    let finishSave: ((member: fleet.FleetMember) => void) | undefined;
    vi.mocked(fleet.addFleetMember).mockReturnValue(
      new Promise<fleet.FleetMember>((resolve) => {
        finishSave = resolve;
      }),
    );
    render(<FleetView />);
    await screen.findByRole('button', { name: 'Add member' });

    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
    fireEvent.change(screen.getByPlaceholderText('mac-mini-eu-west-1'), {
      target: { value: 'mac-mini-test' },
    });
    fireEvent.change(screen.getByPlaceholderText('http://10.0.0.5:3000'), {
      target: { value: 'https://fleet.example.test' },
    });
    const form = screen.getByRole('button', { name: 'Add' }).closest('form');
    if (!form) throw new Error('fleet form not found');

    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByPlaceholderText('mac-mini-eu-west-1')).toBeDisabled();
    expect(fleet.addFleetMember).toHaveBeenCalledTimes(1);

    finishSave?.({
      id: 'fleet_1',
      label: 'mac-mini-test',
      baseUrl: 'https://fleet.example.test',
      notes: null,
      createdAt: '2026-07-12T19:00:00.000Z',
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Saving…' })).toBeNull());
    expect(fleet.listFleetMembers).toHaveBeenCalledTimes(2);
  });
});
