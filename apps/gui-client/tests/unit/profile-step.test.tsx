// V-669 — view tests for FirstRunWizard.tsx::ProfileStep.
//
// Focused on the archetype picker introduced in V-669. Post-2026-06-11
// cutover the picker offers exactly ONE archetype (the iPhone 17 launch
// default) — the prior iPhone 16 Pro / iPhone 15 Pro 2-option catalog was
// removed when the launch default moved to iphone17. Skip path doesn't fire
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
  it('defaults to the iPhone 17 launch archetype', async () => {
    profilesCreate.mockClear();
    const onCreated = vi.fn();
    render(<ProfileStep onSkip={vi.fn()} onCreated={onCreated} />);

    const nameInput = screen.getByLabelText(/profile name/i);
    await userEvent.type(nameInput, 'workflow-1');
    await userEvent.click(screen.getByRole('button', { name: /create profile/i }));

    expect(profilesCreate).toHaveBeenCalledTimes(1);
    expect(profilesCreate).toHaveBeenCalledWith({
      name: 'workflow-1',
      archetype: 'iphone17_ios18_7_safari26_4',
    });
  });

  it('offers the iPhone 17 Safari 26.4 + 26.5 options (the prior 16 Pro / 15 Pro catalog stays gone); 26.4 is the default', async () => {
    profilesCreate.mockClear();
    render(<ProfileStep onSkip={vi.fn()} onCreated={vi.fn()} />);

    // Two selectable archetypes post-2026-06-18: the 26.4 launch default + the
    // 26.5 point-release band (Agent-1 verified it meets the launch bar).
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /Safari 26\.4/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Safari 26\.5/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /iPhone 15 Pro/ })).toBeNull();
    expect(screen.queryByRole('radio', { name: /iPhone 16 Pro/ })).toBeNull();

    // No radio click → the default (26.4) is what create sends.
    await userEvent.type(screen.getByLabelText(/profile name/i), 'launch-target');
    await userEvent.click(screen.getByRole('button', { name: /create profile/i }));

    expect(profilesCreate).toHaveBeenCalledWith({
      name: 'launch-target',
      archetype: 'iphone17_ios18_7_safari26_4',
    });
  });

  it('selecting the 26.5 option sends that archetype to create', async () => {
    profilesCreate.mockClear();
    render(<ProfileStep onSkip={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.click(screen.getByRole('radio', { name: /Safari 26\.5/ }));
    await userEvent.type(screen.getByLabelText(/profile name/i), 'safari-265');
    await userEvent.click(screen.getByRole('button', { name: /create profile/i }));

    expect(profilesCreate).toHaveBeenCalledWith({
      name: 'safari-265',
      archetype: 'iphone17_ios18_7_safari26_5',
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
