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
  setFetchPlan: (plan: Array<(call: MockFetchCall) => Response>) => void;
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
  let plan: Array<(call: MockFetchCall) => Response> = [];
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
    return Promise.resolve(handler(call));
  };
  // Customer-test-only window setup (localStorage seeding etc.).
  beforeScripts(window as JSDOM['window']);
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

  it('on 409 LegalAcceptanceRequired with top-level pending_acceptances, surfaces legal-accept UI (regression for the .extensions.* shape bug)', async () => {
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
              { document_key: 'terms', title: 'Terms', current_version: '1.0' },
              { document_key: 'privacy', title: 'Privacy', current_version: '1.0' },
              { document_key: 'aup', title: 'AUP', current_version: '1.0' },
              { document_key: 'dpa', title: 'DPA', current_version: '1.0' },
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
    const pendingList = local.window.document.querySelector(
      '[data-state="legal-accept"] [data-legal-pending-list]',
    );
    expect(pendingList?.querySelectorAll('li').length).toBe(4);
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
