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
      /\/\/ V-338 — incident form is now wired to POST \/v1\/admin\/incidents\.\s*\/\/ SSG renders an inert unavailable list; the inline script replaces it\s*\/\/ only after a successful live read and also handles the create form\./,
    );
    expect(body).toMatch(
      /\/\/ V-338 — wires the new-incident form to POST \/v1\/admin\/incidents\.\s*\/\/ V-338b — also fetches \/v1\/admin\/incidents on mount \+ replaces\s*\/\/ the unavailable list shell with live data\./,
    );
  });

  it("Page-purpose framing pinned: 'Manually post and update status-page incidents. Public entries surface on status.driftstack.dev within ~60 seconds. Every action audit-logged.' — pinned so the ~60s SLA-adjacent propagation framing survives + the audit-log invariant stays explicit", () => {
    expect(body).toMatch(
      /Manually post and update status-page incidents\. Public entries surface on\s*\n?\s*status\.driftstack\.dev within ~60 seconds\. Every action audit-logged\./,
    );
  });

  it("CF Pages mirror framing pinned: 'Posting an incident writes incident.created to the admin audit log. Public incidents propagate to status.driftstack.dev (CF Pages mirror) within ~60s via Hetzner cron + R2 (V-295c).' — pinned so the propagation pathway (Hetzner cron → R2 → CF Pages) stays documented for ops (drift to dropping the V-295c reference would hide the slice that owns the propagation)", () => {
    expect(body).toMatch(
      /Posting an incident writes <code>incident\.created<\/code> to the admin audit log\.\s*\n?\s*Public incidents propagate to status\.driftstack\.dev \(CF Pages mirror\) within ~60s\s*\n?\s*via Hetzner cron \+ R2 \(V-295c\)\./,
    );
  });

  it("New-incident form fields: title (required, 'API server elevated 5xx — eu-west-1' placeholder) + description (required textarea, 'Investigating elevated error rate on /v1/sessions/create after 14:02 UTC deploy.' placeholder) + severity 3-option select (Minor/Major default selected/Outage) + affected (text 'api, sessions' placeholder) + public (checkbox default checked) — pinned so the placeholder examples + default severity (major, not minor) + public default (checked, not unchecked) stay consistent", () => {
    expect(body).toMatch(
      /<input\s*\n?\s*id="title"\s*\n?\s*name="title"\s*\n?\s*type="text"\s*\n?\s*required\s*\n?\s*placeholder="API server elevated 5xx — eu-west-1"/,
    );
    expect(body).toMatch(
      /<textarea\s*\n?\s*id="description"\s*\n?\s*name="description"\s*\n?\s*rows="3"\s*\n?\s*required\s*\n?\s*placeholder="Investigating elevated error rate on \/v1\/sessions\/create after 14:02 UTC deploy\."/,
    );
    expect(body).toMatch(/<option value="major" selected>Major<\/option>/);
    expect(body).toMatch(/placeholder="api, sessions"/);
    expect(body).toMatch(
      /<input\s*\n?\s*id="public"\s*\n?\s*name="public"\s*\n?\s*type="checkbox"\s*\n?\s*checked/,
    );
  });

  it("Affected-components parsing: comma-split + .map(trim) + .filter(length > 0) — pinned so 'api, sessions, ' (trailing space + comma) doesn't produce empty entries in the affected_components array + leading/trailing whitespace gets stripped (drift to bare split(',') would create [' sessions', ''] which the API would reject)", () => {
    expect(body).toMatch(
      /const affected_components = affectedRaw\s*\n?\s*\? affectedRaw\s*\n?\s*\.split\(','\)\s*\n?\s*\.map\(function \(s\) \{\s*\n?\s*return s\.trim\(\);\s*\n?\s*\}\)\s*\n?\s*\.filter\(function \(s\) \{\s*\n?\s*return s\.length > 0;\s*\n?\s*\}\)\s*\n?\s*: \[\];/,
    );
  });

  it("Submit payload: title + description + severity + status:'investigating' (hardcoded — UI doesn't let operators pick initial status, since 'identified' or 'monitoring' would be incorrect at create-time) + affected_components + public bool — pinned so the create endpoint always gets 'investigating' as the initial status (drift to letting operators pick would allow incidents to start in a state that doesn't match reality)", () => {
    expect(body).toMatch(
      /body: JSON\.stringify\(\{\s*\n?\s*title: title,\s*\n?\s*description: description,\s*\n?\s*severity: severity,\s*\n?\s*status: 'investigating',\s*\n?\s*affected_components: affected_components,\s*\n?\s*public: isPublic,\s*\n?\s*\}\),/,
    );
  });

  it('Open vs resolved split happens only inside the live rebuild path', () => {
    expect(body).toMatch(
      /const open = items\.filter\(function \(i\) \{\s*return i\.status !== 'resolved';\s*\}\);\s*const resolved = items\.filter\(function \(i\) \{\s*return i\.status === 'resolved';/,
    );
    expect(body).not.toMatch(/MOCK_INCIDENTS/);
  });

  it('Static and unavailable states are neutral; only a successful zero-row rebuild may claim all systems operational', () => {
    expect(body).toMatch(/Live incident state unavailable until loaded\./);
    expect(body).toMatch(
      /if \(open\.length === 0\) \{\s*html \+=\s*'<div class="dashboard-card text-center text-sm text-tk-ink-3">No open incidents\. All systems operational\.<\/div>';/,
    );
  });

  it("rebuild() open-list render: checks open.length === 0 → renders the 'No open incidents. All systems operational.' card + sets data-open-count text; non-empty → maps to openLi rows — pinned so the live-replacement path matches the SSG path's empty-state copy + count-tracking", () => {
    expect(body).toMatch(
      /if \(open\.length === 0\) \{\s*\n?\s*html \+=\s*\n?\s*'<div class="dashboard-card text-center text-sm text-tk-ink-3">No open incidents\. All systems operational\.<\/div>';\s*\n?\s*\} else \{\s*\n?\s*html \+= '<ul class="space-y-3">' \+ open\.map\(openLi\)\.join\(''\) \+ '<\/ul>';\s*\n?\s*\}/,
    );
  });

  it('fetchAndRender uses the shared deadline and keeps signed-out/failure states distinct from verified health', () => {
    expect(body).toMatch(
      /boundedFetch\(\s*apiBaseUrl \+ '\/v1\/admin\/incidents\?scope=all&limit=100',\s*\{ headers: \{ authorization: 'Bearer ' \+ token \} \},\s*controller,/,
    );
    expect(body).toMatch(
      /if \(!token\) \{\s*renderUnavailable\('Sign in to load live incident state\.'\);\s*showBanner\('Sign in with a staff admin account to see live data\.'\);/,
    );
    expect(body).toMatch(
      /latestIncidentItems = body && Array\.isArray\(body\.data\) \? body\.data : \[\];\s*rebuild\(latestIncidentItems\);\s*hideBanner\(\);/,
    );
    expect(body).toMatch(
      /\.catch\(function \(err\) \{[\s\S]*?renderUnavailable\('Could not load live incident state\. Retry before judging health\.'\);\s*var msg = requestErrorMessage\(err, 'network error'\);/,
    );
    expect(body).toMatch(/Access denied — admin scope required\./);
  });

  it("Form validation: !title || !description → 'Title + initial update are required.' error banner via showErr + bail — pinned so empty submissions show inline error (drift to letting the request fly with empty body would 422 from the server + operators get a confusing 'invalid request body' instead of a friendly 'title required' message)", () => {
    expect(body).toMatch(
      /if \(!title \|\| !description\) \{\s*\n?\s*showErr\('Title \+ initial update are required\.'\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
