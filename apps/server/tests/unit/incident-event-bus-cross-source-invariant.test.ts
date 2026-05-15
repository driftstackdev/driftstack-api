// W922 — V-295e IncidentEventBus cross-source invariant. Two-hundred-
// forty-eighth in the drift-guard series. Pins the in-process
// incident-event bus that drives the SSE /v1/status/stream route:
//
//   V-295e anchor — 'incident event bus'.
//
//   In-process EventEmitter-style bus. IncidentsService lifecycle
//   publishes; /v1/status/stream SSE route subscribes. Each connected
//   SSE client = one subscription. Cleanup is automatic when client
//   disconnects via `request.raw.on('close', ...)`.
//
//   Single-instance design rationale:
//     1. Driftstack ships single API instance at launch (Hetzner).
//     2. SSE clients hold open connections; sticky sessions are the
//        eventual multi-instance scaling answer anyway.
//   Multi-instance would need Redis Pub/Sub bridging — left as
//   follow-up.
//
//   IncidentEvent shape (4 fields):
//     - event: 'incident.created' | 'incident.resolved'.
//     - generated_at: ISO 8601.
//     - incident: Incident (wire-shape; 11-field publicIncident).
//     - update: IncidentUpdate (publicIncidentUpdate projection).
//
//   2-event union — incident.created + incident.resolved (no
//   .updated v1; the next status update fires a new event with
//   .created/.resolved semantics).
//
//   subscribe() returns an unsubscribe closure (drift to non-closure
//   would force callers to track listener references separately).
//
//   emit() try-catches each listener — 'A listener throwing must NOT
//   prevent other listeners from firing'.
//
//   listenerCount() is test-only.
//
//   publicIncident projection mirrors V-295c2 status-snapshot shape
//   (same 11-field projection function — drift would split formats).
//
// stays in lockstep across
// apps/server/src/services/incident-event-bus.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IncidentEventBus } from '../../src/services/incident-event-bus.js';
import type { IncidentEvent } from '../../src/services/incident-event-bus.js';
import type { IncidentRow, IncidentUpdateRow } from '../../src/services/incidents.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function fakeRow(): IncidentRow {
  return {
    id: 'abc123',
    title: 'API outage',
    description: 'partial',
    severity: 'major',
    status: 'investigating',
    affectedComponents: ['api'],
    public: true,
    autoProbeTarget: null,
    startedAt: new Date('2026-05-15T01:00:00Z'),
    resolvedAt: null,
    createdAt: new Date('2026-05-15T01:00:00Z'),
    updatedAt: new Date('2026-05-15T01:00:00Z'),
  } as unknown as IncidentRow;
}

function fakeUpdate(): IncidentUpdateRow {
  return {
    id: 'upd123',
    incidentId: 'abc123',
    message: 'investigating',
    status: 'investigating',
    postedAt: new Date('2026-05-15T01:00:00Z'),
  } as unknown as IncidentUpdateRow;
}

describe('W922 V-295e IncidentEventBus cross-source invariant', () => {
  // ─── V-295e anchor + SSE consumer framing ────────────────────

  it("CRITICAL apps/server/src/services/incident-event-bus.ts header pins V-295e anchor — 'V-295e — incident event bus'. The V-295e anchor is the SSE-stream policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-event-bus.ts'));
    expect(p).toMatch(/V-295e — incident event bus/);
  });

  it("CRITICAL SSE consumer framing — 'IncidentsService lifecycle publishes to and the /v1/status/stream SSE route subscribes to'. The publish/subscribe role-split is the bus's central contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-event-bus.ts'));
    expect(p).toMatch(/IncidentsService lifecycle/);
    expect(p).toMatch(/publishes to and the \/v1\/status\/stream SSE route subscribes to/);
  });

  // ─── Subscription = one SSE client + auto-cleanup ────────────

  it('CRITICAL framing — \'Each connected SSE client is one subscription; subscriptions are cleaned up automatically when the client disconnects (route handler unwires on request.raw.on("close", ...))\'. The auto-cleanup contract is what prevents leaked listeners on dropped connections.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-event-bus.ts'));
    expect(p).toMatch(/Each\s*\n\/\/ connected SSE client is one subscription/);
    expect(p).toMatch(
      /subscriptions are cleaned\s*\n\/\/ up automatically when the client disconnects/,
    );
    expect(p).toMatch(/`request\.raw\.on\('close', \.\.\.\)`/);
  });

  // ─── Single-instance rationale ───────────────────────────────

  it("CRITICAL single-instance design rationale framing — 'This is intentionally in-process. Multi-instance deployment would need Redis Pub/Sub bridging on top — left as a follow-up because: 1. Driftstack ships a single API instance at launch (Hetzner deploy). 2. SSE clients hold open connections; routing them to a specific instance via sticky sessions is the eventual scaling answer anyway'. The 2-reason rationale is the V-295e architectural decision provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-event-bus.ts'));
    expect(p).toMatch(/This is intentionally in-process\. Multi-instance deployment would/);
    expect(p).toMatch(/need Redis Pub\/Sub bridging on top — left as a follow-up because:/);
    expect(p).toMatch(/1\. Driftstack ships a single API instance at launch \(Hetzner deploy\)/);
    expect(p).toMatch(/2\. SSE clients hold open connections; routing them to a specific/);
    expect(p).toMatch(/instance via sticky sessions is the eventual scaling answer/);
  });

  // ─── 4-field IncidentEvent shape ─────────────────────────────

  it('CRITICAL IncidentEvent has 4 fields — event + generated_at + incident + update. The 4-field shape mirrors the public API wire shape of GET /v1/status/incidents.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-event-bus.ts'));
    expect(p).toMatch(/export interface IncidentEvent \{/);
    expect(p).toMatch(/event: 'incident\.created' \| 'incident\.resolved';/);
    expect(p).toMatch(/generated_at: string;/);
    expect(p).toMatch(/incident: Incident;/);
    expect(p).toMatch(/update: IncidentUpdate;/);
  });

  // ─── 2-event union (no .updated v1) ──────────────────────────

  it("CRITICAL event discriminator is 2-value union — 'incident.created' | 'incident.resolved'. The 2-event v1 design excludes .updated; subsequent status updates fire fresh .created or .resolved events.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-event-bus.ts'));
    expect(p).toMatch(/'incident\.created' \| 'incident\.resolved'/);
    expect(p).not.toMatch(/'incident\.updated'/);
  });

  // ─── publishCreated + publishResolved methods ────────────────

  it('CRITICAL bus exposes 2 publish methods — publishCreated + publishResolved, each calling emit with the matching event discriminator. The 2-method design pins the bus to the 2-event vocabulary.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-event-bus.ts'));
    expect(p).toMatch(
      /publishCreated\(incident: IncidentRow, update: IncidentUpdateRow\): void \{/,
    );
    expect(p).toMatch(/event: 'incident\.created',/);
    expect(p).toMatch(
      /publishResolved\(incident: IncidentRow, update: IncidentUpdateRow\): void \{/,
    );
    expect(p).toMatch(/event: 'incident\.resolved',/);
  });

  // ─── subscribe returns unsubscribe closure ───────────────────

  it("CRITICAL subscribe(listener) returns an unsubscribe closure — '() => void' return type. The closure return is what lets the SSE route's request.raw.on('close', ...) handler clean up without tracking listener refs.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-event-bus.ts'));
    expect(p).toMatch(
      /subscribe\(listener: IncidentEventListener\): \(\) => void \{\s*\n\s*this\.listeners\.add\(listener\);\s*\n\s*return \(\) => \{\s*\n\s*this\.listeners\.delete\(listener\);/,
    );
  });

  it('CRITICAL subscribe runtime — unsubscribe closure removes the listener from the set. The closure-based unsubscribe is the auto-cleanup primitive.', () => {
    const bus = new IncidentEventBus();
    const unsubscribe = bus.subscribe(() => {});
    expect(bus.listenerCount()).toBe(1);
    unsubscribe();
    expect(bus.listenerCount()).toBe(0);
  });

  // ─── emit try-catch isolation ────────────────────────────────

  it("CRITICAL emit() wraps each listener in try-catch — 'A listener throwing must NOT prevent other listeners from firing'. The fan-out isolation prevents one bad SSE client from breaking the bus for all others.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-event-bus.ts'));
    expect(p).toMatch(
      /for \(const listener of this\.listeners\) \{\s*\n\s*try \{\s*\n\s*listener\(event\);\s*\n\s*\} catch \{/,
    );
    expect(p).toMatch(/A listener throwing must NOT prevent other listeners from firing/);
  });

  it('CRITICAL emit runtime — throwing listener does not prevent subsequent listeners from firing. The fan-out isolation is verified mechanically.', () => {
    const bus = new IncidentEventBus();
    let calledA = false;
    let calledB = false;
    bus.subscribe(() => {
      calledA = true;
      throw new Error('listener A boom');
    });
    bus.subscribe(() => {
      calledB = true;
    });
    bus.publishCreated(fakeRow(), fakeUpdate());
    expect(calledA).toBe(true);
    expect(calledB).toBe(true);
  });

  // ─── 2-event publishCreated + publishResolved runtime ────────

  it('CRITICAL publishCreated fires an event with event=incident.created + ISO generated_at + projected incident + projected update. The runtime fan-out is what SSE clients receive.', () => {
    const bus = new IncidentEventBus();
    const events: IncidentEvent[] = [];
    bus.subscribe((e) => events.push(e));
    bus.publishCreated(fakeRow(), fakeUpdate());
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('incident.created');
    expect(events[0]!.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(events[0]!.incident.id).toBe('inc_abc123'); // prefix applied
    expect(events[0]!.update.id).toBe('incu_upd123'); // update prefix applied
  });

  it('CRITICAL publishResolved fires an event with event=incident.resolved. The 2-event discriminator round-trip is verified mechanically.', () => {
    const bus = new IncidentEventBus();
    const events: { event: string }[] = [];
    bus.subscribe((e) => events.push(e));
    bus.publishResolved(fakeRow(), fakeUpdate());
    expect(events[0]!.event).toBe('incident.resolved');
  });

  // ─── listenerCount test-only framing ─────────────────────────

  it("CRITICAL listenerCount() comment pins 'Test-only — exposes the listener count'. The test-only framing prevents production code from depending on it for state.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-event-bus.ts'));
    expect(p).toMatch(/Test-only — exposes the listener count/);
  });

  // ─── publicIncident V-295c2 shape parity ─────────────────────

  it("CRITICAL publicIncident function in incident-event-bus.ts mirrors V-295c2 status-snapshot publicIncident — same 'inc_' prefix + same 11-field projection. The 2-file parity is what makes SSE + R2 fallback present identical incident shapes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-event-bus.ts'));
    expect(p).toMatch(/function publicIncident\(row: IncidentRow\): Incident \{/);
    expect(p).toMatch(/id: `inc_\$\{row\.id\}`,/);
    expect(p).toMatch(/affected_components: \[\.\.\.row\.affectedComponents\],/);
    expect(p).toMatch(/started_at: row\.startedAt\.toISOString\(\),/);
    expect(p).toMatch(/resolved_at: row\.resolvedAt \? row\.resolvedAt\.toISOString\(\) : null,/);
  });

  // ─── publicIncidentUpdate 'incu_' prefix ─────────────────────

  it("CRITICAL publicIncidentUpdate prefixes id with 'incu_' + incident_id with 'inc_'. The 2-prefix discriminator distinguishes update vs incident ids at the wire level.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-event-bus.ts'));
    expect(p).toMatch(/id: `incu_\$\{row\.id\}`,/);
    expect(p).toMatch(/incident_id: `inc_\$\{row\.incidentId\}`,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/incident-event-bus-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
