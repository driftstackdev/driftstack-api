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

  it('offers exactly one archetype option (iPhone 17) — the prior 16 Pro / 15 Pro catalog is gone post-cutover', async () => {
    profilesCreate.mockClear();
    render(<ProfileStep onSkip={vi.fn()} onCreated={vi.fn()} />);

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(1);
    expect(screen.getByRole('radio', { name: /iPhone 17/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /iPhone 15 Pro/ })).toBeNull();
    expect(screen.queryByRole('radio', { name: /iPhone 16 Pro/ })).toBeNull();

    await userEvent.type(screen.getByLabelText(/profile name/i), 'launch-target');
    await userEvent.click(screen.getByRole('button', { name: /create profile/i }));

    expect(profilesCreate).toHaveBeenCalledWith({
      name: 'launch-target',
      archetype: 'iphone17_ios18_7_safari26_4',
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
