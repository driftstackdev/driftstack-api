// Local integration test for the /security page's MFA (2FA) flow,
// focused on DISABLE — the most security-sensitive MFA action (turning
// OFF two-factor must be confirm-gated AND step-up-gated). Covers the
// enrolled/not-enrolled status render, the direct disable
// (DELETE /v1/account/mfa → done), the step-up-required disable (DELETE
// 403 {requires_mfa_step_up} → reveal the step-up form → POST
// /v1/auth/mfa/step-up → retry DELETE → done), and disable-cancelled.
// The security page loads several account endpoints concurrently, so
// this uses a permissive stateful router with a mutable MFA holder.
//
// Mirrors settings-byok-page.test.ts (route-based; stubs driftstackConfirm).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'security', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/security/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}
interface MfaState {
  enrolled: boolean;
  requireStepUp: boolean;
  steppedUp: boolean;
}
interface SetUpOpts {
  confirmReturns?: boolean;
  route: (call: MockFetchCall) => Response;
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
  window.localStorage.setItem('ds_web_session_token', 'tok');
  const cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by DashboardLayout
  window.driftstackConfirm = () => Promise.resolve(cr);

  const pageScript = scriptBodies.find((s) => s.includes('data-page="security"'));
  if (!pageScript) throw new Error('security inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function isHidden(window: JSDOM['window'], selector: string): boolean {
  const el = window.document.querySelector(selector);
  if (!el) throw new Error(`selector not found: ${selector}`);
  return el.classList.contains('hidden');
}
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function makeRouter(mfa: MfaState): (c: MockFetchCall) => Response {
  return (call: MockFetchCall): Response => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const u = call.url.replace(/^https?:\/\/[^/]+/, '');
    if (/\/v1\/auth\/mfa\/step-up$/.test(u) && method === 'POST') {
      mfa.steppedUp = true;
      return json({ ok: true });
    }
    if (/\/v1\/account\/mfa\/enroll$/.test(u) && method === 'POST') {
      return json({
        otpauth_uri: 'otpauth://totp/Driftstack:me%40example.com?secret=ABC&issuer=Driftstack',
        secret_base32: 'ABCDEFGHIJKLMNOP',
      });
    }
    if (/\/v1\/account\/mfa\/verify$/.test(u) && method === 'POST') {
      mfa.enrolled = true;
      return json({ recovery_codes: ['aaaa-1111', 'bbbb-2222'] });
    }
    if (/\/v1\/account\/mfa$/.test(u)) {
      if (method === 'DELETE') {
        if (mfa.requireStepUp && !mfa.steppedUp) {
          return json({ requires_mfa_step_up: true }, 403);
        }
        mfa.enrolled = false;
        return new Response(null, { status: 204 });
      }
      // GET status
      return json({
        enrolled: mfa.enrolled,
        enrolled_at: '2026-05-20T10:00:00.000Z',
        last_used_at: '2026-05-28T10:00:00.000Z',
        recovery_codes_remaining: 8,
      });
    }
    if (/\/v1\/account\/me$/.test(u) && method === 'GET') {
      return json({ email: 'me@example.com', name: 'Me', slug: 'me', region: 'eu' });
    }
    if (/\/v1\/account\/email-preferences$/.test(u)) return json({ data: [] });
    if (/\/v1\/account\/audit-log/.test(u)) return json({ data: [] });
    if (/\/v1\/account\/web-sessions$/.test(u)) return json({ data: [] });
    return json({}, 404); // byok / oauth-links → handled gracefully
  };
}

function newMfa(over: Partial<MfaState> = {}): MfaState {
  return { enrolled: true, requireStepUp: false, steppedUp: false, ...over };
}

describe('security page — MFA (2FA) disable', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('enrolled: shows the enrolled section (Disable/Regenerate) + "enrolled" badge', async () => {
    const { window } = setUpDom(loadBuiltPage(), { route: makeRouter(newMfa({ enrolled: true })) });
    win = window;
    await flush();
    expect(isHidden(window, '[data-section="mfa-enrolled"]')).toBe(false);
    expect(window.document.querySelector('[data-field="mfa-status-badge"]')?.textContent).toBe(
      'enrolled',
    );
    expect(window.document.querySelector('[data-button="mfa-disable"]')).toBeTruthy();
  });

  it('not enrolled: shows the enroll section + "not enrolled" badge', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      route: makeRouter(newMfa({ enrolled: false })),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-section="mfa-enrolled"]')).toBe(true);
    expect(window.document.querySelector('[data-field="mfa-status-badge"]')?.textContent).toBe(
      'not enrolled',
    );
  });

  it('disable (no step-up): confirm → DELETE /v1/account/mfa {confirm:"disable-mfa"} → disabled', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: makeRouter(newMfa({ enrolled: true, requireStepUp: false })),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-button="mfa-disable"]') as HTMLButtonElement).click();
    await flush();
    const del = fetchCalls.find(
      (c) => c.init?.method === 'DELETE' && /\/v1\/account\/mfa$/.test(c.url),
    );
    expect(JSON.parse(String(del?.init?.body))).toEqual({ confirm: 'disable-mfa' });
    // After the post-disable reload, status is not-enrolled → enroll section shows.
    expect(isHidden(window, '[data-section="mfa-enrolled"]')).toBe(true);
  });

  it('disable requiring step-up: DELETE 403 reveals the step-up form; code → step-up POST → retry DELETE → disabled', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: makeRouter(newMfa({ enrolled: true, requireStepUp: true })),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-button="mfa-disable"]') as HTMLButtonElement).click();
    await flush();
    // First DELETE returned 403 → step-up form revealed.
    expect(isHidden(window, '[data-section="mfa-step-up"]')).toBe(false);
    // Enter the code + submit step-up.
    (window.document.querySelector('[data-field="mfa-step-up-code"]') as HTMLInputElement).value =
      '123456';
    (
      window.document.querySelector('[data-button="mfa-step-up-submit"]') as HTMLButtonElement
    ).click();
    await flush();
    const stepUp = fetchCalls.find((c) => /\/v1\/auth\/mfa\/step-up$/.test(c.url));
    expect(JSON.parse(String(stepUp?.init?.body))).toEqual({ code: '123456' });
    // The retried DELETE now succeeds → disabled (enroll section shows).
    const deletes = fetchCalls.filter(
      (c) => c.init?.method === 'DELETE' && /\/v1\/account\/mfa$/.test(c.url),
    );
    expect(deletes.length).toBeGreaterThanOrEqual(2);
    expect(isHidden(window, '[data-section="mfa-enrolled"]')).toBe(true);
  });

  it('disable cancelled at confirm: no DELETE fired, 2FA stays enrolled', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: false,
      route: makeRouter(newMfa({ enrolled: true })),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-button="mfa-disable"]') as HTMLButtonElement).click();
    await flush();
    expect(
      fetchCalls.some((c) => c.init?.method === 'DELETE' && /\/v1\/account\/mfa$/.test(c.url)),
    ).toBe(false);
    expect(isHidden(window, '[data-section="mfa-enrolled"]')).toBe(false);
  });
});

describe('security page — MFA (2FA) enrollment verify', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('verify: double-click while the request is in flight fires only one POST /v1/account/mfa/verify (button disabled meanwhile)', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter(newMfa({ enrolled: false })),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-button="mfa-start"]') as HTMLButtonElement).click();
    await flush();
    (window.document.querySelector('[data-field="mfa-verify-code"]') as HTMLInputElement).value =
      '123456';
    const verifyBtn = window.document.querySelector(
      '[data-button="mfa-verify"]',
    ) as HTMLButtonElement;
    verifyBtn.click();
    // Second click lands while the first request is still in flight
    // (fetch hasn't resolved yet — no await between the two clicks).
    verifyBtn.click();
    expect(verifyBtn.disabled).toBe(true);
    await flush();
    const verifyPosts = fetchCalls.filter(
      (c) => c.init?.method === 'POST' && /\/v1\/account\/mfa\/verify$/.test(c.url),
    );
    expect(verifyPosts.length).toBe(1);
    // Re-enabled once the (successful) request settles.
    expect(verifyBtn.disabled).toBe(false);
  });
});
