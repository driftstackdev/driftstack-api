import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'index.html');

interface LegalDoc {
  document_key: string;
  current_version: string;
  content_hash: string;
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function setUpDom(route: (call: FetchCall) => Response | Promise<Response>): {
  window: JSDOM['window'];
  fetchCalls: FetchCall[];
};
function setUpDom(
  route: (call: FetchCall) => Response | Promise<Response>,
  beforeEval?: (window: JSDOM['window']) => void,
): {
  window: JSDOM['window'];
  fetchCalls: FetchCall[];
} {
  const scripts: string[] = [];
  const html = readFileSync(BUILT_PAGE, 'utf8').replace(
    /<script[^>]*>([\s\S]*?)<\/script>/g,
    (_match, body: string) => {
      scripts.push(body);
      return '';
    },
  );
  const dom = new JSDOM(html, {
    url: 'https://app.driftstack.io/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const fetchCalls: FetchCall[] = [];
  // @ts-expect-error — jsdom's fetch global is intentionally replaced.
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call = { url: String(input), init };
    fetchCalls.push(call);
    return Promise.resolve(route(call));
  };
  window.localStorage.setItem('ds_web_session_token', 'tok');
  beforeEval?.(window);
  installDashboardDeadline(window);
  const legalScript = scripts.find((script) => script.includes('LEGAL_REQUEST_TIMEOUT_MS'));
  if (!legalScript) throw new Error('legal acceptance inline script not found');
  // @ts-expect-error — jsdom exposes eval for deliberate inline-script execution.
  window.eval(legalScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const TOS: LegalDoc = {
  document_key: 'tos',
  current_version: '2026-07-01',
  content_hash: 'a'.repeat(64),
};
const PRIVACY: LegalDoc = {
  document_key: 'privacy',
  current_version: '2026-07-01',
  content_hash: 'b'.repeat(64),
};

function postedDoc(call: FetchCall): LegalDoc {
  return JSON.parse(String(call.init?.body)) as LegalDoc;
}

describe('DashboardLayout legal acceptance reconciliation', () => {
  let win: JSDOM['window'] | null = null;

  afterEach(() => {
    win?.close?.();
    win = null;
  });

  it('keeps the transport deadline armed while a JSON response body is still pending', async () => {
    let fireDeadline = () => undefined;
    let clearCalls = 0;
    let requestSignal: AbortSignal | null = null;
    const stalled = new Response('{"data":[]}');
    Object.defineProperty(stalled, 'json', {
      configurable: true,
      value: () => new Promise<never>(() => undefined),
    });

    const { window } = setUpDom(
      (call) => {
        requestSignal = call.init?.signal ?? null;
        return stalled;
      },
      (target) => {
        target.setTimeout = ((handler: TimerHandler) => {
          fireDeadline = () => {
            if (typeof handler === 'function') handler();
          };
          return 1;
        }) as typeof target.setTimeout;
        target.clearTimeout = (() => {
          clearCalls += 1;
        }) as typeof target.clearTimeout;
      },
    );
    win = window;
    await flush();

    expect(clearCalls).toBe(0);
    expect(requestSignal?.aborted).toBe(false);
    fireDeadline();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('clears the transport deadline after JSON decoding settles', async () => {
    let clearCalls = 0;
    const { window } = setUpDom(
      () => json({ data: [] }),
      (target) => {
        target.setTimeout = (() => 1) as typeof target.setTimeout;
        target.clearTimeout = (() => {
          clearCalls += 1;
        }) as typeof target.clearTimeout;
      },
    );
    win = window;
    await flush();

    expect(clearCalls).toBe(1);
  });

  it('reveals a failed initial check and retries with GET only before enabling acceptance', async () => {
    let requiredReads = 0;
    const { window, fetchCalls } = setUpDom((call) => {
      if (!call.url.endsWith('/v1/legal/required')) {
        throw new Error('acceptance POST must not run during check-only recovery');
      }
      requiredReads += 1;
      if (requiredReads === 1) return Promise.reject(new TypeError('gateway unavailable'));
      return json({ data: [TOS] });
    });
    win = window;
    await flush();

    const banner = window.document.querySelector('[data-legal-banner]') as HTMLElement;
    const button = window.document.querySelector('[data-legal-accept-all]') as HTMLButtonElement;
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(button.textContent).toBe('Retry agreement check');
    expect(window.document.querySelector('[data-legal-status]')?.textContent).toMatch(
      /Could not check whether updated agreements are required/,
    );

    button.click();
    await flush();

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
    expect(fetchCalls.filter((call) => call.url.endsWith('/v1/legal/required'))).toHaveLength(2);
    expect(button.textContent).toBe('Accept all and continue');
    expect(window.document.querySelector('[data-legal-pending-list]')?.textContent).toContain(
      'Terms of Service',
    );
  });

  it('re-renders and retries only the document still required after a partial timeout', async () => {
    let pending = [TOS, PRIVACY];
    let privacyAttempts = 0;
    const { window, fetchCalls } = setUpDom((call) => {
      if (call.url.endsWith('/v1/legal/required')) return json({ data: pending });
      const doc = postedDoc(call);
      if (doc.document_key === 'tos') {
        pending = pending.filter((item) => item.document_key !== 'tos');
        return json({ id: 'lacc_tos' }, 201);
      }
      privacyAttempts += 1;
      if (privacyAttempts === 1) return Promise.reject(abortError('privacy response lost'));
      pending = [];
      return json({ id: 'lacc_privacy' }, 201);
    });
    win = window;
    await flush();

    const button = window.document.querySelector('[data-legal-accept-all]') as HTMLButtonElement;
    button.click();
    await flush(12);

    const firstPosts = fetchCalls.filter((call) => call.init?.method === 'POST');
    expect(firstPosts.map((call) => postedDoc(call).document_key).sort()).toEqual([
      'privacy',
      'tos',
    ]);
    expect(window.document.querySelector('[data-legal-status]')?.textContent).toMatch(
      /1 accepted; 1 document still requires acceptance.*Only the remaining documents will be sent/,
    );
    expect(button.textContent).toBe('Accept remaining and continue');
    expect(window.document.querySelector('[data-legal-pending-list]')?.textContent).toContain(
      'Privacy Policy',
    );
    expect(window.document.querySelector('[data-legal-pending-list]')?.textContent).not.toContain(
      'Terms of Service',
    );

    button.click();
    await flush(10);
    const allPosts = fetchCalls.filter((call) => call.init?.method === 'POST');
    expect(allPosts.map((call) => postedDoc(call).document_key)).toEqual([
      'tos',
      'privacy',
      'privacy',
    ]);
    expect(window.document.querySelector('[data-legal-status]')?.textContent).toBe(
      'Accepted — reloading…',
    );
  });

  it('treats lost responses as complete when authoritative required state is empty', async () => {
    let pending = [TOS, PRIVACY];
    const { window, fetchCalls } = setUpDom((call) => {
      if (call.url.endsWith('/v1/legal/required')) return json({ data: pending });
      const doc = postedDoc(call);
      pending = pending.filter((item) => item.document_key !== doc.document_key);
      return Promise.reject(abortError('response lost after commit'));
    });
    win = window;
    await flush();

    const button = window.document.querySelector('[data-legal-accept-all]') as HTMLButtonElement;
    button.click();
    await flush(12);

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(2);
    expect(window.document.querySelector('[data-legal-status]')?.textContent).toBe(
      'Accepted — reloading…',
    );
    expect(button.disabled).toBe(true);
  });

  it('turns a double-failure into reload-only mode instead of another acceptance POST', async () => {
    let requiredReads = 0;
    const { window, fetchCalls } = setUpDom((call) => {
      if (call.url.endsWith('/v1/legal/required')) {
        requiredReads += 1;
        if (requiredReads > 1) return Promise.reject(new TypeError('status unavailable'));
        return json({ data: [TOS] });
      }
      return Promise.reject(abortError('accept response lost'));
    });
    win = window;
    await flush();

    const button = window.document.querySelector('[data-legal-accept-all]') as HTMLButtonElement;
    button.click();
    await flush(12);

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(button.textContent).toBe('Reload to verify');
    expect(button.disabled).toBe(false);
    expect(window.document.querySelector('[data-legal-status]')?.textContent).toMatch(
      /outcome is unknown.*Reload to check what remains before retrying/,
    );

    button.click();
    await flush();
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
  });
});
