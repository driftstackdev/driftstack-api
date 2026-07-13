// W352.C — drift guard for admin /incidents/[id]. The detail page
// renders SEVERITY_BADGE + STATUS_BADGE maps + a post-update form
// + a "Private" tag for non-public incidents. Pins:
//
//   • SEVERITY_BADGE keys = IncidentSeveritySchema values (exact set)
//   • STATUS_BADGE keys = IncidentStatusSchema values (exact set)
//   • Semantic colours: minor=amber, major=orange, outage=red;
//     resolved=emerald (so a future Tailwind sweep can't accidentally
//     flip the colour mapping)
//   • Post-update form lists exactly {investigating, identified,
//     monitoring} (NOT "resolved" — resolve is a dedicated action,
//     not a regular status update)
//   • Non-public incidents show a "Private" tag
//   • Timeline uses the same STATUS_BADGE map (no copy-paste
//     duplicates with different colours)
//   • Back-link to /incidents resolves

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IncidentSeveritySchema, IncidentStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/shells/incident-detail.astro');
const INDEX = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/incidents/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function badgeKeys(src: string, name: string): string[] {
  const block = src.match(
    new RegExp(`const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\};`),
  );
  if (block === null) throw new Error(`${name} literal not found`);
  return [...block[1]!.matchAll(/^\s*([a-z]+):\s*'/gm)].map((m) => m[1]!).sort();
}

describe('W352.C admin /incidents/[id] detail page parity', () => {
  const body = read(PAGE);

  it('static incident detail shell exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('SEVERITY_BADGE keys exactly match IncidentSeveritySchema values', () => {
    const keys = badgeKeys(body, 'SEVERITY_BADGE');
    const schema = [
      ...(IncidentSeveritySchema._def as { values: readonly string[] }).values,
    ].sort();
    expect(keys).toEqual(schema);
  });

  it('STATUS_BADGE keys exactly match IncidentStatusSchema values', () => {
    const keys = badgeKeys(body, 'STATUS_BADGE');
    const schema = [...(IncidentStatusSchema._def as { values: readonly string[] }).values].sort();
    expect(keys).toEqual(schema);
  });

  it('severity colour mapping pins minor=amber / major=orange / outage=red', () => {
    expect(body).toMatch(/minor:\s*'bg-amber-50 text-amber-700'/);
    expect(body).toMatch(/major:\s*'bg-orange-50 text-orange-700'/);
    expect(body).toMatch(/outage:\s*'bg-red-50 text-red-700'/);
  });

  it('status colour mapping pins resolved=emerald (the only success-coloured status)', () => {
    expect(body).toMatch(/resolved:\s*'bg-emerald-50 text-emerald-700'/);
  });

  it('post-update form lists exactly {investigating, identified, monitoring} — resolve is a separate action', () => {
    // Pull the option values from the form's <select id="update-status">.
    const sel = body.match(/<select[^>]*id="update-status"[\s\S]*?<\/select>/);
    expect(sel).not.toBeNull();
    const values = [...sel![0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]!).sort();
    expect(values).toEqual(['identified', 'investigating', 'monitoring']);
    // Negative guard: "resolved" must NOT be in this dropdown.
    expect(values).not.toContain('resolved');
  });

  it('"Private" tag rendered for non-public incidents', () => {
    // The static shell keeps the private badge in the
    // DOM with data-field="private-badge", hidden via a class:list
    // toggle when incident.public (the inline script re-flips it from
    // the live incident.public). Pin the data-hook + the public-gated
    // hidden toggle + the "private" label.
    expect(body).toMatch(/data-field="private-badge"/);
    expect(body).toMatch(/incident\.public \? 'hidden' : ''/);
    expect(body).toMatch(/>\s*private\s*</);
  });

  it('back-link to /incidents resolves to the list page', () => {
    expect(body).toContain('/incidents');
    expect(existsSync(INDEX)).toBe(true);
  });

  it('timeline reuses STATUS_BADGE (no per-entry colour duplication)', () => {
    // Both the header status badge and the per-update timeline
    // entries pull from STATUS_BADGE — pin both so a future edit
    // doesn't introduce a divergent class list.
    const usages = [...body.matchAll(/STATUS_BADGE\[/g)].length;
    expect(usages).toBeGreaterThanOrEqual(2);
  });
});
