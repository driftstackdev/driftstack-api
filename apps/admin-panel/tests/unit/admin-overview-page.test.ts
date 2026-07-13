// Behavioural coverage for the admin Overview (index) page —
// apps/admin-panel/src/pages/index.astro. The operator's landing page: count
// tiles (active / suspended / total accounts, webhook DLQ depth) from
// /v1/admin/overview + a recent-admin-actions feed from /v1/admin/audit-log.
// Untested until now; this locks the response field reads (the same field-drift
// class that silently broke the Cost page) and the auth-gate / 403 paths.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string;
  confirmCalls?: unknown[];
  confirmReturns?: boolean;
  beforeEval?: (window: JSDOM['window']) => void;
  route: (call: MockFetchCall) => Response | Promise<Response>;
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
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(htmlNoScripts, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
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
  if (opts.token !== undefined) window.localStorage.setItem('ds_web_session_token', opts.token);
  // @ts-expect-error — injected by AdminLayout
  window.dashboardHydrated = () => {};
  // @ts-expect-error — injected by AdminLayout
  window.driftstackConfirm = (_message: string, confirmOpts: unknown) => {
    opts.confirmCalls?.push(confirmOpts);
    return Promise.resolve(opts.confirmReturns ?? true);
  };
  opts.beforeEval?.(window);

  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-overview"'));
  if (!pageScript) throw new Error('admin-overview inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function text(window: JSDOM['window'], selector: string): string {
  return window.document.querySelector(selector)?.textContent?.trim() ?? '';
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeRouter(opts: {
  overview?: Record<string, unknown>;
  overviewStatus?: number;
  audit?: Array<Record<string, unknown>>;
  auditStatus?: number;
  sessionStats?: Record<string, unknown>;
  sessionStatsStatus?: number;
  incidents?: Array<Record<string, unknown>>;
  incidentsStatus?: number;
  payingStats?: Record<string, unknown>;
  payingStatsStatus?: number;
  platformStatus?: Record<string, unknown>;
  platformStatusStatus?: number;
  pricing?: Record<string, unknown>;
  pricingStatus?: number;
  pricingEditStatus?: number;
}): (c: MockFetchCall) => Response {
  return (call) => {
    // PATCH /v1/admin/owner/pricing/:tier (the edit route) — matched BEFORE the
    // generic GET below (it carries a trailing /:tier segment). Echoes the body.
    if (/\/v1\/admin\/owner\/pricing\/[^/]+$/.test(call.url)) {
      const tierMatch = call.url.match(/pricing\/([^/?]+)/);
      const tier = tierMatch ? tierMatch[1] : '';
      let cents = 0;
      try {
        cents = Number(
          (JSON.parse(String(call.init?.body ?? '{}')) as { monthly_cents?: number })
            .monthly_cents ?? 0,
        );
      } catch {
        cents = 0;
      }
      return json({ tier, monthly_cents: cents }, opts.pricingEditStatus ?? 200);
    }
    if (/\/v1\/admin\/owner\/pricing/.test(call.url)) {
      // Default 403 — owner-only; staff fetch forbidden → card stays hidden.
      return json(opts.pricing ?? { tiers: [] }, opts.pricingStatus ?? 403);
    }
    if (/\/v1\/admin\/owner\/platform-status/.test(call.url)) {
      // Default 403 — the platform-status card is owner-only, so a normal
      // staff-admin fetch is forbidden and the card stays hidden.
      return json(opts.platformStatus ?? { features: {} }, opts.platformStatusStatus ?? 403);
    }
    if (/\/v1\/admin\/billing\/subscriptions\/stats/.test(call.url)) {
      return json(
        opts.payingStats ?? { by_tier: {}, total_active: 0 },
        opts.payingStatsStatus ?? 200,
      );
    }
    if (/\/v1\/admin\/incidents/.test(call.url)) {
      return json({ data: opts.incidents ?? [] }, opts.incidentsStatus ?? 200);
    }
    if (/\/v1\/admin\/sessions\/stats/.test(call.url)) {
      return json(
        opts.sessionStats ?? {
          by_status: { creating: 0, ready: 0, busy: 0, destroyed: 0, errored: 0 },
          active: 0,
          total: 0,
        },
        opts.sessionStatsStatus ?? 200,
      );
    }
    if (/\/v1\/admin\/audit-log/.test(call.url)) {
      return json({ data: opts.audit ?? [] }, opts.auditStatus ?? 200);
    }
    if (/\/v1\/admin\/overview/.test(call.url)) {
      return json(opts.overview ?? {}, opts.overviewStatus ?? 200);
    }
    return json({}, 404);
  };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

let win: JSDOM['window'] | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

describe('admin-panel Overview (index.astro) behaviour', () => {
  it('keeps every deadline armed while response JSON is pending, then aborts the stalled bodies', async () => {
    const deadlines: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    let clearCalls = 0;
    function stalledResponse(): Response {
      const response = new Response('{"data":[]}');
      Object.defineProperty(response, 'json', {
        configurable: true,
        value: () => new Promise<never>(() => undefined),
      });
      return response;
    }
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => {
        if (call.init?.signal) signals.push(call.init.signal);
        return stalledResponse();
      },
      beforeEval: (target) => {
        target.setTimeout = ((handler: TimerHandler) => {
          deadlines.push(() => {
            if (typeof handler === 'function') handler();
          });
          return deadlines.length;
        }) as typeof target.setTimeout;
        target.clearTimeout = (() => {
          clearCalls += 1;
        }) as typeof target.clearTimeout;
      },
    });
    win = window;
    await flush();

    expect(signals).toHaveLength(8);
    expect(clearCalls).toBe(0);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    deadlines.forEach((fire) => fire());
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('clears decoded deadlines while leaving unread owner-denial bodies bounded', async () => {
    let clearCalls = 0;
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({ overview: {}, audit: [] }),
      beforeEval: (target) => {
        target.setTimeout = (() => 1) as typeof target.setTimeout;
        target.clearTimeout = (() => {
          clearCalls += 1;
        }) as typeof target.clearTimeout;
      },
    });
    win = window;
    await flush();

    // Five successful resources decode JSON and clear immediately. The three
    // default owner-only 403 responses are intentionally status-only; their
    // still-armed deadlines close any unread body at the boundary.
    expect(clearCalls).toBe(5);
  });

  it('no session token: shows the staff-admin banner and makes no API call', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      route: () => {
        throw new Error('must not fetch when unauthenticated');
      },
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(text(window, '[data-banner]')).toContain('Sign in with a staff admin account');
  });

  it('live data: count tiles + total annotation + DLQ depth populate from /v1/admin/overview', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: {
          accounts: { active: 42, suspended: 3, deleted: 5, total: 50 },
          webhooks: { dlq_depth: 7 },
        },
        audit: [],
      }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-field="active-accounts"]')).toBe('42');
    expect(text(window, '[data-field="suspended-accounts"]')).toBe('3');
    expect(text(window, '[data-field="total-accounts-annotation"]')).toContain('of 50 total');
    expect(text(window, '[data-field="dlq-depth"]')).toBe('7');
    expect(fetchCalls).toHaveLength(8);
    expect(fetchCalls.every((call) => call.init?.signal instanceof window.AbortSignal)).toBe(true);
  });

  it('Refresh now is single-flight across the seven polled resources and restores busy state', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: {
          accounts: { active: 1, suspended: 0, deleted: 0, total: 1 },
          webhooks: { dlq_depth: 0 },
        },
        audit: [],
      }),
    });
    win = window;
    await flush();
    const before = fetchCalls.length;
    const refresh = window.document.querySelector('[data-live-refresh]') as HTMLButtonElement;
    refresh.click();
    refresh.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(refresh.disabled).toBe(true);
    expect(refresh.getAttribute('aria-busy')).toBe('true');
    expect(refresh.textContent?.trim()).toBe('Refreshing…');
    await flush();
    const refreshCalls = fetchCalls.slice(before);
    expect(refreshCalls).toHaveLength(7);
    expect(refreshCalls.every((call) => call.init?.signal instanceof window.AbortSignal)).toBe(
      true,
    );
    expect(refresh.disabled).toBe(false);
    expect(refresh.hasAttribute('aria-busy')).toBe(false);
    expect(refresh.textContent?.trim()).toBe('Refresh now');
  });

  it('open-incidents KPI: counts non-resolved incidents from /v1/admin/incidents (status !== resolved)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: { accounts: { active: 1, suspended: 0, deleted: 0, total: 1 } },
        incidents: [
          { id: 'inc_1', status: 'investigating' },
          { id: 'inc_2', status: 'monitoring' },
          { id: 'inc_3', status: 'resolved' },
        ],
        audit: [],
      }),
    });
    win = window;
    await flush();
    // 2 of the 3 incidents are non-resolved → open count = 2 (real data, not the old mock tile).
    expect(text(window, '[data-field="incidents-open"]')).toBe('2');
  });

  it('open-incidents KPI: zero non-resolved incidents → 0 (all resolved)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: { accounts: { active: 1, suspended: 0, deleted: 0, total: 1 } },
        incidents: [{ id: 'inc_1', status: 'resolved' }],
        audit: [],
      }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-field="incidents-open"]')).toBe('0');
  });

  it('accounts-by-tier: renders a labelled bar per tier with live counts + total from overview.by_tier', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: {
          accounts: {
            active: 11,
            suspended: 2,
            deleted: 0,
            total: 13,
            by_tier: {
              free: 10,
              solo_manual: 0,
              team_manual: 0,
              agency_manual: 0,
              api_starter: 0,
              api_builder: 3,
              api_scale: 0,
              enterprise: 0,
            },
          },
          webhooks: { dlq_depth: 0 },
        },
        audit: [],
      }),
    });
    win = window;
    await flush();
    const tiers = text(window, '[data-list="tier-distribution"]');
    // Friendly labels for every tier are present (zero-filled tiers still render).
    expect(tiers).toContain('Free');
    expect(tiers).toContain('API Builder');
    expect(tiers).toContain('Enterprise');
    // Live counts replace the SSR mock preview.
    expect(tiers).toContain('10');
    expect(tiers).toContain('3');
    // The total annotation reflects the server total.
    expect(text(window, '[data-field="tier-total"]')).toContain('13 total');
    // Eight tiers → eight bar rows.
    expect(window.document.querySelectorAll('[data-list="tier-distribution"] li').length).toBe(8);
  });

  it('paying-subscriber tier card populates from /v1/admin/billing/subscriptions/stats', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: {
          accounts: { active: 6, suspended: 0, deleted: 0, total: 6 },
          webhooks: { dlq_depth: 0 },
        },
        payingStats: { by_tier: { solo_manual: 4, api_scale: 2 }, total_active: 6 },
      }),
    });
    win = window;
    await flush();
    const paying = text(window, '[data-list="paying-tier-distribution"]');
    // Live active-subscription counts replace the SSR "—" preview.
    expect(paying).toContain('4');
    expect(paying).toContain('2');
    // Total-active annotation reflects total_active.
    expect(text(window, '[data-field="paying-total"]')).toContain('6 active');
    // Eight tiers → eight bar rows (zero-filled tiers still render).
    expect(
      window.document.querySelectorAll('[data-list="paying-tier-distribution"] li').length,
    ).toBe(8);
  });

  it('owner platform-status card reveals + populates flags on a 200 (owner account)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: {
          accounts: { active: 1, suspended: 0, deleted: 0, total: 1 },
          webhooks: { dlq_depth: 0 },
        },
        platformStatusStatus: 200,
        platformStatus: {
          features: {
            billing: true,
            livekit: false,
            crypto: true,
            oauth_client: false,
            sentry: true,
            permissive_cors: false,
          },
        },
      }),
    });
    win = window;
    await flush();
    const card = window.document.querySelector('[data-owner-only="platform-status"]');
    // Revealed (hidden class removed) for the owner.
    expect(card?.classList.contains('hidden')).toBe(false);
    expect(text(window, '[data-field="flag-billing"]')).toBe('wired');
    expect(text(window, '[data-field="flag-livekit"]')).toBe('not set');
    expect(text(window, '[data-field="flag-sentry"]')).toBe('wired');
  });

  it('owner platform-status card stays hidden for staff-admins (403)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: {
          accounts: { active: 1, suspended: 0, deleted: 0, total: 1 },
          webhooks: { dlq_depth: 0 },
        },
        // platformStatus defaults to 403 in makeRouter → forbidden for staff.
      }),
    });
    win = window;
    await flush();
    const card = window.document.querySelector('[data-owner-only="platform-status"]');
    expect(card?.classList.contains('hidden')).toBe(true);
  });

  it('owner pricing card reveals + lists per-tier $/mo on a 200 (owner account)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: {
          accounts: { active: 1, suspended: 0, deleted: 0, total: 1 },
          webhooks: { dlq_depth: 0 },
        },
        pricingStatus: 200,
        pricing: {
          tiers: [
            { tier: 'solo_manual', monthly_cents: 7900 },
            { tier: 'api_scale', monthly_cents: 149900 },
          ],
        },
      }),
    });
    win = window;
    await flush();
    const card = window.document.querySelector('[data-owner-only="pricing"]');
    expect(card?.classList.contains('hidden')).toBe(false);
    const pricing = text(window, '[data-list="owner-pricing"]');
    expect(pricing).toContain('solo_manual');
    expect(pricing).toContain('$79/mo');
    expect(pricing).toContain('$1499/mo');
  });

  it('owner pricing card stays hidden for staff-admins (403)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: {
          accounts: { active: 1, suspended: 0, deleted: 0, total: 1 },
          webhooks: { dlq_depth: 0 },
        },
        // pricing defaults to 403 in makeRouter → forbidden for staff.
      }),
    });
    win = window;
    await flush();
    const card = window.document.querySelector('[data-owner-only="pricing"]');
    expect(card?.classList.contains('hidden')).toBe(true);
  });

  it('owner edits a tier price → PATCHes the audited edit route with the new monthly_cents + shows saved', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: {
          accounts: { active: 1, suspended: 0, deleted: 0, total: 1 },
          webhooks: { dlq_depth: 0 },
        },
        pricingStatus: 200,
        pricing: { tiers: [{ tier: 'api_scale', monthly_cents: 149900 }] },
      }),
    });
    win = window;
    await flush();
    const input = window.document.querySelector(
      '[data-edit-tier="api_scale"]',
    ) as HTMLInputElement | null;
    const btn = window.document.querySelector(
      '[data-save-tier="api_scale"]',
    ) as HTMLButtonElement | null;
    expect(input).toBeTruthy();
    expect(btn).toBeTruthy();
    input!.value = '199900'; // $1,499 -> $1,999
    btn!.click();
    await flush();
    const patch = fetchCalls.find(
      (c) =>
        /\/v1\/admin\/owner\/pricing\/api_scale$/.test(c.url) &&
        String(c.init?.method ?? '').toUpperCase() === 'PATCH',
    );
    expect(patch, 'a PATCH to the owner edit route was issued').toBeTruthy();
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ monthly_cents: 199900 });
    expect(text(window, '[data-save-status="api_scale"]')).toContain('saved');
  });

  it('owner pricing timeout refreshes the effective value before another purchase-price edit', async () => {
    let monthlyCents = 149900;
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fallback = makeRouter({
      overview: {
        accounts: { active: 1, suspended: 0, deleted: 0, total: 1 },
        webhooks: { dlq_depth: 0 },
      },
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route(call) {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/admin\/owner\/pricing$/.test(call.url) && method === 'GET') {
          return json({ tiers: [{ tier: 'api_scale', monthly_cents: monthlyCents }] });
        }
        if (/\/v1\/admin\/owner\/pricing\/api_scale$/.test(call.url) && method === 'PATCH') {
          monthlyCents = JSON.parse(String(call.init?.body)).monthly_cents;
          return Promise.reject(timeout);
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();

    const input = window.document.querySelector('[data-edit-tier="api_scale"]') as HTMLInputElement;
    input.value = '199900';
    (window.document.querySelector('[data-save-tier="api_scale"]') as HTMLButtonElement).click();
    await flush(15);

    expect(fetchCalls.filter((call) => call.init?.method === 'PATCH')).toHaveLength(1);
    expect(text(window, '[data-save-status="api_scale"]')).toContain('confirmed');
    expect(text(window, '[data-banner]')).toMatch(
      /pricing outcome is unknown.*effective pricing was refreshed.*api_scale is now \$1999\.00.*save completed.*do not submit it again/i,
    );
  });

  it('owner pricing confirms the resolved value and serializes duplicate saves per tier', async () => {
    const confirmCalls: unknown[] = [];
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      confirmCalls,
      route: makeRouter({
        overview: {
          accounts: { active: 1, suspended: 0, deleted: 0, total: 1 },
          webhooks: { dlq_depth: 0 },
        },
        pricingStatus: 200,
        pricing: { tiers: [{ tier: 'api_scale', monthly_cents: 149900 }] },
      }),
    });
    win = window;
    await flush();
    const input = window.document.querySelector('[data-edit-tier="api_scale"]') as HTMLInputElement;
    const button = window.document.querySelector(
      '[data-save-tier="api_scale"]',
    ) as HTMLButtonElement;
    input.value = '199900';
    button.click();
    button.dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await flush();

    expect(confirmCalls).toEqual([{ confirmLabel: 'Save price' }]);
    expect(
      fetchCalls.filter(
        (c) =>
          /\/v1\/admin\/owner\/pricing\/api_scale$/.test(c.url) &&
          String(c.init?.method ?? '').toUpperCase() === 'PATCH',
      ),
    ).toHaveLength(1);
    expect(input.disabled).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  it('keeps the pending pricing row visibly busy across a live refresh', async () => {
    let resolveSave: ((response: Response) => void) | undefined;
    const fallback = makeRouter({
      overview: {
        accounts: { active: 1, suspended: 0, deleted: 0, total: 1 },
        webhooks: { dlq_depth: 0 },
      },
      pricingStatus: 200,
      pricing: { tiers: [{ tier: 'api_scale', monthly_cents: 149900 }] },
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route(call) {
        if (
          /\/v1\/admin\/owner\/pricing\/api_scale$/.test(call.url) &&
          String(call.init?.method || '').toUpperCase() === 'PATCH'
        ) {
          return new Promise<Response>((resolve) => {
            resolveSave = resolve;
          });
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();
    const input = window.document.querySelector('[data-edit-tier="api_scale"]') as HTMLInputElement;
    const button = window.document.querySelector(
      '[data-save-tier="api_scale"]',
    ) as HTMLButtonElement;
    input.value = '199900';
    button.click();
    await flush(1);

    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
    await flush(2);
    const refreshedInput = window.document.querySelector(
      '[data-edit-tier="api_scale"]',
    ) as HTMLInputElement;
    const refreshedButton = window.document.querySelector(
      '[data-save-tier="api_scale"]',
    ) as HTMLButtonElement;
    expect(refreshedInput).toBe(input);
    expect(refreshedButton).toBe(button);
    expect(refreshedInput.disabled).toBe(true);
    expect(refreshedButton.disabled).toBe(true);
    expect(refreshedButton.textContent).toBe('Saving…');
    refreshedButton.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    expect(fetchCalls.filter((call) => call.init?.method === 'PATCH')).toHaveLength(1);

    resolveSave?.(json({ status: 'updated' }));
    await flush();
    expect(refreshedInput.disabled).toBe(false);
    expect(refreshedButton.disabled).toBe(false);
    expect(refreshedButton.textContent).toBe('Save');
    expect(text(window, '[data-save-status="api_scale"]')).toContain('saved');
  });

  it('owner pricing cancellation restores controls without PATCHing', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      confirmReturns: false,
      route: makeRouter({
        overview: {
          accounts: { active: 1, suspended: 0, deleted: 0, total: 1 },
          webhooks: { dlq_depth: 0 },
        },
        pricingStatus: 200,
        pricing: { tiers: [{ tier: 'team_manual', monthly_cents: 24900 }] },
      }),
    });
    win = window;
    await flush();
    const input = window.document.querySelector(
      '[data-edit-tier="team_manual"]',
    ) as HTMLInputElement;
    const button = window.document.querySelector(
      '[data-save-tier="team_manual"]',
    ) as HTMLButtonElement;
    input.value = '27500';
    button.click();
    await flush();

    expect(fetchCalls.some((c) => /\/v1\/admin\/owner\/pricing\/team_manual$/.test(c.url))).toBe(
      false,
    );
    expect(input.disabled).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Save');
  });

  it('owner edit shows an error when the edit route rejects (non-200)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: {
          accounts: { active: 1, suspended: 0, deleted: 0, total: 1 },
          webhooks: { dlq_depth: 0 },
        },
        pricingStatus: 200,
        pricing: { tiers: [{ tier: 'team_manual', monthly_cents: 24900 }] },
        pricingEditStatus: 400,
      }),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-edit-tier="team_manual"]') as HTMLInputElement).value =
      '27500';
    (window.document.querySelector('[data-save-tier="team_manual"]') as HTMLButtonElement).click();
    await flush();
    expect(text(window, '[data-save-status="team_manual"]')).toContain('error');
  });

  it('owner edit blocks an out-of-range value client-side (no PATCH issued)', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: {
          accounts: { active: 1, suspended: 0, deleted: 0, total: 1 },
          webhooks: { dlq_depth: 0 },
        },
        pricingStatus: 200,
        pricing: { tiers: [{ tier: 'solo_manual', monthly_cents: 7900 }] },
      }),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-edit-tier="solo_manual"]') as HTMLInputElement).value =
      '0';
    (window.document.querySelector('[data-save-tier="solo_manual"]') as HTMLButtonElement).click();
    await flush();
    const patch = fetchCalls.find((c) => /\/v1\/admin\/owner\/pricing\/solo_manual$/.test(c.url));
    expect(patch, 'no PATCH for an invalid value').toBeFalsy();
    expect(text(window, '[data-save-status="solo_manual"]')).toContain('invalid');
  });

  it('new-signups: today / 7d / 30d stats populate from overview.accounts.signups', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: {
          accounts: {
            active: 5,
            suspended: 0,
            deleted: 0,
            total: 5,
            signups: { today: 2, last_7d: 9, last_30d: 41 },
          },
          webhooks: { dlq_depth: 0 },
        },
        audit: [],
      }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-field="signups-today"]')).toBe('2');
    expect(text(window, '[data-field="signups-7d"]')).toBe('9');
    expect(text(window, '[data-field="signups-30d"]')).toBe('41');
  });

  it('live sessions: active / errored / total populate from /v1/admin/sessions/stats', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: { accounts: { active: 1, suspended: 0, total: 1 }, webhooks: { dlq_depth: 0 } },
        sessionStats: {
          by_status: { creating: 1, ready: 3, busy: 2, destroyed: 8, errored: 4 },
          active: 6,
          total: 18,
        },
        audit: [],
      }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-field="sessions-active"]')).toBe('6');
    expect(text(window, '[data-field="sessions-errored"]')).toBe('4');
    expect(text(window, '[data-field="sessions-total"]')).toBe('18');
  });

  it('recent-actions feed renders an admin action with actor, action, result, and target', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: { accounts: { active: 1, suspended: 0, total: 1 }, webhooks: { dlq_depth: 0 } },
        audit: [
          {
            admin_account_id: 'acc_adm1',
            action: 'account.suspend',
            result: 'success',
            timestamp: '2026-05-20T10:00:00.000Z',
            target_account_id: 'acc_t1',
          },
        ],
      }),
    });
    win = window;
    await flush();
    const feed = text(window, '[data-list="recent-audits"]');
    expect(feed).toContain('acc_adm1');
    expect(feed).toContain('account.suspend');
    expect(feed).toContain('success');
    expect(feed).toContain('acc_t1');
  });

  it('empty audit feed: shows the no-actions message', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({
        overview: { accounts: { active: 0, suspended: 0, total: 0 }, webhooks: { dlq_depth: 0 } },
        audit: [],
      }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-list="recent-audits"]')).toContain('No admin actions recorded yet');
  });

  it('403: surfaces the admin-scope-required message', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: makeRouter({ overviewStatus: 403, auditStatus: 403 }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-banner]')).toContain('admin scope required');
  });

  it('owner-secret save confirms without exposing the value and is single-flight', async () => {
    let resolveSave: ((response: Response) => void) | undefined;
    const confirmCalls: unknown[] = [];
    const fallback = makeRouter({
      overview: { accounts: { active: 1, suspended: 0, total: 1 }, webhooks: { dlq_depth: 0 } },
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      confirmCalls,
      route(call) {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/admin\/owner\/secrets$/.test(call.url) && method === 'GET') {
          return json({ enabled: true, secrets: [] });
        }
        if (/\/v1\/admin\/owner\/secrets\/stripe_key$/.test(call.url) && method === 'PUT') {
          return new Promise<Response>((resolve) => {
            resolveSave = resolve;
          });
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="secret-set"]') as HTMLFormElement;
    const name = form.querySelector('[name="name"]') as HTMLInputElement;
    const value = form.querySelector('[name="value"]') as HTMLInputElement;
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    name.value = 'stripe_key';
    value.value = 'sk_secret_must_never_appear';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(1);

    expect(confirmCalls).toEqual([{ confirmLabel: 'Save secret' }]);
    expect(form.getAttribute('aria-busy')).toBe('true');
    expect(name.disabled).toBe(true);
    expect(value.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe('Saving…');
    const puts = fetchCalls.filter(
      (call) => call.init?.method === 'PUT' && /\/owner\/secrets\/stripe_key$/.test(call.url),
    );
    expect(puts).toHaveLength(1);
    expect(String(puts[0]?.init?.body)).toContain('sk_secret_must_never_appear');

    resolveSave?.(json({ status: 'created' }));
    await flush();
    expect(form.getAttribute('aria-busy')).toBeNull();
    expect(name.disabled).toBe(false);
    expect(value.disabled).toBe(false);
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe('Save secret');
  });

  it('owner-secret save timeout refreshes metadata before another blind overwrite', async () => {
    let saved = false;
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fallback = makeRouter({
      overview: { accounts: { active: 1, suspended: 0, total: 1 }, webhooks: { dlq_depth: 0 } },
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route(call) {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/admin\/owner\/secrets$/.test(call.url) && method === 'GET') {
          return json({
            enabled: true,
            secrets: saved
              ? [
                  {
                    name: 'stripe_key',
                    description: 'billing',
                    updated_at: '2026-07-13T01:00:00.000Z',
                  },
                ]
              : [],
          });
        }
        if (/\/v1\/admin\/owner\/secrets\/stripe_key$/.test(call.url) && method === 'PUT') {
          saved = true;
          return Promise.reject(timeout);
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();

    const form = window.document.querySelector('[data-form="secret-set"]') as HTMLFormElement;
    const name = form.querySelector('[name="name"]') as HTMLInputElement;
    const value = form.querySelector('[name="value"]') as HTMLInputElement;
    name.value = 'stripe_key';
    value.value = 'sk_secret_must_never_appear';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(15);

    expect(fetchCalls.filter((call) => call.init?.method === 'PUT')).toHaveLength(1);
    expect(window.document.querySelector('[data-secret-row="stripe_key"]')).toBeTruthy();
    expect(text(window, '[data-field="secret-set-status"]')).toContain('confirmed');
    expect(value.value).toBe('');
    expect(text(window, '[data-banner]')).toMatch(
      /secret-save outcome is unknown.*metadata was refreshed.*stripe_key.*new version.*save likely completed.*do not overwrite it again.*validate the dependent integration/i,
    );
  });

  it('owner-secret reveal is single-flight, visibly busy, and Hide clears plaintext', async () => {
    let resolveReveal: ((response: Response) => void) | undefined;
    const fallback = makeRouter({
      overview: { accounts: { active: 1, suspended: 0, total: 1 }, webhooks: { dlq_depth: 0 } },
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route(call) {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/admin\/owner\/secrets$/.test(call.url) && method === 'GET') {
          return json({
            enabled: true,
            secrets: [{ name: 'stripe_key', description: 'billing', updated_at: null }],
          });
        }
        if (
          /\/v1\/admin\/owner\/secrets\/stripe_key\/reveal$/.test(call.url) &&
          method === 'POST'
        ) {
          return new Promise<Response>((resolve) => {
            resolveReveal = resolve;
          });
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();
    const button = window.document.querySelector(
      '[data-reveal-secret="stripe_key"]',
    ) as HTMLButtonElement;
    const output = window.document.querySelector(
      '[data-secret-value="stripe_key"]',
    ) as HTMLOutputElement;
    button.click();
    button.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(1);

    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Revealing…');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(
      fetchCalls.filter((call) => /\/owner\/secrets\/stripe_key\/reveal$/.test(call.url)),
    ).toHaveLength(1);

    resolveReveal?.(json({ value: 'sk_plaintext' }));
    await flush();
    expect(output.textContent).toBe('sk_plaintext');
    expect(output.classList.contains('hidden')).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Hide');
    expect(button.getAttribute('aria-busy')).toBeNull();

    button.click();
    expect(output.textContent).toBe('');
    expect(output.classList.contains('hidden')).toBe(true);
    expect(button.textContent).toBe('Reveal');
  });

  it('owner-secret delete is destructive-confirmed, single-flight, and visibly busy', async () => {
    let resolveDelete: ((response: Response) => void) | undefined;
    const confirmCalls: unknown[] = [];
    const fallback = makeRouter({
      overview: { accounts: { active: 1, suspended: 0, total: 1 }, webhooks: { dlq_depth: 0 } },
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      confirmCalls,
      route(call) {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/admin\/owner\/secrets$/.test(call.url) && method === 'GET') {
          return json({
            enabled: true,
            secrets: [
              { name: 'stripe_key', description: 'billing', updated_at: '2026-07-12T18:00:00Z' },
            ],
          });
        }
        if (/\/v1\/admin\/owner\/secrets\/stripe_key$/.test(call.url) && method === 'DELETE') {
          return new Promise<Response>((resolve) => {
            resolveDelete = resolve;
          });
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();
    const button = window.document.querySelector(
      '[data-delete-secret="stripe_key"]',
    ) as HTMLButtonElement;

    button.click();
    await flush(1);
    button.click();

    expect(confirmCalls).toEqual([{ confirmLabel: 'Delete secret', destructive: true }]);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Deleting…');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(
      fetchCalls.filter(
        (call) => call.init?.method === 'DELETE' && /\/owner\/secrets\/stripe_key$/.test(call.url),
      ),
    ).toHaveLength(1);

    resolveDelete?.(new Response(null, { status: 204 }));
    await flush();
  });

  it('serializes delete against reveal and replacement save across the secret surface', async () => {
    let resolveDelete: ((response: Response) => void) | undefined;
    const fallback = makeRouter({
      overview: { accounts: { active: 1, suspended: 0, total: 1 }, webhooks: { dlq_depth: 0 } },
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route(call) {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/admin\/owner\/secrets$/.test(call.url) && method === 'GET') {
          return json({
            enabled: true,
            secrets: [
              { name: 'stripe_key', description: 'billing', updated_at: '2026-07-12T18:00:00Z' },
            ],
          });
        }
        if (/\/v1\/admin\/owner\/secrets\/stripe_key$/.test(call.url) && method === 'DELETE') {
          return new Promise<Response>((resolve) => {
            resolveDelete = resolve;
          });
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();
    const deleteButton = window.document.querySelector(
      '[data-delete-secret="stripe_key"]',
    ) as HTMLButtonElement;
    const revealButton = window.document.querySelector(
      '[data-reveal-secret="stripe_key"]',
    ) as HTMLButtonElement;
    const form = window.document.querySelector('[data-form="secret-set"]') as HTMLFormElement;
    const name = form.querySelector('[name="name"]') as HTMLInputElement;
    const value = form.querySelector('[name="value"]') as HTMLInputElement;
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    name.value = 'stripe_key';
    value.value = 'replacement_secret';

    deleteButton.click();
    await flush(1);
    revealButton.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(1);

    expect(revealButton.disabled).toBe(true);
    expect(revealButton.title).toBe('Wait for the active secret action to finish.');
    expect(submit.disabled).toBe(true);
    expect(submit.title).toBe('Wait for the active secret action to finish.');
    expect(fetchCalls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(1);
    expect(fetchCalls.filter((call) => /\/reveal$/.test(call.url))).toHaveLength(0);
    expect(fetchCalls.filter((call) => call.init?.method === 'PUT')).toHaveLength(0);

    resolveDelete?.(new Response(null, { status: 204 }));
    await flush();
    expect(submit.disabled).toBe(false);
    expect(submit.getAttribute('title')).toBeNull();
  });

  it('owner-secret delete timeout refreshes metadata before advising another irreversible delete', async () => {
    let secretPresent = true;
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fallback = makeRouter({
      overview: { accounts: { active: 1, suspended: 0, total: 1 }, webhooks: { dlq_depth: 0 } },
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route(call) {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/admin\/owner\/secrets$/.test(call.url) && method === 'GET') {
          return json({
            enabled: true,
            secrets: secretPresent
              ? [{ name: 'stripe_key', description: 'billing', updated_at: null }]
              : [],
          });
        }
        if (/\/v1\/admin\/owner\/secrets\/stripe_key$/.test(call.url) && method === 'DELETE') {
          secretPresent = false;
          return Promise.reject(timeout);
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();

    (
      window.document.querySelector('[data-delete-secret="stripe_key"]') as HTMLButtonElement
    ).click();
    await flush(15);

    expect(
      fetchCalls.filter(
        (call) => call.init?.method === 'DELETE' && /\/owner\/secrets\/stripe_key$/.test(call.url),
      ),
    ).toHaveLength(1);
    expect(window.document.querySelector('[data-secret-row="stripe_key"]')).toBeNull();
    expect(text(window, '[data-field="secret-set-status"]')).toMatch(
      /secret-deletion outcome is unknown.*metadata was refreshed.*stripe_key.*is absent.*deletion completed.*do not submit it again/i,
    );
  });
});
