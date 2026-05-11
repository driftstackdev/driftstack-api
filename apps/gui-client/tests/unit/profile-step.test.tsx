// V-669 — view tests for FirstRunWizard.tsx::ProfileStep.
//
// Focused on the archetype picker introduced in V-669: defaults to
// the iPhone 16 Pro archetype; switching to the legacy archetype
// passes through to client.profiles.create; skip path doesn't fire
// any API call.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const profilesCreate = vi.fn(() => Promise.resolve({}));

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    client: { profiles: { create: profilesCreate } },
  }),
}));

const { ProfileStep } = await import('../../src/views/FirstRunWizard');

describe('V-669 ProfileStep — archetype picker', () => {
  it('defaults to the iPhone 16 Pro archetype', async () => {
    profilesCreate.mockClear();
    const onCreated = vi.fn();
    render(<ProfileStep onSkip={vi.fn()} onCreated={onCreated} />);

    const nameInput = screen.getByLabelText(/profile name/i);
    await userEvent.type(nameInput, 'workflow-1');
    await userEvent.click(screen.getByRole('button', { name: /create profile/i }));

    expect(profilesCreate).toHaveBeenCalledTimes(1);
    expect(profilesCreate).toHaveBeenCalledWith({
      name: 'workflow-1',
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
  });

  it('switching to the legacy archetype passes through to profiles.create', async () => {
    profilesCreate.mockClear();
    render(<ProfileStep onSkip={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/profile name/i), 'legacy-target');
    // Pick the legacy archetype option.
    const legacyRadio = screen.getByRole('radio', { name: /iPhone 15 Pro/ });
    await userEvent.click(legacyRadio);
    await userEvent.click(screen.getByRole('button', { name: /create profile/i }));

    expect(profilesCreate).toHaveBeenCalledWith({
      name: 'legacy-target',
      archetype: 'iphone15pro_ios17_5_safari17_5',
    });
  });

  it('Skip for now: does not call profiles.create; fires onSkip', async () => {
    profilesCreate.mockClear();
    const onSkip = vi.fn();
    render(<ProfileStep onSkip={onSkip} onCreated={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    expect(profilesCreate).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('Create button is disabled until a name is entered', () => {
    render(<ProfileStep onSkip={vi.fn()} onCreated={vi.fn()} />);
    const createBtn = screen.getByRole('button', { name: /create profile/i });
    expect(createBtn).toBeDisabled();
  });
});
