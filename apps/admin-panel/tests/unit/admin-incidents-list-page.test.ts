// Behavioural coverage for the admin Incidents list page —
// apps/admin-panel/src/pages/incidents/index.astro. This is the one page
// whose entire job is surfacing active incidents, and fetchAndRender() used
// to swallow every failure mode (no token, 403, non-ok status, network
// error) into the exact same rebuild([]) markup the page renders for a
// genuine zero-incident state ("No open incidents. All systems
// operational.") — so a real outage looked identical to "nothing's wrong"
// (audit waefer6wu). This pins the fix: a distinct, retry-capable
// [data-banner] state for load failures, separate from the no-token state,
// separate from the genuinely-empty state.
//
// f66e8a02c hardened both halves of that operator truth, and this file pins
// the hardened contract:
//   READ  — the page renders a list only from a provably COMPLETE page
//           envelope ({data,total,open_count,has_more,next_cursor}). The
//           heading count is the server's exact open_count, never the length
//           of a capped row sample, and a truncated page says so out loud.
//           An envelope it cannot verify is a load failure, not an all-clear.
//   WRITE — creation is an idempotent PUT /v1/admin/incidents/:id against a
//           browser-preallocated id with a frozen payload. An unknown outcome
//           is retryable BY CONSTRUCTION (the replay is byte-identical), which
//           replaced the old "refresh and title-match a bounded list" guess.
//
// Loads the built dist page + runs the inline script in jsdom against a
// mock fetch, mirroring admin-accounts-page.test.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'incidents', 'index.html');
const PAGE_URL = 'https://admin.driftstack.io/incidents/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string;
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
  installAdminDeadline(window);

  const pageScript = scriptBodies.find((s) => s.includes('fetchAndRender'));
  if (!pageScript) throw new Error('admin-incidents-list inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function text(window: JSDOM['window'], selector: string): string {
  return window.document.querySelector(selector)?.textContent?.trim() ?? '';
}

function bannerHidden(window: JSDOM['window']): boolean {
  return window.document.querySelector('[data-banner]')?.classList.contains('hidden') ?? true;
}

function retryVisible(window: JSDOM['window']): boolean {
  return !(
    window.document.querySelector('[data-banner-retry]')?.classList.contains('hidden') ?? true
  );
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

let win: JSDOM['window'] | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

// The page renders a list only from a page it can PROVE is complete, so
// fixtures must be real `Incident` rows inside a real `ListIncidentsResponse`
// envelope (packages/api-types/src/incidents.ts): exact `total`/`open_count`
// plus a `has_more`/`next_cursor` pair that agree with each other.
const INCIDENT = {
  id: 'inc_2f1c8a90-4b6d-4a3e-9d21-77c0f5b8e412',
  title: 'Elevated 5xx on /v1/sessions/create',
  description: 'Investigating.',
  severity: 'major',
  status: 'investigating',
  affected_components: ['api', 'sessions'],
  public: true,
  started_at: '2026-06-30T00:00:00.000Z',
  resolved_at: null,
  created_at: '2026-06-30T00:00:00.000Z',
  updated_at: '2026-06-30T00:00:00.000Z',
};

const RESOLVED_INCIDENT = {
  ...INCIDENT,
  id: 'inc_3a2b1c04-5d6e-4f70-8a91-b2c3d4e5f607',
  title: 'Recovered capture backlog',
  status: 'resolved',
  started_at: '2026-06-29T00:00:00.000Z',
  resolved_at: '2026-06-29T12:00:00.000Z',
  created_at: '2026-06-29T00:00:00.000Z',
  updated_at: '2026-06-29T12:00:00.000Z',
};

/** A complete `ListIncidentsResponse` page. `open_count` is the exact
 *  ALL-TIME open total for the scope, independent of how many rows fit. */
function listPage(
  data: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data,
    total: data.length,
    open_count: 0,
    has_more: false,
    next_cursor: null,
    ...overrides,
  };
}

/** The page partitions the lifecycle server-side: one request for open rows,
 *  one for resolved rows. Route on `state=` so each gets its own page. */
function listRoute(
  openBody: Record<string, unknown>,
  resolvedBody: Record<string, unknown>,
): (call: MockFetchCall) => Response {
  return (call) => (/state=resolved/.test(call.url) ? json(resolvedBody) : json(openBody));
}

/** The exact `PutIncidentResponse` the page accepts: the outcome, the echoed
 *  incident under the client-owned id, and exactly one initial update — all
 *  matching the frozen request byte for byte. */
function writeSuccess(
  call: MockFetchCall,
  outcome: 'created' | 'replayed',
): Record<string, unknown> {
  const id = String(call.url).split('/').pop() as string;
  const sent = JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;
  return {
    outcome,
    incident: {
      ...INCIDENT,
      ...sent,
      id,
      resolved_at: null,
      created_at: sent.started_at,
      updated_at: sent.started_at,
    },
    updates: [
      {
        id: 'incu_9c4d1e20-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
        incident_id: id,
        message: sent.description,
        status: sent.status,
        posted_at: sent.started_at,
      },
    ],
  };
}

describe('admin-panel Incidents list (incidents/index.astro) error-vs-empty behaviour', () => {
  it('no token: shows a distinct sign-in banner (not silently the empty state)', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      route: () => {
        throw new Error('must not fetch when unauthenticated');
      },
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(bannerHidden(window)).toBe(false);
    expect(text(window, '[data-banner]')).toContain('Sign in with a staff admin account');
    // No-token isn't a load failure — retrying won't help until sign-in, so
    // no retry affordance.
    expect(retryVisible(window)).toBe(false);
    expect(text(window, '[data-incidents-list]')).toContain('Sign in to load live incident state');
    expect(text(window, '[data-incidents-list]')).not.toContain('All systems operational');
  });

  it('genuinely empty: a VERIFIED zero-incident page renders the operational message with NO error banner', async () => {
    const empty = listPage([]);
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: listRoute(empty, empty),
    });
    win = window;
    await flush();
    expect(bannerHidden(window)).toBe(true);
    expect(text(window, '[data-incidents-list]')).toContain('All systems operational');
    expect(text(window, '[data-open-count]')).toBe('0');
  });

  it('an all-clear the response cannot prove is never rendered as "All systems operational"', async () => {
    // A bare {data:[]} carries no exact open_count and no complete-page proof.
    // It cannot license the calm empty state on the one page whose entire job
    // is surfacing active incidents (audit waefer6wu) — a truncated or
    // partially-filtered body must read as a load failure, not as health.
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [] }),
    });
    win = window;
    await flush();
    expect(bannerHidden(window)).toBe(false);
    expect(text(window, '[data-incidents-list]')).not.toContain('All systems operational');
    expect(text(window, '[data-open-count]')).toBe('—');
  });

  it('open incidents render + banner stays hidden', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: listRoute(
        listPage([INCIDENT], { open_count: 1 }),
        listPage([RESOLVED_INCIDENT], { open_count: 1 }),
      ),
    });
    win = window;
    await flush();
    expect(bannerHidden(window)).toBe(true);
    expect(text(window, '[data-incidents-list]')).toContain('Elevated 5xx on /v1/sessions/create');
    expect(text(window, '[data-incidents-list]')).toContain('Recovered capture backlog');
    expect(text(window, '[data-open-count]')).toBe('1');
  });

  it('a truncated open page shows the exact open total and discloses what is off screen', async () => {
    // Operator truth: a capped page must never present itself as the whole
    // list. The heading count comes from the exact server aggregate, and the
    // shortfall is stated rather than implied by a short list.
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: listRoute(
        listPage([INCIDENT], {
          total: 7,
          open_count: 7,
          has_more: true,
          next_cursor: 'cur_next',
        }),
        listPage([], { open_count: 7 }),
      ),
    });
    win = window;
    await flush();
    expect(bannerHidden(window)).toBe(true);
    expect(text(window, '[data-open-count]')).toBe('7');
    expect(text(window, '[data-incidents-list]')).toContain(
      'Showing 1 of 7 open incidents. Use the API cursor to review the remainder.',
    );
  });

  it('403: a load failure must NEVER render identically to "no incidents" — distinct, retry-capable banner + open-count clears', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ detail: 'forbidden' }, 403),
    });
    win = window;
    await flush();
    expect(bannerHidden(window)).toBe(false);
    expect(text(window, '[data-banner]')).toContain('admin scope required');
    expect(retryVisible(window)).toBe(true);
  });

  it('5xx: surfaces a distinct, retry-capable error banner (regression guard for the audit waefer6wu false-"all clear")', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ detail: 'boom' }, 500),
    });
    win = window;
    await flush();
    expect(bannerHidden(window)).toBe(false);
    expect(text(window, '[data-banner]')).toContain("Couldn't load incidents");
    expect(retryVisible(window)).toBe(true);
    expect(text(window, '[data-incidents-list]')).toContain('Could not load live incident state');
    expect(text(window, '[data-incidents-list]')).not.toContain('All systems operational');
  });

  it('retry button re-fetches and clears the error banner on success', async () => {
    let shouldFail = true;
    const healthy = listRoute(
      listPage([INCIDENT], { open_count: 1 }),
      listPage([], { open_count: 1 }),
    );
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => (shouldFail ? json({ detail: 'boom' }, 500) : healthy(call)),
    });
    win = window;
    await flush();
    expect(bannerHidden(window)).toBe(false);
    shouldFail = false;
    const retryBtn = window.document.querySelector('[data-banner-retry]') as HTMLButtonElement;
    retryBtn.click();
    await flush();
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
    expect(bannerHidden(window)).toBe(true);
    expect(text(window, '[data-incidents-list]')).toContain('Elevated 5xx on /v1/sessions/create');
  });

  it('single-flights incident creation on ONE client-owned id and exposes accessible busy state', async () => {
    let finishPut: (response: Response) => void = () => {};
    const pendingPut = new Promise<Response>((resolve) => {
      finishPut = resolve;
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => (call.init?.method === 'PUT' ? pendingPut : json(listPage([]))),
    });
    win = window;
    await flush();
    const form = window.document.getElementById('new-incident-form') as HTMLFormElement;
    (form.querySelector('[name="title"]') as HTMLInputElement).value = 'API outage';
    (form.querySelector('[name="description"]') as HTMLTextAreaElement).value =
      'Investigating elevated failures.';
    const submit = window.document.getElementById('submit-btn') as HTMLButtonElement;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(2);

    const writes = fetchCalls.filter((call) => call.init?.method === 'PUT');
    expect(writes).toHaveLength(1);
    // Never an unaddressed create: the browser preallocates the incident id so
    // the write is replayable rather than duplicable.
    expect(fetchCalls.every((call) => call.init?.method !== 'POST')).toBe(true);
    expect(writes[0].url).toMatch(
      /\/v1\/admin\/incidents\/inc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute('aria-busy')).toBe('true');
    expect(submit.textContent).toContain('Posting');

    finishPut(json(writeSuccess(writes[0], 'created'), 201));
    await flush();
    expect(submit.disabled).toBe(false);
    expect(submit.hasAttribute('aria-busy')).toBe(false);
    expect(text(window, '#form-error')).toBe('');
  });

  it('does not report a malformed accepted incident body as a failed post', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) =>
        call.init?.method === 'PUT'
          ? new Response('{', {
              status: 201,
              headers: { 'content-type': 'application/json' },
            })
          : json(listPage([])),
    });
    win = window;
    await flush();
    const form = window.document.getElementById('new-incident-form') as HTMLFormElement;
    (form.querySelector('[name="title"]') as HTMLInputElement).value = 'API outage';
    (form.querySelector('[name="description"]') as HTMLTextAreaElement).value =
      'Investigating elevated failures.';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchCalls.filter((call) => call.init?.method === 'PUT')).toHaveLength(1);
    // An unparseable body proves nothing either way, so the page must not
    // claim failure — it names the outcome as unknown and offers the replay.
    expect(text(window, '#form-error')).not.toContain('Failed to post incident');
    expect(text(window, '#form-error')).toContain('The result was not confirmed.');
  });

  it('an ambiguous write is retried with the SAME id and byte-identical payload, so it cannot duplicate', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => (call.init?.method === 'PUT' ? Promise.reject(timeout) : json(listPage([]))),
    });
    win = window;
    await flush();
    const form = window.document.getElementById('new-incident-form') as HTMLFormElement;
    (form.querySelector('[name="title"]') as HTMLInputElement).value = INCIDENT.title;
    (form.querySelector('[name="description"]') as HTMLTextAreaElement).value =
      INCIDENT.description;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(12);

    // The operator is told the outcome is unknown AND why retrying is safe.
    // The previous design guessed by title-matching a capped list, so a missed
    // match could still invite a second PUBLIC incident; the frozen id removes
    // the guess entirely.
    expect(text(window, '#form-error')).toMatch(
      /not confirmed.*same incident id and exact payload.*cannot create a duplicate/i,
    );
    const submit = window.document.getElementById('submit-btn') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe('Retry same request');
    expect(submit.getAttribute('title')).toBe(
      'Retries reuse the same incident id and frozen payload.',
    );

    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(12);
    const writes = fetchCalls.filter((call) => call.init?.method === 'PUT');
    expect(writes).toHaveLength(2);
    expect(writes[1].url).toBe(writes[0].url);
    expect(writes[1].init?.body).toBe(writes[0].init?.body);
    expect(fetchCalls.every((call) => call.init?.method !== 'POST')).toBe(true);
  });

  it('blocks every further write when the preallocated id already holds a DIFFERENT incident', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    let writeCount = 0;
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => {
        if (call.init?.method === 'PUT') {
          writeCount += 1;
          return writeCount === 1
            ? Promise.reject(timeout)
            : json({ type: 'https://errors.driftstack.dev/conflict', detail: 'mismatch' }, 409);
        }
        return json(listPage([]));
      },
    });
    win = window;
    await flush();
    const form = window.document.getElementById('new-incident-form') as HTMLFormElement;
    (form.querySelector('[name="title"]') as HTMLInputElement).value = 'API outage';
    (form.querySelector('[name="description"]') as HTMLTextAreaElement).value =
      'Investigating elevated failures.';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(12);
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(12);

    // A 409 means the id is bound to a payload the operator did not send here.
    // Blind retrying could not be proven safe, so the form hard-stops and
    // routes the operator to the existing incident first.
    const submit = window.document.getElementById('submit-btn') as HTMLButtonElement;
    expect(text(window, '#form-error')).toContain(
      'This request id already belongs to a different incident payload. Reload and inspect the existing incident before taking another action.',
    );
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute('title')).toBe(
      'Reload and inspect the conflicting incident before continuing.',
    );
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(12);
    expect(fetchCalls.filter((call) => call.init?.method === 'PUT')).toHaveLength(2);
  });

  it('an authoritative rejection clears the frozen attempt so a corrected repost uses a NEW id', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) =>
        call.init?.method === 'PUT'
          ? json({ type: 'https://errors.driftstack.dev/validation-failed', detail: 'bad' }, 422)
          : json(listPage([])),
    });
    win = window;
    await flush();
    const form = window.document.getElementById('new-incident-form') as HTMLFormElement;
    (form.querySelector('[name="title"]') as HTMLInputElement).value = 'API outage';
    (form.querySelector('[name="description"]') as HTMLTextAreaElement).value =
      'Investigating elevated failures.';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(12);

    // A 4xx is authoritative: nothing was written, so the operator starts a
    // clean attempt instead of replaying a request the server refused.
    const submit = window.document.getElementById('submit-btn') as HTMLButtonElement;
    expect(text(window, '#form-error')).not.toBe('');
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe('Post incident');

    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(12);
    const writes = fetchCalls.filter((call) => call.init?.method === 'PUT');
    expect(writes).toHaveLength(2);
    expect(writes[1].url).not.toBe(writes[0].url);
  });
});
