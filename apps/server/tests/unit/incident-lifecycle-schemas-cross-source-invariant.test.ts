// W890 — V-295a Incident lifecycle schemas cross-source invariant.
// Two-hundred-sixteenth in the drift-guard series. Pins the V-295a
// incident-management request shapes:
//
//   CreateIncidentRequest (7 fields):
//     - title: string 1-200.
//     - description: markdown 1-5000.
//     - severity: IncidentSeveritySchema (required).
//     - status?: IncidentStatusSchema (defaults 'investigating').
//     - affected_components?: array of 1-50-char slugs, max 20.
//     - public?: boolean (defaults true).
//     - started_at?: ISO (POST defaults server-now, PUT rejects absence;
//       ops backdate).
//
//   AddIncidentUpdateRequest (2 fields):
//     - message: string 1-2000.
//     - status: IncidentStatusSchema (required transition).
//
//   ResolveIncidentRequest (1 field):
//     - message: string 1-2000 (final message).
//
//   IncidentDetailResponse:
//     - incident: IncidentSchema.
//     - updates: array of IncidentUpdate (chronological).
//
//   6 recognised affected-component slugs:
//     api / gui-distribution / stripe / marketing / docs / status.
//     (Accept any; doc lists these 6.)
//
// stays in lockstep across api-types Zod canonical.
//
// Drift would silently break:
//   * Admin-panel incident-create UI accepting fields the server
//     rejects.
//   * Status-page rendering missing fields.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const RECOGNISED_COMPONENTS = [
  'api',
  'gui-distribution',
  'stripe',
  'marketing',
  'docs',
  'status',
] as const;

describe('W890 V-295a Incident lifecycle schemas cross-source invariant', () => {
  // ─── CreateIncidentRequest 7-field bounds ────────────────────

  it('CRITICAL CreateIncidentRequestSchema title bound = 1-200 + description bound = 1-5000 + severity required + status optional. The 200-char title + 5000-char description bound the storage + UI render.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(
      /CreateIncidentRequestSchema = z\.object\(\{[\s\S]+?title: z\.string\(\)\.min\(1\)\.max\(200\)/,
    );
    expect(p).toMatch(
      /CreateIncidentRequestSchema[\s\S]+?description: z\.string\(\)\.min\(1\)\.max\(5000\)/,
    );
    expect(p).toMatch(/CreateIncidentRequestSchema[\s\S]+?severity: IncidentSeveritySchema,/);
    expect(p).toMatch(
      /CreateIncidentRequestSchema[\s\S]+?status: CreateIncidentStatusSchema\.optional\(\)/,
    );
    expect(p).toContain(
      "export const CreateIncidentStatusSchema = z.enum(['investigating', 'identified', 'monitoring']);",
    );
  });

  it('CRITICAL CreateIncident.affected_components is z.array(z.string().min(1).max(50)).max(20).optional() — array of slugs (1-50 chars each, max 20 components per incident). The bounds bound storage + audit-log payload size.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(
      /affected_components: z\.array\(z\.string\(\)\.min\(1\)\.max\(50\)\)\.max\(20\)\.optional\(\)/,
    );
  });

  it('CRITICAL CreateIncident.public is z.boolean().optional() — defaults true. The default-true means status-page-visible by default; admins explicitly mark internal-triage incidents with public:false.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(/public: z\.boolean\(\)\.optional\(\)/);
    expect(p).toMatch(
      /the incident is admin-only \(internal triage before\s*\n\s*\*\s*public confirmation\)\. Defaults true/,
    );
  });

  it("V-1064 CreateIncident.started_at is Iso8601Schema.optional(), and the comment names both verbs rather than only the POST default — 'defaults to server-now if omitted. Operators usually backdate this once they identify the actual start time'. The backdate-pattern is what makes RCA-aligned timestamps possible.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(/started_at: Iso8601Schema\.optional\(\)/);
    expect(p).toMatch(/Operators usually backdate this once they identify the actual start/);
    // V-1064 — optional in the schema, but only one of the two verbs sharing it
    // treats an omission as a default. The comment now names both.
    expect(p, 'the per-verb difference is no longer stated').toMatch(
      /`PUT \/v1\/admin\/incidents\/:id`[\s\S]*?rejects its absence with a 400/,
    );
  });

  // ─── AddIncidentUpdateRequest ───────────────────────────────

  it('CRITICAL AddIncidentUpdateRequestSchema has 2 fields — message: 1-2000 + status: IncidentStatusSchema (required transition). The status transition is what the public-status timeline renders.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(
      /AddIncidentUpdateRequestSchema = z\.object\(\{\s*\n\s*message: z\.string\(\)\.min\(1\)\.max\(2000\),\s*\n\s*status: IncidentStatusSchema,\s*\n\s*\}\);/,
    );
  });

  // ─── ResolveIncidentRequest ─────────────────────────────────

  it("CRITICAL ResolveIncidentRequestSchema has 1 field — message: 1-2000 (final message). 'Final message posted alongside the resolution' framing pins the closure-summary contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(
      /ResolveIncidentRequestSchema = z\.object\(\{[\s\S]+?message: z\.string\(\)\.min\(1\)\.max\(2000\),\s*\n\s*\}\);/,
    );
    expect(p).toMatch(/Final message posted alongside the resolution/);
  });

  // ─── IncidentDetailResponse: incident + chronological updates ─

  it('CRITICAL IncidentDetailResponseSchema = { incident: IncidentSchema; updates: z.array(IncidentUpdateSchema) }. The 2-field shape lets a single GET return the incident + full timeline.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(
      /IncidentDetailResponseSchema = z\.object\(\{\s*\n\s*incident: IncidentSchema,\s*\n\s*updates: z\.array\(IncidentUpdateSchema\),\s*\n\s*\}\);/,
    );
  });

  // ─── 6 recognised affected-component slugs ───────────────────

  it("CRITICAL CreateIncident affected_components doc lists 6 recognised slugs — api / gui-distribution / stripe / marketing / docs / status. 'Free-form; status page recognises … but accepts any' — the 6-list is informational not enforced.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    for (const slug of RECOGNISED_COMPONENTS) {
      expect(p, `affected_components doc must mention '${slug}'`).toMatch(new RegExp(`'${slug}'`));
    }
  });

  // ─── ListIncidents query: scope+since+limit ──────────────────

  it("CRITICAL ListIncidentsQuerySchema has scope: z.enum(['public', 'all']).optional() + since: Iso8601Schema.optional() + limit: z.coerce.number().int().min(1).max(100).optional(). The scope-enum gates public-vs-admin reads.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(
      /ListIncidentsQuerySchema = z\.object\(\{[\s\S]+?scope: z\.enum\(\['public', 'all'\]\)\.optional\(\)/,
    );
    expect(p).toMatch(/ListIncidentsQuerySchema[\s\S]+?since: Iso8601Schema\.optional\(\)/);
    expect(p).toMatch(
      /ListIncidentsQuerySchema[\s\S]+?limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.optional\(\)/,
    );
  });

  // ─── 6-component cardinality ─────────────────────────────────

  it('CRITICAL 6 recognised affected-component slugs pinned. Drift to dropping a slug would let the status page lose a public-facing component label.', () => {
    expect(RECOGNISED_COMPONENTS.length).toBe(6);
    expect(RECOGNISED_COMPONENTS).toEqual([
      'api',
      'gui-distribution',
      'stripe',
      'marketing',
      'docs',
      'status',
    ]);
  });

  // ─── V-295c markdown-renderer TODO anchor ────────────────────

  it("CRITICAL description field doc pins V-295c markdown-renderer TODO — 'Markdown body. Rendered as plaintext on the status page until V-295c wires the markdown renderer'. The forward-reference is the public TODO for upgrading the render path.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts'));
    expect(p).toMatch(
      /Markdown body\. Rendered as plaintext on the status page until\s*\n\s*\*\s*V-295c wires the markdown renderer/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/incident-lifecycle-schemas-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
