// Behavioural coverage for the admin Cost page —
// apps/admin-panel/src/pages/cost.astro. Focused on the config-load path,
// where the operator reads the rate card + per-tier thresholds. Pins strict
// response decoding and 2-decimal accounting-unit formatting so malformed
// success payloads can never look like measured zero cost. Loads the built dist page + runs the inline
// script in jsdom against a mock fetch.
//
// NOTE: the admin Cost page reads its bearer from localStorage key
// "ds_web_session_token" — the SAME key the AdminLayout SSO bridge writes and
// every other admin page reads. (It previously read a never-set
// "driftstack:admin_token", so the page always showed "No admin token found";
// the cross-page token-key guard now prevents that drift.)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'cost', 'index.html');
const PAGE_SOURCE_DIR = resolve(HERE, '..', '..', 'src');

/**
 * These cases execute the BUILT page out of the gitignored `dist/`, so they are
 * only as truthful as the last `astro build`. A stale artifact used to surface
 * as a dozen unrelated assertion failures against markup the source no longer
 * produces — which invites the worst possible repair: repinning the assertions
 * onto stale HTML and locking in expectations the product does not have.
 *
 * So establish freshness FIRST and fail once, loudly, with the exact command.
 */
function newestSourceMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtimeMs(full));
    } else {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}
const PAGE_URL = 'https://admin.driftstack.dev/cost/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  adminToken?: string;
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
  if (opts.adminToken !== undefined) {
    window.localStorage.setItem('ds_web_session_token', opts.adminToken);
  }
  // @ts-expect-error — injected by AdminLayout
  window.dashboardHydrated = () => {};
  opts.beforeEval?.(window);

  const deadlineScript = scriptBodies.find((s) => s.includes('driftstackFetchWithDeadline'));
  if (!deadlineScript) throw new Error('admin deadline inline script not found');
  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-cost"'));
  if (!pageScript) throw new Error('admin-cost inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(deadlineScript);
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

const ACCOUNT_A = '11111111-2222-4333-8444-555555555555';
const ACCOUNT_B = '22222222-3333-4444-8555-666666666666';
const NOW = new Date();
const CURRENT_CYCLE = `${NOW.getUTCFullYear().toString().padStart(4, '0')}-${(NOW.getUTCMonth() + 1)
  .toString()
  .padStart(2, '0')}`;

function validConfig(): Record<string, unknown> {
  return {
    rates: {
      computeCentsPerMinute: 0.5,
      storageCentsPerGbMonth: 2,
      egressCentsPerGb: 1,
      emailCentsPerSend: 0.1,
      llmCentsPer1kInputTokens: 0.05,
      llmCentsPer1kOutputTokens: 0.25,
    },
    tierThresholds: {
      api_builder: { softCents: 1550, hardCents: 5000 },
    },
  };
}

function accountRow(id: string): Record<string, unknown> {
  return {
    id: `acc_${id}`,
    email: `${id.slice(0, 8)}@example.test`,
    name: null,
    tier: 'api_builder',
    status: 'active',
    created_at: '2026-07-01T12:00:00.000Z',
    updated_at: '2026-07-01T12:00:00.000Z',
  };
}

function accountsPage(ids: string[]): Record<string, unknown> {
  return { data: ids.map(accountRow), has_more: false, next_cursor: null };
}

interface CostSummaryFixture {
  account_id: string;
  billing_cycle: string;
  tier: string;
  breakdown: {
    computeCents: number;
    storageCents: number;
    egressCents: number;
    emailCents: number;
    llmCents: number;
    totalCents: number;
    thresholdState: 'under-soft' | 'between-soft-and-hard' | 'over-hard';
  };
  thresholds: { softCents: number; hardCents: number };
}

function costSummary(
  accountId: string,
  opts: {
    cycle?: string;
    computeCents?: number;
    softCents?: number;
    hardCents?: number;
    thresholdState?: 'under-soft' | 'between-soft-and-hard' | 'over-hard';
  } = {},
): CostSummaryFixture {
  const computeCents = opts.computeCents ?? 0;
  const softCents = opts.softCents ?? 3000;
  const hardCents = opts.hardCents ?? 5000;
  const thresholdState =
    opts.thresholdState ??
    (computeCents >= hardCents
      ? 'over-hard'
      : computeCents >= softCents
        ? 'between-soft-and-hard'
        : 'under-soft');
  return {
    account_id: accountId,
    billing_cycle: opts.cycle ?? CURRENT_CYCLE,
    tier: 'api_builder',
    breakdown: {
      computeCents,
      storageCents: 0,
      egressCents: 0,
      emailCents: 0,
      llmCents: 0,
      totalCents: computeCents,
      thresholdState,
    },
    thresholds: { softCents, hardCents },
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

describe('admin-panel Cost (cost.astro) config-load behaviour', () => {
  it('BUILD PRECONDITION: the dist artifact under test is newer than admin-panel source', () => {
    expect(
      existsSync(BUILT_PAGE),
      `Missing ${BUILT_PAGE}. Build the admin panel first:\n` +
        `  PUBLIC_API_BASE_URL=https://api.driftstack.dev npm run build --workspace @driftstack/admin-panel`,
    ).toBe(true);
    const builtMs = statSync(BUILT_PAGE).mtimeMs;
    const sourceMs = newestSourceMtimeMs(PAGE_SOURCE_DIR);
    expect(
      builtMs >= sourceMs,
      `Stale dist artifact: ${BUILT_PAGE} was built ${new Date(builtMs).toISOString()} but ` +
        `admin-panel source changed ${new Date(sourceMs).toISOString()}. Every assertion below ` +
        `runs against markup the source no longer produces — REBUILD, do not repin:\n` +
        `  PUBLIC_API_BASE_URL=https://api.driftstack.dev npm run build --workspace @driftstack/admin-panel`,
    ).toBe(true);
  });

  it('keeps the deadline armed while response JSON is pending, then aborts the stalled body', async () => {
    let fireDeadline = () => undefined;
    let clearCalls = 0;
    let requestSignal: AbortSignal | null = null;
    const stalled = new Response('{}');
    Object.defineProperty(stalled, 'json', {
      configurable: true,
      value: () => new Promise<never>(() => undefined),
    });
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        requestSignal = call.init?.signal ?? null;
        return stalled;
      },
      beforeEval: (target) => {
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
    });
    win = window;
    await flush();

    expect(clearCalls).toBe(0);
    expect(requestSignal?.aborted).toBe(false);
    fireDeadline();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('clears the deadline after response JSON settles', async () => {
    let clearCalls = 0;
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: () => json(validConfig()),
      beforeEval: (target) => {
        target.setTimeout = (() => 1) as typeof target.setTimeout;
        target.clearTimeout = (() => {
          clearCalls += 1;
        }) as typeof target.clearTimeout;
      },
    });
    win = window;
    await flush();

    expect(clearCalls).toBe(1);
  });

  it('no admin token: surfaces a missing-admin-token message rather than silently failing', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      route: () => {
        throw new Error('must not fetch without an admin token');
      },
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(text(window, '[data-banner]')).toContain('admin token');
    expect(
      (window.document.querySelector('input[name="account_id"]') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (window.document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (window.document.querySelector('[data-button="export-top-csv"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('config load: renders the rate card and per-tier thresholds at 2-decimal precision', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/cost\/config$/.test(call.url)) {
          return json({
            rates: {
              computeCentsPerMinute: 0.5,
              storageCentsPerGbMonth: 2,
              egressCentsPerGb: 1,
              emailCentsPerSend: 0.1,
              llmCentsPer1kInputTokens: 0.05,
              llmCentsPer1kOutputTokens: 0.25,
            },
            tierThresholds: {
              api_builder: { softCents: 1550, hardCents: 5000 },
            },
          });
        }
        return json({}, 404);
      },
    });
    win = window;
    await flush();
    // Rate card shows the compute rate + unit.
    const rateCard = text(window, '[data-field="rate-card"]');
    expect(rateCard).toContain('0.5');
    expect(rateCard).toContain('cents / minute');
    // Thresholds render at 2 decimals without falsely presenting the
    // internal accounting estimate as customer-facing currency.
    const thresholds = text(window, '[data-field="tier-thresholds"]');
    expect(thresholds).toContain('api_builder');
    expect(thresholds).toContain('soft 15.50 accounting units');
    expect(thresholds).toContain('hard 50.00 accounting units');
    expect(thresholds).not.toContain('$');
    expect(
      fetchCalls.find((call) => /\/v1\/admin\/cost\/config$/.test(call.url))?.init?.signal,
    ).toBeTruthy();
    expect(
      (window.document.querySelector('input[name="account_id"]') as HTMLInputElement).disabled,
    ).toBe(false);
    expect(
      (window.document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (window.document.querySelector('[data-button="export-top-csv"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('uses one 15s timer-cleaned boundary and defers config hydration for fresh SSO', () => {
    const built = readFileSync(BUILT_PAGE, 'utf8');
    expect(built).toContain('COST_REQUEST_TIMEOUT_MS = 15_000');
    expect(built).toContain('Request timed out. Check the connection and try again.');
    expect(built).toMatch(/signal: controller\.signal/);
    expect(built).toContain('window.driftstackFetchWithDeadline(');
    expect(built).toMatch(/window\.clearTimeout\(timeout\)/);
    expect(built).toMatch(
      /document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\)/,
    );
  });

  it('config endpoint error: uses staff-safe service copy without endpoint/status/body leakage', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: () => json({ detail: 'database host db.internal:5432 secret=abc' }, 500),
    });
    win = window;
    await flush();
    const banner = text(window, '[data-banner]');
    expect(banner).toContain('admin service is temporarily unavailable');
    expect(banner).not.toMatch(/\/v1\/|500|db\.internal|secret=abc/);
  });

  it('malformed 200 config fails closed instead of enabling controls or rendering zero values', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: () => json({}),
    });
    win = window;
    await flush();

    expect(text(window, '[data-banner]')).toContain('Could not load cost configuration');
    expect(text(window, '[data-field="rate-card"]')).not.toMatch(/0(?:\.00)?/);
    expect(window.document.querySelector('[data-field="rate-card"] .animate-pulse')).toBeNull();
    expect(
      (window.document.querySelector('input[name="account_id"]') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (window.document.querySelector('[data-button="export-top-csv"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('CRITICAL config endpoint error: Rate Card / Tier Thresholds tiles clear out of the perpetual loading-skeleton animation instead of pulsing forever (audit waefer6wu)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: () => json({ detail: 'boom' }, 500),
    });
    win = window;
    await flush();
    const rateCard = window.document.querySelector('[data-field="rate-card"]');
    const tierThresholds = window.document.querySelector('[data-field="tier-thresholds"]');
    expect(rateCard?.querySelector('.animate-pulse')).toBeNull();
    expect(tierThresholds?.querySelector('.animate-pulse')).toBeNull();
    expect(text(window, '[data-field="rate-card"]')).toContain(
      'admin service is temporarily unavailable',
    );
    expect(text(window, '[data-field="tier-thresholds"]')).toContain(
      'admin service is temporarily unavailable',
    );
  });

  it('no admin token: tiles also clear the skeleton (the authedFetch throw is the same failure path as a non-ok response)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      route: () => {
        throw new Error('must not fetch without an admin token');
      },
    });
    win = window;
    await flush();
    const rateCard = window.document.querySelector('[data-field="rate-card"]');
    const tierThresholds = window.document.querySelector('[data-field="tier-thresholds"]');
    expect(rateCard?.querySelector('.animate-pulse')).toBeNull();
    expect(tierThresholds?.querySelector('.animate-pulse')).toBeNull();
  });

  it('account query: strips the acc_ prefix, fetches the breakdown, and renders total + soft/hard at 2-decimals', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (call.url.includes(`/v1/admin/cost/accounts/${ACCOUNT_A}`)) {
          return json(
            costSummary(ACCOUNT_A, {
              computeCents: 2100,
              softCents: 1550,
              hardCents: 5000,
              thresholdState: 'between-soft-and-hard',
            }),
          );
        }
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    const input = form.querySelector('input[name="account_id"]') as HTMLInputElement;
    input.value = `acc_${ACCOUNT_A}`;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    // The acc_ prefix is stripped before hitting the cost endpoint.
    expect(fetchCalls.some((c) => c.url.includes(`/v1/admin/cost/accounts/${ACCOUNT_A}`))).toBe(
      true,
    );
    const result = text(window, '[data-field="account-result"]');
    expect(result).toContain('21.00 accounting units');
    expect(result).toContain('compute only');
    expect(result).toContain('Unmeasured');
    expect(result).toContain('between-soft-and-hard'); // threshold state badge
    expect(result).toContain('15.50 accounting units');
    expect(result).toContain('50.00 accounting units');
  });

  it('rejects malformed account ids and impossible billing cycles before any cost request', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: () => json(validConfig()),
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    const accountInput = form.querySelector('input[name="account_id"]') as HTMLInputElement;
    const cycleInput = form.querySelector('input[name="billing_cycle"]') as HTMLInputElement;

    accountInput.value = 'acc_not-a-uuid';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(text(window, '[data-banner]')).toContain('acc_<uuid>');

    accountInput.value = `acc_${ACCOUNT_A}`;
    cycleInput.value = '2026-13';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(text(window, '[data-banner]')).toContain('YYYY-MM');
    expect(fetchCalls.filter((call) => call.url.includes('/v1/admin/cost/accounts/'))).toHaveLength(
      0,
    );
  });

  it.each([
    [
      'wrong account identity',
      {
        ...costSummary(ACCOUNT_A, { computeCents: 2100 }),
        account_id: ACCOUNT_B,
      },
    ],
    [
      'wrong billing cycle',
      {
        ...costSummary(ACCOUNT_A, { computeCents: 2100 }),
        billing_cycle: '2026-06',
      },
    ],
    [
      'inconsistent component sum',
      {
        ...costSummary(ACCOUNT_A, { computeCents: 2100 }),
        breakdown: {
          ...costSummary(ACCOUNT_A, { computeCents: 2100 }).breakdown,
          totalCents: 2099,
        },
      },
    ],
    [
      'inconsistent threshold state',
      {
        ...costSummary(ACCOUNT_A, { computeCents: 2100 }),
        breakdown: {
          ...costSummary(ACCOUNT_A, { computeCents: 2100 }).breakdown,
          thresholdState: 'over-hard' as const,
        },
      },
    ],
    [
      'non-compute placeholder reported as measured',
      {
        ...costSummary(ACCOUNT_A, { computeCents: 2100 }),
        breakdown: {
          ...costSummary(ACCOUNT_A, { computeCents: 2100 }).breakdown,
          storageCents: 1,
          totalCents: 2101,
        },
      },
    ],
  ])(
    'malformed 200 account summary (%s) is unavailable, never a plausible total',
    async (_name, payload) => {
      const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
        adminToken: 'admtok',
        route: (call) =>
          call.url.includes(`/v1/admin/cost/accounts/${ACCOUNT_A}`)
            ? json(payload)
            : json(validConfig()),
      });
      win = window;
      await flush();
      const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
      (form.querySelector('input[name="account_id"]') as HTMLInputElement).value =
        `acc_${ACCOUNT_A}`;
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();

      expect(text(window, '[data-banner]')).toContain('Could not load account cost');
      expect(text(window, '[data-field="account-result"]')).toContain(
        'Could not load the current account cost',
      );
      expect(text(window, '[data-field="account-result"]')).not.toContain('21.00 accounting units');
    },
  );

  it('clears a stale account error banner after a later strictly valid account result', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (call.url.includes(`/v1/admin/cost/accounts/${ACCOUNT_A}`)) {
          return json({ detail: 'temporary' }, 503);
        }
        if (call.url.includes(`/v1/admin/cost/accounts/${ACCOUNT_B}`)) {
          return json(costSummary(ACCOUNT_B));
        }
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    const input = form.querySelector('input[name="account_id"]') as HTMLInputElement;
    input.value = `acc_${ACCOUNT_A}`;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(text(window, '[data-banner]')).toContain('temporarily unavailable');

    input.value = `acc_${ACCOUNT_B}`;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(text(window, '[data-banner]')).toBe('');
    expect(window.document.querySelector('[data-banner]')?.classList.contains('hidden')).toBe(true);
    expect(text(window, '[data-field="account-result"]')).toContain(ACCOUNT_B);
  });

  it('account query failure uses staff-safe copy without account id/status/body leakage', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (call.url.includes(`/v1/admin/cost/accounts/${ACCOUNT_A}`)) {
          return json({ detail: 'driver token=secret at node.internal' }, 503);
        }
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    (form.querySelector('input[name="account_id"]') as HTMLInputElement).value = `acc_${ACCOUNT_A}`;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const banner = text(window, '[data-banner]');
    expect(banner).toContain('admin service is temporarily unavailable');
    expect(banner).not.toMatch(/503|node\.internal|token=secret|\/v1\//);
  });

  it('revokes a previous customer breakdown immediately and never leaves it visible after the next query fails', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (call.url.includes(`/v1/admin/cost/accounts/${ACCOUNT_A}`)) {
          return json(
            costSummary(ACCOUNT_A, {
              cycle: '2026-07',
              computeCents: 4321,
              softCents: 10000,
              hardCents: 20000,
            }),
          );
        }
        if (call.url.includes(`/v1/admin/cost/accounts/${ACCOUNT_B}`)) {
          return json({ detail: 'private upstream failure' }, 503);
        }
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    const input = form.querySelector('input[name="account_id"]') as HTMLInputElement;
    input.value = `acc_${ACCOUNT_A}`;
    (form.querySelector('input[name="billing_cycle"]') as HTMLInputElement).value = '2026-07';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(text(window, '[data-field="account-result"]')).toContain(ACCOUNT_A);
    expect(text(window, '[data-field="account-result"]')).toContain('43.21 accounting units');

    input.value = `acc_${ACCOUNT_B}`;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    expect(text(window, '[data-field="account-result"]')).toContain(
      'Loading the current account cost',
    );
    expect(text(window, '[data-field="account-result"]')).not.toContain(ACCOUNT_A);
    await flush();
    const result = text(window, '[data-field="account-result"]');
    expect(result).toContain('Could not load the current account cost');
    expect(result).not.toMatch(/43\.21|503|private upstream/);
    expect(result).not.toContain(ACCOUNT_A);
    expect(result).not.toContain(ACCOUNT_B);
  });

  it('account query 404 + account DOES exist (admin-accounts lookup is 200): "exists but no usage" — distinct from "not found" (audit waefer6wu)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/cost\/accounts\//.test(call.url)) return json({ detail: 'none' }, 404);
        // The existence-check call (GET /v1/admin/accounts/:id) finds a
        // real account.
        if (call.url.includes(`/v1/admin/accounts/acc_${ACCOUNT_A}`)) {
          return json({ id: `acc_${ACCOUNT_A}`, status: 'active' });
        }
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    (form.querySelector('input[name="account_id"]') as HTMLInputElement).value = `acc_${ACCOUNT_A}`;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(text(window, '[data-banner]')).toContain('Account exists but has no usage');
    expect(text(window, '[data-banner]')).not.toContain('not found');
  });

  it('CRITICAL account query 404 + account does NOT exist (admin-accounts lookup also 404s): distinct "not found" message — without this an operator fat-fingering a UUID reads it as "confirmed zero usage" (audit waefer6wu)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/cost\/accounts\//.test(call.url)) return json({ detail: 'none' }, 404);
        // The existence-check call also 404s — the id is simply wrong.
        if (call.url.includes(`/v1/admin/accounts/acc_${ACCOUNT_B}`)) return json({}, 404);
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    (form.querySelector('input[name="account_id"]') as HTMLInputElement).value = `acc_${ACCOUNT_B}`;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(text(window, '[data-banner]')).toContain('not found');
    expect(text(window, '[data-banner]')).not.toContain('no usage');
  });

  it('account query 404 + failed existence probe stays unknown instead of claiming zero usage', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/cost\/accounts\//.test(call.url)) return json({}, 404);
        if (call.url.includes(`/v1/admin/accounts/acc_${ACCOUNT_B}`)) {
          return json({ detail: 'database host db.internal:5432' }, 503);
        }
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    (form.querySelector('input[name="account_id"]') as HTMLInputElement).value = `acc_${ACCOUNT_B}`;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const banner = text(window, '[data-banner]');
    expect(banner).toContain('admin service is temporarily unavailable');
    expect(banner).not.toMatch(/exists but has no usage|not found|503|db\.internal/);
  });

  it('top accounts: two-step fetch (accounts → overview) renders the money table', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/accounts\?/.test(call.url)) {
          return json(accountsPage([ACCOUNT_A]));
        }
        if (/\/v1\/admin\/cost\/overview\?/.test(call.url)) {
          return json({
            summaries: [
              costSummary(ACCOUNT_A, {
                cycle: CURRENT_CYCLE,
                computeCents: 2100,
                softCents: 1550,
                hardCents: 5000,
                thresholdState: 'between-soft-and-hard',
              }),
            ],
          });
        }
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    const btn = window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement;
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
    const top = text(window, '[data-field="top-result"]');
    expect(top).toContain(ACCOUNT_A);
    expect(top).toContain('api_builder');
    expect(top).toContain('21.00 accounting units');
    expect(top).toContain('15.50 accounting units');
    expect(top).toContain('50.00 accounting units');
    expect(top).toContain('compute only');
    expect(
      (window.document.querySelector('[data-button="export-top-csv"]') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('malformed 200 newest-account page is unavailable rather than an honest empty result', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => (/\/v1\/admin\/accounts\?/.test(call.url) ? json({}) : json(validConfig())),
    });
    win = window;
    await flush();
    const refresh = window.document.querySelector(
      '[data-button="refresh-top"]',
    ) as HTMLButtonElement;
    const exportCsv = window.document.querySelector(
      '[data-button="export-top-csv"]',
    ) as HTMLButtonElement;
    refresh.click();
    await flush();

    expect(text(window, '[data-field="top-result"]')).toContain('Could not load top accounts');
    expect(text(window, '[data-field="top-result"]')).not.toMatch(/page is empty|No measured/);
    expect(exportCsv.disabled).toBe(true);
  });

  it('rejects out-of-order newest-account rows before requesting an overview', async () => {
    const outOfOrder = accountsPage([ACCOUNT_A, ACCOUNT_B]);
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) =>
        /\/v1\/admin\/accounts\?/.test(call.url) ? json(outOfOrder) : json(validConfig()),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement).click();
    await flush();

    expect(text(window, '[data-field="top-result"]')).toContain('Could not load top accounts');
    expect(
      fetchCalls.filter((call) => /\/v1\/admin\/cost\/overview\?/.test(call.url)),
    ).toHaveLength(0);
  });

  it('rejects ascending overview summaries and keeps CSV unavailable', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/accounts\?/.test(call.url)) {
          return json(accountsPage([ACCOUNT_B, ACCOUNT_A]));
        }
        if (/\/v1\/admin\/cost\/overview\?/.test(call.url)) {
          return json({
            summaries: [
              costSummary(ACCOUNT_A, { computeCents: 1000 }),
              costSummary(ACCOUNT_B, { computeCents: 2000 }),
            ],
          });
        }
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement).click();
    await flush();

    expect(text(window, '[data-field="top-result"]')).toContain('Could not load top accounts');
    expect(text(window, '[data-field="top-result"]')).not.toContain(ACCOUNT_A);
    expect(
      (window.document.querySelector('[data-button="export-top-csv"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('labels an empty newest-account page honestly and never enables CSV', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) =>
        /\/v1\/admin\/accounts\?/.test(call.url) ? json(accountsPage([])) : json(validConfig()),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement).click();
    await flush();

    expect(text(window, '[data-field="top-result"]')).toContain('newest-account page is empty');
    expect(text(window, '[data-field="top-result"]')).not.toMatch(/platform-wide|zero cost/i);
    expect(
      (window.document.querySelector('[data-button="export-top-csv"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('revokes CSV authority while refreshing and keeps export disabled when the current top-accounts read fails', async () => {
    let accountsReads = 0;
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/accounts\?/.test(call.url)) {
          accountsReads += 1;
          return accountsReads === 1
            ? json(accountsPage([ACCOUNT_A]))
            : json({ detail: 'new failure' }, 503);
        }
        if (/\/v1\/admin\/cost\/overview\?/.test(call.url)) {
          return json({
            summaries: [
              costSummary(ACCOUNT_A, {
                cycle: CURRENT_CYCLE,
                computeCents: 2100,
                softCents: 3000,
                hardCents: 5000,
              }),
            ],
          });
        }
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    const refresh = window.document.querySelector(
      '[data-button="refresh-top"]',
    ) as HTMLButtonElement;
    const exportCsv = window.document.querySelector(
      '[data-button="export-top-csv"]',
    ) as HTMLButtonElement;
    refresh.click();
    await flush();
    expect(exportCsv.disabled).toBe(false);
    expect(text(window, '[data-field="top-result"]')).toContain(ACCOUNT_A);

    refresh.click();
    expect(exportCsv.disabled).toBe(true);
    expect(text(window, '[data-field="top-result"]')).toContain('Loading');
    await flush();
    expect(exportCsv.disabled).toBe(true);
    expect(text(window, '[data-field="top-result"]')).toContain(
      'admin service is temporarily unavailable',
    );
    expect(text(window, '[data-field="top-result"]')).not.toContain(ACCOUNT_A);
  });

  it('top-accounts failures use staff-safe copy without raw endpoint/status/body text', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/accounts\?/.test(call.url)) {
          return json({ detail: 'redis://user:secret@cache.internal' }, 503);
        }
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    const btn = window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement;
    btn.click();
    await flush();
    const top = text(window, '[data-field="top-result"]');
    expect(top).toContain('admin service is temporarily unavailable');
    expect(top).not.toMatch(/\/v1\/|503|redis:|cache\.internal|secret/);
  });

  it('top-accounts overview rate limit uses actionable copy without endpoint/status text', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/accounts\?/.test(call.url)) {
          return json(accountsPage([ACCOUNT_A]));
        }
        if (/\/v1\/admin\/cost\/overview\?/.test(call.url)) return json({ detail: 'slow' }, 429);
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    const btn = window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement;
    btn.click();
    await flush();
    const top = text(window, '[data-field="top-result"]');
    expect(top).toContain('Too many requests. Wait a moment and try again.');
    expect(top).not.toMatch(/\/v1\/|429/);
  });

  it('top-accounts refresh is single-flight and exposes honest progress', async () => {
    let releaseAccounts: (() => void) | undefined;
    const accountsGate = new Promise<void>((resolve) => {
      releaseAccounts = resolve;
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: async (call) => {
        if (/\/v1\/admin\/accounts\?/.test(call.url)) {
          await accountsGate;
          return json(accountsPage([]));
        }
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    const btn = window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement;
    btn.click();
    btn.click();
    await flush(2);
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.textContent?.trim()).toBe('Refreshing…');
    expect(fetchCalls.filter((call) => /\/v1\/admin\/accounts\?/.test(call.url))).toHaveLength(1);
    releaseAccounts?.();
    await flush();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe('false');
    expect(btn.textContent?.trim()).toBe('Refresh');
  });

  it('account lookup is single-flight and exposes honest progress', async () => {
    let releaseQuery: (() => void) | undefined;
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: async (call) => {
        if (call.url.includes(`/v1/admin/cost/accounts/${ACCOUNT_A}`)) {
          await queryGate;
          return json(costSummary(ACCOUNT_A, { cycle: CURRENT_CYCLE }));
        }
        return json(validConfig());
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    (form.querySelector('input[name="account_id"]') as HTMLInputElement).value = `acc_${ACCOUNT_A}`;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(2);
    const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(form.getAttribute('aria-busy')).toBe('true');
    expect(btn.disabled).toBe(true);
    expect(btn.textContent?.trim()).toBe('Querying…');
    expect(
      fetchCalls.filter((call) => call.url.includes(`/v1/admin/cost/accounts/${ACCOUNT_A}`)),
    ).toHaveLength(1);
    releaseQuery?.();
    await flush();
    expect(form.getAttribute('aria-busy')).toBe('false');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent?.trim()).toBe('Query');
  });
});
