// Drift guard for apps/admin-panel/src/pages/incidents/[id].astro.
// Pins the V-344 doc-comment + the 3-severity / 4-status badge
// taxonomies + the SSG-from-MOCK_INCIDENTS pattern.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/incidents/[id].astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('admin-panel incidents/[id] content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('V-344 doc-comment framing pinned: apiBaseUrl exposed to inline script for live form wiring. Drift would orphan the engineering anchor for the live-fetch wiring on this page', () => {
    expect(body).toMatch(/\/\/ V-344 — apiBaseUrl exposed to inline script for live form wiring\./);
  });

  it('V-200* SSR pattern pinned: export const prerender = false (Worker serves ANY incident id at request time) + MOCK_INCIDENTS is only a paint-shell fallback (?? placeholder shell keyed by Astro.params.id). The prior getStaticPaths build-time enumeration 404d every REAL incident id (only mock ids had pages), so the incident-management surface was dead for live incidents. Drift back to getStaticPaths would re-introduce that 404.', () => {
    expect(body).toMatch(/export const prerender = false;/);
    expect(body).not.toMatch(/export function getStaticPaths\(\)/);
    expect(body).toMatch(/const incident = MOCK_INCIDENTS\.find\(\(inc\) => inc\.id === id\) \?\?/);
  });

  it('No build-time redirect: the SSR page renders a placeholder shell for non-mock ids (then the inline script populates from GET /v1/admin/incidents/:id) rather than redirecting. Drift back to Astro.redirect would re-couple the page to the build-time mock enumeration.', () => {
    expect(body).not.toMatch(/Astro\.redirect\('\/incidents'\)/);
  });

  it('SEVERITY_BADGE 3-state taxonomy pinned: minor (amber) / major (orange) / outage (red). Drift to dropping any severity would orphan that severity from visual styling + create an at-a-glance ambiguity for ops triage', () => {
    expect(body).toMatch(/minor:\s+'bg-amber-50 text-amber-700'/);
    expect(body).toMatch(/major:\s+'bg-orange-50 text-orange-700'/);
    expect(body).toMatch(/outage:\s+'bg-red-50 text-red-700'/);
  });

  it('STATUS_BADGE 4-state taxonomy pinned: investigating (amber) / identified (blue) / monitoring (indigo) / resolved (emerald). Drift to dropping any state would orphan that lifecycle stage from visual styling', () => {
    expect(body).toMatch(/investigating:\s+'bg-amber-50 text-amber-700'/);
    expect(body).toMatch(/identified:\s+'bg-blue-50 text-blue-700'/);
    expect(body).toMatch(/monitoring:\s+'bg-indigo-50 text-indigo-700'/);
    expect(body).toMatch(/resolved:\s+'bg-emerald-50 text-emerald-700'/);
  });

  it('Back-to-list link pinned: /incidents. Drift to a different path would orphan the navigation breadcrumb', () => {
    expect(body).toMatch(
      /<a href="\/incidents" class="text-sm text-tk-accent hover:underline">← Back to incidents<\/a>/,
    );
  });
});
