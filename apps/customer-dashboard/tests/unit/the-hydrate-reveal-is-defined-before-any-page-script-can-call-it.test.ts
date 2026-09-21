// The dashboard's <main> renders at opacity 0 and each page calls
// window.dashboardHydrated() to reveal it — after its primary fetch, or at once
// in its signed-out branch. The reveal used to be DEFINED at the end of <body>,
// after every page's inline script, so a synchronous call (every signed-out
// branch; settings.astro on every load) hit an undefined function and the page
// waited for the 1200ms safety cap instead. Measured before the fix: ~1224ms on
// settings; ~20–170ms on pages whose call waits on a network round-trip.
//
// Two arms. The source-order arm pins WHERE the definition sits (in <head>,
// before <slot />) so a refactor that moves it back fails here, not in a
// browser a week later. The behaviour arm runs the layout's own reveal script
// in jsdom, then a page-style synchronous call from inside <main>, and asserts
// <main> is revealed with the safety timer still pending.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// @ts-expect-error — jsdom ships no types in this workspace; every dashboard page test imports it this way
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');
const PAGES_DIR = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/** The reveal script's body, cut from the layout by its marker attribute. */
function revealScript(layout: string): string {
  const open = layout.indexOf('<script is:inline data-dashboard-hydrate-reveal>');
  expect(open, 'the reveal script carries its marker attribute').toBeGreaterThan(-1);
  const bodyStart = layout.indexOf('>', open) + 1;
  const close = layout.indexOf('</script>', bodyStart);
  expect(close).toBeGreaterThan(bodyStart);
  return layout.slice(bodyStart, close);
}

describe('the hydrate reveal is defined before any page script can call it', () => {
  const layout = read(LAYOUT);

  it('is defined in <head>, before <slot /> parses, and defined exactly once', () => {
    const definedAt = layout.indexOf('window.dashboardHydrated = reveal;');
    const headEnd = layout.indexOf('</head>');
    // The slot TAG on its own line — the head's comments mention `<slot />`
    // too, and a comment is not where the page is rendered.
    const slotAt = layout.search(/\n\s*<slot \/>\s*\n/u);
    expect(definedAt).toBeGreaterThan(-1);
    expect(headEnd).toBeGreaterThan(-1);
    expect(slotAt).toBeGreaterThan(-1);
    expect(definedAt, 'defined inside <head>').toBeLessThan(headEnd);
    expect(definedAt, 'defined before the slotted page').toBeLessThan(slotAt);
    expect(layout.match(/window\.dashboardHydrated = /gu)).toHaveLength(1);
    // The safety cap is still there, and still 1200ms: pages that never
    // call (network down) must not stay blank.
    expect(revealScript(layout)).toContain('setTimeout(reveal, 1200);');
  });

  it('a synchronous call from inside <main> reveals it at once, with the safety timer still pending', () => {
    const script = revealScript(layout);
    const virtualConsole = new VirtualConsole();
    const errors: unknown[] = [];
    virtualConsole.on('jsdomError', (e: unknown) => errors.push(e));
    // The document is built the way the layout builds it: the reveal script
    // in <head>, then <main data-hydrate="pending"> whose page script calls
    // the reveal synchronously — a signed-out branch's shape.
    const html =
      '<!doctype html><html><head><script>' +
      script +
      '</script></head><body>' +
      '<main id="main-content" data-hydrate="pending" style="opacity: 0">' +
      '<script>window.__calledWhile = document.readyState; window.dashboardHydrated();</script>' +
      '</main></body></html>';
    const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole });
    const { window } = dom;
    const main = window.document.querySelector('main');
    expect(errors, 'no script error while running the layout script').toEqual([]);
    expect(main?.getAttribute('data-hydrate')).toBe('ready');
    expect(main?.style.opacity).toBe('1');
    // The page's call happened during parsing — the case the old body-end
    // definition could not serve.
    expect((window as unknown as { __calledWhile: string }).__calledWhile).toBe('loading');
    window.close();
  });

  it('a call that arrives before <main> exists is deferred to the parsed document, not lost', async () => {
    const script = revealScript(layout);
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', () => {});
    const html =
      '<!doctype html><html><head><script>' +
      script +
      '</script><script>window.dashboardHydrated();</script></head><body>' +
      '<main data-hydrate="pending" style="opacity: 0"></main></body></html>';
    const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole });
    // jsdom dispatches DOMContentLoaded after the constructor returns.
    await new Promise<void>((done) => {
      const doc = dom.window.document;
      if (doc.readyState !== 'loading') done();
      else doc.addEventListener('DOMContentLoaded', () => done(), { once: true });
    });
    const main = dom.window.document.querySelector('main');
    expect(main?.getAttribute('data-hydrate')).toBe('ready');
    dom.window.close();
  });

  it('every page that calls the reveal synchronously in its signed-out branch is served by this definition', () => {
    // The population this fix is for: pages whose `if (!token)` branch calls
    // the reveal directly. Each of them now reveals on that call. If a page
    // drops the call, the customer sees the chrome only after the safety
    // cap — so the list is asserted, not sampled.
    const expected = ['api-keys.astro', 'billing.astro', 'usage.astro', 'webhooks.astro'];
    for (const name of expected) {
      const page = read(resolve(PAGES_DIR, name));
      expect(page, `${name} reveals in its signed-out branch`).toMatch(
        /if \(!token\) \{[\s\S]{0,600}?window\.dashboardHydrated\(\);/u,
      );
    }
  });
});
