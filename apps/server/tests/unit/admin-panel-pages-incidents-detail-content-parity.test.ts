// W490.A — drift guard for apps/admin-panel/src/pages/incidents/[id].astro.
// V-344 per-incident detail page with post-update + mark-resolved
// forms. Drift here either drops the resolved-incident form-hiding
// invariant (forms would render on resolved incidents, allowing
// state corruption) or breaks the {/updates,/resolve} URL suffix
// split (post-update would land at /resolve endpoint or vice-versa).
//
//   • V-344 framing pinned + getStaticPaths over MOCK_INCIDENTS.
//   • SEVERITY_BADGE 3-tone (minor amber / major orange / outage
//     red) + STATUS_BADGE 4-tone (investigating amber / identified
//     blue / monitoring indigo / resolved emerald).
//   • Forms hidden when isResolved (status === 'resolved').
//   • bind() helper: shared form-submit handler for both /updates
//     and /resolve endpoints with optional status field.
//   • Private-incident badge (slate-100) for !public.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/incidents/[id].astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W490.A apps/admin-panel/src/pages/incidents/[id].astro content parity', () => {
  const body = read(LIB);

  it("V-344 framing pinned: 'apiBaseUrl exposed to inline script for live form wiring.' + 'wires Post-update + Mark-resolved forms to the live /v1/admin/incidents/:id/{updates,resolve} endpoints. Replaces the V-295a alert-stubs.' — pinned so the V-295a-replacement evolution stays explicit + the URL-suffix split (updates vs resolve) is documented", () => {
    expect(body).toMatch(/\/\/ V-344 — apiBaseUrl exposed to inline script for live form wiring\./);
    expect(body).toMatch(
      /\/\/ V-344 — wires Post-update \+ Mark-resolved forms to the live\s*\n?\s*\/\/ \/v1\/admin\/incidents\/:id\/\{updates,resolve\} endpoints\. Replaces\s*\n?\s*\/\/ the V-295a alert-stubs\./,
    );
  });

  it("getStaticPaths over MOCK_INCIDENTS + Astro.redirect('/incidents') for missing id — pinned so the SSG path enumeration matches the mock data + a stale URL on a removed mock doesn't 404 (redirects back to the list page instead)", () => {
    expect(body).toMatch(
      /export function getStaticPaths\(\) \{\s*\n?\s*return MOCK_INCIDENTS\.map\(\(inc\) => \(\{ params: \{ id: inc\.id \} \}\)\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /if \(!incident\) \{\s*\n?\s*return Astro\.redirect\('\/incidents'\);\s*\n?\s*\}/,
    );
  });

  it("SEVERITY_BADGE 3-tone (minor amber-50 / major orange-50 / outage red-50) + STATUS_BADGE 4-tone (investigating amber-50 / identified blue-50 / monitoring indigo-50 / resolved emerald-50) — pinned so the dual badge taxonomies stay distinct (severity = how bad, status = where in the lifecycle) and don't collide in tone (drift to using emerald for both 'resolved status' AND 'minor severity' would confuse operators)", () => {
    expect(body).toMatch(
      /const SEVERITY_BADGE: Record<string, string> = \{\s*\n?\s*minor: 'bg-amber-50 text-amber-700',\s*\n?\s*major: 'bg-orange-50 text-orange-700',\s*\n?\s*outage: 'bg-red-50 text-red-700',\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /const STATUS_BADGE: Record<string, string> = \{\s*\n?\s*investigating: 'bg-amber-50 text-amber-700',\s*\n?\s*identified: 'bg-blue-50 text-blue-700',\s*\n?\s*monitoring: 'bg-indigo-50 text-indigo-700',\s*\n?\s*resolved: 'bg-emerald-50 text-emerald-700',\s*\n?\s*\};/,
    );
  });

  it("isResolved gate: const isResolved = incident.status === 'resolved' + both Post-update + Mark-resolved forms wrapped in {!isResolved && (<>...</>)} — pinned so the forms hide on resolved incidents (drift to showing them would allow operators to post updates / re-resolve already-resolved incidents, creating audit-log noise + potential state corruption)", () => {
    expect(body).toMatch(/const isResolved = incident\.status === 'resolved';/);
    expect(body).toMatch(/\{\s*\n?\s*!isResolved && \(\s*\n?\s*<>/);
  });

  it("Post-update form: <select id='update-status'> with 3 options (Investigating / Identified / Monitoring [selected]) + required <textarea id='update-message'> — pinned so the form's status enum stays a subset of STATUS_BADGE (no 'resolved' option here — that's the separate resolve form) and the message field is required for an audit-log entry to have content", () => {
    expect(body).toMatch(/<option value="investigating">Investigating<\/option>/);
    expect(body).toMatch(/<option value="identified">Identified<\/option>/);
    expect(body).toMatch(/<option value="monitoring" selected>Monitoring<\/option>/);
    expect(body).toMatch(
      /<textarea\s*\n?\s*id="update-message"\s*\n?\s*name="message"\s*\n?\s*rows="3"\s*\n?\s*required/,
    );
  });

  it('Resolve form framing pinned: \'Posts a final timeline entry with status "resolved" and stamps resolved_at. The status page will show a green banner once propagated.\' — pinned so operators know clicking Resolve does two things atomically: timeline entry + resolved_at stamp (drift to softer framing might suggest the stamp happens later via a cron job)', () => {
    expect(body).toMatch(
      /Posts a final timeline entry with status “resolved” and stamps\s*\n?\s*<code>resolved_at<\/code>\. The status page will show a green banner once propagated\./,
    );
  });

  it("bind(formId, urlSuffix, includeStatus) helper: shared submit handler for both forms; includeStatus controls whether the 'status' field gets pulled from FormData; encodeURIComponent on incidentId — pinned so the same code path handles both forms (drift to per-form duplicate handlers would mean post-update could land at /resolve endpoint if the URL suffixes get swapped — a critical bug)", () => {
    expect(body).toMatch(
      /function bind\(formId, urlSuffix, includeStatus\) \{\s*\n?\s*const form = document\.getElementById\(formId\);\s*\n?\s*if \(!form\) return;/,
    );
    expect(body).toMatch(/bind\('add-update-form', '\/updates', true\);/);
    expect(body).toMatch(/bind\('resolve-form', '\/resolve', false\);/);
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/admin\/incidents\/' \+ encodeURIComponent\(incidentId\) \+ urlSuffix, \{/,
    );
  });

  it("Submit-button state machine: submit.disabled = true + dataset.origText preservation + 'Posting…' label during fetch; on error: re-enable + restore origText (fallback 'Submit') — pinned so failed posts don't leave the button stuck in 'Posting…' forever (UX-locked button is one of the most common ops-tool footguns)", () => {
    expect(body).toMatch(
      /submit\.disabled = true;\s*\n?\s*submit\.dataset\.origText = submit\.textContent \|\| '';\s*\n?\s*submit\.textContent = 'Posting…';/,
    );
    expect(body).toMatch(
      /submit\.disabled = false;\s*\n?\s*submit\.textContent = submit\.dataset\.origText \|\| 'Submit';/,
    );
  });

  it("Private-incident badge: !incident.public → 'private' slate-100 badge alongside severity + status — pinned so internal-only incidents are visually distinguishable from public ones (operators need to know at-a-glance whether their actions affect the status page or stay internal)", () => {
    expect(body).toMatch(
      /\{!incident\.public && \(\s*\n?\s*<span class="inline-flex rounded-full bg-tk-hover px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-tk-ink-2">\s*\n?\s*private\s*\n?\s*<\/span>\s*\n?\s*\)\}/,
    );
  });

  it("Error-detail surfacing: r.json().catch(() => {}).then((b) => Promise.reject(new Error(b.detail || 'HTTP N'))) — pinned so server-returned problem+json detail messages reach the operator's alert (drift to raw 'HTTP 400' would hide the specific validation error like 'message must be at least 10 chars')", () => {
    expect(body).toMatch(
      /return r\s*\n?\s*\.json\(\)\s*\n?\s*\.catch\(function \(\) \{\s*\n?\s*return \{\};\s*\n?\s*\}\)\s*\n?\s*\.then\(function \(b\) \{\s*\n?\s*return Promise\.reject\(new Error\(b\.detail \|\| 'HTTP ' \+ r\.status\)\);\s*\n?\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
