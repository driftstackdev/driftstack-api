// V-295e — incident event bus.
//
// In-process EventEmitter-style bus that the IncidentsService lifecycle
// publishes to and the /v1/status/stream SSE route subscribes to. Each
// connected SSE client is one subscription; subscriptions are cleaned
// up automatically when the client disconnects (route handler unwires
// on `request.raw.on('close', ...)`).
//
// This is intentionally in-process. Multi-instance deployment would
// need Redis Pub/Sub bridging on top — left as a follow-up because:
//   1. Driftstack ships a single API instance at launch (Hetzner deploy).
//   2. SSE clients hold open connections; routing them to a specific
//      instance via sticky sessions is the eventual scaling answer
//      anyway.
//
// Event payload mirrors the public API wire shape of GET /v1/status/incidents:
//   { event: 'incident.created' | 'incident.resolved', incident: PublicIncident, update: PublicIncidentUpdate }

import type { Incident, IncidentUpdate } from '@driftstack/api-types';
import type { IncidentRow, IncidentUpdateRow } from './incidents.js';

export interface IncidentEvent {
  event: 'incident.created' | 'incident.resolved';
  generated_at: string;
  incident: Incident;
  update: IncidentUpdate;
}

export type IncidentEventListener = (event: IncidentEvent) => void;

function publicIncident(row: IncidentRow): Incident {
  return {
    id: `inc_${row.id}`,
    title: row.title,
    description: row.description,
    severity: row.severity,
    status: row.status,
    affected_components: [...row.affectedComponents],
    public: row.public,
    started_at: row.startedAt.toISOString(),
    resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function publicIncidentUpdate(row: IncidentUpdateRow): IncidentUpdate {
  return {
    id: `incu_${row.id}`,
    incident_id: `inc_${row.incidentId}`,
    message: row.message,
    status: row.status,
    posted_at: row.postedAt.toISOString(),
  };
}

export class IncidentEventBus {
  private readonly listeners = new Set<IncidentEventListener>();

  subscribe(listener: IncidentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** V-295c3-followup-style — fires on lifecycle. */
  publishCreated(incident: IncidentRow, update: IncidentUpdateRow): void {
    this.emit({
      event: 'incident.created',
      generated_at: new Date().toISOString(),
      incident: publicIncident(incident),
      update: publicIncidentUpdate(update),
    });
  }

  publishResolved(incident: IncidentRow, update: IncidentUpdateRow): void {
    this.emit({
      event: 'incident.resolved',
      generated_at: new Date().toISOString(),
      incident: publicIncident(incident),
      update: publicIncidentUpdate(update),
    });
  }

  private emit(event: IncidentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener throwing must NOT prevent other listeners from firing.
      }
    }
  }

  /** Test-only — exposes the listener count. */
  listenerCount(): number {
    return this.listeners.size;
  }
}
