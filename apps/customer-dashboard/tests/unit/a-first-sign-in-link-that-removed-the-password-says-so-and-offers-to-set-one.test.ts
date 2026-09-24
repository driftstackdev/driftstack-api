// A first sign-in link that removed the password says so, and offers to set one.
//
// Sign-in re-audit, round 1, new defect 2 (MEDIUM). A magic link that is an
// account's first confirmation of its address removes any password set before it.
// The person who really chose that password was not told: the magic-link page
// stored the session and moved on. Now `/v1/auth/magic-link/consume` answers
// `password_removed: true` in that case, and the page stays to say what happened
// and offer "Set a password" (the reset flow) — after the two-factor step too,
// when the account has one. Without the flag it moves on exactly as before.
//
// Runs the page's own inline script from the built page, as magic-link-page.test.ts does.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// @ts-expect-error — jsdom ships no type declarations in this workspace.
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'auth', 'magic-link', 'index.html');
const PAGE_URL = 'https://app.driftstack.io/auth/magic-link/?token=magic_tok_123&next=%2Fbilling';

type Handler = () => Response;

interface Page {
  window: JSDOM['window'];
  fetchUrls: string[];
  /** Page navigations the script attempted (jsdom does not navigate). */
  navigations: () => number;
}

function load(plan: Handler[]): Page {
  const html = readFileSync(BUILT_PAGE, 'utf8');
  const scripts: string[] = [];
  const bare = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scripts.push(body);
    return '';
  });
  let navigations = 0;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err: Error) => {
    if (/Not implemented: navigation/.test(String(err.message))) navigations += 1;
  });
  const { window } = new JSDOM(bare, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const fetchUrls: string[] = [];
  const queue = [...plan];
  if (typeof window.Response !== 'function') window.Response = Response;
  window.fetch = (input: string) => {
    fetchUrls.push(String(input));
    const next = queue.shift();
    return Promise.resolve(next ? next() : new Response('{}', { status: 500 }));
  };
  installDashboardDeadline(window);
  const pageScript = scripts.find((body) => body.includes('data-page="magic-link"'));
  if (!pageScript) throw new Error('magic-link inline script not found');
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchUrls, navigations: () => navigations };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function panel(window: JSDOM['window']): HTMLElement {
  const el = window.document.querySelector<HTMLElement>('[data-password-removed]');
  if (el === null) throw new Error('the password-removed notice is not on the page');
  return el;
}

let open: JSDOM['window'] | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

describe('a first sign-in link that removed the password says so and offers to set one', () => {
  it('CRITICAL password_removed: the session is kept, the page says the password was removed because the address was confirmed by email link, and "Set a password" leads to the reset flow — no silent redirect', async () => {
    const page = load([() => json({ session: { token: 'web_tok' }, password_removed: true })]);
    open = page.window;
    await flush();

    expect(page.window.localStorage.getItem('ds_web_session_token')).toBe('web_tok');
    expect(page.navigations()).toBe(0);
    const notice = panel(page.window);
    expect(notice.classList.contains('hidden')).toBe(false);
    expect(notice.textContent?.replace(/\s+/g, ' ')).toContain(
      'The password on your account was removed because your email address was confirmed by email link.',
    );
    const setPassword = notice.querySelector<HTMLAnchorElement>('[data-link="set-password"]');
    expect(setPassword?.textContent?.trim()).toBe('Set a password');
    expect(setPassword?.getAttribute('href')).toBe('/forgot-password/');
    // Moving on keeps the continuation the link carried.
    expect(notice.querySelector('[data-link="continue"]')?.getAttribute('href')).toBe('/billing');
  });

  it('after the two-factor step too: the flag from the link is kept through the code exchange', async () => {
    const page = load([
      () =>
        json({
          mfa_required: true,
          challenge_token: 'ch_tok',
          challenge_expires_at: new Date(Date.now() + 300_000).toISOString(),
          password_removed: true,
        }),
      () => json({ session: { token: 'web_after_mfa' }, via: 'totp' }),
    ]);
    open = page.window;
    await flush();
    expect(panel(page.window).classList.contains('hidden')).toBe(true);

    const mfaForm = page.window.document.querySelector(
      '[data-form="magic-link-mfa"]',
    ) as HTMLFormElement;
    (mfaForm.querySelector('#magic-link-mfa-code') as HTMLInputElement).value = '123456';
    mfaForm.dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(page.window.localStorage.getItem('ds_web_session_token')).toBe('web_after_mfa');
    expect(page.navigations()).toBe(0);
    expect(panel(page.window).classList.contains('hidden')).toBe(false);
    expect(mfaForm.classList.contains('hidden')).toBe(true);
  });

  it('without the flag nothing changes: the session is stored and the page moves on', async () => {
    const page = load([() => json({ session: { token: 'web_plain' } })]);
    open = page.window;
    await flush();
    expect(page.window.localStorage.getItem('ds_web_session_token')).toBe('web_plain');
    expect(page.navigations()).toBe(1);
    expect(panel(page.window).classList.contains('hidden')).toBe(true);
  });
});
