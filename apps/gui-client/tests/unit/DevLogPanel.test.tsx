import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const formatLogEntries = vi.fn(() => '2026-07-14T02:46:00.000Z [ERROR] exact diagnostics');

vi.mock('../../src/lib/log-buffer', () => ({
  clearLogEntries: vi.fn(),
  formatLogEntries,
  getLogEntries: vi.fn(() => []),
  subscribeLogs: vi.fn(() => () => undefined),
}));

const { DevLogPanel } = await import('../../src/components/DevLogPanel');

describe('DevLogPanel clipboard recovery', () => {
  it('surfaces a synchronous clipboard failure and retries the exact formatted buffer', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const throwingWrite = vi.fn(() => {
      throw new Error('clipboard denied');
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: throwingWrite },
      configurable: true,
    });
    try {
      render(<DevLogPanel />);
      fireEvent.click(screen.getByRole('button', { name: 'Logs' }));
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

      const retry = await screen.findByRole('button', { name: 'Copy failed — retry' });
      expect(retry).toBeEnabled();
      expect(throwingWrite).toHaveBeenCalledWith(formatLogEntries());

      const recoveredWrite = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: recoveredWrite },
        configurable: true,
      });
      fireEvent.click(retry);

      await waitFor(() => expect(recoveredWrite).toHaveBeenCalledWith(formatLogEntries()));
      expect(recoveredWrite).toHaveBeenCalledTimes(1);
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeEnabled();
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
      else delete (navigator as Partial<Navigator>).clipboard;
    }
  });
});
