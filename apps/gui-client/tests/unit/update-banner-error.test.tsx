import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from '../../src/components/UpdateBanner';
import type { AvailableUpdate } from '../../src/lib/updater';

describe('UpdateBanner error copy', () => {
  it('does not expose raw installer exception details', async () => {
    const update: AvailableUpdate = {
      version: '2.0.0',
      currentVersion: '1.0.0',
      notes: null,
      install: vi.fn(() => Promise.reject(new Error('spawn helper ENOENT /private/tmp/key'))),
    };
    render(<UpdateBanner update={update} onDismiss={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Install & restart' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/couldn't be installed/i),
    );
    expect(screen.getByRole('status')).not.toHaveTextContent(/ENOENT|private\/tmp/i);
  });
});
