// W490.B — drift guard for apps/admin-panel/src/pages/incidents/index.astro.
// V-338 incident list + new-incident form page. Drift here either
// drops the 'Public incidents propagate to status.driftstack.dev'
// SLA-adjacent framing (operators lose context for the public-
// checkbox decision) or breaks the open/resolved split (resolved
// incidents would appear in the open list, hiding the actually-
// urgent ones).
//
//   • V-338 framing pinned + V-338b live-replace evolution.
//   • New-incident form: title + description + severity (3-option
//     default 'major') + affected (comma-split) + public (checkbox
//     default checked).
//   • SEVERITY_BADGE + STATUS_BADGE duplicated frontmatter +
//     inline.
//   • Open vs resolved split: incidents.filter(status !==
//     'resolved') and inverse.
//   • CF Pages mirror framing: '~60 seconds via Hetzner cron + R2
//     (V-295c)'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/incidents/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W490.B apps/admin-panel/src/pages/incidents/index.astro content parity', () => {
  const body = read(LIB);

  it('V-338 + V-338b frame an inert incident shell that becomes authoritative only after a successful live read', () => {
    expect(body).toMatch(
      /\/\/ V-338 — incident form uses client-owned-id PUT \/v1\/admin\/incidents\/:id\.\s*\/\/ SSG renders an inert unavailable list; the inline script replaces it\s*\/\/ only after a successful live read and also handles the create form\./,
    );
    expect(body).toMatch(
      /\/\/ V-338 — wires the new-incident form to idempotent PUT \/v1\/admin\/incidents\/:id\.\s*\/\/ V-338b — also fetches \/v1\/admin\/incidents on mount \+ replaces\s*\/\/ the unavailable list shell with live data\./,
    );
  });

  it("Page-purpose framing pinned: 'Manually post and update status-page incidents. Public entries surface on status.driftstack.dev within ~60 seconds. Every action audit-logged.' — pinned so the ~60s SLA-adjacent propagation framing survives + the audit-log invariant stays explicit", () => {
    expect(body).toMatch(
      /Manually post and update status-page incidents\. Public entries surface on\s*status\.driftstack\.dev within ~60 seconds\. Every action audit-logged\./,
    );
  });

  it('CF Pages mirror cadence, Hetzner poller, R2, and audit behavior stay documented without an internal label', () => {
    expect(body).toMatch(
      /Posting an incident writes <code>incident\.created<\/code> to the admin audit log\.\s*Public incidents propagate to status\.driftstack\.dev through the Cloudflare Pages mirror\s*within about 60 seconds via the Hetzner poller and R2\./,
    );
  });

  it("New-incident form fields: title (required, 'API server elevated 5xx — eu-west-1' placeholder) + description (required textarea, 'Investigating elevated error rate on /v1/sessions/create after 14:02 UTC deploy.' placeholder) + severity 3-option select (Minor/Major default selected/Outage) + affected (text 'api, sessions' placeholder) + public (checkbox default checked) — pinned so the placeholder examples + default severity (major, not minor) + public default (checked, not unchecked) stay consistent", () => {
    expect(body).toMatch(
      /<input\s*id="title"\s*name="title"\s*type="text"\s*required\s*placeholder="API server elevated 5xx — eu-west-1"/,
    );
    expect(body).toMatch(
      /<textarea\s*id="description"\s*name="description"\s*rows="3"\s*required\s*placeholder="Investigating elevated error rate on \/v1\/sessions\/create after 14:02 UTC deploy\."/,
    );
    expect(body).toMatch(/<option value="major" selected>Major<\/option>/);
    expect(body).toMatch(/placeholder="api, sessions"/);
    expect(body).toMatch(/<input\s*id="public"\s*name="public"\s*type="checkbox"\s*checked/);
  });

  it("Affected-components parsing: comma-split + .map(trim) + .filter(length > 0) — pinned so 'api, sessions, ' (trailing space + comma) doesn't produce empty entries in the affected_components array + leading/trailing whitespace gets stripped (drift to bare split(',') would create [' sessions', ''] which the API would reject)", () => {
    expect(body).toMatch(
      /const affected_components = affectedRaw\s*\? affectedRaw\s*\.split\(','\)\s*\.map\(function \(s\) \{\s*return s\.trim\(\);\s*\}\)\s*\.filter\(function \(s\) \{\s*return s\.length > 0;\s*\}\)\s*: \[\];/,
    );
  });

  it('freezes the complete create payload once and retries it byte-for-byte', () => {
    expect(body).toContain("id: 'inc_' + window.crypto.randomUUID()");
    expect(body).toContain("status: 'investigating'");
    expect(body).toContain('affected_components: affected_components');
    expect(body).toContain("public: fd.get('public') === 'on'");
    expect(body).toContain('started_at: new Date().toISOString()');
    expect(body).toContain('body: JSON.stringify(attempt.body)');
  });

  it('Open vs resolved partition is authoritative server state, validated before rebuild', () => {
    expect(body).toContain('state=open&limit=100');
    expect(body).toContain('state=resolved&limit=100');
    expect(body).toContain('function parseListPage(value)');
    expect(body).toContain('rebuild(openPage.data, resolvedPage.data');
    expect(body).not.toMatch(/MOCK_INCIDENTS/);
  });

  it('Static and unavailable states are neutral; only a successful zero-row rebuild may claim all systems operational', () => {
    expect(body).toMatch(/Live incident state unavailable until loaded\./);
    expect(body).toMatch(
      /if \(metadata\.openTotal === 0\) \{\s*html \+=\s*'<div class="dashboard-card text-center text-sm text-tk-ink-3">No open incidents\. All systems operational\.<\/div>';/,
    );
  });

  it('rebuild uses exact aggregate count and discloses bounded-row truncation', () => {
    expect(body).toContain('openCountEl.textContent = String(metadata.openTotal)');
    expect(body).toContain('if (metadata.openTruncated)');
    expect(body).toContain("' of ' +");
    expect(body).toContain('Use the API cursor to review the remainder.');
  });

  it('fetchAndRender uses the shared deadline and keeps signed-out/failure states distinct from verified health', () => {
    expect(body).toMatch(/apiBaseUrl \+ '\/v1\/admin\/incidents\?scope=all&state=open&limit=100'/);
    expect(body).toMatch(
      /if \(!token\) \{\s*renderUnavailable\('Sign in to load live incident state\.'\);\s*showBanner\('Sign in with a staff admin account to see live data\.'\);/,
    );
    expect(body).toContain('const openPage = parseListPage(bodies[0]);');
    expect(body).toContain('const resolvedPage = parseListPage(bodies[1]);');
    expect(body).toMatch(
      /\.catch\(function \(err\) \{[\s\S]*?renderUnavailable\('Could not load live incident state\. Retry before judging health\.'\);\s*var msg = requestErrorMessage\(err, 'network error'\);/,
    );
    expect(body).toMatch(/Access denied — admin scope required\./);
  });

  it("Form validation: !title || !description → 'Title + initial update are required.' error banner via showErr + bail — pinned so empty submissions show inline error (drift to letting the request fly with empty body would 422 from the server + operators get a confusing 'invalid request body' instead of a friendly 'title required' message)", () => {
    expect(body).toMatch(
      /if \(!title \|\| !description\) \{\s*showErr\('Title \+ initial update are required\.'\);\s*return;\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
