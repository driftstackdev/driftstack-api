// W410.A — drift guard for apps/server/src/services/status-snapshot.ts.
// V-295c2 public status snapshot writer. Periodically writes
// /v1/status/incidents wire shape as a single JSON object to R2 under
// `status/incidents-public.json` so the status-site CF Pages frontend
// can fall through to it during API outages. Drift here either
// silently stops the fallback (page goes stale during the outage we
// most need it for) or drifts the wire shape (status page breaks).
//
//   • V-295c2 framing pinned: single-key R2 overwrite + per-tick
//     rewrite + matches GET /v1/status/incidents wire envelope.
//   • Cadence: 60s poller shared with health probe; no history; no
//     per-tick proliferation.
//   • Defaults: windowMs = 30 days (matches public API); limit = 50
//     (matches public API).
//   • STATUS_SNAPSHOT_KEY constant = 'status/incidents-public.json'.
//   • Envelope: `{ generated_at, data: Incident[] }`.
//   • publicIncident: 11-field shape; id prefixed `inc_`; ISO-string
//     timestamps; resolved_at nullable; affectedComponents copy via
//     spread (defensive).
//   • Incident type imported from @driftstack/api-types (SDK mirror).
//   • Optional config.key override for tests.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W410.A apps/server/src/services/status-snapshot.ts content parity', () => {
  const body = read(LIB);

  it('V-295c2 framing pinned: writes /v1/status/incidents data to R2 as single JSON object; status-site fallback', () => {
    expect(body).toMatch(/V-295c2 — public status snapshot writer\./);
    expect(body).toMatch(
      /Reads the same data the public `\/v1\/status\/incidents` endpoint\s*\n?\s*\/\/\s*surfaces and writes it as a single JSON object to R2 under\s*\n?\s*\/\/\s*`status\/incidents-public\.json`\. The status-site CF Pages frontend\s*\n?\s*\/\/\s*falls back to the R2 URL when the live API fetch fails — keeping\s*\n?\s*\/\/\s*the page current even during API outages\./,
    );
  });

  it('Cadence framing pinned: 60s poller shared with health probe + per-tick rewrite same key (no history)', () => {
    expect(body).toMatch(
      /Cadence: bootstrap calls processSnapshot\(\) in the same 60s poller\s*\n?\s*\/\/\s*as the health probe\. Each tick rewrites the same key \(no history,\s*\n?\s*\/\/\s*no per-tick proliferation\)\./,
    );
  });

  it('Shape framing pins exact aggregates + truncation for live/fallback parity', () => {
    expect(body).toMatch(/Shape: matches GET \/v1\/status\/incidents: bounded data plus exact/);
    expect(body).toMatch(/total\/open\/outage aggregates and an explicit truncation bit/);
  });

  it("STATUS_SNAPSHOT_KEY exported constant = 'status/incidents-public.json'", () => {
    expect(body).toMatch(/export const STATUS_SNAPSHOT_KEY = 'status\/incidents-public\.json';/);
  });

  it('Defaults: 90-day resolved history + all-time open truth; limit 50', () => {
    expect(body).toMatch(/Resolved-history window; defaults to 90 days/);
    expect(body).toMatch(/Open rows are all-time/);
    expect(body).toMatch(
      /\/\*\* Max incidents to include; defaults to 50 \(matches the public API\)\. \*\//,
    );
    expect(body).toMatch(/this\.windowMs = config\.windowMs \?\? 90 \* 24 \* 60 \* 60 \* 1000;/);
    expect(body).toMatch(/this\.limit = config\.limit \?\? 50;/);
    expect(body).toMatch(/this\.key = config\.key \?\? STATUS_SNAPSHOT_KEY;/);
  });

  it('publicIncident: 11-field wire shape with id="inc_${row.id}" + ISO timestamps + resolved_at nullable + affectedComponents spread copy', () => {
    expect(body).toMatch(/function publicIncident\(row: IncidentRow\): Incident \{/);
    expect(body).toMatch(/id: `inc_\$\{row\.id\}`,/);
    expect(body).toMatch(/affected_components: \[\.\.\.row\.affectedComponents\],/);
    expect(body).toMatch(/started_at: row\.startedAt\.toISOString\(\),/);
    expect(body).toMatch(
      /resolved_at: row\.resolvedAt \? row\.resolvedAt\.toISOString\(\) : null,/,
    );
    expect(body).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
    expect(body).toMatch(/updated_at: row\.updatedAt\.toISOString\(\),/);
  });

  it('processSnapshot: exact publicFeed envelope + R2 same-key overwrite', () => {
    expect(body).toMatch(
      /\/\*\* Write one snapshot to R2\. Idempotent — same key, full overwrite\. \*\/\s*\n?\s*async processSnapshot\(now: Date\): Promise<\{ count: number; bytes: number \}> \{/,
    );
    expect(body).toMatch(/const since = new Date\(now\.getTime\(\) - this\.windowMs\);/);
    expect(body).toContain('const feed = await this.incidents.publicFeed({');
    expect(body).toContain('data: feed.rows.map(publicIncident)');
    expect(body).toContain('total: feed.total');
    expect(body).toContain('open_count: feed.openCount');
    expect(body).toContain('open_outage_count: feed.openOutageCount');
    expect(body).toContain('truncated: feed.truncated');
    expect(body).toMatch(
      /await this\.r2\.putObject\(\{\s*\n?\s*key: this\.key,\s*\n?\s*body: buffer,\s*\n?\s*contentType: 'application\/json; charset=utf-8',\s*\n?\s*\}\);/,
    );
  });

  it('processSnapshot: returns { count, bytes }; debug-log (optional chain) on success', () => {
    expect(body).toMatch(/return \{ count: feed\.rows\.length, bytes: buffer\.byteLength \};/);
    expect(body).toMatch(/this\.logger\.debug\?\.\(/);
    expect(body).toMatch(/'wrote status snapshot to R2',/);
  });

  it('imports: Incident (SDK mirror from @driftstack/api-types) + Logger + R2 + IncidentRow/IncidentsService', () => {
    expect(body).toMatch(/import type \{ Incident \} from '@driftstack\/api-types';/);
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
    expect(body).toMatch(/import type \{ R2 \} from '\.\.\/lib\/r2\.js';/);
    expect(body).toMatch(
      /import type \{ IncidentRow, IncidentsService \} from '\.\/incidents\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
