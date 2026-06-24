// W364.C — drift guard for admin-panel /leads page deferred-state.
// The page is intentionally a static "coming soon" empty state (no
// progressive-enhancement script) because the /v1/admin/leads endpoint
// is a deferred Tier-3 slice (#72 "Prod wire-up deferred slices").
// It previously SSG-rendered fabricated demo rows with dead /leads/:id
// drill-downs + dead #convert / #archive anchors; those were removed
// because they presented fake records + affordances that went nowhere.
// This guard now pins:
//
//   • Negative server-side guard: NO /v1/admin/leads route is
//     registered. A future "live" wire-up that lands the route
//     without coordinating with this page would leave it silently
//     mock — this guard flips when the endpoint lands.
//   • Page has no inline <script> tag (static-only stance) — a future
//     progressive-enhancement add must come with the /v1/admin/leads
//     endpoint or it's dead code.
//   • NO dead affordances: no /leads/:id drill-down, no #convert /
//     #archive anchors, no mailto: action (all removed — they were
//     wired to nothing).
//   • Honest "coming soon" empty-state copy (no "live" banner).

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/leads.astro');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function allRoutes(): string {
  const out: string[] = [];
  for (const e of readdirSync(ROUTES_DIR)) {
    if (e.endsWith('.ts')) out.push(readFileSync(join(ROUTES_DIR, e), 'utf8'));
  }
  return out.join('\n');
}

describe('W364.C admin-panel /leads deferred-state parity', () => {
  const body = read(PAGE);
  const routes = allRoutes();

  it('negative server-side guard: NO /v1/admin/leads route is registered', () => {
    // #72 deferred slice — when the endpoint lands, this guard
    // will flip + the page should grow a progressive-enhancement
    // script in the same change.
    expect(routes).not.toMatch(/['"]\/v1\/admin\/leads['"]/);
    expect(routes).not.toMatch(/['"]\/v1\/admin\/leads\/[^'"]+['"]/);
  });

  it('page has no inline <script> tag (static-only stance)', () => {
    // A progressive-enhancement script without the underlying
    // endpoint would be dead code that runs every page load.
    expect(body).not.toMatch(/<script[\s>]/);
  });

  it('no dead affordances: no /leads/:id drill-down, no #convert / #archive anchors, no mailto: action', () => {
    // These were wired to nothing (no leads/[id].astro page, no
    // handlers); removed so the page ships no controls that go
    // nowhere. A future re-add must come with real handlers + the
    // /v1/admin/leads endpoint.
    expect(body).not.toMatch(/href={`\/leads\/\$\{lead\.id\}`}/);
    expect(body).not.toMatch(/#convert-/);
    expect(body).not.toMatch(/#archive-/);
    expect(body).not.toMatch(/mailto:/);
  });

  it('honest "coming soon" empty-state copy', () => {
    expect(body).toMatch(/Coming soon/);
    expect(body).toMatch(/Lead capture isn't wired yet/);
  });

  it('page does not advertise a "live" status indicator (no SSG/live banner)', () => {
    // Defensive: no banner / data-loaded / signed-in copy that
    // would imply the page is anything but a placeholder today.
    expect(body).not.toMatch(/Sign in with a staff admin/);
    expect(body).not.toMatch(/Live leads loaded/);
  });
});
