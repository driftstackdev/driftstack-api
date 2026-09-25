// GUI audit #9 — the dashboard's /cli/authorize page with a desktop sign-in that
// is bound to a code verifier (RFC 7636 PKCE).
//
// The desktop app now keeps a `code_verifier` to itself and sends only its hash
// at initiate; the server refuses to hand the key to anyone who cannot present
// the verifier. The sign-in link keeps its shape (`?code=…&state=…`), so this
// page needs no new input. What it must keep doing is:
//
//   - approve the flow with exactly `{code, state, user_code}` — nothing more is
//     needed, and nothing the page could send would stand in for the verifier;
//   - hand back to the app with a `driftstack://auth/callback` that carries only
//     `code` and `state`, which is safe to leak because it cannot collect the key.
//
// Runs the page's inline script from SOURCE, not the built `dist/` copy that
// `cli-authorize.test.ts` reads, so it checks the page as it is in this tree.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — jsdom ships no type declarations in this workspace.
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const PAGE = resolve(process.cwd(), 'apps/customer-dashboard/src/pages/cli/authorize.astro');
const API = 'https://api.driftstack.test';
const CODE = 'Q2hhbGxlbmdlLWJvdW5kLWNvZGUtZm9yLXRoZS1kZXNrdG9w';
const STATE = '9f3a1c0e5b7d2a4f6e8c0b1d3f5a7c9e1b3d5f7a9c1e3b5d';

let dom: JSDOM | null = null;
afterEach(() => {
  dom?.window.close();
  dom = null;
});

function loadPage(pageUrl: string): {
  window: JSDOM['window'];
  binds: Array<{ url: string; body: unknown }>;
  handOffs: string[];
} {
  const source = readFileSync(PAGE, 'utf8');
  const markup = source.match(/<DashboardLayout[^>]*>([\s\S]*?)<script is:inline define:vars/);
  const script = source.match(
    /<script is:inline define:vars=\{\{ apiBaseUrl \}\}>([\s\S]*?)<\/script>/,
  );
  if (!markup?.[1] || !script?.[1]) throw new Error('cli/authorize page structure not found');

  dom = new JSDOM(`<!doctype html><html><body>${markup[1]}</body></html>`, {
    url: pageUrl,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.localStorage.setItem('ds_web_session_token', 'web-session-token');
  const binds: Array<{ url: string; body: unknown }> = [];
  const handOffs: string[] = [];
  Object.assign(window, {
    Response,
    fetch: (input: string, init?: RequestInit) => {
      binds.push({ url: String(input), body: JSON.parse(String(init?.body ?? 'null')) });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, account_id: 'acc_1', expires_at: 'x' }), {
          status: 200,
        }),
      );
    },
  });
  // The page hands off with `window.location.assign(target)`. jsdom's location
  // cannot be replaced, so the one call is redirected to a recorder — and the
  // substitution must happen exactly once, or the page no longer hands off the
  // way this test reads it.
  const handOffCall = 'window.location.assign(target)';
  const body = script[1];
  if (body.split(handOffCall).length !== 2) throw new Error('hand-off call not found once');
  Object.assign(window, { __recordHandOff: (href: string) => handOffs.push(href) });
  installDashboardDeadline(window);
  window.eval(
    `(function(){ const apiBaseUrl = ${JSON.stringify(API)};\n${body.replace(handOffCall, 'window.__recordHandOff(target)')}\n})();`,
  );
  return { window, binds, handOffs };
}

async function settle(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await new Promise((r) => setTimeout(r, 0));
}

describe('GUI audit #9 — /cli/authorize with a verifier-bound desktop sign-in', () => {
  it('approves with only code, state and the typed device code, then hands back only code and state', async () => {
    const page = loadPage(
      `https://app.driftstack.io/cli/authorize?code=${encodeURIComponent(CODE)}&state=${STATE}`,
    );
    const input = page.window.document.querySelector('[data-user-code]') as HTMLInputElement;
    input.value = 'abcd efgh';
    (page.window.document.querySelector('[data-authorize]') as HTMLButtonElement).click();
    await settle(700);

    expect(page.binds).toHaveLength(1);
    expect(page.binds[0]?.url).toBe(`${API}/v1/auth/cli-authorize/bind-device-code`);
    expect(page.binds[0]?.body).toEqual({ code: CODE, state: STATE, user_code: 'ABCD-EFGH' });

    const successVisible = !page.window.document
      .querySelector('[data-state="success"]')
      ?.classList.contains('hidden');
    expect(successVisible).toBe(true);

    expect(page.handOffs).toHaveLength(1);
    const handOff = new URL(page.handOffs[0] ?? '');
    expect(handOff.protocol).toBe('driftstack:');
    expect(handOff.host).toBe('auth');
    expect(handOff.pathname).toBe('/callback');
    expect([...handOff.searchParams.keys()].sort()).toEqual(['code', 'state']);
    expect(handOff.searchParams.get('code')).toBe(CODE);
    expect(handOff.searchParams.get('state')).toBe(STATE);
  });

  it('does not forward a verifier or challenge that someone appended to the link', async () => {
    const page = loadPage(
      `https://app.driftstack.io/cli/authorize?code=${encodeURIComponent(CODE)}&state=${STATE}` +
        '&code_verifier=planted-verifier-planted-verifier-planted-ver' +
        '&code_challenge=planted-challenge',
    );
    const input = page.window.document.querySelector('[data-user-code]') as HTMLInputElement;
    input.value = 'ABCD-EFGH';
    (page.window.document.querySelector('[data-authorize]') as HTMLButtonElement).click();
    await settle(700);

    expect(JSON.stringify(page.binds)).not.toMatch(/planted/);
    expect(page.handOffs.join(' ')).not.toMatch(/planted/);
  });
});
