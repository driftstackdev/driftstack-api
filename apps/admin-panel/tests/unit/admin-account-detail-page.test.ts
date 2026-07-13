import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/accounts/[id].astro');

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function scriptBody(): string {
  const source = readFileSync(PAGE, 'utf8');
  const match = source.match(
    /<script is:inline define:vars=\{\{ apiBaseUrl \}\}>([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) throw new Error('account detail inline script not found');
  return match[1];
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('admin account detail mutation reconciliation', () => {
  let windowRef: JSDOM['window'] | null = null;

  afterEach(() => {
    windowRef?.close();
    windowRef = null;
  });

  it('refreshes committed suspend and unsuspend timeouts before advising another transition', async () => {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', () => {});
    const dom = new JSDOM(
      `<!doctype html><title>Account</title>
       <main data-page="admin-account-detail">
         <div data-banner class="hidden"></div>
         <span data-field="title-name"></span><span data-field="title-email"></span>
         <span data-field="tier"></span><span data-field="status">active</span>
         <span data-field="created"></span><span data-field="updated"></span>
         <span data-field="status-badge"></span>
         <div data-field="action-row">
           <button data-action="suspend">Suspend account</button>
           <button data-action="unsuspend" class="hidden">Unsuspend account</button>
         </div>
         <form data-field="override-form" class="hidden"></form>
         <ul data-list="account-audit"></ul>
         <div data-account-cost-body></div>
       </main>`,
      {
        url: 'https://admin.driftstack.dev/accounts/1234',
        runScripts: 'dangerously',
        virtualConsole,
      },
    );
    windowRef = dom.window;
    const calls: FetchCall[] = [];
    let status = 'active';
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    // @ts-expect-error -- jsdom's fetch global is intentionally injected.
    dom.window.fetch = (input: string, init: RequestInit | undefined) => {
      const call = { url: String(input), init };
      calls.push(call);
      if (call.init?.method === 'POST' && /\/suspend$/.test(call.url)) {
        status = 'suspended';
        return Promise.reject(timeout);
      }
      if (call.init?.method === 'POST' && /\/unsuspend$/.test(call.url)) {
        status = 'active';
        return Promise.reject(timeout);
      }
      if (/\/v1\/admin\/accounts\/acc_1234$/.test(call.url)) {
        return Promise.resolve(
          response({
            name: 'Test Account',
            email: 'owner@example.test',
            tier: 'api_builder',
            status,
            created_at: '2026-07-01T00:00:00.000Z',
            updated_at: '2026-07-13T00:00:00.000Z',
          }),
        );
      }
      if (/\/v1\/admin\/audit-log\?/.test(call.url)) {
        return Promise.resolve(response({ data: [] }));
      }
      return Promise.resolve(response({}, 404));
    };
    // @ts-expect-error -- branded modal helpers are injected by AdminLayout.
    dom.window.driftstackConfirm = () => Promise.resolve(true);
    // @ts-expect-error -- branded modal helpers are injected by AdminLayout.
    dom.window.driftstackPrompt = () => Promise.resolve('incident response');
    dom.window.localStorage.setItem('ds_web_session_token', 'staff-token');
    dom.window.eval(`const apiBaseUrl = 'https://api.driftstack.dev';${scriptBody()}`);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await flush();

    const suspendButton = dom.window.document.querySelector(
      '[data-action="suspend"]',
    ) as HTMLButtonElement;
    const unsuspendButton = dom.window.document.querySelector(
      '[data-action="unsuspend"]',
    ) as HTMLButtonElement;
    suspendButton.click();
    await flush(60);

    expect(calls.filter((call) => /\/suspend$/.test(call.url))).toHaveLength(1);
    expect(dom.window.document.querySelector('[data-field="status"]')?.textContent).toBe(
      'suspended',
    );
    expect(dom.window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /suspension outcome is unknown.*account was refreshed and is suspended.*sessions and API keys were revoked.*do not suspend it again/i,
    );
    expect(suspendButton.classList.contains('hidden')).toBe(true);
    expect(unsuspendButton.classList.contains('hidden')).toBe(false);

    unsuspendButton.click();
    await flush(60);

    expect(calls.filter((call) => /\/unsuspend$/.test(call.url))).toHaveLength(1);
    expect(dom.window.document.querySelector('[data-field="status"]')?.textContent).toBe('active');
    expect(dom.window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /unsuspension outcome is unknown.*account was refreshed and is active.*do not unsuspend it again/i,
    );
    expect(suspendButton.disabled).toBe(false);
    expect(unsuspendButton.disabled).toBe(false);
  });
});
