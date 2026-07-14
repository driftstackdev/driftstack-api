// Public, registry-derived archetype catalog. This is the API/SDK-codegen source
// for customer-selectable device + iOS + Safari combinations. Internal reference
// baselines and planned placeholders are deliberately excluded.

import type { FastifyInstance } from 'fastify';
import {
  ARCHETYPE_REGISTRY,
  LOCKED_ARCHETYPE_ID,
  type ListArchetypesResponse,
  type PublicArchetypeStatus,
} from '@driftstack/api-types';

export const ARCHETYPE_CATALOG_CACHE_MAX_AGE_SECONDS = 300;

const SELECTABLE_STATUSES = new Set<PublicArchetypeStatus>(['launch', 'available']);

const response: ListArchetypesResponse = {
  default_archetype_id: LOCKED_ARCHETYPE_ID,
  data: ARCHETYPE_REGISTRY.filter(
    (entry): entry is typeof entry & { status: PublicArchetypeStatus } =>
      SELECTABLE_STATUSES.has(entry.status as PublicArchetypeStatus),
  ).map((entry) => ({
    id: entry.id,
    display_label: entry.displayLabel,
    device: entry.device,
    ios_version: entry.iosVersion,
    safari_version: entry.safariVersion,
    canvas_family: entry.canvasFamily,
    status: entry.status,
    is_default: entry.id === LOCKED_ARCHETYPE_ID,
  })),
};

export function registerArchetypeRoutes(app: FastifyInstance): void {
  app.get('/v1/archetypes', (_request, reply) => {
    reply.header(
      'cache-control',
      `public, max-age=${ARCHETYPE_CATALOG_CACHE_MAX_AGE_SECONDS.toString()}`,
    );
    return response;
  });
}
