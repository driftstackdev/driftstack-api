// W383.A — drift guard for marketing-site StatusBadge.astro component.
// Embedded on every page footer + on /trust/incidents hero. Pins the
// load-bearing V-474 customer-trust claims:
//
//   • V-474 framing pinned in component comment.
//   • Fetches /v1/status from https://api.driftstack.dev (hardcoded
//     production API URL — marketing site only ever hits prod).
//   • 4 status states pinned (operational / degraded / major_outage
//     / unknown) with corresponding labels + dot colors.
//   • 4-second AbortController hard timeout (slow status endpoint
//     doesn't keep the badge spinning forever).
//   • Failure-mode honesty: fetch failure → "Status unavailable"
//     label + slate-300 dot; explicit "nothing is implied about
//     uptime from a fetch error alone" framing.
//   • Anchor href=https://status.driftstack.dev + target="_blank"
//     + rel="noopener noreferrer".
//   • Dot-only accessible names track the resolved live state.
//   • Props: className (override) + withLabel (default true,
//     dot-only when false for header strips).
//   • Initial render: slate-300 dot + "checking…" label.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const COMPONENT = resolve(REPO_ROOT, 'apps/marketing-site/src/components/StatusBadge.astro');
const BUILT_TRUST = resolve(REPO_ROOT, 'apps/marketing-site/dist/trust/index.html');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W383.A marketing-site StatusBadge.astro content parity', () => {
  const body = read(COMPONENT);

  it('V-474 public-status-badge framing pinned', () => {
    expect(body).toMatch(/V-474 — public status badge/);
    expect(body).toMatch(/Embeds anywhere on the marketing site/);
  });

  it('hardcoded production API URL: https://api.driftstack.dev (marketing site only hits prod)', () => {
    expect(body).toMatch(/const apiBaseUrl = 'https:\/\/api\.driftstack\.dev';/);
  });

  it('fetches /v1/status endpoint inline', () => {
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/status'/);
  });

  it('4 status states pinned (operational / degraded / major_outage / unknown)', () => {
    expect(body).toMatch(/case 'operational':/);
    expect(body).toMatch(/case 'degraded':/);
    expect(body).toMatch(/case 'major_outage':/);
    expect(body).toMatch(/case 'unknown':\s*\n?\s*default:/);
  });

  it('4 status labels pinned ("All systems operational" / "Degraded performance" / "Major outage" / "Status unavailable")', () => {
    expect(body).toMatch(/label\.textContent = 'All systems operational';/);
    expect(body).toMatch(/label\.textContent = 'Degraded performance';/);
    expect(body).toMatch(/label\.textContent = 'Major outage';/);
    expect(body).toMatch(/label\.textContent = 'Status unavailable';/);
  });

  it('4 dot colors pinned (emerald-500 / amber-500 / red-500 / slate-300 fallback)', () => {
    expect(body).toMatch(/dot\.classList\.add\('bg-emerald-500'\);/);
    expect(body).toMatch(/dot\.classList\.add\('bg-amber-500'\);/);
    expect(body).toMatch(/dot\.classList\.add\('bg-red-500'\);/);
    expect(body).toMatch(/dot\.classList\.add\('bg-slate-300'\);/);
  });

  it('color-reset list before applying new state (no stale color carry-over)', () => {
    expect(body).toMatch(
      /dot\.classList\.remove\(\s*\n?\s*'bg-slate-300',\s*\n?\s*'bg-emerald-500',\s*\n?\s*'bg-amber-500',\s*\n?\s*'bg-red-500',\s*\n?\s*\);/,
    );
  });

  it('4-second AbortController hard timeout pinned', () => {
    expect(body).toMatch(
      /4-second hard timeout — a slow status endpoint shouldn't keep\s*\n?\s*\/\/\s*the badge spinning forever/,
    );
    expect(body).toMatch(/const controller = new AbortController\(\);/);
    expect(body).toMatch(/window\.setTimeout\(\(\) => controller\.abort\(\), 4000\);/);
    expect(body).toMatch(/signal: controller\.signal/);
  });

  it('failure-mode honesty: "nothing is implied about uptime from a fetch error alone"', () => {
    expect(body).toMatch(
      /if the fetch fails \(CORS, timeout, network\), the\s*\n?\s*\/\/\s*badge falls back to "status unavailable"/,
    );
    expect(body).toMatch(/nothing is implied about uptime from\s*\n?\s*\/\/\s*a fetch error alone/);
  });

  it('anchor is safe and the dot-only accessible name starts in checking state', () => {
    expect(body).toMatch(
      /<a\s*\n?\s*href="https:\/\/status\.driftstack\.dev"\s*\n?\s*target="_blank"\s*\n?\s*rel="noopener noreferrer"/,
    );
    expect(body).toMatch(/aria-label=\{withLabel \? undefined : 'Platform status: checking'\}/);
  });

  it('Props: className override (default empty) + withLabel default true', () => {
    expect(body).toMatch(/className\?: string;/);
    expect(body).toMatch(/withLabel\?: boolean;/);
    expect(body).toMatch(/const \{ className = '', withLabel = true \} = Astro\.props;/);
  });

  it('withLabel=false dot-only variant suitable for header strips (no label rendered)', () => {
    expect(body).toMatch(
      /renders a tighter dot-only variant suitable\s*\n?\s*\*\s*for header strips/,
    );
    expect(body).toMatch(
      /\{withLabel \? <span class="driftstack-status-label" aria-live="polite">checking…<\/span> : null\}/,
    );
  });

  it('single-flights status fetches across multiple component instances', () => {
    expect(body).toContain("const promiseKey = '__driftstackStatusStatePromise'");
    expect(body).toMatch(/if \(!window\[promiseKey\]\)/);
    expect(body).toMatch(/window\[promiseKey\] = fetch\(apiBaseUrl \+ '\/v1\/status'/);
    expect(body).toMatch(/window\[promiseKey\]\.then\(applyState\)/);
  });

  it('publishes resolved state to dot-only accessible names', () => {
    expect(body).toContain("let accessibleState = 'Status unavailable'");
    expect(body).toContain(
      "badge.setAttribute('aria-label', 'Platform status: ' + accessibleState)",
    );
    expect(body).toMatch(/aria-live="polite"/);
  });

  it('initial render: slate-300 dot + "checking…" label (no flicker before fetch settles)', () => {
    expect(body).toMatch(/inline-block h-2 w-2 shrink-0 rounded-full bg-slate-300/);
    expect(body).toMatch(/aria-hidden="true"/);
    expect(body).toMatch(/>\s*checking…\s*</);
  });

  it('reads body.overall_status from the response (V-474 contract)', () => {
    expect(body).toMatch(
      /body && typeof body\.overall_status === 'string'\s*\n?\s*\?\s*body\.overall_status\s*\n?\s*:\s*'unknown'/,
    );
  });

  it('server-side cache framing pinned (30s + cf-edge cache framing)', () => {
    expect(body).toMatch(
      /Cached server-side for 30s by \/v1\/status itself; cf-edge cache\s*\n?\s*\/\/\s*likely extends that/,
    );
  });

  it('class names use driftstack-* prefix (allows page-level styling overrides)', () => {
    expect(body).toMatch(/driftstack-status-badge/);
    expect(body).toMatch(/driftstack-status-dot/);
    expect(body).toMatch(/driftstack-status-label/);
  });

  it('component file exists at canonical path', () => {
    expect(existsSync(COMPONENT)).toBe(true);
  });

  it('built trust page shares one request across both instances and updates dot-only state', async () => {
    const html = read(BUILT_TRUST);
    const scripts = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))
      .map((match) => match[1] ?? '')
      .filter((script) => script.includes('__driftstackStatusStatePromise'));
    expect(scripts).toHaveLength(2);

    const dom = new JSDOM(html, {
      url: 'https://driftstack.dev/trust/',
      runScripts: 'outside-only',
    });
    const dotOnly = dom.window.document.createElement('a');
    dotOnly.className = 'driftstack-status-badge';
    dotOnly.setAttribute('aria-label', 'Platform status: checking');
    dotOnly.innerHTML = '<span class="driftstack-status-dot bg-slate-300"></span>';
    dom.window.document.body.append(dotOnly);

    let fetchCount = 0;
    // @ts-expect-error — deterministic fetch double for the built inline scripts.
    dom.window.fetch = () => {
      fetchCount += 1;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ overall_status: 'degraded' }),
      });
    };
    scripts.forEach((script) => dom.window.eval(script));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise<void>((resolveDone) => dom.window.setTimeout(resolveDone, 0));

    expect(fetchCount).toBe(1);
    expect(
      Array.from(dom.window.document.querySelectorAll('.driftstack-status-label')).every(
        (label) => label.textContent === 'Degraded performance',
      ),
    ).toBe(true);
    expect(dotOnly.getAttribute('aria-label')).toBe('Platform status: Degraded performance');
    dom.window.close();
  });
});
