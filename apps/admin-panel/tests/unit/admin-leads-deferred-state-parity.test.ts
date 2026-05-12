// W364.C — drift guard for admin-panel /leads page deferred-state.
// The page is intentionally pure-SSG mock (no progressive-
// enhancement script) because the /v1/admin/leads endpoint is
// a deferred Tier-3 slice (#72 "Prod wire-up deferred slices").
// W338.C already pins the source taxonomy; this guard pins:
//
//   • Negative server-side guard: NO /v1/admin/leads route is
//     registered. A future "live" wire-up that lands the route
//     without coordinating with this page would leave it
//     silently mock.
//   • Page has no inline <script> tag (mock-SSG-only stance) —
//     a future progressive-enhancement add must come with the
//     /v1/admin/leads endpoint or it's dead code.
//   • Per-lead drill-down href pattern (/leads/:id) pinned for
//     when the V-NNN detail page lands.
//   • Convert + Archive are #anchor placeholders (no JS today) —
//     pinned as load-bearing TODO breadcrumbs for the
//     deferred-slice tracking.
//   • mailto: direct-reply link pinned (the only working
//     external action today).
//   • Empty-state copy directs at marketing-site signup intent.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

  it('page has no inline <script> tag (mock-SSG-only stance)', () => {
    // A progressive-enhancement script without the underlying
    // endpoint would be dead code that runs every page load.
    expect(body).not.toMatch(/<script[\s>]/);
  });

  it('per-lead drill-down href pattern (/leads/:id) pinned', () => {
    expect(body).toMatch(/href={`\/leads\/\$\{lead\.id\}`}/);
  });

  it('convert + archive are #anchor placeholders today (no JS handler)', () => {
    // Load-bearing TODO breadcrumbs for the deferred slice.
    expect(body).toMatch(/href={`#convert-\$\{lead\.id\}`}/);
    expect(body).toMatch(/href={`#archive-\$\{lead\.id\}`}/);
    expect(body).toMatch(/Convert to account →/);
    expect(body).toMatch(/Archive/);
  });

  it('mailto: direct-reply link pinned (only working external action today)', () => {
    expect(body).toMatch(/href={`mailto:\$\{lead\.email\}`}/);
    expect(body).toMatch(/Email reply/);
  });

  it('empty-state copy directs at marketing-site signup intent', () => {
    expect(body).toMatch(/No leads yet/);
    expect(body).toMatch(
      /Once the marketing site captures signup intent, leads land here for\s+sales follow-up/,
    );
  });

  it('page does not advertise a "live" status indicator (no SSG/live banner)', () => {
    // Defensive: no banner / data-loaded / signed-in copy that
    // would imply the page is anything but mock today.
    expect(body).not.toMatch(/Sign in with a staff admin/);
    expect(body).not.toMatch(/Live leads loaded/);
  });

  it('source filter dropdown is presentation-only (no onChange handler today)', () => {
    // Inside the <select>, the only attributes are class +
    // <option> children — no data-field / data-action / id
    // attributes that would imply JS wiring.
    const selectMatch = body.match(/<select\b[^>]*>([\s\S]*?)<\/select>/);
    expect(selectMatch).not.toBeNull();
    const tag = selectMatch![0]!;
    expect(tag).not.toMatch(/data-field=/);
    expect(tag).not.toMatch(/onchange=/i);
  });
});
