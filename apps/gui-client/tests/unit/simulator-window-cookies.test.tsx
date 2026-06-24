// SimulatorWindow — the fancy live Cookies drawer pane (founder 2026-06-24,
// APPROVED). Validates per-domain expandable groups, flag chips derived from the
// REAL cookie fields, the working client-side Export, the disabled Import (the
// set-cookies wire is pending A3), search, and the inert (null / empty) states.
// Own file (the AgentSessionPanel→room mock pattern) so it doesn't leak into the
// base suite. Mirrors simulator-window-downloads.test.tsx.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const cookiesMock = vi.fn();
const downloadBlobMock = vi.fn();

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendNavigate: vi.fn(() => Promise.resolve()),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    DataReceived: 'dataReceived',
  },
}));

const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: { onRoom?: (room: unknown) => void }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  getAgentSession: () => Promise.resolve({ mode: 'manual', pairKind: null }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: (...a: unknown[]) => cookiesMock(...a) as unknown,
  uploadAgentSessionFile: () => Promise.resolve({ status: 'unavailable', handle: null }),
  listAgentSessionDownloads: () => Promise.resolve({ status: 'unavailable', files: null }),
  fetchAgentSessionDownload: () => Promise.resolve({ status: 'unavailable', file: null }),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

vi.mock('../../src/lib/download', () => ({
  downloadBlob: (...a: unknown[]) => downloadBlobMock(...a) as unknown,
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_ck');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

// Approach B drawer = an icon RAIL + a single content PANE. Open the drawer if
// collapsed, then select the Cookies rail icon so its pane renders (the default
// active pane is Session).
function openCookies(c: HTMLElement): void {
  const show = c.querySelector('[aria-label="Show controls"]');
  if (show) fireEvent.click(show);
  const railCk = c.querySelector('[data-component="sim-rail-cookies"]');
  if (railCk) fireEvent.click(railCk);
}

const YEAR_FROM_NOW = Math.floor(Date.now() / 1000) + 400 * 24 * 3600;

describe('SimulatorWindow — fancy Cookies pane (founder 2026-06-24)', () => {
  beforeEach(() => {
    cookiesMock.mockReset();
    downloadBlobMock.mockReset();
  });

  it('groups cookies by domain with flag chips + a live indicator', async () => {
    cookiesMock.mockResolvedValue({
      status: 'ok',
      cookies: [
        {
          domain: 'github.com',
          name: 'logged_in',
          value: 'yes',
          secure: true,
          httpOnly: true,
          expires: YEAR_FROM_NOW,
          sameSite: 'Lax',
        },
        {
          domain: 'github.com',
          name: 'dotcom_user',
          value: 'octocat',
          secure: true,
          expires: YEAR_FROM_NOW,
        },
        {
          domain: 'api.github.com',
          name: '_gh_api',
          value: 'a1b2c3',
          secure: true,
          httpOnly: true,
          expires: null,
        },
      ],
    });
    const { container } = renderSim();
    openCookies(container);

    const pane = await waitFor(() => {
      const p = container.querySelector('[data-component="simulator-cookies"]');
      if (!p || !p.querySelector('[data-component="simulator-cookie-domain"]')) {
        throw new Error('not yet');
      }
      return p;
    });
    // Two domain groups (github.com + api.github.com).
    const groups = pane.querySelectorAll('[data-component="simulator-cookie-domain"]');
    expect(groups.length).toBe(2);
    expect(pane.textContent).toContain('github.com');
    expect(pane.textContent).toContain('api.github.com');
    // Live indicator present (cookies !== null).
    expect(pane.querySelector('[data-component="simulator-cookies-live"]')).not.toBeNull();
    // First group is open by default → its flag chips render from the REAL fields.
    expect(pane.textContent).toContain('🔒 Secure');
    expect(pane.textContent).toContain('HttpOnly');
    expect(pane.textContent).toContain('SameSite=Lax');
    expect(pane.textContent).toContain('⏱ 1y');
  });

  it('Export downloads the jar as JSON; Import is disabled (pending A3)', async () => {
    cookiesMock.mockResolvedValue({
      status: 'ok',
      cookies: [{ domain: 'example.com', name: 'sid', value: 'abc', secure: true, expires: null }],
    });
    const { container } = renderSim();
    openCookies(container);

    const exportBtn = (await waitFor(() => {
      const b = container.querySelector('[data-action="export-cookies"]');
      if (!b || (b as HTMLButtonElement).disabled) throw new Error('not yet');
      return b;
    })) as HTMLButtonElement;
    fireEvent.click(exportBtn);
    expect(downloadBlobMock).toHaveBeenCalledTimes(1);
    const [filename, blob] = downloadBlobMock.mock.calls[0] as [string, Blob];
    expect(filename).toBe('cookies-agt_ck.json');
    expect(blob).toBeInstanceOf(Blob);

    // Import stays disabled with the "next device update" affordance.
    const importBtn = container.querySelector(
      '[data-action="import-cookies"]',
    ) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
    expect(importBtn.getAttribute('title')).toContain('next device update');
  });

  it('search filters by cookie name or domain', async () => {
    cookiesMock.mockResolvedValue({
      status: 'ok',
      cookies: [
        { domain: 'github.com', name: 'logged_in', value: 'yes' },
        { domain: 'tracker.io', name: '_ga', value: 'GA1.2' },
      ],
    });
    const { container } = renderSim();
    openCookies(container);

    const search = (await waitFor(() => {
      const s = container.querySelector('[aria-label="Search cookies"]');
      if (!s) throw new Error('not yet');
      return s;
    })) as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'tracker' } });
    const pane = container.querySelector('[data-component="simulator-cookies"]') as HTMLElement;
    const groups = pane.querySelectorAll('[data-component="simulator-cookie-domain"]');
    expect(groups.length).toBe(1);
    expect(pane.textContent).toContain('tracker.io');
    expect(pane.textContent).not.toContain('github.com');
  });

  it('inert: a null jar shows the calm pending note (Export disabled), not a broken layout', async () => {
    cookiesMock.mockResolvedValue({
      status: 'unavailable',
      cookies: null,
      reason: 'not available yet',
    });
    const { container } = renderSim();
    openCookies(container);

    const pane = await waitFor(() => {
      const p = container.querySelector('[data-component="simulator-cookies"]');
      if (!p) throw new Error('not yet');
      return p;
    });
    expect(pane.textContent).toContain('not available yet');
    // No live dot + Export disabled when there is no jar.
    expect(pane.querySelector('[data-component="simulator-cookies-live"]')).toBeNull();
    expect(
      (pane.querySelector('[data-action="export-cookies"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('inert: an empty jar shows "no cookies on this page" with the live indicator', async () => {
    cookiesMock.mockResolvedValue({ status: 'ok', cookies: [] });
    const { container } = renderSim();
    openCookies(container);

    const pane = await waitFor(() => {
      const p = container.querySelector('[data-component="simulator-cookies"]');
      if (!p || !p.textContent?.includes('no cookies')) throw new Error('not yet');
      return p;
    });
    expect(pane.textContent).toContain('no cookies on this page');
    // cookies !== null → live indicator shows even for the empty jar.
    expect(pane.querySelector('[data-component="simulator-cookies-live"]')).not.toBeNull();
  });
});
