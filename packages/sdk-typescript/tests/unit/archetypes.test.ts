import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../../src/http.js';
import { Driftstack } from '../../src/client.js';
import { ArchetypesResource } from '../../src/resources/archetypes.js';

describe('ArchetypesResource', () => {
  it('is installed on the top-level client', () => {
    const client = new Driftstack({ apiKey: 'ds_test_example' });
    expect(client.archetypes).toBeInstanceOf(ArchetypesResource);
  });

  it('lists the server-authoritative public catalog', async () => {
    const response = {
      default_archetype_id: 'iphone17_ios18_7_safari26_4',
      data: [
        {
          id: 'iphone17_ios18_7_safari26_4',
          display_label: 'iPhone 17 / iOS 18.7 / Safari 26.4',
          device: 'iPhone 17',
          ios_version: '18.7',
          safari_version: '26.4',
          canvas_family: 'B' as const,
          status: 'launch' as const,
          is_default: true,
        },
      ],
    };
    const request = vi.fn(() => Promise.resolve(response));
    const resource = new ArchetypesResource({ request } as unknown as HttpClient);

    await expect(resource.list()).resolves.toEqual(response);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/archetypes' });
  });
});
