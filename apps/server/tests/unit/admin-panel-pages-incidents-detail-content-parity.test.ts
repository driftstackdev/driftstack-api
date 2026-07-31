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
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/shells/incident-detail.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// `\s*\n?\s*` is AMBIGUOUS: `\s` already matches `\n`, so each group offers the
// engine many ways to split one whitespace run, and chaining seven of them made
// this single assertion backtrack for ~1.9s against a file every sibling
// assertion scans in under 1ms. Under suite load it blew the 10s timeout and
// reddened the whole run intermittently — a false red, not a real drift. A plain
// `\s*` matches exactly the same language with no ambiguity, so the check is
// unchanged and now linear.
function hasSafeMutationErrorBoundary(source: string): boolean {
  return (
    /return r\s*\.json\(\)\s*\.catch\(function \(\) \{\s*return \{\};\s*\}\)\s*\.then\(function \(b\) \{\s*return Promise\.reject\(window\.driftstackResponseError\(r, b\)\);\s*\}\);/.test(
      source,
    ) && !/new Error\(b\.(?:detail|title)/.test(source)
  );
}

describe('W490.A apps/admin-panel/src/pages/incidents/[id].astro content parity', () => {
  const body = read(LIB);

  it("V-344 framing pinned: 'apiBaseUrl exposed to inline script for live form wiring.' + 'wires Post-update + Mark-resolved forms to the live /v1/admin/incidents/:id/{updates,resolve} endpoints. Replaces the V-295a alert-stubs.' — pinned so the V-295a-replacement evolution stays explicit + the URL-suffix split (updates vs resolve) is documented", () => {
    expect(body).toMatch(/\/\/ V-344 — apiBaseUrl exposed to inline script for live form wiring\./);
    expect(body).toMatch(
      /\/\/ V-344 — wires Post-update \+ Mark-resolved forms to the live\s*\n?\s*\/\/ \/v1\/admin\/incidents\/:id\/\{updates,resolve\} endpoints\. Replaces\s*\n?\s*\/\/ the V-295a alert-stubs\./,
    );
  });

  it('Static Pages shell serves arbitrary incident ids via a URL-preserving internal rewrite without SSR', () => {
    expect(body).toMatch(/deterministic static shell/);
    expect(body).toMatch(/internally rewrites\s*\n?\s*\/\/ \/incidents\/<id>/);
    expect(body).toMatch(/without\s*\n?\s*\/\/ a Pages Worker or SSR adapter/);
    expect(body).not.toMatch(/export const prerender = false;/);
    expect(body).not.toMatch(/export function getStaticPaths\(\)/);
    expect(body).not.toMatch(/Astro\.redirect\('\/incidents'\)/);
    expect(body).not.toMatch(/Astro\.params/);
    expect(body).toMatch(/pathParts\.length === 2 && pathParts\[0\] === 'incidents'/);
  });

  it("SEVERITY_BADGE 3-tone (minor amber-50 / major orange-50 / outage red-50) + STATUS_BADGE 4-tone (investigating amber-50 / identified blue-50 / monitoring indigo-50 / resolved emerald-50) — pinned so the dual badge taxonomies stay distinct (severity = how bad, status = where in the lifecycle) and don't collide in tone (drift to using emerald for both 'resolved status' AND 'minor severity' would confuse operators)", () => {
    expect(body).toMatch(
      /const SEVERITY_BADGE: Record<string, string> = \{\s*\n?\s*minor: 'bg-amber-50 text-amber-700',\s*\n?\s*major: 'bg-orange-50 text-orange-700',\s*\n?\s*outage: 'bg-red-50 text-red-700',\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /const STATUS_BADGE: Record<string, string> = \{\s*\n?\s*investigating: 'bg-amber-50 text-amber-700',\s*\n?\s*identified: 'bg-blue-50 text-blue-700',\s*\n?\s*monitoring: 'bg-indigo-50 text-indigo-700',\s*\n?\s*resolved: 'bg-emerald-50 text-emerald-700',\s*\n?\s*\};/,
    );
  });

  it('isResolved gate is shell-safe: both form groups render and live state toggles them after fetch', () => {
    expect(body).toMatch(/const isResolved = incident\.status === 'resolved';/);
    expect(body).toMatch(
      /<div data-form-group="active" class:list=\{\[isResolved \? 'hidden' : ''\]\}>/,
    );
    expect(body).toMatch(
      /<div data-form-group="resolved" class:list=\{\[isResolved \? '' : 'hidden'\]\}>/,
    );
    // The inline script toggles both groups from the live status.
    expect(body).toMatch(
      /const activeGroup = document\.querySelector\('\[data-form-group="active"\]'\);/,
    );
    expect(body).toMatch(
      /const resolvedGroup = document\.querySelector\('\[data-form-group="resolved"\]'\);/,
    );
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
    expect(body).toMatch(/function bind\(formId, urlSuffix, includeStatus\)/);
    expect(body).toMatch(/bind\('add-update-form', '\/updates', true\);/);
    expect(body).toMatch(/bind\('resolve-form', '\/resolve', false\);/);
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/admin\/incidents\/' \+ encodeURIComponent\(incidentId\) \+ urlSuffix, \{/,
    );
  });

  it("Submit-button state machine: submit.disabled = true + dataset.origText preservation + 'Posting…' label during fetch; on error: re-enable + restore origText (fallback 'Submit') — pinned so failed posts don't leave the button stuck in 'Posting…' forever (UX-locked button is one of the most common ops-tool footguns)", () => {
    expect(body).toMatch(/activeSubmit\.dataset\.origText = activeSubmit\.textContent \|\| '';/);
    expect(body).toMatch(/activeSubmit\.textContent = 'Posting…';/);
    expect(body).toMatch(/activeSubmit\.dataset\.origText \|\| 'Submit'/);
  });

  it('Private-incident badge is hidden from the static placeholder and toggled from live incident.public so operators can distinguish internal incidents', () => {
    expect(body).toMatch(/data-field="private-badge"/);
    expect(body).toMatch(/incident\.public \? 'hidden' : ''/);
    expect(body).toMatch(/>\s*\n?\s*private\s*\n?\s*<\/span>/);
    // The inline script toggles the private badge from the live data.
    expect(body).toMatch(
      /const privBadge = document\.querySelector\('\[data-field="private-badge"\]'\);/,
    );
  });

  it('maps bounded problem bodies through the fixed admin error boundary without reflecting server detail', () => {
    expect(hasSafeMutationErrorBoundary(body)).toBe(true);

    const detailReflectingMutant = body.replace(
      'window.driftstackResponseError(r, b)',
      "new Error(b.detail || 'HTTP ' + r.status)",
    );
    expect(detailReflectingMutant).not.toBe(body);
    expect(hasSafeMutationErrorBoundary(detailReflectingMutant)).toBe(false);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
