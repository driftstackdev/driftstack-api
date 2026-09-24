// The audit log names a verification that removed the password.
//
// Sign-in re-audit, round 1, new defect 2 (MEDIUM). When a first sign-in link
// confirmed the address and removed the account's password, the only trace was
// an `account.email_verified` row with `payload.password_removed: true` — which
// the audit-log page showed as a plain "Email verified". It now reads
// "Email verified — password removed"; every other verification is unchanged.
//
// Runs the page's own inline script from the built page, as audit-log-page.test.ts does.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// @ts-expect-error — jsdom ships no type declarations in this workspace.
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'audit-log', 'index.html');

function load(rows: unknown[]): JSDOM['window'] {
  const html = readFileSync(BUILT_PAGE, 'utf8');
  const scripts: string[] = [];
  const bare = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scripts.push(body);
    return '';
  });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const { window } = new JSDOM(bare, {
    url: 'https://app.driftstack.io/audit-log/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  if (typeof window.Response !== 'function') window.Response = Response;
  window.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ data: rows, next_cursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  window.localStorage.setItem('ds_web_session_token', 'tok');
  window.dashboardHydrated = () => {};
  window.driftstackActAsHeaders = () => ({});
  const pageScript = scripts.find((s) => s.includes('data-page="audit-log"'));
  if (!pageScript) throw new Error('audit-log inline script not found');
  installDashboardDeadline(window);
  window.eval(pageScript);
  return window as JSDOM['window'];
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function labels(window: JSDOM['window']): string[] {
  const rows: Element[] = Array.from(
    (window.document as Document).querySelectorAll('[data-list] > li p:first-child'),
  );
  return rows.map((p) => p.textContent?.trim() ?? '');
}

let open: JSDOM['window'] | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

describe('the audit log names a verification that removed the password', () => {
  it('password_removed: true reads "Email verified — password removed"; other verifications read "Email verified"', async () => {
    open = load([
      {
        action: 'account.email_verified',
        timestamp: '2026-09-24T10:00:00.000Z',
        payload: { via: 'magic_link', password_removed: true },
      },
      {
        action: 'account.email_verified',
        timestamp: '2026-09-24T09:00:00.000Z',
        payload: { via: 'magic_link', password_removed: false },
      },
      {
        action: 'account.email_verified',
        timestamp: '2026-09-24T08:00:00.000Z',
        payload: { via: 'password_reset' },
      },
      { action: 'account.email_verified', timestamp: '2026-09-24T07:00:00.000Z', payload: null },
    ]);
    await flush();
    expect(labels(open)).toEqual([
      'Email verified — password removed',
      'Email verified',
      'Email verified',
      'Email verified',
    ]);
  });
});
