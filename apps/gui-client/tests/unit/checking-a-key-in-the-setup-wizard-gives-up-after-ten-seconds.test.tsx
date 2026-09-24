import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as Sdk from '@driftstack/sdk';

/**
 * GUI audit #19 — "Check key and continue" in the setup wizard built its probe
 * client with the SDK defaults: a 30 s deadline and three retries on a timeout.
 * Against a server that silently drops packets the wizard sat on "Validating…"
 * for about two minutes before saying anything. The probe is one question with a
 * person waiting on it: a 10 s deadline and no retries.
 *
 * The SDK class is the real one, observed: the options the wizard builds its
 * probe with are the ones checked, and the probe still runs for real.
 */

const constructed: Array<Record<string, unknown>> = [];
vi.mock('@driftstack/sdk', async (importOriginal) => {
  const real = await importOriginal<typeof Sdk>();
  class ObservedDriftstack extends real.Driftstack {
    constructor(opts: ConstructorParameters<typeof real.Driftstack>[0]) {
      constructed.push({ ...opts });
      super(opts);
    }
  }
  return { ...real, Driftstack: ObservedDriftstack };
});

const update = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ update, client: null, settings: { apiKey: null } }),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(() => Promise.resolve(() => {})),
}));

const { FirstRunWizard } = await import('../../src/views/FirstRunWizard');

beforeEach(() => {
  constructed.length = 0;
  update.mockClear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ id: 'acc_1', email: 'a@example.com', tier: 'solo_manual' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
});

describe('checking a pasted key in the setup wizard', () => {
  it('CRITICAL asks once, with a 10 s deadline — never the SDK default of 30 s and three retries', async () => {
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /get started/i }));
    await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
    await userEvent.click(
      screen.getByRole('button', { name: /have an api key\? paste it instead/i }),
    );
    await userEvent.type(screen.getByLabelText(/api key/i), 'ds_live_test_key');
    await userEvent.click(screen.getByRole('button', { name: /check key and continue/i }));
    await waitFor(() => expect(update).toHaveBeenCalled());

    const probe = constructed.find((o) => o.apiKey === 'ds_live_test_key');
    expect(probe).toBeDefined();
    expect(probe?.timeoutMs).toBe(10_000);
    expect(probe?.retry).toEqual({ maxAttempts: 0 });
  });
});
