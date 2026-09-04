// Local integration test for the /team page's inline script
// (V-298c / V-326e team RBAC). The page manages two lists — members
// and pending invites — and the invite/remove flows are real
// customer-facing mutations (POST /v1/team/invites, DELETE
// /v1/team/members/:id) with only source-regex coverage before. Loads
// the BUILT page, mocks localStorage + fetch with a stateful URL
// router (the page fires two concurrent load fetches — members +
// invites — and every mutation refreshes both), eval's the script, and
// asserts the real hydrated-DOM branches.
//
// Mirrors profiles-page.test.ts. NOTE: /team renders inline empty-state
// <li>s into [data-members-list] / [data-invites-list] rather than
// toggling a [data-empty] section, so assertions check list text /
// row buttons, not hidden classes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'team', 'index.html');
const PAGE_URL = 'https://app.driftstack.io/team/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string;
  confirmReturns?: boolean;
  actAsAccount?: string;
  route: (call: MockFetchCall) => Response | Promise<Response>;
}

function setUpDom(
  html: string,
  opts: SetUpOpts,
): { window: JSDOM['window']; fetchCalls: MockFetchCall[] } {
  const scriptBodies: string[] = [];
  const htmlNoScripts = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scriptBodies.push(body);
    return '';
  });
  const dom = new JSDOM(htmlNoScripts, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const fetchCalls: MockFetchCall[] = [];
  // @ts-expect-error — jsdom global is loose
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call: MockFetchCall = { url: String(input), init };
    fetchCalls.push(call);
    return Promise.resolve(opts.route(call));
  };
  if (opts.token !== undefined) window.localStorage.setItem('ds_web_session_token', opts.token);
  if (opts.actAsAccount !== undefined)
    window.localStorage.setItem('ds_act_as_account', opts.actAsAccount);
  const __cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by DashboardLayout (not eval'd here)
  window.driftstackConfirm = () => Promise.resolve(__cr);
  window.confirm = () => __cr;

  const pageScript = scriptBodies.find((s) => s.includes('data-page="team"'));
  if (!pageScript) throw new Error('team inline script not found');
  installDashboardDeadline(window);
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function text(window: JSDOM['window'], selector: string): string {
  return window.document.querySelector(selector)?.textContent ?? '';
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

interface Member {
  id: string;
  member_email: string;
  role: string;
  accepted_at: string;
}
interface Invite {
  id: string;
  invitee_email: string;
  created_at: string;
  expires_at: string;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Stateful router over mutable members[] + invites[]. POST invite →
// 202 (the page treats 202 as success); DELETE member → 204.
function makeRouter(members: Member[], invites: Invite[]): (c: MockFetchCall) => Response {
  let invSeq = 0;
  return (call: MockFetchCall): Response => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const u = call.url;
    if (/\/v1\/team\/members$/.test(u) && method === 'GET') return json({ data: members });
    if (/\/v1\/team\/invites$/.test(u) && method === 'GET') return json({ data: invites });
    if (/\/v1\/team\/invites$/.test(u) && method === 'POST') {
      const body = JSON.parse(String(call.init?.body || '{}'));
      invites.push({
        id: 'inv_new' + invSeq++,
        invitee_email: body.email,
        created_at: '2026-05-29T10:00:00.000Z',
        expires_at: '2026-06-05T10:00:00.000Z',
      });
      return json({ status: 'invited' }, 202);
    }
    const rm = u.match(/\/v1\/team\/members\/([^/]+)$/);
    if (rm && method === 'DELETE') {
      const i = members.findIndex((m) => m.id === rm[1]);
      if (i >= 0) members.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    // eslint-disable-next-line no-console
    console.warn('[team-page test] unrouted fetch:', method, u);
    return json({}, 500);
  };
}

const MEMBER: Member = {
  id: 'mem_a',
  member_email: 'alice@example.com',
  role: 'member',
  accepted_at: '2026-05-20T10:00:00.000Z',
};
const INVITE: Invite = {
  id: 'inv_a',
  invitee_email: 'bob@example.com',
  created_at: '2026-05-18T10:00:00.000Z',
  expires_at: '2026-05-25T10:00:00.000Z',
};

describe('team page — local integration', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('"Acting as" notice is hidden by default (no global act-as selection)', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter([], []),
    });
    win = window;
    await flush();
    expect(
      window.document.querySelector('[data-self-scoped-notice]')?.classList.contains('hidden'),
    ).toBe(true);
  });

  it('"Acting as" notice is revealed when ds_act_as_account is set — team membership never silently claims to manage the acted-as account while the global banner says otherwise', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      actAsAccount: 'acc_00000000-0000-4000-8000-000000000099',
      route: makeRouter([], []),
    });
    win = window;
    await flush();
    expect(
      window.document.querySelector('[data-self-scoped-notice]')?.classList.contains('hidden'),
    ).toBe(false);
  });

  it('empty: both lists render their inline empty states', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter([], []),
    });
    win = window;
    await flush();
    expect(fetchCalls.some((c) => /\/v1\/team\/members$/.test(c.url))).toBe(true);
    expect(fetchCalls.some((c) => /\/v1\/team\/invites$/.test(c.url))).toBe(true);
    expect(text(window, '[data-members-list]')).toMatch(/No team members yet/);
    expect(text(window, '[data-invites-list]')).toMatch(/No pending invites/);
  });

  it('non-empty: renders the member (with Remove) + the pending invite', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter([{ ...MEMBER }], [{ ...INVITE }]),
    });
    win = window;
    await flush();
    expect(text(window, '[data-members-list]')).toContain('alice@example.com');
    expect(window.document.querySelector('[data-remove="mem_a"]')).toBeTruthy();
    const invites = text(window, '[data-invites-list]');
    expect(invites).toContain('bob@example.com');
    expect(invites.toLowerCase()).toContain('pending');
  });

  it('invite: POSTs {email, role} and the new invite appears after refresh', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter([], []),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-invite]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-invite-form]') as HTMLFormElement;
    (form.querySelector('input[name="email"]') as HTMLInputElement).value = 'carol@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const posts = fetchCalls.filter(
      (c) => c.init?.method === 'POST' && /\/v1\/team\/invites$/.test(c.url),
    );
    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post).toBeTruthy();
    expect(post?.init?.signal).toBeDefined();
    const body = JSON.parse(String(post?.init?.body));
    expect(body.email).toBe('carol@example.com');
    expect(typeof body.role).toBe('string');
    expect(text(window, '[data-invites-list]')).toContain('carol@example.com');
  });

  it('invite validation: empty email shows "Email is required." inline, fires no POST', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter([], []),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-invite]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-invite-form]') as HTMLFormElement;
    (form.querySelector('input[name="email"]') as HTMLInputElement).value = '   ';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const err = window.document.querySelector('[data-invite-error]');
    expect(err?.classList.contains('hidden')).toBe(false);
    expect(err?.textContent).toMatch(/Email is required\./);
    expect(fetchCalls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  it('invite timeout reconciles a committed pending row without replacing its emailed link', async () => {
    const invites: Invite[] = [];
    const base = makeRouter([], invites);
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (call.init?.method === 'POST' && /\/v1\/team\/invites$/.test(call.url)) {
          invites.push({
            id: 'inv_committed',
            invitee_email: 'carol@example.com',
            created_at: '2026-05-29T10:00:00.000Z',
            expires_at: '2026-06-05T10:00:00.000Z',
          });
          return Promise.reject(timeout);
        }
        return base(call);
      },
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-invite]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-invite-form]') as HTMLFormElement;
    (form.querySelector('input[name="email"]') as HTMLInputElement).value = 'carol@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(12);

    expect(fetchCalls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);
    expect(text(window, '[data-invites-list]')).toContain('carol@example.com');
    expect(text(window, '[data-banner]')).toMatch(
      /appears in pending invites.*not sent again.*emailed link remains valid/i,
    );
    expect(
      window.document.querySelector('[data-invite-form-wrap]')?.classList.contains('hidden'),
    ).toBe(true);

    (window.document.querySelector('[data-show-invite]') as HTMLButtonElement).click();
    (form.querySelector('input[name="email"]') as HTMLInputElement).value = 'CAROL@example.com';
    form
      .querySelector('input[name="email"]')
      ?.dispatchEvent(new window.Event('input', { bubbles: true }));
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe('Already pending');
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchCalls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);
  });

  it('invite timeout blocks the unchanged retry when pending-list reconciliation also fails', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    let postStarted = false;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (method === 'POST' && /\/v1\/team\/invites$/.test(call.url)) {
          postStarted = true;
          return Promise.reject(timeout);
        }
        if (postStarted) return json({}, 503);
        if (/\/v1\/team\/members$/.test(call.url)) return json({ data: [] });
        if (/\/v1\/team\/invites$/.test(call.url)) return json({ data: [] });
        return json({}, 500);
      },
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-invite]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-invite-form]') as HTMLFormElement;
    const emailInput = form.querySelector('input[name="email"]') as HTMLInputElement;
    emailInput.value = 'unknown@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(12);

    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(text(window, '[data-invite-error]')).toMatch(
      /couldn't refresh pending invites.*reload and verify.*replace the first emailed link/i,
    );
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe('Verify before retrying');
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchCalls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);

    emailInput.value = 'different@example.com';
    emailInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe('Send invite');
  });

  it('a delayed initial refresh cannot overwrite the newer post-invite list', async () => {
    const initialMembers = deferred<Response>();
    const initialInvites = deferred<Response>();
    const invites: Invite[] = [];
    let memberGets = 0;
    let inviteGets = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/team\/members$/.test(call.url) && method === 'GET') {
          memberGets += 1;
          return memberGets === 1 ? initialMembers.promise : json({ data: [] });
        }
        if (/\/v1\/team\/invites$/.test(call.url) && method === 'GET') {
          inviteGets += 1;
          return inviteGets === 1 ? initialInvites.promise : json({ data: invites });
        }
        if (/\/v1\/team\/invites$/.test(call.url) && method === 'POST') {
          const body = JSON.parse(String(call.init?.body || '{}'));
          invites.push({
            id: 'inv_new',
            invitee_email: body.email,
            created_at: '2026-05-29T10:00:00.000Z',
            expires_at: '2026-06-05T10:00:00.000Z',
          });
          return json({ status: 'invited' }, 202);
        }
        return json({}, 500);
      },
    });
    win = window;
    await flush();

    (window.document.querySelector('[data-show-invite]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-invite-form]') as HTMLFormElement;
    (form.querySelector('input[name="email"]') as HTMLInputElement).value = 'new@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(10);

    expect(text(window, '[data-invites-list]')).toContain('new@example.com');
    const initialReads = fetchCalls
      .filter((call) => (call.init?.method || 'GET') === 'GET')
      .slice(0, 2);
    expect(initialReads.every((call) => call.init?.signal?.aborted === true)).toBe(true);

    initialMembers.resolve(json({ data: [] }));
    initialInvites.resolve(json({ data: [] }));
    await flush(8);
    expect(text(window, '[data-invites-list]')).toContain('new@example.com');
  });

  it('remove: confirm-gated DELETE /v1/team/members/:id then refresh drops the member', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      route: makeRouter([{ ...MEMBER }], []),
    });
    win = window;
    await flush();
    expect(text(window, '[data-members-list]')).toContain('alice@example.com');
    const removeBtn = window.document.querySelector('[data-remove="mem_a"]') as HTMLButtonElement;
    removeBtn.dispatchEvent(new window.Event('click'));
    removeBtn.dispatchEvent(new window.Event('click'));
    await flush();
    const deletes = fetchCalls.filter((c) => c.init?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    const del = deletes[0];
    expect(del?.url).toMatch(/\/v1\/team\/members\/mem_a$/);
    expect(del?.init?.signal).toBeDefined();
    expect(text(window, '[data-members-list]')).toMatch(/No team members yet/);
  });

  it('remove timeout reconciles a committed membership deletion before another attempt', async () => {
    const members = [{ ...MEMBER }];
    const base = makeRouter(members, []);
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      route: (call) => {
        if (call.init?.method === 'DELETE' && /\/v1\/team\/members\/mem_a$/.test(call.url)) {
          members.splice(0, 1);
          return Promise.reject(timeout);
        }
        return base(call);
      },
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-remove="mem_a"]') as HTMLButtonElement).click();
    await flush(12);

    expect(fetchCalls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(1);
    expect(window.document.querySelector('[data-remove="mem_a"]')).toBeNull();
    expect(text(window, '[data-banner]')).toMatch(
      /member-removal outcome is unknown.*team list was refreshed.*alice@example.com is no longer present.*removal likely completed.*do not submit it again/i,
    );
  });

  it('remove cancelled at confirm: no DELETE fired, member stays', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: false,
      route: makeRouter([{ ...MEMBER }], []),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-remove="mem_a"]') as HTMLButtonElement).click();
    await flush();
    expect(fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false);
    expect(text(window, '[data-members-list]')).toContain('alice@example.com');
  });
});
