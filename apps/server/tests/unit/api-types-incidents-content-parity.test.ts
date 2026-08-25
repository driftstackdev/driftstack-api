// W434.A — drift guard for packages/api-types/src/incidents.ts.
// V-295a public-status incident shapes. Drift here either drops a
// severity/status enum value (admin can't post a real incident) or
// breaks the public-vs-admin scope filter (private internal-triage
// incidents leak to the public status page).
//
//   • V-295a framing pinned: two-table semantics (Incident +
//     IncidentUpdate); status page reads public incidents; admin
//     reads/writes both.
//   • IncidentSeverity enum: minor | major | outage.
//   • IncidentStatus enum: investigating | identified | monitoring
//     | resolved.
//   • IncidentSchema: 11-field public shape.
//   • IncidentUpdate: id + incident_id + message + status +
//     posted_at.
//   • CreateIncident: title 1..200 + markdown description 1..5000
//     + severity + optional status (default investigating) +
//     affected_components free-form slugs (status page recognises
//     api/gui-distribution/stripe/marketing/docs/status) + public
//     optional (default true) + optional backdate-able started_at.
//   • ListIncidentsQuery scope: public (status page) | all
//     (admin default).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/incidents.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W434.A packages/api-types/src/incidents.ts content parity', () => {
  const body = read(LIB);

  it('V-295a framing pinned: public-status incident schemas; two-table semantics (top-level Incident + chronological IncidentUpdate timeline); status page renders public; admin reads/writes both via /v1/admin/incidents/*', () => {
    expect(body).toMatch(/\/\/ V-295a — public-status incident schemas\./);
    expect(body).toMatch(
      /\/\/ Incidents have two-table semantics: a top-level Incident row with\s*\/\/ the current state \+ a chronological list of IncidentUpdate rows\s*\/\/ for the timeline\. The status page renders public incidents; admin\s*\/\/ surface reads \+ writes both via \/v1\/admin\/incidents\/\*\./,
    );
  });

  it("imports: z from 'zod' + Iso8601Schema from './common.js'", () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(/import \{ Iso8601Schema \} from '\.\/common\.js';/);
  });

  it('IncidentSeverity enum: minor | major | outage', () => {
    expect(body).toMatch(
      /export const IncidentSeveritySchema = z\.enum\(\['minor', 'major', 'outage'\]\);/,
    );
    expect(body).toMatch(/export type IncidentSeverity = z\.infer<typeof IncidentSeveritySchema>;/);
  });

  it('IncidentStatus enum: investigating | identified | monitoring | resolved (in exact order)', () => {
    expect(body).toMatch(
      /export const IncidentStatusSchema = z\.enum\(\[\s*'investigating',\s*'identified',\s*'monitoring',\s*'resolved',\s*\]\);/,
    );
    expect(body).toMatch(/export type IncidentStatus = z\.infer<typeof IncidentStatusSchema>;/);
  });

  it('IncidentSchema public-view shape: id + title + description + severity + status + affected_components[] + public bool + started_at + nullable resolved_at + created_at + updated_at (11 fields)', () => {
    expect(body).toMatch(
      /export const IncidentSchema = z\.object\(\{\s*id: z\.string\(\),\s*title: z\.string\(\),\s*description: z\.string\(\),\s*severity: IncidentSeveritySchema,\s*status: IncidentStatusSchema,\s*affected_components: z\.array\(z\.string\(\)\),\s*public: z\.boolean\(\),\s*started_at: Iso8601Schema,\s*resolved_at: Iso8601Schema\.nullable\(\),\s*created_at: Iso8601Schema,\s*updated_at: Iso8601Schema,\s*\}\);/,
    );
  });

  it('IncidentUpdate: id + incident_id + message + status + posted_at', () => {
    expect(body).toMatch(
      /export const IncidentUpdateSchema = z\.object\(\{\s*id: z\.string\(\),\s*incident_id: z\.string\(\),\s*message: z\.string\(\),\s*status: IncidentStatusSchema,\s*posted_at: Iso8601Schema,\s*\}\);/,
    );
  });

  it('CreateIncident: title 1..200 + markdown description 1..5000 (rendered plaintext until V-295c) + severity + optional status default investigating + affected_components<=20 strings 1..50 optional + public optional default true + optional backdate-able started_at', () => {
    expect(body).toContain(
      "export const CreateIncidentStatusSchema = z.enum(['investigating', 'identified', 'monitoring']);",
    );
    expect(body).toMatch(/title: z\.string\(\)\.min\(1\)\.max\(200\),/);
    expect(body).toMatch(
      /\/\*\* Markdown body\. Rendered as plaintext on the status page until\s*\*\s*V-295c wires the markdown renderer\. \*\/\s*description: z\.string\(\)\.min\(1\)\.max\(5000\),/,
    );
    expect(body).toMatch(
      /\/\*\* Initial active status; defaults to 'investigating'\. \*\/\s*status: CreateIncidentStatusSchema\.optional\(\),/,
    );
    expect(body).toMatch(
      /\/\*\* Component slugs the incident affects\. Free-form; status page\s*\*\s*recognises 'api', 'gui-distribution', 'stripe', 'marketing',\s*\*\s*'docs', 'status' but accepts any\. \*\/\s*affected_components: z\.array\(z\.string\(\)\.min\(1\)\.max\(50\)\)\.max\(20\)\.optional\(\),/,
    );
    expect(body).toMatch(
      /\/\*\* When false, the incident is admin-only \(internal triage before\s*\*\s*public confirmation\)\. Defaults true\. \*\/\s*public: z\.boolean\(\)\.optional\(\),/,
    );
    // V-1064 — the comment used to state the server-now default unconditionally,
    // which is false for the idempotent PUT. Both halves are pinned separately so
    // neither can be dropped while the other survives.
    expect(body).toMatch(/\/\*\* ISO-8601 timestamp when the incident actually started\./);
    expect(body, 'the POST default is no longer stated').toMatch(
      /`POST \/v1\/admin\/incidents` defaults to server-now if omitted/,
    );
    expect(body, 'the PUT rejection is no longer stated').toMatch(
      /rejects its absence with a 400 in the handler/,
    );
    expect(
      body,
      'started_at again claims a server-now default with no mention of the PUT that rejects its ' +
        'absence',
    ).not.toMatch(/started\.\s*\*\s*Defaults to server-now if omitted\. Operators/);
  });

  it('AddIncidentUpdate: message 1..2000 + status; ResolveIncident: final message 1..2000 only', () => {
    expect(body).toMatch(
      /export const AddIncidentUpdateRequestSchema = z\.object\(\{\s*message: z\.string\(\)\.min\(1\)\.max\(2000\),\s*status: IncidentStatusSchema,\s*\}\);/,
    );
    expect(body).toMatch(
      /export const ResolveIncidentRequestSchema = z\.object\(\{\s*\/\*\* Final message posted alongside the resolution\. \*\/\s*message: z\.string\(\)\.min\(1\)\.max\(2000\),\s*\}\);/,
    );
  });

  it("ListIncidentsQuery: scope enum 'public'|'all' (status page vs admin default) + optional since + limit coerced int 1..100", () => {
    expect(body).toMatch(
      /\/\*\* When 'public', returns only public=true incidents \(status page\)\.\s*\*\s*When 'all' \(default for admin\), returns everything\. \*\/\s*scope: z\.enum\(\['public', 'all'\]\)\.optional\(\),/,
    );
    expect(body).toMatch(
      /\/\*\* Filter to incidents started since this ISO-8601 timestamp\.\s*\*\s*Status page typically uses last-30-days\. \*\/\s*since: Iso8601Schema\.optional\(\),/,
    );
    expect(body).toMatch(
      /limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.optional\(\),/,
    );
  });

  it('list/public-feed/idempotent-put responses carry exact truth metadata', () => {
    expect(body).toContain('export const ListIncidentsResponseSchema = z.object({');
    expect(body).toContain('data: z.array(IncidentSchema)');
    expect(body).toContain('total: z.number().int().nonnegative()');
    expect(body).toContain('open_count: z.number().int().nonnegative()');
    expect(body).toContain('has_more: z.boolean()');
    expect(body).toContain('next_cursor: z.string().nullable()');
    expect(body).toContain('export const PublicIncidentFeedResponseSchema = z.object({');
    expect(body).toContain('open_outage_count: z.number().int().nonnegative()');
    expect(body).toContain("outcome: z.enum(['created', 'replayed'])");
    expect(body).toMatch(
      /export const IncidentDetailResponseSchema = z\.object\(\{\s*incident: IncidentSchema,\s*updates: z\.array\(IncidentUpdateSchema\),\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
