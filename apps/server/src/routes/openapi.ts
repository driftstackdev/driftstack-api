// Serve the OpenAPI spec at /openapi.json and Scalar UI at /docs.

import type { FastifyInstance } from 'fastify';
import scalarApiReference from '@scalar/fastify-api-reference';
import { generateOpenApiSpec } from '../lib/openapi.js';

export async function registerOpenApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/openapi.json', () => generateOpenApiSpec());

  await app.register(scalarApiReference, {
    routePrefix: '/docs',
    configuration: {
      url: '/openapi.json',
      theme: 'default',
      hideClientButton: true,
    },
  });
}
