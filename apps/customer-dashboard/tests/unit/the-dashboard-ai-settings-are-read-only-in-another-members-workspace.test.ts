// The /settings AI billing form reads and writes the SIGNED-IN account only:
// the status read ignores the workspace a member is viewing, and the server now
// refuses a save that names another workspace (S13–S16 re-audit #3). So in a
// team workspace the form shows the member's own settings, read-only, with a
// note saying so — never a Save button that can only fail with an error about a
// request header. In the member's own workspace nothing changes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

// jsdom ships no type declarations here; the page's window is the DOM window
// plus the globals DashboardLayout injects.
type PageWindow = Window &
  typeof globalThis & {
    driftstackConfirm?: (message?: string) => Promise<boolean>;
    driftstackActAsHeaders?: () => Record<string, string>;
  };
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: Record<string, unknown>) => { window: PageWindow };
};

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'settings', 'index.html');
const PAGE_URL = 'https://app.driftstack.io/settings/';
const OWNER = 'acc_0f1e2d3c-4b5a-4968-8776-655443322110';

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setUpDom(actAs: string | null): { window: PageWindow; patches: string[] } {
  const scriptBodies: string[] = [];
  const html = readFileSync(BUILT_PAGE, 'utf8').replace(
    /<script[^>]*>([\s\S]*?)<\/script>/g,
    (_m, body: string) => {
      scriptBodies.push(body);
      return '';
    },
  );
  const { window } = new JSDOM(html, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const patches: string[] = [];
  if (typeof window.Response !== 'function') window.Response = Response;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    if (/bundled-llm-settings$/.test(url) && method === 'PATCH') {
      patches.push(String(init?.body));
      return Promise.resolve(json({ consent: true, monthly_cap_usd_cents: 2_000 }));
    }
    if (/\/v1\/account\/me\/bundled-llm-status$/.test(url)) {
      return Promise.resolve(
        json({
          consent: true,
          cap_cents: 2_000,
          used_this_month_cents: 0,
          remaining_cents: 2_000,
          month_started_at: '2026-09-01T00:00:00.000Z',
        }),
      );
    }
    if (/\/v1\/account\/me$/.test(url)) {
      return Promise.resolve(json({ email: 'me@example.com', name: 'Me', slug: 'me' }));
    }
    return Promise.resolve(json({}, 404));
  };
  window.localStorage.setItem('ds_web_session_token', 'tok');
  window.driftstackConfirm = () => Promise.resolve(true);
  // DashboardLayout's act-as helper: a header only while viewing another
  // member's workspace.
  window.driftstackActAsHeaders = (): Record<string, string> =>
    actAs === null ? {} : { 'x-driftstack-account': actAs };
  const pageScript = scriptBodies.find((s) => s.includes('data-page="settings"'));
  if (!pageScript) throw new Error('settings inline script not found');
  installDashboardDeadline(window);
  window.eval(pageScript);
  return { window, patches };
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function el<T extends Element>(window: PageWindow, selector: string): T {
  const found = window.document.querySelector(selector);
  if (found === null) throw new Error(`not found: ${selector}`);
  return found as T;
}

async function submit(window: PageWindow): Promise<void> {
  el<HTMLFormElement>(window, '[data-bundled-form]').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
}

describe("the dashboard AI settings are read-only in another member's workspace", () => {
  let win: PageWindow | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });

  it('in a team workspace the controls are disabled, the note says why, and nothing is saved', async () => {
    const { window, patches } = setUpDom(OWNER);
    win = window;
    await flush();

    const note = el<HTMLElement>(window, '[data-bundled-other-workspace]');
    expect(note.classList.contains('hidden')).toBe(false);
    expect(note.textContent).toMatch(/your own/);
    expect(note.textContent).not.toMatch(/X-Driftstack|header/i);
    for (const selector of [
      '[data-field="bundled-consent"]',
      '[data-field="bundled-cap-usd"]',
      '[data-bundled-save]',
    ]) {
      const control = el<HTMLInputElement | HTMLButtonElement>(window, selector);
      expect(control.disabled, selector).toBe(true);
      expect(control.title, selector).toMatch(/own workspace/);
    }
    // The settings still load, so the customer sees their own numbers.
    expect(el<HTMLInputElement>(window, '[data-field="bundled-cap-usd"]').value).toBe('20.00');

    await submit(window);
    expect(patches).toEqual([]);
  });

  it('CONTROL — in their own workspace the form is live and a save is sent', async () => {
    const { window, patches } = setUpDom(null);
    win = window;
    await flush();

    expect(
      el<HTMLElement>(window, '[data-bundled-other-workspace]').classList.contains('hidden'),
    ).toBe(true);
    expect(el<HTMLButtonElement>(window, '[data-bundled-save]').disabled).toBe(false);
    await submit(window);
    expect(patches).toHaveLength(1);
  });
});
