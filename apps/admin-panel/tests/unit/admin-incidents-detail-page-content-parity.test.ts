// W367.C — drift guard for admin-panel /incidents/[id] (detail)
// page content. V-344. The companion of /incidents (list), which
// W366.C pins. Existing incidents-detail-page-parity test covers
// route + form structure; this guard pins:
//
//   • Frontmatter SEVERITY_BADGE + STATUS_BADGE keys match the
//     incident-{severity,status} taxonomies exactly. STATUS_BADGE
//     covers all 4 values incl. 'resolved'; SEVERITY_BADGE covers
//     all 3.
//   • V-344 wires Post-update + Mark-resolved forms to the live
//     /v1/admin/incidents/:id/updates + /resolve endpoints
//     (registered server-side) — replacing V-295a alert-stubs.
//   • Audit actions 'incident.updated' + 'incident.resolved'
//     emitted by the route (the page promises "every action
//     audit-logged" via the list page; pin the detail's two
//     additional actions here).
//   • Status select default = 'monitoring' (operator is
//     expected to have already progressed from 'investigating').
//   • Resolve-form copy pinned: "stamps resolved_at" + "status
//     page will show a green banner once propagated".
//   • Resolved-incident view hides both forms (isResolved gate).
//   • Back link to /incidents list pinned.
//   • localStorage key ds_web_session_token.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/incidents/[id].astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W367.C admin-panel /incidents/[id] (detail) page content parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);

  it('SEVERITY_BADGE covers all 3 incident-severity values (minor / major / outage)', () => {
    for (const s of ['minor', 'major', 'outage']) {
      expect(body).toMatch(new RegExp(`${s}:\\s*'bg-`));
    }
  });

  it('STATUS_BADGE covers all 4 incident-status values (investigating / identified / monitoring / resolved)', () => {
    for (const s of ['investigating', 'identified', 'monitoring', 'resolved']) {
      expect(body).toMatch(new RegExp(`${s}:\\s*'bg-`));
    }
  });

  it('V-344 POST /v1/admin/incidents/:id/updates + /resolve wired server-side', () => {
    expect(existsSync(ROUTE)).toBe(true);
    expect(route).toContain("'/v1/admin/incidents/:id/updates'");
    expect(route).toContain("'/v1/admin/incidents/:id/resolve'");
    // V-344 — page binds both forms via the same fetch helper.
    expect(body).toMatch(/bind\('add-update-form', '\/updates', true\)/);
    expect(body).toMatch(/bind\('resolve-form', '\/resolve', false\)/);
  });

  it("audit actions 'incident.updated' + 'incident.resolved' emitted by route", () => {
    expect(route).toContain("'incident.updated'");
    expect(route).toContain("'incident.resolved'");
  });

  it("status-select default is 'monitoring' (operator already past 'investigating')", () => {
    expect(body).toMatch(/<option value="monitoring" selected/);
  });

  it('resolve-form copy pinned: "stamps resolved_at" + "green banner once propagated"', () => {
    expect(body).toMatch(/stamps\s*\n?\s*<code>resolved_at<\/code>/);
    expect(body).toMatch(/The status page will show a green banner once propagated/);
  });

  it('resolved-incident view hides the active forms (isResolved gate, SSR-safe)', () => {
    // V-200* — the page is now SSR (prerender = false). The shell can't
    // know the live status at build time, so the Post-update + Mark-
    // resolved forms live in <div data-form-group="active"> (hidden when
    // isResolved) and the Reopen form in <div data-form-group="resolved">
    // (hidden when !isResolved); the inline script flips the .hidden
    // class from the live status. Pin so a future refactor doesn't let
    // operators "un-resolve" by posting more updates to a closed incident.
    expect(body).toMatch(/const isResolved = incident\.status === 'resolved'/);
    expect(body).toMatch(
      /<div data-form-group="active" class:list=\{\[isResolved \? 'hidden' : ''\]\}>/,
    );
    expect(body).toMatch(
      /<div data-form-group="resolved" class:list=\{\[isResolved \? '' : 'hidden'\]\}>/,
    );
    // The inline script toggles both groups from the live status.
    expect(body).toMatch(/document\.querySelector\('\[data-form-group="active"\]'\)/);
    expect(body).toMatch(/document\.querySelector\('\[data-form-group="resolved"\]'\)/);
  });

  it('back-link to /incidents list pinned', () => {
    expect(body).toMatch(
      /<a href="\/incidents" class="text-sm text-tk-accent hover:underline">← Back to incidents<\/a>/,
    );
  });

  it("'Sign in with a staff admin account' gate fires before fetch (no anonymous fallback)", () => {
    expect(body).toMatch(/Sign in with a staff admin account before posting/);
  });

  it('localStorage key ds_web_session_token (admin-panel convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('bounds reads/writes, makes hydration latest-wins, and defers fresh-SSO loading', () => {
    expect(body).toMatch(/const INCIDENT_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(/signal: activeController\.signal/);
    expect(body).toMatch(/if \(loadController\) loadController\.abort\(\)/);
    expect(body).toMatch(/const generation = \+\+loadGeneration;/);
    expect(body).toMatch(/if \(generation !== loadGeneration\) return;/);
    expect(body).toContain('Request timed out. Try again.');
    expect(body).toMatch(
      /document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\)/,
    );
  });

  it('V-344 replaces V-295a alert-stubs framing comment pinned', () => {
    // The previous slice used window.alert() stubs; V-344 wired
    // live endpoints. Pin so a future "let's reuse the alert
    // pattern" softening can't slip in.
    expect(body).toMatch(
      /V-344 — wires Post-update \+ Mark-resolved forms to the live[\s\S]*Replaces\s*\n?\s*\/\/\s*the V-295a alert-stubs/,
    );
  });

  it('notifications use the branded data-banner / showBanner, NOT native alert() (2026-05-29 no-alert-boxes)', () => {
    // The sign-in guard + post-failure notifications were the last two
    // native alert() calls in the admin panel; they now route through the
    // shared role="status" banner. Pin the helper + both call sites, and
    // assert no actual alert() call (matched as a statement, so the
    // explanatory comment mentioning alert() doesn't false-positive).
    expect(body).toMatch(/data-banner/);
    expect(body).toMatch(/function showBanner\(msg, isError\)/);
    // post-failure routes through showBanner(..., true) not alert.
    expect(body).toMatch(/showBanner\(\s*\n?\s*'Post failed: '/);
    // no bare `alert(...)` statement (preceded by whitespace/`{`/`;`, i.e.
    // a call, not the word inside a comment or "alert-stubs"/"alert()").
    expect(body).not.toMatch(/(?:^|[;{}]|\)\s)\s*alert\(/m);
  });

  it('update, resolve, and reopen forms share one incident-wide mutation lease', () => {
    expect(body).toMatch(/let incidentMutationInFlight = false;/);
    expect(body).toMatch(/if \(incidentMutationInFlight\) return false;/);
    expect(body).toMatch(/if \(incidentMutationInFlight\) return;/);
    expect(body).toMatch(/beginIncidentMutation\(submit\)/);
    expect(body).toMatch(/activeSubmit\.setAttribute\('aria-busy', 'true'\)/);
    expect(body).toMatch(/state\.control\.disabled = state\.disabled/);
    expect(body).toMatch(/endIncidentMutation\(submit\)/);
  });
});
