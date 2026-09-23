// The /security page is revealed as soon as its loaders are scheduled, not
// when they answer. Its three lists ship with a SIGNED-OUT placeholder ("Sign
// in to load …"), so a signed-in customer saw "Sign in to load recent
// activity." and "Sign in to load your linked accounts." while the fetches
// ran — an audit caught it on the built page. Each loader now hides its
// placeholder before fetching, as the active sign-ins loader always did. A
// signed-out visitor still sees them: that is what they are for.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// @ts-expect-error — jsdom ships no type declarations in this workspace.
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'security', 'index.html');
const PAGE_URL = 'https://app.driftstack.io/security/';

const PLACEHOLDERS = [
  '[data-field="web-sessions-empty"]',
  '[data-field="oauth-links-empty"]',
  '[data-field="audit-empty"]',
] as const;

function setUpDom(token: string | null): {
  window: JSDOM['window'];
  hydratedCount: () => number;
  fetched: string[];
} {
  const html = readFileSync(BUILT_PAGE, 'utf8');
  const scriptBodies: string[] = [];
  const htmlNoScripts = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scriptBodies.push(body);
    return '';
  });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(htmlNoScripts, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const fetched: string[] = [];
  if (typeof window.Response !== 'function') window.Response = Response;
  // Every request stays in flight: this is the moment between the reveal and
  // the first answer.
  window.fetch = (input: string) => {
    fetched.push(String(input));
    return new Promise<Response>(() => {});
  };
  if (token !== null) window.localStorage.setItem('ds_web_session_token', token);
  let hydrated = 0;
  window.dashboardHydrated = () => {
    hydrated += 1;
  };
  window.driftstackConfirm = () => Promise.resolve(true);
  const pageScript = scriptBodies.find((s) => s.includes('data-page="security"'));
  if (!pageScript) throw new Error('security inline script not found');
  installDashboardDeadline(window);
  window.eval(pageScript);
  return { window: window as JSDOM['window'], hydratedCount: () => hydrated, fetched };
}

function shownPlaceholders(window: JSDOM['window']): string[] {
  return PLACEHOLDERS.flatMap((selector) => {
    const el = window.document.querySelector(selector);
    if (el === null) throw new Error(`placeholder not found: ${selector}`);
    const hidden = el.classList.contains('hidden') || (el as HTMLElement).hidden;
    return hidden ? [] : [el.textContent?.trim() ?? ''];
  });
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('a signed-in customer never sees the signed-out placeholders while the security page loads', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });

  it('once revealed, with every request still in flight, no "Sign in to load" line shows', async () => {
    const { window, hydratedCount, fetched } = setUpDom('tok');
    win = window;
    await flush();
    expect(hydratedCount()).toBe(1);
    // The loaders did start — the page is waiting on them, not skipping them.
    expect(fetched.some((u) => u.includes('/v1/account/audit-log'))).toBe(true);
    expect(fetched.some((u) => u.includes('/v1/account/me/oauth-links'))).toBe(true);
    expect(fetched.some((u) => u.includes('/v1/account/web-sessions'))).toBe(true);
    expect(shownPlaceholders(window)).toEqual([]);
  });

  it('CONTROL — a signed-out visitor still sees all three placeholders', async () => {
    const { window, hydratedCount, fetched } = setUpDom(null);
    win = window;
    await flush();
    expect(hydratedCount()).toBe(1);
    expect(fetched).toEqual([]);
    const shown = shownPlaceholders(window);
    expect(shown).toHaveLength(3);
    for (const line of shown) expect(line).toMatch(/^Sign in to load /);
  });
});
