// W366.C — drift guard for admin-panel /incidents (list) page
// content. V-338 + V-338b + V-295c. The existing list-page-parity
// test pins frontmatter SEVERITY_BADGE / STATUS_BADGE byte-
// identical to the /incidents/[id] detail page. This guard adds:
//
//   • SEVERITY_BADGE + STATUS_BADGE are each defined once in
//     the live-render script. The inert SSG shell deliberately
//     carries no fake incident rows or duplicate badge maps.
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

function extractInlineBadge(src: string, name: string): string {
  const m = src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`));
  if (m === null) throw new Error(`inline ${name} literal not found`);
  return m[1]!.replace(/\s+/g, ' ').trim();
}

describe('W366.C admin-panel /incidents (list) page content parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);

  it('defines SEVERITY_BADGE once in the authoritative live-render script', () => {
    expect(extractInlineBadge(body, 'SEVERITY_BADGE')).toContain("outage: 'bg-red-50");
    expect(body.match(/const SEVERITY_BADGE(?:\s*:[^=]+)?\s*=/g)).toHaveLength(1);
  });

  it('defines STATUS_BADGE once in the authoritative live-render script', () => {
    expect(extractInlineBadge(body, 'STATUS_BADGE')).toContain("resolved: 'bg-emerald-50");
    expect(body.match(/const STATUS_BADGE(?:\s*:[^=]+)?\s*=/g)).toHaveLength(1);
  });

  it('V-338 idempotent PUT + lifecycle-partitioned GETs are wired against the route', () => {
    expect(existsSync(ROUTE)).toBe(true);
    expect(route).toContain("'/v1/admin/incidents'");
    // Lifecycle filtering is server-side before the cap; open_count is exact.
    expect(body).toMatch(/apiBaseUrl \+ '\/v1\/admin\/incidents\?scope=all&state=open&limit=100'/);
    expect(body).toMatch(
      /apiBaseUrl \+ '\/v1\/admin\/incidents\?scope=all&state=resolved&limit=100'/,
    );
    // The browser preallocates one public id and retries it with PUT.
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/admin\/incidents\/' \+ encodeURIComponent\(attempt\.id\), \{\s*method: 'PUT'/s,
    );
  });

  it('bounds reads/writes, aborts superseded retries, and defers SSO hydration', () => {
    expect(body).toMatch(/const INCIDENT_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(/INCIDENT_TIMEOUT_MS,\s*activeController/);
    expect(body).toMatch(/if \(listController\) listController\.abort\(\)/);
    expect(body).toMatch(/const generation = \+\+listGeneration;/);
    expect(body).toMatch(/if \(generation !== listGeneration\) return;/);
    expect(body).toContain('window.driftstackRequestErrorMessage(err, fallback)');
    expect(body).toMatch(
      /document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\)/,
    );
  });

  it("audit-action 'incident.created' emitted by the route (page promises 'Every action audit-logged')", () => {
    expect(route).toContain("'incident.created'");
    expect(body).toMatch(/Every action audit-logged/);
  });

  it('V-295c propagation mechanism pinned: Cloudflare Pages mirror via Hetzner poller + R2', () => {
    // Falsifiable claim — a future "Cloudflare-only push" or
    // "real-time SSE" refactor must update this copy first.
    expect(body).toMatch(
      /Public incidents propagate to status\.driftstack\.dev through the Cloudflare Pages mirror\s+within about 60 seconds via the Hetzner poller and R2/,
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
    expect(body).toMatch(/if \(postingIncident \|\| createAttemptBlocked\) return;/);
    expect(body).toMatch(/postingIncident = true;/);
    expect(body).toMatch(/submit\.setAttribute\('aria-busy', 'true'\)/);
    expect(body).toMatch(/\.finally\(function \(\) \{\s*postingIncident = false;/);
  });

  it('accepts only an exact created/replayed body for the frozen request', () => {
    expect(body).toContain('function parseWriteSuccess(status, value, attempt)');
    expect(body).toContain('function isIncidentUpdate(value)');
    expect(body).toContain('!isIncidentUpdate(value.updates[0])');
    expect(body).not.toContain('value.incident.status !== attempt.body.status');
    expect(body).toContain('value.updates[0].status !== attempt.body.status');
    expect(body).toContain(
      "const expectedOutcome = status === 201 ? 'created' : status === 200 ? 'replayed' : null;",
    );
    expect(body).toContain('value.incident.id !== attempt.id');
    expect(body).toContain('value.incident.started_at !== attempt.body.started_at');
    expect(body).toContain('value.updates[0].message !== attempt.body.description');
  });

  it('retries ambiguous creation with one stable id and exact frozen body', () => {
    expect(body).toContain('let createAttempt = null;');
    expect(body).toContain("id: 'inc_' + window.crypto.randomUUID()");
    expect(body).toContain('started_at: new Date().toISOString()');
    expect(body).toContain('body: JSON.stringify(attempt.body)');
    expect(body).toContain('Retry same request');
    expect(body).toContain('Retries reuse the same incident id and frozen payload.');
    expect(body).not.toContain('latestIncidentItems.some');
  });

  it('CSS class on `Public on status page` checkbox is `checked` by default (status-page-default-public)', () => {
    // The default posture is PUBLIC, not private — pin so a
    // future "default to private" change forces a discussion
    // about discoverability of in-progress incidents.
    expect(body).toMatch(/<input[^>]*id="public"[^>]*checked/);
  });
});
