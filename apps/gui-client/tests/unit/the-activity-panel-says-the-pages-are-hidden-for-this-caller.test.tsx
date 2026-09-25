// Follow-up B (owner list 2026-09-24): "when `/v1/profiles/:id/activity` answers
// `pages_withheld: true`, the activity panel must say the pages are hidden for
// this caller instead of 'No pages recorded yet'."
//
// ROOT CAUSE. Security sweep #3 gated the pages behind the `read:sessions` scope
// (and, in a teammate's workspace, the admin role). A caller without it gets the
// rest of the feed with `data: []` and `pages_withheld: true` — documented so that
// it "never reads as 'no activity'". The panel branched on `data.length === 0`
// alone and never read the flag, so it said exactly that: "No pages recorded
// yet", beside a footer counting the sessions it had read.
//
// Pinned: withheld → the hidden sentence (role="status"), never the empty-state
// sentence, and the footer still counts the sessions read. VACUITY: an empty
// feed that is NOT withheld (and one from an older server with no flag at all)
// still says "No pages recorded yet".

import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  ProfileActivityPanel,
  PAGES_WITHHELD_SENTENCE,
} from '../../src/components/ProfileActivityPanel';

type Activity = {
  data: Array<{ at: string; url: string; agent_session_id: string }>;
  sessions_scanned: number;
  truncated: boolean;
  pages_withheld?: boolean;
};

function mount(activity: Activity): HTMLElement {
  const client = { profiles: { activity: vi.fn((_id: string) => Promise.resolve(activity)) } };
  const { container } = render(
    <ProfileActivityPanel
      client={client}
      profileId="prof_1"
      profileName="Work"
      onClose={() => {}}
    />,
  );
  return container;
}

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
};

const EMPTY = /No pages recorded yet/;

describe('follow-up B — withheld pages read as hidden, never as "no activity"', () => {
  it('CRITICAL pages_withheld: true → the hidden sentence, not "No pages recorded yet"; the footer still counts the sessions read', async () => {
    mount({ data: [], sessions_scanned: 3, truncated: false, pages_withheld: true });
    await flush();
    expect(screen.queryByText(EMPTY)).toBeNull();
    const hidden = screen.getByText(PAGES_WITHHELD_SENTENCE);
    expect(hidden.closest('[data-component="profile-activity-withheld"]')).not.toBeNull();
    expect(hidden.closest('[role="status"]')).not.toBeNull();
    expect(document.querySelector('[data-component="profile-activity-empty"]')).toBeNull();
    expect(screen.getByText('3 sessions read')).toBeTruthy();
    cleanup();
  });

  it('the sentence says WHAT is hidden and for whom, in plain words', () => {
    expect(PAGES_WITHHELD_SENTENCE).toMatch(/hidden/i);
    expect(PAGES_WITHHELD_SENTENCE).toMatch(/you/i);
    // Customer copy never names the mechanism.
    expect(PAGES_WITHHELD_SENTENCE).not.toMatch(/scope|read:sessions|403|token|harness|fleet/i);
  });

  it('VACUITY: an empty feed that is not withheld still says "No pages recorded yet"', async () => {
    mount({ data: [], sessions_scanned: 0, truncated: false, pages_withheld: false });
    await flush();
    expect(screen.getByText(EMPTY)).toBeTruthy();
    expect(screen.queryByText(PAGES_WITHHELD_SENTENCE)).toBeNull();
    cleanup();
  });

  it('VACUITY: an older server that sends no flag reads as today (not withheld)', async () => {
    mount({ data: [], sessions_scanned: 0, truncated: false });
    await flush();
    expect(screen.getByText(EMPTY)).toBeTruthy();
    cleanup();
  });
});
