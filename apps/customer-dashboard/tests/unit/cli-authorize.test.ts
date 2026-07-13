// 2026-05-20 — local integration test for the cli-authorize page's
// inline script. Loads the deployed page (from prod), strips the
// inline script body, executes it inside a jsdom environment with a
// mocked localStorage + fetch, and asserts which [data-state] section
// is visible after each scripted branch.
//
// Purpose: catch the regressions that have been wasting customer time
// when an edit lands without local verification (e.g. the
// extensions-spread bug, the /v1/account/me preflight breaking the
// confirm render).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'cli', 'authorize', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/cli/authorize/?code=ABCDEF&state=XYZ123';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function setUpDom(
  html: string,
  beforeScripts: (window: JSDOM['window']) => void,
): {
  window: JSDOM['window'];
  fetchCalls: MockFetchCall[];
  setFetchPlan: (plan: Array<(call: MockFetchCall) => Response | Promise<Response>>) => void;
} {
  // Strip the page <script> tags from the HTML before jsdom parses so
  // we can pre-seed window globals (localStorage, fetch mock) BEFORE
  // the page scripts run, then re-attach + execute the scripts.
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
  let plan: Array<(call: MockFetchCall) => Response | Promise<Response>> = [];
  // Polyfill Response on the jsdom window. Some jsdom builds expose
  // Response via globalThis but not on the window object — set it
  // explicitly so test-side `new window.Response(...)` works.
  // @ts-expect-error — jsdom global is loose
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call: MockFetchCall = { url: String(input), init };
    fetchCalls.push(call);
    const handler = plan.shift();
    if (!handler) {
      // Unplanned fetch — log so we can see what hit us.
      // eslint-disable-next-line no-console
      console.warn('[cli-authorize test] unplanned fetch:', call.url);
      return Promise.resolve(new Response('{}', { status: 500 }));
    }
    return Promise.resolve().then(() => handler(call));
  };
  // Customer-test-only window setup (localStorage seeding etc.).
  beforeScripts(window as JSDOM['window']);
  installDashboardDeadline(window);
  // Execute the cli-authorize page script (the LAST <script> body,
  // after DashboardLayout's act-as picker + legal banner scripts).
  // Use window.eval so the script runs inside jsdom's window context
  // — appendChild of a dynamic <script> works only when the parser
  // is still active in some jsdom versions; eval is reliable.
  // Find the cli-authorize script body specifically — script order on
  // the rendered page is: act-as picker, legal banner, then the page
  // script — but the order isn't load-bearing, so locate by content
  // rather than index. The cli-authorize script is the only one that
  // references `data-page="cli-authorize"`.
  const pageScript = scriptBodies.find((s) => s.includes('data-page="cli-authorize"'));
  if (!pageScript) throw new Error('cli-authorize inline script not found');
  try {
    // @ts-expect-error — jsdom global has eval
    window.eval(pageScript);
  } catch (err) {
    // Surface eval errors so test failures point at the real cause.
    // eslint-disable-next-line no-console
    console.error('[cli-authorize test] inline-script eval threw:', err);
    throw err;
  }
  return {
    window: window as JSDOM['window'],
    fetchCalls,
    setFetchPlan: (p) => {
      plan = [...p];
    },
  };
}

function visibleState(window: JSDOM['window']): string {
  const sections = window.document.querySelectorAll('[data-state]');
  const visible: string[] = [];
  sections.forEach((el) => {
    if (!el.classList.contains('hidden')) {
      const name = el.getAttribute('data-state');
      if (name) visible.push(name);
    }
  });
  return visible.join(',');
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('cli-authorize page — local integration', () => {
  let dom: ReturnType<typeof setUpDom> | null = null;

  afterEach(() => {
    dom?.window.close?.();
    dom = null;
  });

  function loadBuiltPage(): string {
    return readFileSync(BUILT_PAGE, 'utf8');
  }

  it('shows needs-signin when ds_web_session_token is absent', async () => {
    const html = loadBuiltPage();
    dom = setUpDom(html, () => {
      /* no localStorage seed */
    });
    await flush();
    expect(visibleState(dom.window)).toBe('needs-signin');
    // Sign-in link wires the next= param so post-login bounce works.
    const signinLink = dom.window.document.querySelector('[data-signin-link]');
    expect(signinLink?.getAttribute('href')).toMatch(/\/login\?next=/);
  });

  it('shows confirm when a session token is present', async () => {
    const html = loadBuiltPage();
    dom = setUpDom(html, (window) => {
      window.localStorage.setItem('ds_web_session_token', 'tok-ok');
    });
    await flush();
    expect(visibleState(dom.window)).toBe('confirm');
    // Code preview is populated.
    const preview = dom.window.document.querySelector('[data-code-preview]');
    expect(preview?.textContent).toContain('ABCDEF'.slice(0, 6));
  });

  it('coalesces forced duplicate authorize clicks into one bind request', async () => {
    const html = loadBuiltPage();
    const local = setUpDom(html, (window) => {
      window.localStorage.setItem('ds_web_session_token', 'tok-ok');
    });
    dom = local;
    local.setFetchPlan([
      () => new local.window.Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);
    const authorizeBtn = local.window.document.querySelector(
      '[data-authorize]',
    ) as HTMLButtonElement;
    authorizeBtn.dispatchEvent(new local.window.MouseEvent('click'));
    authorizeBtn.dispatchEvent(new local.window.MouseEvent('click'));
    expect(local.fetchCalls).toHaveLength(1);
    expect(local.fetchCalls[0]?.init?.signal).toBeDefined();
    await flush();
  });

  it('turns an ambiguous bind timeout into desktop-handoff-only mode with no second bind', async () => {
    const html = loadBuiltPage();
    const local = setUpDom(html, (window) => {
      window.localStorage.setItem('ds_web_session_token', 'tok-ok');
    });
    dom = local;
    const timeout = new Error('response deadline exceeded');
    timeout.name = 'AbortError';
    local.setFetchPlan([() => Promise.reject(timeout)]);

    (local.window.document.querySelector('[data-authorize]') as HTMLButtonElement).click();
    await flush();
    await flush();

    expect(visibleState(local.window)).toBe('error');
    expect(local.window.document.querySelector('[data-error-message]')?.textContent).toMatch(
      /may already have completed.*existing poll.*Do not retry this link.*fresh browser sign-in/i,
    );
    const retry = local.window.document.querySelector('[data-retry]') as HTMLButtonElement;
    expect(retry.textContent).toBe('Return to desktop');
    retry.dispatchEvent(new local.window.MouseEvent('click'));
    retry.dispatchEvent(new local.window.MouseEvent('click'));
    await flush();
    expect(
      local.fetchCalls.filter((call) => call.url.endsWith('/v1/auth/cli-authorize/bind')),
    ).toHaveLength(1);
  });

  it('keeps an authoritative HTTP bind failure retryable', async () => {
    const html = loadBuiltPage();
    const local = setUpDom(html, (window) => {
      window.localStorage.setItem('ds_web_session_token', 'tok-ok');
    });
    dom = local;
    local.setFetchPlan([
      () =>
        new local.window.Response(JSON.stringify({ detail: 'Temporary bind failure.' }), {
          status: 503,
        }),
      () =>
        new local.window.Response(JSON.stringify({ status: 'bound' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ]);

    (local.window.document.querySelector('[data-authorize]') as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(visibleState(local.window)).toBe('error');
    const retry = local.window.document.querySelector('[data-retry]') as HTMLButtonElement;
    expect(retry.textContent).toBe('Try again');

    retry.click();
    await flush();
    await flush();
    expect(visibleState(local.window)).toBe('success');
    expect(
      local.fetchCalls.filter((call) => call.url.endsWith('/v1/auth/cli-authorize/bind')),
    ).toHaveLength(2);
  });

  it('on 409 LegalAcceptanceRequired with top-level pending_acceptances, surfaces legal-accept UI with mapped slugs + friendly labels (regression for .extensions.* shape AND tos→terms URL slug)', async () => {
    const html = loadBuiltPage();
    const local = setUpDom(html, (window) => {
      window.localStorage.setItem('ds_web_session_token', 'tok-ok');
    });
    dom = local;
    local.setFetchPlan([
      (_call) =>
        new local.window.Response(
          JSON.stringify({
            type: 'https://errors.driftstack.dev/legal-acceptance-required',
            title: 'Legal acceptance required',
            status: 409,
            detail: 'Operation requires acceptance of 4 document(s) before proceeding.',
            pending_acceptances: [
              { document_key: 'tos', current_version: '1.0' },
              { document_key: 'privacy', current_version: '1.0' },
              { document_key: 'aup', current_version: '1.0' },
              { document_key: 'dpa', current_version: '1.0' },
            ],
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
    ]);
    await flush();
    const authorizeBtn = local.window.document.querySelector(
      '[data-authorize]',
    ) as HTMLButtonElement;
    authorizeBtn.click();
    await flush();
    await flush();
    expect(visibleState(local.window)).toBe('legal-accept');
    const items = local.window.document.querySelectorAll(
      '[data-state="legal-accept"] [data-legal-pending-list] li',
    );
    expect(items.length).toBe(4);
    // tos → /legal/terms/ slug mapping + friendly label.
    const tosLink = items[0].querySelector('a') as HTMLAnchorElement;
    expect(tosLink.href).toBe('https://driftstack.dev/legal/terms/');
    expect(tosLink.textContent).toBe('Terms of Service');
    // Pass-through slugs work too.
    const privacyLink = items[1].querySelector('a') as HTMLAnchorElement;
    expect(privacyLink.href).toBe('https://driftstack.dev/legal/privacy/');
    expect(privacyLink.textContent).toBe('Privacy Policy');
  });

  it('Accept-all prefetches /v1/legal/required for content_hash, then POSTs {document_key, version, content_hash} per doc', async () => {
    const html = loadBuiltPage();
    const local = setUpDom(html, (window) => {
      window.localStorage.setItem('ds_web_session_token', 'tok-ok');
    });
    dom = local;
    const HASH = {
      tos: 'a'.repeat(64),
      privacy: 'b'.repeat(64),
      aup: 'c'.repeat(64),
      dpa: 'd'.repeat(64),
    };
    local.setFetchPlan([
      // 1. bind → 409 with the 4 pending docs.
      (_call) =>
        new local.window.Response(
          JSON.stringify({
            type: 'https://errors.driftstack.dev/legal-acceptance-required',
            title: 'Legal acceptance required',
            status: 409,
            detail: 'Operation requires acceptance of 4 document(s) before proceeding.',
            pending_acceptances: [
              { document_key: 'tos', current_version: '1.2' },
              { document_key: 'privacy', current_version: '1.0' },
              { document_key: 'aup', current_version: '1.1' },
              { document_key: 'dpa', current_version: '1.0' },
            ],
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      // 2. accept-all prefetches /v1/legal/required for content_hash.
      // Real server returns { data: [...] } per routes/legal.ts:76.
      (_call) =>
        new local.window.Response(
          JSON.stringify({
            data: [
              { document_key: 'tos', current_version: '1.2', content_hash: HASH.tos },
              { document_key: 'privacy', current_version: '1.0', content_hash: HASH.privacy },
              { document_key: 'aup', current_version: '1.1', content_hash: HASH.aup },
              { document_key: 'dpa', current_version: '1.0', content_hash: HASH.dpa },
            ],
          }),
          { status: 200 },
        ),
      // 3-6. Four /v1/legal/accept calls, all 200.
      (_call) => new local.window.Response('{}', { status: 200 }),
      (_call) => new local.window.Response('{}', { status: 200 }),
      (_call) => new local.window.Response('{}', { status: 200 }),
      (_call) => new local.window.Response('{}', { status: 200 }),
      // 7. retry bind → 200 success.
      (_call) => new local.window.Response(JSON.stringify({ status: 'bound' }), { status: 200 }),
    ]);
    await flush();
    (local.window.document.querySelector('[data-authorize]') as HTMLButtonElement).click();
    await flush();
    await flush();
    const acceptAllBtn = local.window.document.querySelector(
      '[data-state="legal-accept"] [data-legal-accept-all]',
    ) as HTMLButtonElement;
    acceptAllBtn.dispatchEvent(new local.window.MouseEvent('click'));
    acceptAllBtn.dispatchEvent(new local.window.MouseEvent('click'));
    expect(local.fetchCalls.filter((c) => c.url.endsWith('/v1/legal/required'))).toHaveLength(1);
    await flush();
    await flush();
    await flush();
    // Prefetch present.
    expect(local.fetchCalls.find((c) => c.url.endsWith('/v1/legal/required'))).toBeTruthy();
    // 4 accept POSTs carry the canonical key + version + matching hash.
    const acceptCalls = local.fetchCalls.filter((c) => c.url.endsWith('/v1/legal/accept'));
    expect(acceptCalls.length).toBe(4);
    const legalCalls = local.fetchCalls.filter(
      (c) => c.url.endsWith('/v1/legal/required') || c.url.endsWith('/v1/legal/accept'),
    );
    expect(legalCalls.every((c) => c.init?.signal)).toBe(true);
    expect(new Set(legalCalls.map((c) => c.init?.signal)).size).toBe(legalCalls.length);
    const bodies = acceptCalls.map((c) => JSON.parse(String(c.init?.body)));
    expect(bodies).toEqual([
      { document_key: 'tos', version: '1.2', content_hash: HASH.tos },
      { document_key: 'privacy', version: '1.0', content_hash: HASH.privacy },
      { document_key: 'aup', version: '1.1', content_hash: HASH.aup },
      { document_key: 'dpa', version: '1.0', content_hash: HASH.dpa },
    ]);
    expect(visibleState(local.window)).toBe('success');
  });

  it('reconciles a partial legal timeout and retries only the remaining document', async () => {
    const html = loadBuiltPage();
    const local = setUpDom(html, (window) => {
      window.localStorage.setItem('ds_web_session_token', 'tok-ok');
    });
    dom = local;
    const tosHash = 'a'.repeat(64);
    const privacyHash = 'b'.repeat(64);
    const lost = new Error('privacy response lost');
    lost.name = 'AbortError';
    local.setFetchPlan([
      () =>
        new local.window.Response(
          JSON.stringify({
            pending_acceptances: [
              { document_key: 'tos', current_version: '1.2' },
              { document_key: 'privacy', current_version: '1.0' },
            ],
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      () =>
        new local.window.Response(
          JSON.stringify({
            data: [
              { document_key: 'tos', current_version: '1.2', content_hash: tosHash },
              { document_key: 'privacy', current_version: '1.0', content_hash: privacyHash },
            ],
          }),
          { status: 200 },
        ),
      () => new local.window.Response('{}', { status: 201 }),
      () => Promise.reject(lost),
      () =>
        new local.window.Response(
          JSON.stringify({
            data: [{ document_key: 'privacy', current_version: '1.0', content_hash: privacyHash }],
          }),
          { status: 200 },
        ),
      () =>
        new local.window.Response(
          JSON.stringify({
            data: [{ document_key: 'privacy', current_version: '1.0', content_hash: privacyHash }],
          }),
          { status: 200 },
        ),
      () => new local.window.Response('{}', { status: 201 }),
      () => new local.window.Response(JSON.stringify({ status: 'bound' }), { status: 200 }),
    ]);

    (local.window.document.querySelector('[data-authorize]') as HTMLButtonElement).click();
    await flush();
    await flush();
    const accept = local.window.document.querySelector(
      '[data-state="legal-accept"] [data-legal-accept-all]',
    ) as HTMLButtonElement;
    accept.click();
    await flush();
    await flush();
    await flush();

    expect(accept.textContent).toBe('Accept remaining and authorize');
    expect(
      local.window.document.querySelector('[data-state="legal-accept"] [data-legal-status]')
        ?.textContent,
    ).toMatch(
      /1 accepted; 1 document still requires acceptance.*Only the remaining documents will be sent/,
    );
    expect(
      local.window.document.querySelector('[data-state="legal-accept"] [data-legal-pending-list]')
        ?.textContent,
    ).toContain('Privacy Policy');
    expect(
      local.window.document.querySelector('[data-state="legal-accept"] [data-legal-pending-list]')
        ?.textContent,
    ).not.toContain('Terms of Service');

    accept.click();
    await flush();
    await flush();
    await flush();
    const acceptCalls = local.fetchCalls.filter((call) => call.url.endsWith('/v1/legal/accept'));
    expect(acceptCalls.map((call) => JSON.parse(String(call.init?.body)).document_key)).toEqual([
      'tos',
      'privacy',
      'privacy',
    ]);
    expect(visibleState(local.window)).toBe('success');
  });

  it('makes a legal timeout plus failed reconciliation reload-only with no second POST', async () => {
    const html = loadBuiltPage();
    const local = setUpDom(html, (window) => {
      window.localStorage.setItem('ds_web_session_token', 'tok-ok');
    });
    dom = local;
    const lost = new Error('accept response lost');
    lost.name = 'AbortError';
    local.setFetchPlan([
      () =>
        new local.window.Response(
          JSON.stringify({
            pending_acceptances: [{ document_key: 'tos', current_version: '1.2' }],
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      () =>
        new local.window.Response(
          JSON.stringify({
            data: [{ document_key: 'tos', current_version: '1.2', content_hash: 'a'.repeat(64) }],
          }),
          { status: 200 },
        ),
      () => Promise.reject(lost),
      () => Promise.reject(new TypeError('required state unavailable')),
    ]);

    (local.window.document.querySelector('[data-authorize]') as HTMLButtonElement).click();
    await flush();
    await flush();
    const accept = local.window.document.querySelector(
      '[data-state="legal-accept"] [data-legal-accept-all]',
    ) as HTMLButtonElement;
    accept.click();
    await flush();
    await flush();
    await flush();

    expect(accept.textContent).toBe('Reload to verify');
    expect(
      local.window.document.querySelector('[data-state="legal-accept"] [data-legal-status]')
        ?.textContent,
    ).toMatch(/outcome is unknown.*Reload to check what remains before authorizing/);
    expect(local.fetchCalls.filter((call) => call.url.endsWith('/v1/legal/accept'))).toHaveLength(
      1,
    );
    accept.dispatchEvent(new local.window.MouseEvent('click'));
    accept.dispatchEvent(new local.window.MouseEvent('click'));
    await flush();
    expect(local.fetchCalls.filter((call) => call.url.endsWith('/v1/legal/accept'))).toHaveLength(
      1,
    );
  });

  it('on 200 bind success, shows success state', async () => {
    const html = loadBuiltPage();
    const local = setUpDom(html, (window) => {
      window.localStorage.setItem('ds_web_session_token', 'tok-ok');
    });
    dom = local;
    local.setFetchPlan([
      (_call) =>
        new local.window.Response(JSON.stringify({ status: 'bound' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    await flush();
    const authorizeBtn = dom.window.document.querySelector('[data-authorize]') as HTMLButtonElement;
    authorizeBtn.click();
    await flush();
    await flush();
    expect(visibleState(dom.window)).toBe('success');
  });
});
