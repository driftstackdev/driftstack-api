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
}): (c: MockFetchCall) => Response {
  return (call) => {
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
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
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
});
