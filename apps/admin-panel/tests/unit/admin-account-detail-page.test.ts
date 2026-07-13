import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/shells/account-detail.astro');

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

  it('refreshes committed tier/suspend transitions before advising another mutation', async () => {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', () => {});
    const dom = new JSDOM(
      `<!doctype html><title>Account</title>
       <main data-page="admin-account-detail">
         <div data-banner class="hidden"></div>
         <span data-field="title-name"></span><span data-field="title-email"></span>
         <span data-field="tier"></span><span data-field="status">active</span>
         <span data-field="created"></span><span data-field="updated"></span>
         <span data-field="account-id"></span><a data-field="full-audit-link"></a>
         <span data-field="status-badge"></span>
         <div data-field="action-row">
           <button data-action="change-tier">Change tier</button>
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
    let tier = 'api_builder';
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
      if (call.init?.method === 'POST' && /\/tier$/.test(call.url)) {
        tier = JSON.parse(String(call.init.body)).tier;
        return Promise.reject(timeout);
      }
      if (/\/v1\/admin\/accounts\/acc_1234$/.test(call.url)) {
        return Promise.resolve(
          response({
            name: 'Test Account',
            email: 'owner@example.test',
            tier,
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
    dom.window.driftstackPrompt = (message: string) =>
      Promise.resolve(message.startsWith('New tier') ? 'api_scale' : 'incident response');
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

    const tierButton = dom.window.document.querySelector(
      '[data-action="change-tier"]',
    ) as HTMLButtonElement;
    tierButton.click();
    await flush(80);

    expect(calls.filter((call) => /\/tier$/.test(call.url))).toHaveLength(1);
    expect(dom.window.document.querySelector('[data-field="tier"]')?.textContent).toBe('api_scale');
    expect(dom.window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /tier-change outcome is unknown.*account was refreshed and now uses api_scale.*change completed.*do not submit it again/i,
    );
    expect(tierButton.disabled).toBe(false);
  });

  it('blocks confirmed or unverifiable audit writes and only retries an authoritative non-match', async () => {
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
           <button data-action="add-note">Add support note</button>
           <button data-action="record-refund">Record refund</button>
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
    const auditRows: Array<Record<string, unknown>> = [
      {
        id: 'audit-before',
        admin_account_id: 'acc_admin',
        action: 'audit_note.added',
        input_payload: { note: 'older note' },
        result: 'success',
        timestamp: '2026-07-13T00:00:00.000Z',
      },
    ];
    let commitNotes = false;
    let failAuditRefresh = false;
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    // @ts-expect-error -- jsdom's fetch global is intentionally injected.
    dom.window.fetch = (input: string, init: RequestInit | undefined) => {
      const call = { url: String(input), init };
      calls.push(call);
      if (call.init?.method === 'POST' && /\/audit-note$/.test(call.url)) {
        const payload = JSON.parse(String(call.init.body));
        if (commitNotes) {
          auditRows.unshift({
            id: 'audit-note-after',
            admin_account_id: 'acc_admin',
            action: 'audit_note.added',
            input_payload: payload,
            result: 'success',
            timestamp: '2026-07-13T00:01:00.000Z',
          });
        }
        return Promise.reject(timeout);
      }
      if (call.init?.method === 'POST' && /\/refund-record$/.test(call.url)) {
        const payload = JSON.parse(String(call.init.body));
        auditRows.unshift({
          id: 'audit-refund-after',
          admin_account_id: 'acc_admin',
          action: 'refund.recorded',
          input_payload: { ...payload, currency: 'USD' },
          result: 'success',
          timestamp: '2026-07-13T00:02:00.000Z',
        });
        return Promise.reject(timeout);
      }
      if (/\/v1\/admin\/accounts\/acc_1234$/.test(call.url)) {
        return Promise.resolve(
          response({
            name: 'Test Account',
            email: 'owner@example.test',
            tier: 'api_builder',
            status: 'active',
            created_at: '2026-07-01T00:00:00.000Z',
            updated_at: '2026-07-13T00:00:00.000Z',
          }),
        );
      }
      if (/\/v1\/admin\/audit-log\?/.test(call.url)) {
        if (failAuditRefresh) return Promise.reject(new Error('audit unavailable'));
        return Promise.resolve(response({ data: auditRows }));
      }
      return Promise.resolve(response({}, 404));
    };
    const prompts = ['investigated customer report'];
    // @ts-expect-error -- branded modal helpers are injected by AdminLayout.
    dom.window.driftstackPrompt = () => Promise.resolve(prompts.shift() ?? null);
    dom.window.localStorage.setItem('ds_web_session_token', 'staff-token');
    dom.window.eval(`const apiBaseUrl = 'https://api.driftstack.dev';${scriptBody()}`);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await flush();

    const noteButton = dom.window.document.querySelector(
      '[data-action="add-note"]',
    ) as HTMLButtonElement;
    noteButton.click();
    await flush(80);

    expect(calls.filter((call) => /\/audit-note$/.test(call.url))).toHaveLength(1);
    expect(dom.window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /support-note outcome is unknown.*refreshed authoritative audit slice has no new matching successful entry.*retry only if the record is still required/i,
    );
    expect(noteButton.disabled).toBe(false);

    commitNotes = true;
    prompts.push('investigated customer report');
    noteButton.click();
    await flush(80);

    expect(calls.filter((call) => /\/audit-note$/.test(call.url))).toHaveLength(2);
    expect(dom.window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /support-note outcome is unknown.*refreshed audit log contains a new successful entry with the same note.*likely recorded.*do not submit it again/i,
    );
    expect(noteButton.disabled).toBe(true);
    noteButton.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.filter((call) => /\/audit-note$/.test(call.url))).toHaveLength(2);
    expect(dom.window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /support-note submission is locked.*reload and review the audit log/i,
    );

    const refundButton = dom.window.document.querySelector(
      '[data-action="record-refund"]',
    ) as HTMLButtonElement;
    prompts.push('ch_test_123', '299', 'duplicate charge');
    failAuditRefresh = true;
    refundButton.click();
    await flush(100);

    expect(calls.filter((call) => /\/refund-record$/.test(call.url))).toHaveLength(1);
    expect(dom.window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /refund-record outcome is unknown.*audit log could not be refreshed.*verify the full audit log before retrying.*avoid a duplicate record/i,
    );
    expect(refundButton.disabled).toBe(true);
    refundButton.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.filter((call) => /\/refund-record$/.test(call.url))).toHaveLength(1);
    expect(dom.window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /refund-record submission is locked.*reload and review the audit log/i,
    );
  });

  it('requires an advanced exact override version before treating a timed-out upsert as applied', async () => {
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
         <div data-field="action-row"></div>
         <form data-field="override-form" class="hidden">
           <select name="bucket_key"><option value="global">Global</option></select>
           <input name="capacity" value="240" />
           <input name="refill_per_second" value="8" />
           <input name="duration_seconds" value="3600" />
           <textarea name="reason">incident capacity</textarea>
           <button type="submit">Apply override</button>
         </form>
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
    let overrideRows: Array<Record<string, unknown>> = [];
    let commitOverride = true;
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    // @ts-expect-error -- jsdom's fetch global is intentionally injected.
    dom.window.fetch = (input: string, init: RequestInit | undefined) => {
      const call = { url: String(input), init };
      calls.push(call);
      if (call.init?.method === 'POST' && /\/quota-override$/.test(call.url)) {
        const payload = JSON.parse(String(call.init.body));
        if (commitOverride) {
          overrideRows = [
            {
              id: 'rlo_test',
              account_id: 'acc_1234',
              bucket_key: payload.bucket_key,
              capacity: payload.capacity,
              refill_per_second: payload.refill_per_second,
              reason: payload.reason,
              expires_at: '2026-07-13T02:48:00.000Z',
              updated_at: '2026-07-13T01:48:00.000Z',
            },
          ];
        }
        return Promise.reject(timeout);
      }
      if (/\/v1\/admin\/rate-limit-overrides\?/.test(call.url)) {
        return Promise.resolve(response({ data: overrideRows }));
      }
      if (/\/v1\/admin\/accounts\/acc_1234$/.test(call.url)) {
        return Promise.resolve(
          response({
            name: 'Test Account',
            email: 'owner@example.test',
            tier: 'api_builder',
            status: 'active',
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
    dom.window.localStorage.setItem('ds_web_session_token', 'staff-token');
    dom.window.eval(`const apiBaseUrl = 'https://api.driftstack.dev';${scriptBody()}`);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await flush();

    const form = dom.window.document.querySelector(
      '[data-field="override-form"]',
    ) as HTMLFormElement;
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(100);

    expect(calls.filter((call) => /\/quota-override$/.test(call.url))).toHaveLength(1);
    expect(calls.filter((call) => /\/rate-limit-overrides\?/.test(call.url))).toHaveLength(2);
    expect(dom.window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /override outcome is unknown.*authoritative list now contains a new or updated global override with the submitted capacity, refill rate, duration, and reason.*likely applied.*do not submit it again/i,
    );
    expect(form.classList.contains('hidden')).toBe(true);
    expect(submit.disabled).toBe(false);

    commitOverride = false;
    form.classList.remove('hidden');
    (form.elements.namedItem('capacity') as HTMLInputElement).value = '240';
    (form.elements.namedItem('refill_per_second') as HTMLInputElement).value = '8';
    (form.elements.namedItem('duration_seconds') as HTMLInputElement).value = '3600';
    (form.elements.namedItem('reason') as HTMLTextAreaElement).value = 'incident capacity';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(100);

    expect(calls.filter((call) => /\/quota-override$/.test(call.url))).toHaveLength(2);
    expect(dom.window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /override outcome is unknown.*authoritative global record could not be confirmed as a new exact version.*review it on Rate limits before retrying/i,
    );
    expect(form.classList.contains('hidden')).toBe(false);
  });
});
