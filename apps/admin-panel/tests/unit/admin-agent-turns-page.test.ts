// Behavioural coverage for the admin "AI turns" page —
// apps/admin-panel/src/pages/agent-turns.astro.
//
// Runs the page's OWN inline script, taken from source, in jsdom against a mock
// fetch. Deliberately not the built `dist/` page: what this pins is how the
// script treats the data, and that does not need a build to be current.
//
// The rules under test are the ones that make the page honest at low volume:
//
//   • a rate over nothing renders "—" and NEVER "0.0%";
//   • every rate is shown with what it is a share of;
//   • after a failed load NOTHING stale is left on screen;
//   • no request is sent without a staff bearer;
//   • API strings are escaped before they reach innerHTML.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// jsdom ships no typings in this workspace, so the import is `any`. Its siblings
// each carry this as a counted entry in the pinned test-type backlog; this file
// states it instead, so a new page test does not raise that count. The day
// `@types/jsdom` is installed this directive turns "unused" and says so — which
// is the prompt to restore the three window-assignment directives below.
// @ts-expect-error — no declaration file for 'jsdom' in this workspace
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, '..', '..', 'src', 'pages', 'agent-turns.astro');
const SERVER_SUMMARY = resolve(
  HERE,
  '..',
  '..',
  '..',
  'server',
  'src',
  'services',
  'agent-turn-summary.ts',
);
const SERVER_REPO = resolve(
  HERE,
  '..',
  '..',
  '..',
  'server',
  'src',
  'db',
  'agent-turn-telemetry-repo.ts',
);
const source = readFileSync(SOURCE, 'utf8');

/** A frontmatter `const NAME: Record<string, string> = { … };` as a JS literal. */
function frontmatterObject(name: string): string {
  const match = new RegExp(`const ${name}: Record<string, string> = (\\{[\\s\\S]*?\\n\\});`).exec(
    source,
  );
  if (match?.[1] === undefined) throw new Error(`frontmatter object ${name} not found`);
  return match[1];
}

function pageParts(): { markup: string; script: string } {
  const scriptMatch = /<script is:inline define:vars=\{\{([^}]*)\}\}>([\s\S]*?)<\/script>/.exec(
    source,
  );
  if (scriptMatch?.[2] === undefined) throw new Error('inline script not found');
  const injected = (scriptMatch[1] ?? '').split(',').map((v) => v.trim());
  // Every define:vars name must be one this harness supplies, or the script
  // would run against an undefined and pass for the wrong reason.
  expect(injected.sort()).toEqual(
    ['OUTCOME_LABELS', 'PHASE_LABELS', 'REASON_LABELS', 'apiBaseUrl'].sort(),
  );
  const prelude =
    `const apiBaseUrl = 'https://api.test';\n` +
    `const OUTCOME_LABELS = ${frontmatterObject('OUTCOME_LABELS')};\n` +
    `const REASON_LABELS = ${frontmatterObject('REASON_LABELS')};\n` +
    `const PHASE_LABELS = ${frontmatterObject('PHASE_LABELS')};\n`;
  const markup = source
    .slice(source.indexOf('<AdminLayout'), source.indexOf('<script is:inline'))
    .replace(/<AdminLayout[^>]*>/, '')
    .replace(
      /\{WINDOWS\.map\([\s\S]*?<\/option>\)\}/,
      '<option value="1">1h</option><option value="24" selected>24h</option><option value="168">7d</option>',
    )
    .replace(/\{PAGE_TITLE\}/g, 'AI turns');
  expect(markup).not.toMatch(/\{[A-Z_]+[.}]/); // no Astro expression left unrendered
  return { markup, script: `(function () {\n${prelude}${scriptMatch[2]}\n})();` };
}

const PCT = { p50: null, p95: null };

function summary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    window: { hours: 24, since: '2026-09-17T12:00:00.000Z', until: '2026-09-18T12:00:00.000Z' },
    retention_days: 90,
    requests: { total: 0, by_outcome: { completed: 0, failed: 0, busy_409: 0 } },
    turns: {
      ran: 0,
      decided: 0,
      completed: 0,
      completion_rate: null,
      replan_rate: null,
      avg_replans: null,
      recovered_after_replan: 0,
      avg_model_calls: null,
      step_success_rate: null,
      customer_stopped: 0,
      viewer_disconnected: 0,
    },
    conflicts: { rate_409: null, busy_409_rate: null, busy_409: 0, conflict_409: 0 },
    deaths: [],
    turned_away: [],
    durations_ms: {
      turn: PCT,
      time_to_first_progress: { stream: PCT, all: PCT },
      phases: {
        planning: PCT,
        starting_browser: PCT,
        executing: PCT,
        reading_page: PCT,
        answering: PCT,
      },
      after_turn: PCT,
    },
    tokens: {
      total: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      per_turn: { input: null, output: null, cache_read: null, cache_write: null },
      cache_read_share: null,
    },
    cost: {
      estimated_cents_total: 0,
      estimated_cents_per_turn: null,
      estimated_cents_per_completed_turn: null,
    },
    models: [],
    ...over,
  };
}

const POPULATED = summary({
  requests: { total: 4, by_outcome: { completed: 1, failed: 1, busy_409: 2 } },
  turns: {
    ran: 2,
    decided: 2,
    completed: 1,
    completion_rate: 0.5,
    replan_rate: 0.5,
    avg_replans: 0.5,
    recovered_after_replan: 1,
    avg_model_calls: 2.5,
    step_success_rate: 0.75,
    customer_stopped: 0,
    viewer_disconnected: 0,
  },
  conflicts: { rate_409: 0.5, busy_409_rate: 0.5, busy_409: 2, conflict_409: 0 },
  deaths: [
    {
      reason: 'element_never_appeared_in_retry_budget',
      step_kind: 'interact',
      count: 1,
      share: 1,
    },
  ],
  turned_away: [{ reason: 'turn_in_progress', count: 2, share: 1 }],
  durations_ms: {
    turn: { p50: 12_000, p95: 95_000 },
    time_to_first_progress: { stream: { p50: 300, p95: 6200 }, all: { p50: 300, p95: 6200 } },
    phases: {
      planning: { p50: 4000, p95: 9000 },
      starting_browser: PCT,
      executing: { p50: 7000, p95: 80_000 },
      reading_page: PCT,
      answering: PCT,
    },
    after_turn: { p50: 250, p95: 1300 },
  },
  tokens: {
    total: { input: 4000, output: 800, cache_read: 8000, cache_write: 0 },
    per_turn: { input: 2000, output: 400, cache_read: 4000, cache_write: 0 },
    cache_read_share: 0.6667,
  },
  cost: {
    estimated_cents_total: 4,
    estimated_cents_per_turn: 2,
    estimated_cents_per_completed_turn: 4,
  },
  models: [{ model: 'claude-opus-5', turns: 2 }],
});

interface Call {
  url: string;
  init: RequestInit | undefined;
}

let openWindows: Array<JSDOM['window']> = [];

afterEach(() => {
  for (const w of openWindows) w.close();
  openWindows = [];
});

function mount(opts: { token?: string; route: (call: Call) => Response }): {
  window: JSDOM['window'];
  calls: Call[];
} {
  const { markup, script } = pageParts();
  const virtualConsole = new VirtualConsole();
  const errors: unknown[] = [];
  virtualConsole.on('jsdomError', (e: unknown) => errors.push(e));
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {
    url: 'https://admin.driftstack.io/agent-turns/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  openWindows.push(window);
  const calls: Call[] = [];
  if (typeof window.Response !== 'function') window.Response = Response;
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call = { url: String(input), init };
    calls.push(call);
    try {
      return Promise.resolve(opts.route(call));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
  if (opts.token !== undefined) window.localStorage.setItem('ds_web_session_token', opts.token);
  window.dashboardHydrated = () => {};
  installAdminDeadline(window);
  window.eval(script);
  expect(errors, 'the page script must run without throwing').toEqual([]);
  return { window, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25));
const stat = (w: JSDOM['window'], key: string): string =>
  w.document.querySelector(`[data-stat="${key}"]`)?.textContent ?? '';

describe('admin AI turns page', () => {
  it('sends NO request without a staff bearer, and says so instead of showing numbers', async () => {
    const { window, calls } = mount({ route: () => json(POPULATED) });
    await settle();
    expect(calls).toEqual([]);
    expect(window.document.body.textContent).toContain(
      'Sign in with a staff admin account to load AI turn health.',
    );
    expect(stat(window, 'completionRate')).toBe('—');
    expect(window.document.getElementById('refresh-btn')?.hasAttribute('disabled')).toBe(true);
  });

  it('asks the admin endpoint for the selected window, with the bearer', async () => {
    const { calls } = mount({ token: 'staff-token', route: () => json(POPULATED) });
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.test/v1/admin/agent-turns/summary?window_hours=24');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer staff-token');
  });

  it('CRITICAL an empty window renders "—" for every rate and never "0.0%" — "no turns yet" must not look like "none completed"', async () => {
    const { window } = mount({ token: 't', route: () => json(summary()) });
    await settle();
    for (const key of [
      'completionRate',
      'conflictRate',
      'firstProgressP95',
      'turnTime',
      'replanRate',
      'costPerTurn',
    ]) {
      expect(stat(window, key), key).toBe('—');
    }
    expect(window.document.body.textContent).not.toContain('0.0%');
    expect(stat(window, 'completionBasis')).toBe('No turn reached a verdict in this window.');
    expect(stat(window, 'conflictBasis')).toBe('No requests in this window.');
    expect(window.document.getElementById('deaths-tbody')?.textContent).toContain(
      'No turn died in this window.',
    );
    expect(window.document.getElementById('turned-away-tbody')?.textContent).toContain(
      'No request was turned away in this window.',
    );
  });

  it('shows every rate WITH its denominator, and each death as a sentence plus its raw class', async () => {
    const { window } = mount({ token: 't', route: () => json(POPULATED) });
    await settle();
    expect(stat(window, 'completionRate')).toBe('50.0%');
    expect(stat(window, 'completionBasis')).toBe('1 of 2 turns that reached a verdict');
    expect(stat(window, 'conflictRate')).toBe('50.0%');
    expect(stat(window, 'conflictBasis')).toBe('2 still-running + 0 other, of 4 requests');
    expect(stat(window, 'firstProgressP95')).toBe('6.2 s');
    expect(stat(window, 'turnTime')).toBe('12.0 s / 1.6 min');
    expect(stat(window, 'costPerTurn')).toBe('$0.0200');

    const deaths = window.document.getElementById('deaths-tbody')?.textContent ?? '';
    expect(deaths).toContain('The element was never found inside the retry budget');
    expect(deaths).toContain('element_never_appeared_in_retry_budget');
    expect(deaths).toContain('interact');
    expect(deaths).toContain('100.0%');
    // A 409 is not a task that died: it is listed apart, so it cannot dilute
    // the share of real step deaths.
    expect(deaths).not.toContain('turn_in_progress');
    const turnedAway = window.document.getElementById('turned-away-tbody')?.textContent ?? '';
    expect(turnedAway).toContain('The previous turn on this session was still running');
    expect(turnedAway).toContain('turn_in_progress');
    expect(turnedAway).toContain('2');

    const phases = window.document.getElementById('phases-tbody')?.textContent ?? '';
    expect(phases).toContain('Planning (model)');
    expect(phases).toContain('4.0 s');
    // The route's own work after the AI returned, apart from the model's time.
    expect(phases).toContain('After the turn (saving, settling)');
    expect(phases).toContain('250 ms');
    expect(phases).toContain('1.3 s');
    // A phase no turn entered is "—", not "0 ms".
    expect(phases).not.toMatch(/(?<!\d)0 ms/);

    const tokens = window.document.getElementById('tokens-tbody')?.textContent ?? '';
    expect(tokens).toContain('66.7%');
    expect(tokens).toContain('Turns on claude-opus-5');
  });

  it('CRITICAL after a FAILED refresh nothing stale is left on screen', async () => {
    let fail = false;
    const { window } = mount({
      token: 't',
      route: () => (fail ? json({ title: 'nope' }, 503) : json(POPULATED)),
    });
    await settle();
    expect(stat(window, 'completionRate')).toBe('50.0%');
    fail = true;
    window.document.getElementById('refresh-btn')?.dispatchEvent(new window.Event('click'));
    await settle();
    expect(stat(window, 'completionRate')).toBe('—');
    expect(window.document.body.textContent).not.toContain('50.0%');
    expect(window.document.body.textContent).not.toContain('1 of 2 turns');
    const banner = window.document.getElementById('error-banner');
    expect(banner?.classList.contains('hidden')).toBe(false);
    expect(banner?.textContent).toBe(
      'The admin service is temporarily unavailable. Try again shortly.',
    );
    // The refresh control is released, not left busy.
    expect(window.document.getElementById('refresh-btn')?.getAttribute('aria-busy')).toBe('false');
  });

  it('a transport failure shows fixed copy, never the thrown message', async () => {
    const { window } = mount({
      token: 't',
      route: () => {
        throw new Error('getaddrinfo ENOTFOUND internal-host.example');
      },
    });
    await settle();
    expect(window.document.body.textContent).not.toContain('internal-host');
    expect(window.document.getElementById('error-banner')?.textContent).toBe(
      'Could not load AI turn health. Check your connection and try again.',
    );
  });

  it('changing the window re-fetches for that window', async () => {
    const { window, calls } = mount({ token: 't', route: () => json(POPULATED) });
    await settle();
    const select = window.document.getElementById('window-hours') as HTMLSelectElement;
    select.value = '168';
    select.dispatchEvent(new window.Event('change'));
    await settle();
    expect(calls.at(-1)?.url).toContain('window_hours=168');
  });

  it('escapes API strings before they reach innerHTML', async () => {
    const hostile = summary({
      requests: { total: 1, by_outcome: { '<img src=x onerror=alert(1)>': 1 } },
      deaths: [{ reason: '<script>alert(1)</script>', step_kind: '<b>x</b>', count: 1, share: 1 }],
      turned_away: [{ reason: '<u>away</u>', count: 1, share: 1 }],
      models: [{ model: '<i>m</i>', turns: 1 }],
    });
    const { window } = mount({ token: 't', route: () => json(hostile) });
    await settle();
    expect(window.document.querySelector('#deaths-tbody script')).toBeNull();
    expect(window.document.querySelector('#deaths-tbody b')).toBeNull();
    expect(window.document.querySelector('#turned-away-tbody u')).toBeNull();
    expect(window.document.querySelector('#outcomes-tbody img')).toBeNull();
    expect(window.document.querySelector('#tokens-tbody i')).toBeNull();
    expect(window.document.getElementById('deaths-tbody')?.textContent).toContain(
      '<script>alert(1)</script>',
    );
  });

  it('ships a neutral first paint: no number, no "Loading…" claim, controls inert', () => {
    expect(source).toContain('Nothing is shown until the summary loads.');
    expect(source).not.toMatch(/Loading via/);
    expect(source).toMatch(/id="refresh-btn"\s*type="button"\s*disabled\s*aria-disabled="true"/);
    expect(source).toMatch(/id="window-hours"\s*disabled\s*aria-disabled="true"/);
  });

  it('every field the page reads exists on the server’s summary type, so a rename there cannot silently blank a card here', () => {
    const server = readFileSync(SERVER_SUMMARY, 'utf8');
    const repoSource = readFileSync(SERVER_REPO, 'utf8');
    const iface =
      server.slice(
        server.indexOf('export interface AgentTurnSummary'),
        server.indexOf('/** Outcomes that can appear'),
      ) +
      // `p50` / `p95` live on the shared Percentiles shape.
      repoSource.slice(
        repoSource.indexOf('export interface Percentiles'),
        repoSource.indexOf('/** Raw figures for one window'),
      );
    const script = pageParts().script;
    const read = new Set<string>();
    for (const m of script.matchAll(/\b(?:data|t|c|d|tk|requests|phases)\.([A-Za-z_0-9.]+)/g)) {
      for (const part of (m[1] ?? '').split('.')) read.add(part);
    }
    // DOM / JS members the same pattern picks up; everything else must be API.
    for (const notApi of ['el', 'cols', 'innerHTML', 'length', 'map', 'forEach', 'toFixed']) {
      read.delete(notApi);
    }
    expect(read.size).toBeGreaterThan(20);
    const missing = [...read].filter((name) => !new RegExp(`\\b${name}[?]?:`).test(iface)).sort();
    expect(missing, 'field(s) the page reads that the server summary does not declare:').toEqual(
      [],
    );
  });
});
