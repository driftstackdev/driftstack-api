// W398.A — drift guard for apps/server/src/services/incident-event-bus.ts.
// V-295e in-process EventEmitter-style bus. IncidentsService lifecycle
// publishes; /v1/status/stream SSE route subscribes. One subscription
// per connected SSE client; route handler unwires on client disconnect.
// Drift here either misses lifecycle events (SSE clients stop seeing
// real-time updates) or one bad listener poisons the whole batch.
//
//   • V-295e framing + IncidentsService → bus → SSE subscriber chain.
//   • In-process intentional — multi-instance needs Redis Pub/Sub
//     bridging (deferred: single-instance launch, sticky-sessions
//     scaling answer).
//   • IncidentEvent wire shape mirrors GET /v1/status/incidents
//     (4 fields: event + generated_at + incident + update).
//   • Event types: 'incident.created' | 'incident.resolved' (2-literal).
//   • publicIncident: inc_<uuid> id prefix; ISO timestamps for
//     started_at / resolved_at?/created_at/updated_at; affected_
//     components spread (defensive copy).
//   • publicIncidentUpdate: incu_<uuid> id + inc_<uuid> incident_id
//     prefix.
//   • subscribe returns unsubscribe-fn closure (delete-from-Set).
//   • emit: try/catch per-listener — one throw must NOT prevent other
//     listeners from firing.
//   • listenerCount() test-only.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/incident-event-bus.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W398.A apps/server/src/services/incident-event-bus.ts content parity', () => {
  const body = read(LIB);

  it('V-295e framing pinned: in-process EventEmitter, SSE /v1/status/stream subscriber, route unwires on disconnect', () => {
    expect(body).toMatch(/V-295e — incident event bus\./);
    expect(body).toMatch(
      /In-process EventEmitter-style bus that the IncidentsService lifecycle\s*\/\/\s*publishes to and the \/v1\/status\/stream SSE route subscribes to\. Each\s*\/\/\s*connected SSE client is one subscription; subscriptions are cleaned\s*\/\/\s*up automatically when the client disconnects \(route handler unwires\s*\/\/\s*on `request\.raw\.on\('close', \.\.\.\)`\)/,
    );
  });

  it('Multi-instance follow-up framing pinned: Redis Pub/Sub deferred (single-instance launch + sticky-sessions scaling answer)', () => {
    expect(body).toMatch(
      /This is intentionally in-process\. Multi-instance deployment would\s*\/\/\s*need Redis Pub\/Sub bridging on top — left as a follow-up because:\s*\/\/\s*1\. Driftstack ships a single API instance at launch \(Hetzner deploy\)\.\s*\/\/\s*2\. SSE clients hold open connections; routing them to a specific\s*\/\/\s*instance via sticky sessions is the eventual scaling answer\s*\/\/\s*anyway\./,
    );
  });

  it('IncidentEvent wire-shape framing: event + generated_at + incident + update (mirrors GET /v1/status/incidents)', () => {
    expect(body).toMatch(
      /Event payload mirrors the public API wire shape of GET \/v1\/status\/incidents:\s*\/\/\s*\{ event: 'incident\.created' \| 'incident\.resolved', incident: PublicIncident, update: PublicIncidentUpdate \}/,
    );
  });

  it('IncidentEvent interface: 4 fields with event 2-literal union', () => {
    expect(body).toMatch(/export interface IncidentEvent \{/);
    expect(body).toMatch(/event: 'incident\.created' \| 'incident\.resolved';/);
    expect(body).toMatch(/generated_at: string;/);
    expect(body).toMatch(/incident: Incident;/);
    expect(body).toMatch(/update: IncidentUpdate;/);
  });

  it('IncidentEventListener: callback type (IncidentEvent) => void', () => {
    expect(body).toMatch(/export type IncidentEventListener = \(event: IncidentEvent\) => void;/);
  });

  it('publicIncident: inc_<row.id> id prefix, affected_components spread (defensive copy), ISO timestamps', () => {
    expect(body).toMatch(
      /function publicIncident\(row: IncidentRow\): Incident \{\s*return \{\s*id: `inc_\$\{row\.id\}`,/,
    );
    expect(body).toMatch(/affected_components: \[\.\.\.row\.affectedComponents\],/);
    expect(body).toMatch(/started_at: row\.startedAt\.toISOString\(\),/);
    expect(body).toMatch(
      /resolved_at: row\.resolvedAt \? row\.resolvedAt\.toISOString\(\) : null,/,
    );
    expect(body).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
    expect(body).toMatch(/updated_at: row\.updatedAt\.toISOString\(\),/);
  });

  it('publicIncidentUpdate: incu_<row.id> id + inc_<row.incidentId> incident_id prefixes', () => {
    expect(body).toMatch(
      /function publicIncidentUpdate\(row: IncidentUpdateRow\): IncidentUpdate \{\s*return \{\s*id: `incu_\$\{row\.id\}`,\s*incident_id: `inc_\$\{row\.incidentId\}`,\s*message: row\.message,\s*status: row\.status,\s*posted_at: row\.postedAt\.toISOString\(\),\s*\};\s*\}/,
    );
  });

  it('IncidentEventBus: private listeners Set + subscribe returns unsubscribe-fn (delete-from-Set closure)', () => {
    expect(body).toMatch(/export class IncidentEventBus \{/);
    expect(body).toMatch(/private readonly listeners = new Set<IncidentEventListener>\(\);/);
    expect(body).toMatch(
      /subscribe\(listener: IncidentEventListener\): \(\) => void \{\s*this\.listeners\.add\(listener\);\s*return \(\) => \{\s*this\.listeners\.delete\(listener\);\s*\};\s*\}/,
    );
  });

  it('publishCreated / publishResolved: emit event with new Date().toISOString() generated_at', () => {
    expect(body).toMatch(/\/\*\* V-295c3-followup-style — fires on lifecycle\. \*\//);
    expect(body).toMatch(
      /publishCreated\(incident: IncidentRow, update: IncidentUpdateRow\): void \{\s*this\.emit\(\{\s*event: 'incident\.created',\s*generated_at: new Date\(\)\.toISOString\(\),\s*incident: publicIncident\(incident\),\s*update: publicIncidentUpdate\(update\),\s*\}\);/,
    );
    expect(body).toMatch(
      /publishResolved\(incident: IncidentRow, update: IncidentUpdateRow\): void \{\s*this\.emit\(\{\s*event: 'incident\.resolved',\s*generated_at: new Date\(\)\.toISOString\(\),/,
    );
  });

  it('emit: try/catch per-listener — one throw must NOT prevent other listeners from firing', () => {
    expect(body).toMatch(
      /private emit\(event: IncidentEvent\): void \{\s*for \(const listener of this\.listeners\) \{\s*try \{\s*listener\(event\);\s*\} catch \{\s*\/\/ A listener throwing must NOT prevent other listeners from firing\.\s*\}\s*\}/,
    );
  });

  it('listenerCount: test-only debug surface', () => {
    expect(body).toMatch(
      /\/\*\* Test-only — exposes the listener count\. \*\/\s*listenerCount\(\): number \{\s*return this\.listeners\.size;\s*\}/,
    );
  });

  it('imports: Incident / IncidentUpdate types from @driftstack/api-types + IncidentRow/IncidentUpdateRow from ./incidents.js', () => {
    expect(body).toMatch(
      /import type \{ Incident, IncidentUpdate \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /import type \{ IncidentRow, IncidentUpdateRow \} from '\.\/incidents\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
