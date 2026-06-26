// Deep-audit LOW: the wizard's mode-switch effect reset baseUrl to the default
// on EVERY mode change, so a self-hosted user who typed a custom URL, toggled to
// cloud, then back to self-hosted lost their URL (overwritten with
// http://localhost:3000). The wizard now remembers the last self-hosted URL and
// restores it on the cloud round-trip.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ update: vi.fn(() => Promise.resolve()) }),
}));
vi.mock('../../src/lib/browser-sign-in', () => ({
  useBrowserSignIn: () => ({ state: { kind: 'idle' }, start: vi.fn(), cancel: vi.fn() }),
}));

const { FirstRunWizard } = await import('../../src/views/FirstRunWizard');

function goToModeStep(): void {
  render(<FirstRunWizard onComplete={vi.fn()} />);
  // Welcome → mode step.
  fireEvent.click(screen.getByRole('button', { name: /get started|continue|next/i }));
}

describe('FirstRunWizard — mode switch preserves a custom self-hosted URL', () => {
  it('a custom self-hosted URL survives a cloud round-trip', () => {
    goToModeStep();

    // Switch to self-hosted → the URL field appears (default localhost).
    fireEvent.click(screen.getByRole('radio', { name: /self-hosted/i }));
    const urlInput = screen.getByPlaceholderText<HTMLInputElement>('http://localhost:3000');
    expect(urlInput.value).toBe('http://localhost:3000');

    // Type a custom URL.
    fireEvent.change(urlInput, { target: { value: 'http://10.0.0.5:9000' } });
    expect(urlInput.value).toBe('http://10.0.0.5:9000');

    // Toggle to cloud, then back to self-hosted.
    fireEvent.click(screen.getByRole('radio', { name: /cloud/i }));
    fireEvent.click(screen.getByRole('radio', { name: /self-hosted/i }));

    // The custom URL is restored (NOT reset to the default).
    const urlAfter = screen.getByPlaceholderText<HTMLInputElement>('http://localhost:3000');
    expect(urlAfter.value).toBe('http://10.0.0.5:9000');
  });
});
