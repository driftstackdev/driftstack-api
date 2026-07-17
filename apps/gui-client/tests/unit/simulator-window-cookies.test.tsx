// SimulatorWindow — the fancy live Cookies drawer pane (founder 2026-06-24,
// APPROVED). Validates per-domain expandable groups, flag chips derived from the
// REAL cookie fields, the working client-side Export, the disabled Import (the
// set-cookies wire is pending A3), search, and the inert (null / empty) states.
// Own file (the AgentSessionPanel→room mock pattern) so it doesn't leak into the
// base suite. Mirrors simulator-window-downloads.test.tsx.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';

const cookiesMock = vi.fn();
const setCookiesMock = vi.fn();
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
  AgentSessionPanel: (props: { onRoom?: (room: unknown, ownerRoom: unknown) => void }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  getAgentSession: () => Promise.resolve({ mode: 'manual', pairKind: null }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: (...a: unknown[]) => cookiesMock(...a) as unknown,
  setAgentSessionCookies: (...a: unknown[]) => setCookiesMock(...a) as unknown,
  uploadAgentSessionFile: () => Promise.resolve({ status: 'unavailable', handle: null }),
  listAgentSessionDownloads: () => Promise.resolve({ status: 'unavailable', files: null }),
  fetchAgentSessionDownload: () => Promise.resolve({ status: 'unavailable', file: null }),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  // Mirror the real class shape (#58): the cookie poll `.catch` branches on the
  // HTTP `status` attached to the thrown error, so the mock must carry it too.
  AgentSessionControlError: class extends Error {
    constructor(
      message: string,
      public status = 0,
      public kind = 'unknown',
    ) {
      super(message);
    }
  },
}));

vi.mock('../../src/lib/download', () => ({
  downloadBlob: (...a: unknown[]) => downloadBlobMock(...a) as unknown,
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');
// The mocked error class (carries `status`) so #58 catch-branch tests can throw it.
const { AgentSessionControlError } =
  (await import('../../src/lib/agent-session-control')) as unknown as {
    AgentSessionControlError: new (m: string, s?: number) => Error;
  };

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_ck');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

// Activity-bar drawer = an always-docked icon RAIL + a single content PANE that
// expands on icon click. Click the Cookies rail icon so its pane renders (the
// rail is always visible — no Show-controls chevron anymore; default is collapsed).
function openCookies(c: HTMLElement): void {
  const railCk = c.querySelector('[data-component="sim-rail-cookies"]');
  if (railCk) fireEvent.click(railCk);
}

const YEAR_FROM_NOW = Math.floor(Date.now() / 1000) + 400 * 24 * 3600;

describe('SimulatorWindow — fancy Cookies pane (founder 2026-06-24)', () => {
  beforeEach(() => {
    cookiesMock.mockReset();
    setCookiesMock.mockReset();
    downloadBlobMock.mockReset();
    // downloadBlob returns Promise<boolean> (true = confirmed write); the cookie-export
    // handler awaits it (.then) to surface a success/failure note. A bare reset returns
    // undefined → the .then throws an unhandled rejection. Default it to a resolved write.
    downloadBlobMock.mockResolvedValue(true);
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

  it('surfaces a synchronous cookie-copy failure and retries the exact value', async () => {
    cookiesMock.mockResolvedValue({
      status: 'ok',
      cookies: [
        {
          domain: 'example.com',
          name: 'sid',
          value: 'secret-cookie-value',
          secure: true,
          expires: null,
        },
      ],
    });
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const throwingWrite = vi.fn(() => {
      throw new Error('clipboard denied');
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: throwingWrite },
      configurable: true,
    });
    try {
      const { container } = renderSim();
      openCookies(container);
      const copyButton = (await waitFor(() => {
        const button = container.querySelector('[aria-label="Copy value of sid"]');
        if (button === null) throw new Error('cookie row not ready');
        return button;
      })) as HTMLButtonElement;
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(copyButton.getAttribute('aria-label')).toBe('Retry copy value of sid');
      });
      expect(copyButton.textContent).toBe("Couldn't copy — retry");
      expect(throwingWrite).toHaveBeenCalledWith('secret-cookie-value');

      const recoveredWrite = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: recoveredWrite },
        configurable: true,
      });
      fireEvent.click(copyButton);

      await waitFor(() => expect(recoveredWrite).toHaveBeenCalledWith('secret-cookie-value'));
      expect(recoveredWrite).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(copyButton.getAttribute('aria-label')).toBe('Copied value of sid');
      });
      expect(copyButton.textContent).toBe('Copied ✓');
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
      else delete (navigator as Partial<Navigator>).clipboard;
    }
  });

  it('ignores an older cookie-copy completion after a newer row succeeds', async () => {
    cookiesMock.mockResolvedValue({
      status: 'ok',
      cookies: [
        { domain: 'example.com', name: 'first', value: 'alpha', expires: null },
        { domain: 'example.com', name: 'second', value: 'beta', expires: null },
      ],
    });
    let resolveFirst: (() => void) | undefined;
    const writeText = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    try {
      const { container } = renderSim();
      openCookies(container);
      const first = (await waitFor(() => {
        const button = container.querySelector('[aria-label="Copy value of first"]');
        if (button === null) throw new Error('first cookie row not ready');
        return button;
      })) as HTMLButtonElement;
      const second = container.querySelector(
        '[aria-label="Copy value of second"]',
      ) as HTMLButtonElement;

      fireEvent.click(first);
      await waitFor(() => expect(first.getAttribute('aria-label')).toBe('Copying value of first'));
      fireEvent.click(second);
      await waitFor(() => expect(second.getAttribute('aria-label')).toBe('Copied value of second'));

      await act(async () => {
        resolveFirst?.();
        await Promise.resolve();
      });
      expect(second.getAttribute('aria-label')).toBe('Copied value of second');
      expect(first.textContent).toBe('alpha');
      expect(writeText.mock.calls).toEqual([['alpha'], ['beta']]);
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
      else delete (navigator as Partial<Navigator>).clipboard;
    }
  });

  it('labels a long poll as refreshing while retaining the last good cookie jar', async () => {
    let resolveRefresh:
      ((value: { status: 'ok'; cookies: Array<Record<string, unknown>> }) => void) | undefined;
    cookiesMock
      .mockResolvedValueOnce({
        status: 'ok',
        cookies: [
          {
            domain: 'example.com',
            name: 'sid',
            value: 'abc',
            secure: true,
            expires: null,
          },
        ],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const { container, unmount } = renderSim();
    openCookies(container);

    try {
      const liveBadge = await waitFor(() => {
        const badge = container.querySelector('[data-component="simulator-cookies-live"]');
        expect(badge?.textContent).toContain('live');
        return badge as HTMLElement;
      });
      expect(liveBadge.getAttribute('data-refreshing')).toBe('false');

      const scheduledPoll = [...timerSpy.mock.calls]
        .reverse()
        .find((call) => call[1] === 3000 && typeof call[0] === 'function');
      expect(scheduledPoll).toBeDefined();
      act(() => {
        (scheduledPoll?.[0] as () => void)();
      });

      await waitFor(() => expect(cookiesMock).toHaveBeenCalledTimes(2));
      expect(liveBadge.textContent).toContain('refreshing');
      expect(liveBadge.getAttribute('data-refreshing')).toBe('true');
      expect(container.textContent).toContain('sid');

      await act(async () => {
        resolveRefresh?.({ status: 'ok', cookies: [] });
        await Promise.resolve();
      });
      await waitFor(() => expect(liveBadge.textContent).toContain('live'));
      expect(liveBadge.getAttribute('data-refreshing')).toBe('false');
    } finally {
      unmount();
      timerSpy.mockRestore();
    }
  });

  it('Export downloads the jar as JSON; Import is now ENABLED (the set-cookies wire is wired)', async () => {
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
    expect(filename).toBe('cookies.json');
    expect(blob).toBeInstanceOf(Blob);

    // Import is now enabled (a live session) + advertises the smart multi-format
    // import (founder #3) — not the old JSON-only title.
    const importBtn = container.querySelector(
      '[data-action="import-cookies"]',
    ) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(false);
    expect(importBtn.getAttribute('title')).toContain('cookies.txt');
  });

  it('Import reads a valid cookies.json, validates it, and calls setAgentSessionCookies → success note', async () => {
    cookiesMock.mockResolvedValue({ status: 'ok', cookies: [] });
    setCookiesMock.mockResolvedValue({ status: 'ok' });
    const { container } = renderSim();
    openCookies(container);

    const input = (await waitFor(() => {
      const i = container.querySelector('[data-component="simulator-cookies-import-input"]');
      if (!i) throw new Error('not yet');
      return i;
    })) as HTMLInputElement;

    const jar = [
      {
        domain: '.example.com',
        name: 'sid',
        value: 'abc',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
      { domain: 'example.com', name: 'pref', value: 'dark' },
    ];
    const file = new File([JSON.stringify(jar)], 'cookies.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const note = container.querySelector('[data-component="simulator-cookies-import-note"]');
      if (!note || !note.textContent?.includes('Imported')) throw new Error('not yet');
      return note;
    });
    // Called with the session id + the parsed jar. The smart parser NORMALIZES
    // (e.g. stamps an explicit expires:null for session cookies), so assert the
    // essential per-cookie fields rather than a raw deep-equal.
    expect(setCookiesMock).toHaveBeenCalledTimes(1);
    const [calledId, calledJar] = setCookiesMock.mock.calls[0] as [
      string,
      Array<{ name: string; value: string; domain: string }>,
    ];
    expect(calledId).toBe('agt_ck');
    expect(calledJar).toHaveLength(2);
    expect(calledJar.map((c) => c.name)).toEqual(['sid', 'pref']);
    expect(calledJar[0]).toMatchObject({ domain: '.example.com', value: 'abc', httpOnly: true });
    const note = container.querySelector(
      '[data-component="simulator-cookies-import-note"]',
    ) as HTMLElement;
    expect(note.textContent).toContain('Imported 2 cookies');
  });

  it('Import rejects a non-cookies file shape WITHOUT calling the server (clear validation note)', async () => {
    cookiesMock.mockResolvedValue({ status: 'ok', cookies: [] });
    const { container } = renderSim();
    openCookies(container);

    const input = (await waitFor(() => {
      const i = container.querySelector('[data-component="simulator-cookies-import-input"]');
      if (!i) throw new Error('not yet');
      return i;
    })) as HTMLInputElement;

    // An array, but the entries are not cookies (no string domain/name/value).
    const bad = new File([JSON.stringify([{ foo: 1 }])], 'bad.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [bad] } });

    await waitFor(() => {
      const note = container.querySelector('[data-component="simulator-cookies-import-note"]');
      if (!note || note.textContent === '' || note.textContent === null) throw new Error('not yet');
      return note;
    });
    const note = container.querySelector(
      '[data-component="simulator-cookies-import-note"]',
    ) as HTMLElement;
    // The smart parser finds 0 valid cookies in [{foo:1}] (no name/value) → a clear
    // "couldn't…" note + NO server round-trip (the import never reaches the device).
    expect(note.textContent?.toLowerCase()).toContain("couldn't");
    expect(setCookiesMock).not.toHaveBeenCalled();
  });

  it('Import surfaces the REAL unavailable reason (honest copy, not a "next device update" mask)', async () => {
    cookiesMock.mockResolvedValue({ status: 'ok', cookies: [] });
    setCookiesMock.mockResolvedValue({
      status: 'unavailable',
      reason: 'session is not live on a node',
    });
    const { container } = renderSim();
    openCookies(container);

    const input = (await waitFor(() => {
      const i = container.querySelector('[data-component="simulator-cookies-import-input"]');
      if (!i) throw new Error('not yet');
      return i;
    })) as HTMLInputElement;

    const jar = [{ domain: 'example.com', name: 'sid', value: 'abc' }];
    const file = new File([JSON.stringify(jar)], 'cookies.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const note = container.querySelector('[data-component="simulator-cookies-import-note"]');
      if (!note || !note.textContent?.includes("Can't import right now"))
        throw new Error('not yet');
      return note;
    });
    expect(setCookiesMock).toHaveBeenCalledTimes(1);
  });

  it('Import surfaces the REAL reason on a 422 (rejected jar), not the "next device update" mask', async () => {
    cookiesMock.mockResolvedValue({ status: 'ok', cookies: [] });
    setCookiesMock.mockRejectedValue(new AgentSessionControlError('too many cookies', 422));
    const { container } = renderSim();
    openCookies(container);
    const input = (await waitFor(() => {
      const i = container.querySelector('[data-component="simulator-cookies-import-input"]');
      if (!i) throw new Error('not yet');
      return i;
    })) as HTMLInputElement;
    const jar = [{ domain: 'example.com', name: 'sid', value: 'abc' }];
    const file = new File([JSON.stringify(jar)], 'cookies.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      const note = container.querySelector('[data-component="simulator-cookies-import-note"]');
      if (!note || !note.textContent?.toLowerCase().includes('rejected'))
        throw new Error('not yet');
      return note;
    });
    expect(
      container
        .querySelector('[data-component="simulator-cookies-import-note"]')
        ?.textContent?.toLowerCase(),
    ).not.toContain('next device update');
  });

  it('Import surfaces "Session is no longer live" on a 404', async () => {
    cookiesMock.mockResolvedValue({ status: 'ok', cookies: [] });
    setCookiesMock.mockRejectedValue(new AgentSessionControlError('gone', 404));
    const { container } = renderSim();
    openCookies(container);
    const input = (await waitFor(() => {
      const i = container.querySelector('[data-component="simulator-cookies-import-input"]');
      if (!i) throw new Error('not yet');
      return i;
    })) as HTMLInputElement;
    const jar = [{ domain: 'example.com', name: 'sid', value: 'abc' }];
    const file = new File([JSON.stringify(jar)], 'cookies.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      const note = container.querySelector('[data-component="simulator-cookies-import-note"]');
      if (!note || !note.textContent?.toLowerCase().includes('no longer live'))
        throw new Error('not yet');
      return note;
    });
  });

  it('Import catches an over-cap jar (>2000 cookies) client-side WITHOUT calling the server', async () => {
    cookiesMock.mockResolvedValue({ status: 'ok', cookies: [] });
    const { container } = renderSim();
    openCookies(container);
    const input = (await waitFor(() => {
      const i = container.querySelector('[data-component="simulator-cookies-import-input"]');
      if (!i) throw new Error('not yet');
      return i;
    })) as HTMLInputElement;
    const jar = Array.from({ length: 2001 }, (_, n) => ({
      domain: 'example.com',
      name: `c${n}`,
      value: 'v',
    }));
    const file = new File([JSON.stringify(jar)], 'cookies.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      const note = container.querySelector('[data-component="simulator-cookies-import-note"]');
      if (!note || !note.textContent?.toLowerCase().includes('too many cookies'))
        throw new Error('not yet');
      return note;
    });
    // The over-cap jar never went to the server (caught before the round-trip).
    expect(setCookiesMock).not.toHaveBeenCalled();
  });

  it('an EXPIRED control key (401) degrades the cookies pane calmly — a reopen hint, NOT an endless "retrying"', async () => {
    cookiesMock.mockRejectedValue(new AgentSessionControlError('control key expired', 401));
    const { container } = renderSim();
    openCookies(container);
    await waitFor(() => {
      const pane = container.querySelector('[data-component="simulator-cookies"]');
      if (!pane || !pane.textContent?.toLowerCase().includes('credential expired'))
        throw new Error('not yet');
      return pane;
    });
    const pane = container.querySelector('[data-component="simulator-cookies"]') as HTMLElement;
    expect(pane.textContent?.toLowerCase()).toContain('reopen the session');
    expect(pane.textContent?.toLowerCase()).not.toContain("couldn't load cookies — retrying");
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
    expect(pane.textContent).toContain('unavailable for this session');
    expect(pane.textContent).not.toContain('not available yet');
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

  // #58 — the poll `.catch` now branches on the thrown error's HTTP status
  // instead of one blanket "ships with the next device update" line.
  it('#58: a 404 (no page loaded yet) surfaces a calm "cookies will appear once a page loads" note', async () => {
    cookiesMock.mockRejectedValue(new AgentSessionControlError('not found', 404));
    const { container } = renderSim();
    openCookies(container);

    const pane = await waitFor(() => {
      const p = container.querySelector('[data-component="simulator-cookies"]');
      if (!p || !p.textContent?.includes('once a page loads')) throw new Error('not yet');
      return p;
    });
    expect(pane.textContent).toContain('cookies will appear once a page loads in the session');
    // The stale "next device update" copy is gone.
    expect(pane.textContent).not.toContain('next device update');
  });

  it('#58: a 503 (route gated off) surfaces "cookies aren’t enabled on this deployment"', async () => {
    cookiesMock.mockRejectedValue(new AgentSessionControlError('unavailable', 503));
    const { container } = renderSim();
    openCookies(container);

    const pane = await waitFor(() => {
      const p = container.querySelector('[data-component="simulator-cookies"]');
      if (!p || !p.textContent?.includes("aren't enabled")) throw new Error('not yet');
      return p;
    });
    expect(pane.textContent).toContain("cookies aren't enabled on this deployment");
    expect(pane.textContent).not.toContain('next device update');
  });

  it('#58: a network/other error surfaces a transient "couldn’t load — retrying" note', async () => {
    cookiesMock.mockRejectedValue(new Error('network down')); // not an AgentSessionControlError
    const { container } = renderSim();
    openCookies(container);

    const pane = await waitFor(() => {
      const p = container.querySelector('[data-component="simulator-cookies"]');
      if (!p || !p.textContent?.includes('retrying')) throw new Error('not yet');
      return p;
    });
    expect(pane.textContent).toContain("couldn't load cookies — retrying");
    expect(pane.textContent).not.toContain('next device update');
  });

  // Finding #4 — a 200 `unavailable` whose `reason` is one of the three INTERNAL server
  // diagnostics is mapped to friendly customer copy by the LIST poll (the raw debug
  // phrase must not leak). An actionable reason still passes through (see the helper
  // unit tests in simulator-window-sizing.test.ts).
  it('finding #4: an internal "unavailable" reason shows friendly copy, not the raw phrase', async () => {
    cookiesMock.mockResolvedValue({
      status: 'unavailable',
      cookies: null,
      reason: 'session is not live on a node',
    });
    const { container } = renderSim();
    openCookies(container);

    const pane = await waitFor(() => {
      const p = container.querySelector('[data-component="simulator-cookies"]');
      if (!p || !p.textContent?.includes("isn't live on a device")) throw new Error('not yet');
      return p;
    });
    expect(pane.textContent).toContain("the session isn't live on a device right now");
    // The raw internal diagnostic is NOT surfaced.
    expect(pane.textContent).not.toContain('session is not live on a node');
  });

  // Finding #5 — the poll self-schedules the next tick ONLY after the prior request
  // settles, so requests can never overlap/stack. With a request that never resolves,
  // only ONE call is ever made (the old setInterval would have fired several more).
  it('finding #5: requests never stack — a pending request blocks the next tick (single-flight)', async () => {
    cookiesMock.mockReturnValue(new Promise(() => {})); // never settles
    const { container } = renderSim();
    openCookies(container);

    // Give the would-be 3s interval ample real time to fire repeatedly if it were still
    // a fixed-interval poll; the self-scheduling poll must stay at exactly one in-flight.
    await new Promise((r) => setTimeout(r, 250));
    expect(cookiesMock).toHaveBeenCalledTimes(1);
  });
});
