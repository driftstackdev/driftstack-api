import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/shells/incident-detail.astro');

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function scriptBody(): string {
  const source = readFileSync(PAGE, 'utf8');
  const match = source.match(
    /<script is:inline define:vars=\{\{ apiBaseUrl \}\}>([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) throw new Error('incident detail inline script not found');
  return match[1];
}

function evalPage(window: JSDOM['window']): void {
  installAdminDeadline(window);
  window.eval(`const apiBaseUrl = 'https://api.driftstack.dev';${scriptBody()}`);
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function form(id: string, label: string, withStatus = false): string {
  return `<form id="${id}">
    <textarea name="message">${label} message</textarea>
    ${withStatus ? '<select name="status"><option value="monitoring">monitoring</option></select>' : ''}
    <button type="submit">${label}</button>
  </form>`;
}

describe('admin incident detail mutation lifecycle', () => {
  let windowRef: JSDOM['window'] | null = null;

  afterEach(() => {
    windowRef?.close();
    windowRef = null;
  });

  it('serializes update/resolve/reopen into one busy mutation lane', async () => {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', () => {});
    const dom = new JSDOM(
      `<!doctype html><title>Incident</title>
       <div data-banner class="hidden"></div>
       <div data-form-group="active">${form('add-update-form', 'Post update', true)}${form('resolve-form', 'Resolve')}</div>
       <div data-form-group="resolved" class="hidden">${form('reopen-form', 'Reopen')}</div>`,
      {
        url: 'https://admin.driftstack.dev/incidents/inc_test',
        runScripts: 'dangerously',
        virtualConsole,
      },
    );
    windowRef = dom.window;
    const calls: FetchCall[] = [];
    let releaseUpdate: (value: Response) => void = () => {};
    const pendingUpdate = new Promise<Response>((resolve) => {
      releaseUpdate = resolve;
    });
    // @ts-expect-error — jsdom's fetch global is intentionally injected.
    dom.window.fetch = (input: string, init: RequestInit | undefined) => {
      const call = { url: String(input), init };
      calls.push(call);
      if (/\/updates$/.test(call.url)) return pendingUpdate;
      if (init?.method === 'POST') return Promise.resolve(response({}, 200));
      return Promise.resolve(
        response({
          incident: {
            id: 'inc_test',
            title: 'Test incident',
            severity: 'major',
            status: 'investigating',
            public: true,
            affected_components: [],
            started_at: '2026-07-12T00:00:00.000Z',
            resolved_at: null,
          },
          updates: [],
        }),
      );
    };
    dom.window.localStorage.setItem('ds_web_session_token', 'tok');
    evalPage(dom.window);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await flush();

    const updateForm = dom.window.document.getElementById('add-update-form') as HTMLFormElement;
    const resolveForm = dom.window.document.getElementById('resolve-form') as HTMLFormElement;
    const updateButton = updateForm.querySelector('button') as HTMLButtonElement;
    const resolveButton = resolveForm.querySelector('button') as HTMLButtonElement;
    const reopenButton = dom.window.document.querySelector(
      '#reopen-form button',
    ) as HTMLButtonElement;
    updateForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    resolveForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(updateButton.disabled).toBe(true);
    expect(updateButton.getAttribute('aria-busy')).toBe('true');
    expect(resolveButton.disabled).toBe(true);
    expect(reopenButton.disabled).toBe(true);
    expect(calls.find((call) => call.init?.method === 'POST')?.init?.signal).toBeDefined();

    releaseUpdate(response({ detail: 'test failure' }, 500));
    await flush(40);
    expect(updateButton.disabled).toBe(false);
    expect(updateButton.hasAttribute('aria-busy')).toBe(false);
    expect(updateButton.textContent).toBe('Post update');
    expect(resolveButton.disabled).toBe(false);
    expect(reopenButton.disabled).toBe(false);
  });

  it('does not report malformed accepted update JSON as a failed mutation', async () => {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', () => {});
    const dom = new JSDOM(
      `<!doctype html><title>Incident</title>
       <div data-banner class="hidden"></div>
       <div data-form-group="active">${form('add-update-form', 'Post update', true)}${form('resolve-form', 'Resolve')}</div>
       <div data-form-group="resolved" class="hidden">${form('reopen-form', 'Reopen')}</div>`,
      {
        url: 'https://admin.driftstack.dev/incidents/inc_test',
        runScripts: 'dangerously',
        virtualConsole,
      },
    );
    windowRef = dom.window;
    const calls: FetchCall[] = [];
    // @ts-expect-error — jsdom's fetch global is intentionally injected.
    dom.window.fetch = (input: string, init: RequestInit | undefined) => {
      const call = { url: String(input), init };
      calls.push(call);
      if (/\/updates$/.test(call.url)) {
        return Promise.resolve(
          new Response('{', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        response({
          incident: {
            id: 'inc_test',
            title: 'Test incident',
            severity: 'major',
            status: 'investigating',
            public: true,
            affected_components: [],
            started_at: '2026-07-12T00:00:00.000Z',
            resolved_at: null,
          },
          updates: [],
        }),
      );
    };
    dom.window.localStorage.setItem('ds_web_session_token', 'tok');
    evalPage(dom.window);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await flush();

    const updateForm = dom.window.document.getElementById('add-update-form') as HTMLFormElement;
    updateForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    updateForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(40);

    expect(calls.filter((call) => /\/updates$/.test(call.url))).toHaveLength(1);
    expect(dom.window.document.querySelector('[data-banner]')?.textContent).not.toContain(
      'Post failed',
    );
  });

  it('reconciles a committed timeline update after timeout without inviting a duplicate', async () => {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', () => {});
    const dom = new JSDOM(
      `<!doctype html><title>Incident</title>
       <div data-banner class="hidden"></div>
       <span data-field="status-badge"></span>
       <ul data-list="timeline"></ul>
       <div data-form-group="active">${form('add-update-form', 'Post update', true)}${form('resolve-form', 'Resolve')}</div>
       <div data-form-group="resolved" class="hidden">${form('reopen-form', 'Reopen')}</div>`,
      {
        url: 'https://admin.driftstack.dev/incidents/inc_test',
        runScripts: 'dangerously',
        virtualConsole,
      },
    );
    windowRef = dom.window;
    const calls: FetchCall[] = [];
    let committed = false;
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    // @ts-expect-error — jsdom's fetch global is intentionally injected.
    dom.window.fetch = (input: string, init: RequestInit | undefined) => {
      const call = { url: String(input), init };
      calls.push(call);
      if (/\/updates$/.test(call.url)) {
        committed = true;
        return Promise.reject(timeout);
      }
      return Promise.resolve(
        response({
          incident: {
            id: 'inc_test',
            title: 'Test incident',
            severity: 'major',
            status: committed ? 'monitoring' : 'investigating',
            public: true,
            affected_components: [],
            started_at: '2026-07-12T00:00:00.000Z',
            resolved_at: null,
          },
          updates: committed
            ? [
                {
                  status: 'monitoring',
                  message: 'Post update message',
                  posted_at: '2026-07-12T00:05:00.000Z',
                },
              ]
            : [],
        }),
      );
    };
    dom.window.localStorage.setItem('ds_web_session_token', 'tok');
    evalPage(dom.window);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await flush();

    const updateForm = dom.window.document.getElementById('add-update-form') as HTMLFormElement;
    updateForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(50);

    expect(calls.filter((call) => /\/updates$/.test(call.url))).toHaveLength(1);
    expect(calls.filter((call) => call.init?.method !== 'POST')).toHaveLength(2);
    expect(dom.window.document.querySelector('[data-list="timeline"]')?.textContent).toContain(
      'Post update message',
    );
    expect(dom.window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /refreshed timeline contains a new exact message and status.*not posted again/i,
    );
    const updateButton = updateForm.querySelector('button') as HTMLButtonElement;
    const resolveButton = dom.window.document.querySelector(
      '#resolve-form button',
    ) as HTMLButtonElement;
    const reopenButton = dom.window.document.querySelector(
      '#reopen-form button',
    ) as HTMLButtonElement;
    expect(updateButton.disabled).toBe(true);
    expect(updateButton.textContent).toBe('Already applied');
    expect(resolveButton.disabled).toBe(true);
    expect(reopenButton.disabled).toBe(true);
    updateForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.filter((call) => /\/updates$/.test(call.url))).toHaveLength(1);
  });

  it.each([
    {
      formId: 'resolve-form',
      suffix: '/resolve',
      initialStatus: 'investigating',
      finalStatus: 'resolved',
      banner: /refreshed incident is resolved.*not submitted again/i,
    },
    {
      formId: 'reopen-form',
      suffix: '/reopen',
      initialStatus: 'resolved',
      finalStatus: 'investigating',
      banner: /refreshed incident is active again.*not submitted again/i,
    },
  ])(
    'reconciles a committed $suffix state transition and blocks every mutation',
    async (testCase) => {
      const virtualConsole = new VirtualConsole();
      virtualConsole.on('jsdomError', () => {});
      const dom = new JSDOM(
        `<!doctype html><title>Incident</title>
       <div data-banner class="hidden"></div>
       <span data-field="status-badge"></span>
       <ul data-list="timeline"></ul>
       <div data-form-group="active">${form('add-update-form', 'Post update', true)}${form('resolve-form', 'Resolve')}</div>
       <div data-form-group="resolved">${form('reopen-form', 'Reopen')}</div>`,
        {
          url: 'https://admin.driftstack.dev/incidents/inc_test',
          runScripts: 'dangerously',
          virtualConsole,
        },
      );
      windowRef = dom.window;
      const calls: FetchCall[] = [];
      let committed = false;
      const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
      // @ts-expect-error — jsdom's fetch global is intentionally injected.
      dom.window.fetch = (input: string, init: RequestInit | undefined) => {
        const call = { url: String(input), init };
        calls.push(call);
        if (call.url.endsWith(testCase.suffix)) {
          committed = true;
          return Promise.reject(timeout);
        }
        return Promise.resolve(
          response({
            incident: {
              id: 'inc_test',
              title: 'Test incident',
              severity: 'major',
              status: committed ? testCase.finalStatus : testCase.initialStatus,
              public: true,
              affected_components: [],
              started_at: '2026-07-12T00:00:00.000Z',
              resolved_at:
                committed && testCase.finalStatus === 'resolved'
                  ? '2026-07-12T00:05:00.000Z'
                  : null,
            },
            updates: [],
          }),
        );
      };
      dom.window.localStorage.setItem('ds_web_session_token', 'tok');
      evalPage(dom.window);
      dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
      await flush();

      const activeForm = dom.window.document.getElementById(testCase.formId) as HTMLFormElement;
      activeForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(50);

      expect(calls.filter((call) => call.url.endsWith(testCase.suffix))).toHaveLength(1);
      expect(dom.window.document.querySelector('[data-banner]')?.textContent).toMatch(
        testCase.banner,
      );
      const buttons = Array.from(
        dom.window.document.querySelectorAll('form button'),
      ) as HTMLButtonElement[];
      expect(buttons.every((button) => button.disabled)).toBe(true);
      expect(activeForm.querySelector('button')?.textContent).toBe('Already applied');
      activeForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(calls.filter((call) => call.url.endsWith(testCase.suffix))).toHaveLength(1);
    },
  );

  it('blocks every mutation when a timed-out update cannot be authoritatively refreshed', async () => {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', () => {});
    const dom = new JSDOM(
      `<!doctype html><title>Incident</title>
       <div data-banner class="hidden"></div>
       <ul data-list="timeline"></ul>
       <div data-form-group="active">${form('add-update-form', 'Post update', true)}${form('resolve-form', 'Resolve')}</div>
       <div data-form-group="resolved">${form('reopen-form', 'Reopen')}</div>`,
      {
        url: 'https://admin.driftstack.dev/incidents/inc_test',
        runScripts: 'dangerously',
        virtualConsole,
      },
    );
    windowRef = dom.window;
    const calls: FetchCall[] = [];
    let postStarted = false;
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    // @ts-expect-error — jsdom's fetch global is intentionally injected.
    dom.window.fetch = (input: string, init: RequestInit | undefined) => {
      const call = { url: String(input), init };
      calls.push(call);
      if (/\/updates$/.test(call.url)) {
        postStarted = true;
        return Promise.reject(timeout);
      }
      if (postStarted) return Promise.resolve(response({ detail: 'unavailable' }, 503));
      return Promise.resolve(
        response({
          incident: {
            id: 'inc_test',
            title: 'Test incident',
            severity: 'major',
            status: 'investigating',
            public: true,
            affected_components: [],
            started_at: '2026-07-12T00:00:00.000Z',
            resolved_at: null,
          },
          updates: [],
        }),
      );
    };
    dom.window.localStorage.setItem('ds_web_session_token', 'tok');
    evalPage(dom.window);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await flush();

    const updateForm = dom.window.document.getElementById('add-update-form') as HTMLFormElement;
    updateForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(50);

    expect(dom.window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /couldn't refresh the incident.*reload and verify.*duplicate a timeline entry/i,
    );
    const buttons = Array.from(
      dom.window.document.querySelectorAll('form button'),
    ) as HTMLButtonElement[];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(updateForm.querySelector('button')?.textContent).toBe('Verify before retrying');
    updateForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.filter((call) => /\/updates$/.test(call.url))).toHaveLength(1);
  });
});
