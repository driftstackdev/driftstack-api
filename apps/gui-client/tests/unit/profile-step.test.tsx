// V-669 — view tests for FirstRunWizard.tsx::ProfileStep.
//
// Focused on the archetype picker introduced in V-669. The picker derives from
// ARCHETYPE_REGISTRY filtered to the customer-selectable statuses
// (launch|available). Since 2026-09-14 that registry is GENERATED from the fork's catalog,
// so its size moves whenever it is republished — the arms below count from the
// registry rather than pinning a number, and the held CriOS family is checked to
// stay OUT of the picker. The iPhone 17 26.4 launch default is still
// pre-selected. Skip path doesn't fire any API call.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ARCHETYPE_REGISTRY } from '@driftstack/api-types';

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

  it('offers the full fork catalog (launch iphone17 26.4 + every available slug); the iPhone 17 26.4/26.5 bands render and 26.4 is the default', async () => {
    profilesCreate.mockClear();
    render(<ProfileStep onSkip={vi.fn()} onCreated={vi.fn()} />);

    // The picker derives from ARCHETYPE_REGISTRY filtered to launch|available.
    //
    // ⛔ Counted from the registry, NOT hard-coded. This read `toHaveLength(81)`
    // and 81 was simply the number of slugs someone had last transcribed by hand
    // — so when the registry became generated and the catalog had moved on to 99
    // selectable, this arm failed for the RIGHT reason and told the wrong story
    // ("expected 99 to have length 81" reads like the picker broke). The property
    // worth pinning is that the picker offers exactly the selectable registry and
    // nothing else; the count is a consequence, and it changes every time the
    // fork's catalog is republished.
    const selectable = ARCHETYPE_REGISTRY.filter(
      (a) => a.status === 'launch' || a.status === 'available',
    );
    const radios = screen.getAllByRole('radio');
    expect(
      selectable.length,
      'the registry is empty — every check here would be vacuous',
    ).toBeGreaterThan(80);
    expect(radios).toHaveLength(selectable.length);
    // The held CriOS family sits in the registry as `planned` and must NOT be
    // offered. This is the arm that would catch a generator change that folded
    // held entries in as selectable — the one direction where a bigger picker is
    // a bug rather than new devices arriving.
    const held = ARCHETYPE_REGISTRY.filter((a) => a.status === 'planned');
    expect(held.length, 'no held entries — this check would be vacuous').toBeGreaterThan(0);
    const offered = new Set(radios.map((r) => r.getAttribute('value')));
    for (const entry of held) {
      expect(offered.has(entry.id), `${entry.id} is held and must not be selectable`).toBe(false);
    }
    expect(
      screen.getByRole('radio', { name: /iPhone 17 · iOS 18\.7 · Safari 26\.4/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /iPhone 17 · iOS 18\.7 · Safari 26\.5/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /iPhone 15 Pro \/ iOS 17\.5/ })).toBeNull();

    // No radio click → the default (26.4 launch) is what create sends.
    await userEvent.type(screen.getByLabelText(/profile name/i), 'launch-target');
    await userEvent.click(screen.getByRole('button', { name: /create profile/i }));

    expect(profilesCreate).toHaveBeenCalledWith({
      name: 'launch-target',
      archetype: 'iphone17_ios18_7_safari26_4',
    });
  });

  it('selecting the iPhone 17 Safari 26.5 option sends that archetype to create', async () => {
    profilesCreate.mockClear();
    render(<ProfileStep onSkip={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.click(
      screen.getByRole('radio', { name: /iPhone 17 · iOS 18\.7 · Safari 26\.5/ }),
    );
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

  it('does not render an unknown local profile-creation exception', async () => {
    profilesCreate.mockRejectedValueOnce(
      new Error('SQLite failed /Users/customer token=secret private-store.internal'),
    );
    render(<ProfileStep onSkip={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/profile name/i), 'safe-error');
    await userEvent.click(screen.getByRole('button', { name: /create profile/i }));

    expect(
      await screen.findByText("Couldn't complete setup. Check the details and try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\/Users|token=secret|private-store|SQLite/i)).toBeNull();
  });
});
