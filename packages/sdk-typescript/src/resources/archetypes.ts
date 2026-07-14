import type { ListArchetypesResponse } from '@driftstack/api-types';
import type { HttpClient } from '../http.js';

/** Public, server-authoritative browser archetype discovery. */
export class ArchetypesResource {
  constructor(private readonly http: HttpClient) {}

  /** List every customer-selectable archetype and the current default. */
  list(): Promise<ListArchetypesResponse> {
    return this.http.request<ListArchetypesResponse>({ method: 'GET', path: '/v1/archetypes' });
  }
}
