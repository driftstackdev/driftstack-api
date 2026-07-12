// W366.C — drift guard for admin-panel /incidents (list) page
// content. V-338 + V-338b + V-295c. The existing list-page-parity
// test pins frontmatter SEVERITY_BADGE / STATUS_BADGE byte-
// identical to the /incidents/[id] detail page. This guard adds:
//
//   • SEVERITY_BADGE in the inline <script> is byte-identical
//     to the frontmatter SEVERITY_BADGE on this same page (the
//     page duplicates the map across SSG + progressive-
//     enhancement render paths — drift here would show
//     different colours pre- and post-fetch).
//   • Same for STATUS_BADGE.
//   • V-338 POST /v1/admin/incidents + V-338b GET on mount
//     wired against the same route file.
//   • Audit-action `incident.created` is emitted by the route
//     (load-bearing — the page promises "Every action audit-
//     logged" + `incident.created` shows up in the admin audit
//     log).
//   • V-295c "public propagates to status.driftstack.dev within
//     ~60 seconds via Hetzner cron + R2" mechanism pinned —
//     specific, falsifiable claim that a future Cloudflare-only
//     refactor would need to update.
//   • status default = 'investigating' (page POST body).
//   • localStorage ds_web_session_token (admin-panel convention).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/incidents/index.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Normalise whitespace for byte-identical comparison.
function extractFrontmatterBadge(src: string, name: string): string {
  const m = src.match(new RegExp(`const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\};`));
  if (m === null) throw new Error(`frontmatter ${name} literal not found`);
  return m[1]!.replace(/\s+/g, ' ').trim();
}

function extractInlineBadge(src: string, name: string): string {
  const m = src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`));
  if (m === null) throw new Error(`inline ${name} literal not found`);
  return m[1]!.replace(/\s+/g, ' ').trim();
}

describe('W366.C admin-panel /incidents (list) page content parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);

  it('frontmatter SEVERITY_BADGE matches inline-script SEVERITY_BADGE byte-identical', () => {
    // Same const name lives twice on this page (frontmatter +
    // inline script). Drift between them would show different
    // colours pre- vs post-fetch.
    expect(extractInlineBadge(body, 'SEVERITY_BADGE')).toEqual(
      extractFrontmatterBadge(body, 'SEVERITY_BADGE'),
    );
  });

  it('frontmatter STATUS_BADGE matches inline-script STATUS_BADGE byte-identical', () => {
    expect(extractInlineBadge(body, 'STATUS_BADGE')).toEqual(
      extractFrontmatterBadge(body, 'STATUS_BADGE'),
    );
  });

  it('V-338 POST /v1/admin/incidents + V-338b GET on mount wired against the route', () => {
    expect(existsSync(ROUTE)).toBe(true);
    expect(route).toContain("'/v1/admin/incidents'");
    // V-338b — GET on mount with scope=all + limit=100.
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/admin\/incidents\?scope=all&limit=100'/);
    // V-338 — POST handler.
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/admin\/incidents',\s*\{\s*method: 'POST'/s);
  });

  it("audit-action 'incident.created' emitted by the route (page promises 'Every action audit-logged')", () => {
    expect(route).toContain("'incident.created'");
    expect(body).toMatch(/Every action audit-logged/);
  });

  it('V-295c propagation mechanism pinned: status.driftstack.dev within ~60s via Hetzner cron + R2', () => {
    // Falsifiable claim — a future "Cloudflare-only push" or
    // "real-time SSE" refactor must update this copy first.
    expect(body).toMatch(
      /Public incidents propagate to status\.driftstack\.dev \(CF Pages mirror\) within ~60s\s+via Hetzner cron \+ R2 \(V-295c\)/,
    );
  });

  it("status default in POST body is 'investigating' (matches form Severity-major-selected pair)", () => {
    // The form selects Severity=major by default, but the POST
    // body always hard-codes status='investigating' (the operator
    // is expected to transition to identified/monitoring/resolved
    // after the timeline update).
    expect(body).toMatch(/status: 'investigating'/);
  });

  it('localStorage key ds_web_session_token (admin-panel convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('"Sign in with a staff admin account" gate pinned (no fallback to anonymous)', () => {
    // Load-bearing security claim — the form refuses to post
    // when no token is present rather than relying on server
    // 401. A future "let the server 401" softening would
    // weaken the UI affordance.
    expect(body).toMatch(/Sign in with a staff admin account before posting an incident/);
  });

  it('incident creation is synchronous single-flight with accessible busy state', () => {
    expect(body).toMatch(/let postingIncident = false;/);
    expect(body).toMatch(/if \(postingIncident\) return;/);
    expect(body).toMatch(/postingIncident = true;/);
    expect(body).toMatch(/submit\.setAttribute\('aria-busy', 'true'\)/);
    expect(body).toMatch(/\.finally\(function \(\) \{\s*postingIncident = false;/);
  });

  it('CSS class on `Public on status page` checkbox is `checked` by default (status-page-default-public)', () => {
    // The default posture is PUBLIC, not private — pin so a
    // future "default to private" change forces a discussion
    // about discoverability of in-progress incidents.
    expect(body).toMatch(/<input[^>]*id="public"[^>]*checked/);
  });
});
