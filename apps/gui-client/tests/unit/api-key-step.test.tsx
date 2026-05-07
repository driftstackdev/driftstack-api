// V-291 — view tests for FirstRunWizard.tsx::ApiKeyStep.
//
// Covers the V-274 useBrowserSignIn-driven UI states + the
// "Have an API key? Paste it instead" toggle path.
//
// Pattern: mock useBrowserSignIn (V-289 covers its lifecycle in
// isolation); each test re-mocks the hook to return a specific
// state-machine slice + asserts ApiKeyStep renders the corresponding
// UI shell.
//
// What we don't test here: the V-289 hook's poll loop / fetch /
// cleanup — that's already covered. V-291 is the rendering layer
// only.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const startMock = vi.fn();
const cancelMock = vi.fn();
let mockState: { kind: string; message?: string } = { kind: 'idle' };

vi.mock('../../src/lib/browser-sign-in', () => ({
  useBrowserSignIn: () => ({
    state: mockState,
    start: startMock,
    cancel: cancelMock,
  }),
}));

const { ApiKeyStep } = await import('../../src/views/FirstRunWizard');

function defaultProps(overrides: Partial<Parameters<typeof ApiKeyStep>[0]> = {}) {
  return {
    mode: 'cloud' as const,
    baseUrl: 'https://api.driftstack.dev',
    apiKey: '',
    validating: false,
    error: null,
    onApiKeyChange: vi.fn(),
    onBack: vi.fn(),
    onValidate: vi.fn(),
    ...overrides,
  };
}

describe('ApiKeyStep — browser path UI states', () => {
  it('idle state: shows Sign in with browser button + Back button + paste-toggle', () => {
    mockState = { kind: 'idle' };
    startMock.mockClear();
    cancelMock.mockClear();

    render(<ApiKeyStep {...defaultProps()} />);

    expect(screen.getByRole('button', { name: /sign in with browser/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    // Toggle to paste path is exposed.
    expect(
      screen.getByRole('button', { name: /have an api key\? paste it instead/i }),
    ).toBeInTheDocument();
  });

  it('opening state: shows "Opening browser…" copy', () => {
    mockState = { kind: 'opening' };
    render(<ApiKeyStep {...defaultProps()} />);
    expect(screen.getByText(/opening browser…/i)).toBeInTheDocument();
  });

  it('waiting state: shows pulsing dot + cancel button', () => {
    mockState = { kind: 'waiting' };
    cancelMock.mockClear();
    render(<ApiKeyStep {...defaultProps()} />);

    expect(screen.getByText(/waiting for browser confirmation/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('success state: shows Authorized — Continuing… message', () => {
    mockState = { kind: 'success' };
    render(<ApiKeyStep {...defaultProps()} />);
    expect(screen.getByText(/authorized\. continuing…/i)).toBeInTheDocument();
  });

  it('error state: shows the message + Try again button', () => {
    mockState = { kind: 'error', message: 'Authorization expired.' };
    startMock.mockClear();
    render(<ApiKeyStep {...defaultProps()} />);

    expect(screen.getByText(/authorization expired\./i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('ApiKeyStep — click handlers', () => {
  it('Sign in with browser button calls hook.start()', async () => {
    mockState = { kind: 'idle' };
    startMock.mockClear();
    const user = userEvent.setup();

    render(<ApiKeyStep {...defaultProps()} />);

    const btn = screen.getByRole('button', { name: /sign in with browser/i });
    await user.click(btn);

    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('Cancel button (waiting state) calls hook.cancel()', async () => {
    mockState = { kind: 'waiting' };
    cancelMock.mockClear();
    const user = userEvent.setup();

    render(<ApiKeyStep {...defaultProps()} />);

    const btn = screen.getByRole('button', { name: /cancel/i });
    await user.click(btn);

    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it('Try again (error state) calls hook.start()', async () => {
    mockState = { kind: 'error', message: 'oops' };
    startMock.mockClear();
    const user = userEvent.setup();

    render(<ApiKeyStep {...defaultProps()} />);

    const btn = screen.getByRole('button', { name: /try again/i });
    await user.click(btn);

    expect(startMock).toHaveBeenCalledTimes(1);
  });
});

describe('ApiKeyStep — paste fallback path', () => {
  it('toggling to paste shows the API-key input + Validate button', async () => {
    mockState = { kind: 'idle' };
    const user = userEvent.setup();

    render(<ApiKeyStep {...defaultProps({ apiKey: 'ds_test_xxx' })} />);

    // Initially in browser path — no API-key input visible.
    expect(screen.queryByPlaceholderText('ds_live_…')).not.toBeInTheDocument();

    // Toggle.
    await user.click(screen.getByRole('button', { name: /have an api key\? paste it instead/i }));

    // Now the paste form is showing.
    expect(screen.getByPlaceholderText('ds_live_…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /validate \+ continue/i })).toBeInTheDocument();
    // Toggle-back link is present.
    expect(
      screen.getByRole('button', { name: /use browser sign-in instead/i }),
    ).toBeInTheDocument();
  });

  it('Validate button calls onValidate when apiKey is non-empty', async () => {
    mockState = { kind: 'idle' };
    const onValidate = vi.fn();
    const user = userEvent.setup();

    render(<ApiKeyStep {...defaultProps({ apiKey: 'ds_test_xxx', onValidate })} />);

    await user.click(screen.getByRole('button', { name: /have an api key\? paste it instead/i }));

    const btn = screen.getByRole('button', { name: /validate \+ continue/i });
    expect(btn).not.toBeDisabled();
    await user.click(btn);

    expect(onValidate).toHaveBeenCalledTimes(1);
  });

  it('Validate button is disabled when apiKey is empty', async () => {
    mockState = { kind: 'idle' };
    const user = userEvent.setup();

    render(<ApiKeyStep {...defaultProps()} />);

    await user.click(screen.getByRole('button', { name: /have an api key\? paste it instead/i }));

    const btn = screen.getByRole('button', { name: /validate \+ continue/i });
    expect(btn).toBeDisabled();
  });

  it('paste error message renders in alert role', async () => {
    mockState = { kind: 'idle' };
    const user = userEvent.setup();

    render(<ApiKeyStep {...defaultProps({ error: 'invalid-key' })} />);

    await user.click(screen.getByRole('button', { name: /have an api key\? paste it instead/i }));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/invalid-key/);
  });
});
