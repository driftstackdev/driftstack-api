// The /settings bundled-AI limit accepts exactly what the server accepts.
//
// A NEW monthly limit is at most $100. A limit stored above that before the
// maximum was lowered is kept: the server returns and enforces it, accepts it
// sent back unchanged (the form always saves consent AND limit together, so a
// customer who only flips consent re-sends it), and accepts it LOWERED to any
// value, but never raised.
//
// The form has no `novalidate`, so the input's `max` is a real gate: a static
// max of $100 would stop the browser from submitting a kept $500 limit, locking
// that customer out of their own consent toggle. So the max follows the limit
// the server returned, and so does the page's own check.
//
// The mock server below applies the server's real rule (`bundledCapWriteRefusal`)
// and answers a refusal with the route's real problem shape, so this test moves
// when the server's rule does.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { bundledCapWriteRefusal } from '../../../server/src/services/bundled-llm';
import { installDashboardDeadline } from './dashboard-test-runtime';

// jsdom ships no type declarations and none are installed here, so the page's
// window is typed as the DOM window plus the two globals the page script reads.
type PageWindow = Window &
  typeof globalThis & { driftstackConfirm?: (message?: string) => Promise<boolean> };
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: Record<string, unknown>) => { window: PageWindow };
};

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'settings', 'index.html');
const PAGE_URL = 'https://app.driftstack.io/settings/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface BundledServer {
  consent: boolean;
  capCents: number;
  /** Replaces the rule for one test; otherwise the server's own rule applies. */
  refuse?: (requested: Record<string, unknown>) => Response | null;
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function validationProblem(fieldErrors: Record<string, string[]>): Response {
  return json(
    {
      type: PROBLEM_TYPES.ValidationFailed,
      title: 'Validation Failed',
      status: 400,
      detail: 'One or more fields failed validation.',
      issues: { formErrors: [], fieldErrors },
    },
    400,
  );
}

function makeRouter(server: BundledServer): (call: MockFetchCall) => Response {
  return (call) => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const path = call.url.replace(/^https?:\/\/[^/]+/, '');
    if (/\/v1\/account\/me\/bundled-llm-status$/.test(path) && method === 'GET') {
      return json({
        consent: server.consent,
        cap_cents: server.capCents,
        used_this_month_cents: 0,
        remaining_cents: server.capCents,
        month_started_at: '2026-09-01T00:00:00.000Z',
      });
    }
    if (/\/v1\/account\/me\/bundled-llm-settings$/.test(path) && method === 'PATCH') {
      const requested = JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;
      const override = server.refuse?.(requested);
      if (override) return override;
      if (typeof requested['monthly_cap_usd_cents'] === 'number') {
        const refusal = bundledCapWriteRefusal({
          requestedCents: requested['monthly_cap_usd_cents'],
          currentCents: server.capCents,
        });
        if (refusal !== null) return validationProblem({ monthly_cap_usd_cents: [refusal] });
        server.capCents = requested['monthly_cap_usd_cents'];
      }
      if (typeof requested['consent'] === 'boolean') server.consent = requested['consent'];
      return json({ consent: server.consent, monthly_cap_usd_cents: server.capCents });
    }
    if (/\/v1\/account\/me$/.test(path) && method === 'GET') {
      return json({ email: 'me@example.com', name: 'Me', slug: 'me', region: 'eu' });
    }
    if (/\/v1\/account\/me\/byok-anthropic-key$/.test(path)) {
      return json({ has_key: false, set_at: null, last_used_at: null });
    }
    if (/\/v1\/account\/email-preferences$/.test(path)) return json({ data: [] });
    return json({}, 404);
  };
}

function setUpDom(server: BundledServer): {
  window: PageWindow;
  fetchCalls: MockFetchCall[];
} {
  const scriptBodies: string[] = [];
  const html = readFileSync(BUILT_PAGE, 'utf8').replace(
    /<script[^>]*>([\s\S]*?)<\/script>/g,
    (_m, body: string) => {
      scriptBodies.push(body);
      return '';
    },
  );
  const dom = new JSDOM(html, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const fetchCalls: MockFetchCall[] = [];
  const route = makeRouter(server);
  if (typeof window.Response !== 'function') window.Response = Response;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const call: MockFetchCall = { url: String(input), init };
    fetchCalls.push(call);
    return Promise.resolve().then(() => route(call));
  };
  window.localStorage.setItem('ds_web_session_token', 'tok');
  // Injected by DashboardLayout in the real page.
  window.driftstackConfirm = () => Promise.resolve(true);
  const pageScript = scriptBodies.find((s) => s.includes('data-page="settings"'));
  if (!pageScript) throw new Error('settings inline script not found');
  installDashboardDeadline(window);
  window.eval(pageScript);
  return { window, fetchCalls };
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function capInput(window: PageWindow): HTMLInputElement {
  return window.document.querySelector('[data-field="bundled-cap-usd"]') as HTMLInputElement;
}

function keptLineShown(window: PageWindow): boolean {
  const line = window.document.querySelector('[data-bundled-cap-kept]');
  if (!line) throw new Error('kept-limit line not found');
  return !line.classList.contains('hidden');
}

function bundledError(window: PageWindow): string | null {
  const el = window.document.querySelector('[data-bundled-error]');
  if (!el) throw new Error('bundled error element not found');
  return el.classList.contains('hidden') ? null : (el.textContent ?? '');
}

async function save(window: PageWindow, capUsd?: string): Promise<void> {
  if (capUsd !== undefined) capInput(window).value = capUsd;
  const form = window.document.querySelector('[data-bundled-form]') as HTMLFormElement;
  // The browser runs constraint validation before it fires `submit`; a dispatched
  // event skips that, so each test asks the input directly where it matters.
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
}

function patches(fetchCalls: MockFetchCall[]): Array<Record<string, unknown>> {
  return fetchCalls
    .filter((c) => c.init?.method === 'PATCH' && /bundled-llm-settings$/.test(c.url))
    .map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
}

describe('the dashboard AI limit accepts what the server accepts', () => {
  let win: PageWindow | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });

  it('a limit of $100 or less loads under a $100 maximum, and a new limit above $100 is refused before it is sent', async () => {
    const server: BundledServer = { consent: true, capCents: 2_000 };
    const { window, fetchCalls } = setUpDom(server);
    win = window;
    await flush();

    expect(capInput(window).value).toBe('20.00');
    expect(capInput(window).max).toBe('100.00');
    expect(keptLineShown(window)).toBe(false);

    await save(window, '100.01');
    expect(bundledError(window)).toMatch(/Enter a limit from \$0 to \$100 with at most two/);
    expect(patches(fetchCalls)).toEqual([]);

    await save(window, '100');
    expect(patches(fetchCalls)).toEqual([{ consent: true, monthly_cap_usd_cents: 10_000 }]);
    expect(bundledError(window)).toBeNull();
    expect(server.capCents).toBe(10_000);
  });

  it('a kept limit above $100 can be saved unchanged when only consent changes', async () => {
    const server: BundledServer = { consent: true, capCents: 50_000 };
    const { window, fetchCalls } = setUpDom(server);
    win = window;
    await flush();

    const input = capInput(window);
    expect(input.value).toBe('500.00');
    expect(input.max).toBe('500.00');
    // What the browser checks before it lets the form submit.
    expect(input.validity.rangeOverflow).toBe(false);
    expect(input.checkValidity()).toBe(true);
    expect(keptLineShown(window)).toBe(true);

    (window.document.querySelector('[data-field="bundled-consent"]') as HTMLInputElement).checked =
      false;
    await save(window);

    expect(patches(fetchCalls)).toEqual([{ consent: false, monthly_cap_usd_cents: 50_000 }]);
    expect(bundledError(window)).toBeNull();
    expect(server).toMatchObject({ consent: false, capCents: 50_000 });
  });

  it('a kept limit can be lowered to a value still above $100, and the lowered value becomes the ceiling', async () => {
    const server: BundledServer = { consent: true, capCents: 50_000 };
    const { window, fetchCalls } = setUpDom(server);
    win = window;
    await flush();

    await save(window, '300');
    expect(patches(fetchCalls)).toEqual([{ consent: true, monthly_cap_usd_cents: 30_000 }]);
    expect(bundledError(window)).toBeNull();
    expect(capInput(window).max).toBe('300.00');
    expect(keptLineShown(window)).toBe(true);

    // Raising it again is refused on the page, before anything is sent.
    await save(window, '300.01');
    expect(bundledError(window)).toMatch(/up to your current \$300\.00 limit/);
    expect(patches(fetchCalls)).toHaveLength(1);
  });

  it('a limit above the kept one is refused before it is sent', async () => {
    const { window, fetchCalls } = setUpDom({ consent: true, capCents: 50_000 });
    win = window;
    await flush();

    expect(capInput(window).validity.rangeOverflow).toBe(false);
    capInput(window).value = '500.01';
    expect(capInput(window).validity.rangeOverflow).toBe(true);
    await save(window);
    expect(bundledError(window)).toMatch(/up to your current \$500\.00 limit/);
    expect(patches(fetchCalls)).toEqual([]);
  });

  it('a limit the server refuses is explained in dollars, and the form reloads the limit the server holds', async () => {
    const server: BundledServer = { consent: true, capCents: 50_000 };
    const { window, fetchCalls } = setUpDom(server);
    win = window;
    await flush();
    expect(capInput(window).max).toBe('500.00');

    // Lowered somewhere else (the desktop app) after this page loaded.
    server.capCents = 20_000;
    await save(window, '300');

    expect(patches(fetchCalls)).toEqual([{ consent: true, monthly_cap_usd_cents: 30_000 }]);
    const message = bundledError(window);
    expect(message).toBe(
      'That limit was not accepted. New limits are at most $100, and a limit already above $100 can be kept or lowered, but not raised. The form now shows your current settings.',
    );
    // The server's own text is written for API callers; none of it reaches the form.
    expect(message).not.toMatch(/monthly_cap_usd_cents|10000/);
    expect(capInput(window).value).toBe('200.00');
    expect(capInput(window).max).toBe('200.00');
    expect(server.capCents).toBe(20_000);
  });

  it('any other refused field keeps the general message', async () => {
    const { window } = setUpDom({
      consent: true,
      capCents: 2_000,
      refuse: () => validationProblem({ consent: ['Expected boolean, received string'] }),
    });
    win = window;
    await flush();

    await save(window, '50');
    expect(bundledError(window)).toBe(
      'Some information was not accepted. Check your input and try again.',
    );
  });
});
