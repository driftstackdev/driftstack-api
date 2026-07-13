import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// @ts-expect-error — status-site does not ship jsdom declaration types.
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', '..', 'dist');

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function setUpPage(
  relativePath: string,
  url: string,
  fetchHandler: (call: FetchCall) => Response | Promise<Response>,
  timeoutImmediately = true,
): { window: JSDOM['window']; fetchCalls: FetchCall[] } {
  const html = readFileSync(resolve(DIST, relativePath), 'utf8');
  const scripts: string[] = [];
  const htmlNoScripts = html.replace(
    /<script[^>]*>([\s\S]*?)<\/script>/g,
    (_match, body: string) => {
      scripts.push(body);
      return '';
    },
  );
  const dom = new JSDOM(htmlNoScripts, {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const fetchCalls: FetchCall[] = [];
  if (typeof window.Response !== 'function') window.Response = Response;
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call = { url: String(input), init };
    fetchCalls.push(call);
    return Promise.resolve(fetchHandler(call));
  };
  if (timeoutImmediately) {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 10_000) {
        window.queueMicrotask(() => {
          if (typeof handler === 'function') handler(...args);
        });
        return 42;
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  }
  const marker = relativePath.endsWith('unsubscribe/index.html')
    ? 'unsub-pending'
    : relativePath === 'subscribe/index.html'
      ? 'subscribe-form'
      : 'confirm-pending';
  const script = scripts.find((body) => body.includes(marker));
  if (!script) throw new Error(`status-site inline script not found for ${relativePath}`);
  let instrumentedScript = script;
  if (marker === 'confirm-pending') {
    instrumentedScript = script.replace(
      'confirmSubscription();',
      'confirmSubscription(); window.__testConfirmSubscription = confirmSubscription;',
    );
  } else if (marker === 'unsub-pending') {
    instrumentedScript = script.replace(
      'unsubscribe();',
      'unsubscribe(); window.__testUnsubscribe = unsubscribe;',
    );
  }
  window.eval(instrumentedScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function abortOnSignal(call: FetchCall): Promise<Response> {
  return new Promise((_resolve, reject) => {
    call.init?.signal?.addEventListener(
      'abort',
      () => reject(new DOMException('request timed out', 'AbortError')),
      { once: true },
    );
  });
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('status-site subscription timeout recovery', () => {
  let win: JSDOM['window'] | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  it('rejects malformed email without a POST and focuses the invalid input', async () => {
    const setup = setUpPage(
      'subscribe/index.html',
      'https://status.driftstack.dev/subscribe/',
      () => new Response(null, { status: 202 }),
      false,
    );
    const { window, fetchCalls } = setup;
    win = window;
    const form = window.document.querySelector('#subscribe-form') as HTMLFormElement;
    const input = window.document.querySelector('#email-input') as HTMLInputElement;
    input.value = 'not-an-email';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchCalls).toHaveLength(0);
    expect(input.getAttribute('aria-describedby')).toBe('subscribe-status');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(window.document.activeElement).toBe(input);
    expect(window.document.querySelector('#subscribe-status')?.textContent).toMatch(/valid email/i);
  });

  it('marks and focuses an email rejected by the server, then clears state for a valid retry', async () => {
    let attempts = 0;
    const setup = setUpPage(
      'subscribe/index.html',
      'https://status.driftstack.dev/subscribe/',
      () => {
        attempts += 1;
        return new Response(null, { status: attempts === 1 ? 400 : 202 });
      },
      false,
    );
    const { window, fetchCalls } = setup;
    win = window;
    const form = window.document.querySelector('#subscribe-form') as HTMLFormElement;
    const input = window.document.querySelector('#email-input') as HTMLInputElement;
    input.value = 'alerts@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(window.document.activeElement).toBe(input);

    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchCalls).toHaveLength(2);
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it('blocks subscription replay after delivery becomes ambiguous', async () => {
    const setup = setUpPage(
      'subscribe/index.html',
      'https://status.driftstack.dev/subscribe/',
      abortOnSignal,
    );
    const { window, fetchCalls } = setup;
    win = window;
    const form = window.document.querySelector('#subscribe-form') as HTMLFormElement;
    const input = window.document.querySelector('#email-input') as HTMLInputElement;
    input.value = 'alerts@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal?.aborted).toBe(true);
    expect(form.classList.contains('hidden')).toBe(true);
    expect(window.document.querySelector('#subscribe-unknown')?.classList.contains('hidden')).toBe(
      false,
    );
    expect(window.document.querySelector('#unknown-email')?.textContent).toBe('alerts@example.com');
    expect(window.document.querySelector('#subscribe-unknown')?.textContent).toMatch(
      /may already[\s\S]*have emailed[\s\S]*do not subscribe[\s\S]*inbox and spam[\s\S]*newest one/i,
    );
    expect((window.document.querySelector('#submit-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps an authoritative network failure retryable', async () => {
    const setup = setUpPage(
      'subscribe/index.html',
      'https://status.driftstack.dev/subscribe/',
      () => Promise.reject(new Error('offline')),
      false,
    );
    const { window, fetchCalls } = setup;
    win = window;
    const form = window.document.querySelector('#subscribe-form') as HTMLFormElement;
    (window.document.querySelector('#email-input') as HTMLInputElement).value =
      'alerts@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchCalls).toHaveLength(2);
    expect(form.classList.contains('hidden')).toBe(false);
    expect((window.document.querySelector('#submit-btn') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(window.document.querySelector('#subscribe-status')?.textContent).toMatch(
      /couldn't reach the status api/i,
    );
  });

  it('blocks confirmation-link replay after its outcome becomes ambiguous', async () => {
    const setup = setUpPage(
      'subscribe/confirm/index.html',
      'https://status.driftstack.dev/subscribe/confirm/?token=confirm_token_1234567890',
      abortOnSignal,
    );
    const { window, fetchCalls } = setup;
    win = window;
    await flush();
    // Exercise a queued/synthetic replay independently of browser navigation.
    window.__testConfirmSubscription();
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal?.aborted).toBe(true);
    expect(window.document.querySelector('#confirm-pending')?.classList.contains('hidden')).toBe(
      true,
    );
    expect(window.document.querySelector('#confirm-unknown')?.classList.contains('hidden')).toBe(
      false,
    );
    expect(window.document.querySelector('#confirm-unknown')?.textContent).toMatch(
      /may already have confirmed[\s\S]*welcome[\s\S]*unsubscribe link[\s\S]*do not reload/i,
    );
  });

  it('blocks one-click unsubscribe replay after its outcome becomes ambiguous', async () => {
    const setup = setUpPage(
      'subscribe/unsubscribe/index.html',
      'https://status.driftstack.dev/subscribe/unsubscribe/?token=unsub_token_1234567890',
      abortOnSignal,
    );
    const { window, fetchCalls } = setup;
    win = window;
    await flush();
    // Exercise a queued/synthetic replay independently of browser navigation.
    window.__testUnsubscribe();
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal?.aborted).toBe(true);
    expect(window.document.querySelector('#unsub-pending')?.classList.contains('hidden')).toBe(
      true,
    );
    expect(window.document.querySelector('#unsub-unknown')?.classList.contains('hidden')).toBe(
      false,
    );
    expect(window.document.querySelector('#unsub-unknown')?.textContent).toMatch(
      /may already be complete[\s\S]*stopped future\s+status emails[\s\S]*do not reload[\s\S]*newest email/i,
    );
  });

  it('keeps an authoritative unsubscribe network failure retryable', async () => {
    const setup = setUpPage(
      'subscribe/unsubscribe/index.html',
      'https://status.driftstack.dev/subscribe/unsubscribe/?token=unsub_token_1234567890',
      () => Promise.reject(new Error('offline')),
      false,
    );
    const { window, fetchCalls } = setup;
    win = window;
    await flush();
    window.__testUnsubscribe();
    await flush();

    expect(fetchCalls).toHaveLength(2);
    expect(window.document.querySelector('#unsub-error')?.classList.contains('hidden')).toBe(false);
    expect(window.document.querySelector('#unsub-error-message')?.textContent).toMatch(
      /couldn't reach the status api/i,
    );
  });
});
