// W353.C — drift guard for admin /incidents (list page). The
// companion of /incidents/[id]. The list's live-render script and
// detail shell both define SEVERITY_BADGE + STATUS_BADGE. If they drift,
// the list and the detail
// pages will show different colours for the same severity / status,
// which is a high-confusion bug. Pin them as byte-identical.
//
// Also pinned:
//   • The new-incident form's Severity dropdown lists exactly
//     {minor, major, outage} = IncidentSeveritySchema.
//   • POST /v1/admin/incidents is the registered server route.
//   • The SSG shell is inert/unavailable; only fetched live rows
//     are split by status into open / resolved sections.
//   • Form fields: title (required), description (required),
//     severity (default 'major'), affected components (optional),
//     public checkbox (default checked).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IncidentSeveritySchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/incidents/index.astro');
const DETAIL_PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/shells/incident-detail.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function extractBadge(src: string, name: string): string {
  const m = src.match(new RegExp(`const ${name}(?:\\s*:[^=]+)?\\s*=\\s*\\{([\\s\\S]*?)\\};`));
  if (m === null) throw new Error(`${name} literal not found`);
  // Normalise whitespace for byte-identical comparison.
  return m[1]!.replace(/\s+/g, ' ').trim();
}

describe('W353.C admin /incidents list page parity', () => {
  const body = read(PAGE);
  const detail = read(DETAIL_PAGE);

  it('page file exists at the conventional /incidents path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('SEVERITY_BADGE is byte-identical to /incidents/[id] (no divergent colour maps)', () => {
    expect(extractBadge(body, 'SEVERITY_BADGE')).toEqual(extractBadge(detail, 'SEVERITY_BADGE'));
  });

  it('STATUS_BADGE is byte-identical to /incidents/[id] (no divergent colour maps)', () => {
    expect(extractBadge(body, 'STATUS_BADGE')).toEqual(extractBadge(detail, 'STATUS_BADGE'));
  });

  it('Severity dropdown lists exactly IncidentSeveritySchema values (minor, major, outage)', () => {
    const sel = body.match(/<select[^>]*id="severity"[\s\S]*?<\/select>/);
    expect(sel).not.toBeNull();
    const values = [...sel![0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]!).sort();
    const schema = [
      ...(IncidentSeveritySchema._def as { values: readonly string[] }).values,
    ].sort();
    expect(values).toEqual(schema);
  });

  it("Severity default is 'major' (the most common manual-post case)", () => {
    expect(body).toMatch(/<option value="major" selected/);
  });

  it('POST /v1/admin/incidents is the registered server route', () => {
    const route = read(ROUTE);
    expect(body).toMatch(/POST\s*\/v1\/admin\/incidents|'\/v1\/admin\/incidents'/);
    expect(route).toContain("'/v1/admin/incidents'");
  });

  it('splits only fetched live incidents into open + resolved sections', () => {
    expect(body).toMatch(
      /const open = items\.filter\(function \(i\) \{\s*return i\.status !== 'resolved';/,
    );
    expect(body).toMatch(
      /const resolved = items\.filter\(function \(i\) \{\s*return i\.status === 'resolved';/,
    );
    expect(body).toContain('Live incident state unavailable until loaded.');
    expect(body).not.toContain('MOCK_INCIDENTS');
  });

  it('form fields required posture: title + description required; affected + public optional', () => {
    // Required: title + description (textarea).
    expect(body).toMatch(/<input[^>]*id="title"[^>]*required/);
    expect(body).toMatch(/<textarea[^>]*id="description"[^>]*required/);
    // Public checkbox defaults checked.
    expect(body).toMatch(/<input[^>]*id="public"[^>]*checked/);
    // Affected components NOT required.
    const affected = body.match(/<input[^>]*id="affected"[^>]*\/>/);
    expect(affected).not.toBeNull();
    expect(affected![0]).not.toMatch(/required/);
  });

  it('public framing claim ("60 seconds to status page") pinned', () => {
    // Pin the customer-facing latency claim so a future server-side
    // window-change forces a doc edit.
    expect(body).toMatch(/within ~60 seconds/);
    expect(body).toContain('status.driftstack.dev');
  });
});
