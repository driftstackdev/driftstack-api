// W297.C — drift guard for /usage page sparkline keys. The page
// renders four mock sparklines keyed on documented metric names
// (navigates, interacts, captures, session_minutes). These names
// must match the documented event taxonomy on the docs/api/usage
// page so a customer reading the sparkline labels finds the
// matching metric definition.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/usage.astro');
const DOCS_USAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/usage.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W297.C /usage page sparkline keys ↔ docs/api/usage parity', () => {
  const dashboard = read(PAGE);
  const docs = read(DOCS_USAGE);

  // Dashboard sparkline keys → docs canonical metric names.
  // The dashboard aggregates state_capture + screenshot_capture into
  // a single "captures" sparkline by design. The docs/api/usage.md
  // page uses the UsageRecordType enum names — SINGULAR forms
  // (`navigate`, `interact`, `session_minute`, `state_capture`,
  // `screenshot_capture`) — which is the canonical wire shape.
  // 2026-06-24 — the fabricated plural-keyed mockSeries generator was
  // removed; the sparkline hooks are the data-spark="…" attributes the
  // live handler targets (singular wire names + the derived "captures").
  const METRIC_PAIRS: Array<{ dashboardKey: string; docsAny: string[] }> = [
    { dashboardKey: 'navigate', docsAny: ['navigate'] },
    { dashboardKey: 'interact', docsAny: ['interact'] },
    { dashboardKey: 'captures', docsAny: ['state_capture', 'screenshot_capture'] },
    { dashboardKey: 'session_minute', docsAny: ['session_minute'] },
  ];

  for (const { dashboardKey, docsAny } of METRIC_PAIRS) {
    it(`/usage page references the ${dashboardKey} sparkline key`, () => {
      expect(dashboard).toMatch(new RegExp(`data-spark="${dashboardKey}"`));
    });

    it(`docs/api/usage.md documents at least one of [${docsAny.join(', ')}]`, () => {
      const hit = docsAny.some((name) => new RegExp(`\\b${name}\\b`).test(docs));
      expect(hit).toBe(true);
    });
  }
});
