// P-23 — ProfileActivityPanel.
//
// The property that matters most is the NAME. Ledger decision D-1 keeps the
// server-side session transcript out of the profile's "Clear history" action, so
// this panel shows rows a customer may have just "cleared". A heading that said
// history would have the product contradict itself; the panel says ACTIVITY and
// tells the customer plainly that clearing does not remove these. One arm pins
// that copy the way a parity test would, because a rename is exactly the kind
// of "harmless polish" that would reintroduce the contradiction.

import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ProfileActivityPanel } from '../../src/components/ProfileActivityPanel';

type Activity = {
  data: Array<{ at: string; url: string; agent_session_id: string }>;
  sessions_scanned: number;
  truncated: boolean;
};

function clientWith(result: Promise<Activity>) {
  const activity = vi.fn((_id: string) => result);
  return { client: { profiles: { activity } }, activity };
}

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
};

describe('ProfileActivityPanel', () => {
  it('CRITICAL renders each navigation with its time and URL, most recent first as delivered, and asks the server for exactly this profile', async () => {
    const { client, activity } = clientWith(
      Promise.resolve({
        data: [
          {
            at: '2026-09-05T08:05:00.000Z',
            url: 'https://a.example/pricing?x=1',
            agent_session_id: 'agt_1',
          },
          { at: '2026-09-05T08:00:00.000Z', url: 'https://b.example/', agent_session_id: 'agt_2' },
        ],
        sessions_scanned: 2,
        truncated: false,
      }),
    );
    render(
      <ProfileActivityPanel
        client={client}
        profileId="prof_1"
        profileName="Work"
        onClose={() => {}}
      />,
    );
    await flush();
    expect(activity).toHaveBeenCalledWith('prof_1');
    const rows = screen.getAllByText(
      (_, el) => el?.getAttribute('data-component') === 'profile-activity-row',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('a.example');
    expect(rows[0]?.textContent).toContain('https://a.example/pricing?x=1');
    expect(rows[1]?.textContent).toContain('b.example');
    expect(screen.getByText('2 sessions read')).toBeTruthy();
  });

  it('CRITICAL the heading says Activity and the subtitle says clearing history does not remove these — never "history" as the heading (D-1)', async () => {
    const { client } = clientWith(
      Promise.resolve({ data: [], sessions_scanned: 0, truncated: false }),
    );
    render(
      <ProfileActivityPanel
        client={client}
        profileId="prof_1"
        profileName="Work"
        onClose={() => {}}
      />,
    );
    await flush();
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toMatch(/^Activity/);
    expect(heading.textContent?.toLowerCase()).not.toContain('history');
    const subtitle = screen.getByText(
      (_, el) => el?.getAttribute('data-component') === 'profile-activity-subtitle',
    );
    expect(subtitle.textContent).toContain("Clearing the profile's history does not remove these.");
  });

  it('VACUITY CONTROL an empty result shows the empty state, not a blank list', async () => {
    const { client } = clientWith(
      Promise.resolve({ data: [], sessions_scanned: 3, truncated: false }),
    );
    render(
      <ProfileActivityPanel
        client={client}
        profileId="prof_1"
        profileName="Work"
        onClose={() => {}}
      />,
    );
    await flush();
    expect(
      screen.getByText((_, el) => el?.getAttribute('data-component') === 'profile-activity-empty'),
    ).toBeTruthy();
    expect(screen.getByText('3 sessions read')).toBeTruthy();
  });

  it('says so when older activity exists beyond the server bound', async () => {
    const { client } = clientWith(
      Promise.resolve({
        data: [
          { at: '2026-09-05T08:05:00.000Z', url: 'https://a.example/', agent_session_id: 'agt_1' },
        ],
        sessions_scanned: 100,
        truncated: true,
      }),
    );
    render(
      <ProfileActivityPanel
        client={client}
        profileId="prof_1"
        profileName="Work"
        onClose={() => {}}
      />,
    );
    await flush();
    expect(screen.getByText(/older activity exists but is not shown/)).toBeTruthy();
  });

  it('a failed load shows the error, not a silent empty panel', async () => {
    const { client } = clientWith(Promise.reject(new Error('Session activity is not available')));
    render(
      <ProfileActivityPanel
        client={client}
        profileId="prof_1"
        profileName="Work"
        onClose={() => {}}
      />,
    );
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('Session activity is not available');
  });

  it('Escape and the close control both close it', async () => {
    const onClose = vi.fn();
    const { client } = clientWith(
      Promise.resolve({ data: [], sessions_scanned: 0, truncated: false }),
    );
    render(
      <ProfileActivityPanel
        client={client}
        profileId="prof_1"
        profileName="Work"
        onClose={onClose}
      />,
    );
    await flush();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Close activity'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
