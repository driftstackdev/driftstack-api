// W522.C — drift guard for apps/marketing-site/src/components/StatusBadge.astro.
// V-474 public status badge. Drift here either changes the API path
// (would create marketing↔/v1/status divergence) or breaks the
// 4-state failure-mode commitment (would mislead users on outage
// transparency).
//
//   • V-474 doc-comment framing + failure-mode (CORS/timeout/network
//     → 'status unavailable' fallback, never imply uptime from fetch
//     error alone).
//   • 30-second cache server-side via /v1/status; cf-edge cache likely
//     extends.
//   • 2-prop interface: className (default '') + withLabel (default true).
//   • Default fallback dot: bg-slate-300 (slate-300 = 'checking…' /
//     'unknown' / fetch-error).
//   • https://status.driftstack.dev anchor with noopener noreferrer
//     + target=_blank + honest dynamic dot-only aria-label.
//   • 4-state applyState: operational (emerald-500 + 'All systems
//     operational') / degraded (amber-500 + 'Degraded performance') /
//     major_outage (red-500 + 'Major outage') / unknown-default
//     (slate-300 + 'Status unavailable').
//   • 4-second hard-timeout via AbortController + window.setTimeout.
//   • apiBaseUrl = https://api.driftstack.dev hardcoded (production).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/components/StatusBadge.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W522.C apps/marketing-site/src/components/StatusBadge.astro content parity', () => {
  const body = read(LIB);

  it("V-474 framing + failure-mode + 30s-cache pinned: 'public status badge. Client-side fetches /v1/status from the production API and renders an operational / degraded / major_outage indicator. Embeds anywhere on the marketing site.' + 'Failure mode: if the fetch fails (CORS, timeout, network), the badge falls back to \"status unavailable\" and links to the future status.driftstack.dev page; nothing is implied about uptime from a fetch error alone.' + 'Cached server-side for 30s by /v1/status itself; cf-edge cache likely extends that.' — pinned so the V-474 anchor + 3-state-indicator + 3-failure-mode (CORS/timeout/network) + nothing-implied-on-fetch-error + 30s-server-side-cache + cf-edge-extends commitment survives", () => {
    expect(body).toMatch(
      /\/\/ V-474 — public status badge\. Client-side fetches \/v1\/status from\s*\n?\s*\/\/ the production API and renders an operational \/ degraded \/\s*\n?\s*\/\/ major_outage indicator\. Embeds anywhere on the marketing site\./,
    );
    expect(body).toMatch(
      /\/\/ Failure mode: if the fetch fails \(CORS, timeout, network\), the\s*\n?\s*\/\/ badge falls back to "status unavailable" and links to the future\s*\n?\s*\/\/ status\.driftstack\.dev page; nothing is implied about uptime from\s*\n?\s*\/\/ a fetch error alone\./,
    );
    expect(body).toMatch(
      /\/\/ Cached server-side for 30s by \/v1\/status itself; cf-edge cache\s*\n?\s*\/\/ likely extends that\./,
    );
  });

  it("2-prop interface framing pinned: 'className?: string' (Optional className override. Defaults to inline pill.) + 'withLabel?: boolean' (When true (default), renders the badge with a textual status label. When false, renders a tighter dot-only variant suitable for header strips.) + default destructure { className = '', withLabel = true } — pinned so the 2-prop interface + className-default-empty + withLabel-default-true + dot-only-variant-for-header-strips commitment survives", () => {
    expect(body).toMatch(/\/\*\* Optional className override\. Defaults to inline pill\. \*\//);
    expect(body).toMatch(/className\?: string;/);
    expect(body).toMatch(
      /\* When true \(default\), renders the badge with a textual status\s*\n?\s*\* label\. When false, renders a tighter dot-only variant suitable\s*\n?\s*\* for header strips\./,
    );
    expect(body).toMatch(/withLabel\?: boolean;/);
    expect(body).toMatch(/const \{ className = '', withLabel = true \} = Astro\.props;/);
  });

  it('apiBaseUrl + status.driftstack.dev anchor framing pinned with honest dot-only checking label and external-link safety', () => {
    expect(body).toMatch(/const apiBaseUrl = 'https:\/\/api\.driftstack\.dev';/);
    expect(body).toMatch(/href="https:\/\/status\.driftstack\.dev"/);
    expect(body).toMatch(/target="_blank"/);
    expect(body).toMatch(/rel="noopener noreferrer"/);
    // S17 2026-07-04 (Lighthouse label-content-name-mismatch): the labeled
    // variant's VISIBLE text is its accessible name; the static aria-label
    // applies only to the dot-only variant (withLabel=false), where it starts
    // with the same checking state as the visible variant.
    expect(body).toMatch(/aria-label=\{withLabel \? undefined : 'Platform status: checking'\}/);
  });

  it("Initial-render dot + 'checking…' label framing pinned: 'driftstack-status-dot inline-block h-2 w-2 shrink-0 rounded-full bg-slate-300' + aria-hidden=\"true\" + '<span class=\"driftstack-status-label\">checking…</span>' (withLabel ? render : null) — pinned so the initial slate-300 dot + checking… loading-state label + aria-hidden-on-dot + withLabel-conditional commitment survives", () => {
    expect(body).toMatch(
      /class="driftstack-status-dot inline-block h-2 w-2 shrink-0 rounded-full bg-slate-300"/,
    );
    expect(body).toMatch(/aria-hidden="true"/);
    expect(body).toMatch(
      /\{withLabel \? <span class="driftstack-status-label" aria-live="polite">checking…<\/span> : null\}/,
    );
  });

  it("4-state applyState switch framing pinned: 'operational' → bg-emerald-500 + 'All systems operational' + 'degraded' → bg-amber-500 + 'Degraded performance' + 'major_outage' → bg-red-500 + 'Major outage' + 'unknown' / default → bg-slate-300 + 'Status unavailable' — pinned so the 4-state Tailwind-color + label commitment survives (drift to a different color or label would create UX-state divergence)", () => {
    expect(body).toMatch(/case 'operational':/);
    expect(body).toMatch(/dot\.classList\.add\('bg-emerald-500'\);/);
    expect(body).toMatch(/if \(label\) label\.textContent = 'All systems operational';/);
    expect(body).toMatch(/case 'degraded':/);
    expect(body).toMatch(/dot\.classList\.add\('bg-amber-500'\);/);
    expect(body).toMatch(/if \(label\) label\.textContent = 'Degraded performance';/);
    expect(body).toMatch(/case 'major_outage':/);
    expect(body).toMatch(/dot\.classList\.add\('bg-red-500'\);/);
    expect(body).toMatch(/if \(label\) label\.textContent = 'Major outage';/);
    expect(body).toMatch(/case 'unknown':\s*\n?\s*default:/);
    expect(body).toMatch(/dot\.classList\.add\('bg-slate-300'\);/);
    expect(body).toMatch(/if \(label\) label\.textContent = 'Status unavailable';/);
    expect(body).toMatch(/let accessibleState = 'Status unavailable';/);
    expect(body).toMatch(/accessibleState = 'All systems operational';/);
    expect(body).toMatch(/accessibleState = 'Degraded performance';/);
    expect(body).toMatch(/accessibleState = 'Major outage';/);
    expect(body).toMatch(
      /if \(!label\) badge\.setAttribute\('aria-label', 'Platform status: ' \+ accessibleState\);/,
    );
  });

  it("Reset-color-classes-before-add framing pinned: 4-classList.remove (bg-slate-300, bg-emerald-500, bg-amber-500, bg-red-500) + '// Reset color classes.' comment — pinned so the reset-before-add pattern (prevents stale color classes from sticking) survives", () => {
    expect(body).toMatch(/\/\/ Reset color classes\./);
    expect(body).toMatch(
      /dot\.classList\.remove\(\s*\n?\s*'bg-slate-300',\s*\n?\s*'bg-emerald-500',\s*\n?\s*'bg-amber-500',\s*\n?\s*'bg-red-500',\s*\n?\s*\);/,
    );
  });

  it('4-second AbortController + shared fetch chain + exact-once finally cleanup + body.overall_status extraction are pinned', () => {
    expect(body).toMatch(
      /\/\/ 4-second hard timeout — a slow status endpoint shouldn't keep\s*\n?\s*\/\/ the badge spinning forever\./,
    );
    expect(body).toMatch(/const controller = new AbortController\(\);/);
    expect(body).toMatch(
      /const timeout = window\.setTimeout\(\(\) => controller\.abort\(\), 4000\);/,
    );
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/status', \{ signal: controller\.signal \}\)/);
    expect(body).toMatch(
      /\.then\(\(r\) => \(r\.ok \? r\.json\(\) : Promise\.reject\(new Error\('HTTP ' \+ r\.status\)\)\)\)/,
    );
    expect(body).toMatch(/\.finally\(\(\) => window\.clearTimeout\(timeout\)\);/);
    expect(body).toMatch(
      /body && typeof body\.overall_status === 'string' \? body\.overall_status : 'unknown'/,
    );
    expect(body).toMatch(/const promiseKey = '__driftstackStatusStatePromise';/);
    expect(body).toMatch(/if \(!window\[promiseKey\]\) \{/);
    expect(body).toMatch(/window\[promiseKey\]\.then\(applyState\);/);
  });

  it("script is:inline + IIFE + early-return-if-no-badges framing pinned: '<script is:inline define:vars={{ apiBaseUrl }}>' + '(function () {' IIFE + 'const badges = document.querySelectorAll(\".driftstack-status-badge\")' + 'if (badges.length === 0) return;' — pinned so the inline-script + define:vars apiBaseUrl pass-through + IIFE-pattern + early-return-on-empty-NodeList commitment survives (drift to non-inline would let CSP block; drift to dropping early-return would error on pages without the badge)", () => {
    expect(body).toMatch(/<script is:inline define:vars=\{\{ apiBaseUrl \}\}>/);
    expect(body).toMatch(/\(function \(\) \{/);
    expect(body).toMatch(
      /const badges = document\.querySelectorAll\('\.driftstack-status-badge'\);/,
    );
    expect(body).toMatch(/if \(badges\.length === 0\) return;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
