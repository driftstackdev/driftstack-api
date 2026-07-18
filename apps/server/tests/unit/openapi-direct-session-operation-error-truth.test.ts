// Runtime direct-session operations share one atomic ready→busy owner. The
// generated and frozen OpenAPI contracts must publish the resulting 409 wait
// versus 410 fresh-session distinction on every operation, or generated
// clients can make the wrong recovery decision.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';

type JsonObject = Record<string, unknown>;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SNAPSHOT = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

const DIRECT_OPERATIONS = [
  { method: 'post', path: '/v1/sessions/{id}/navigate', extraStatuses: ['504'] },
  { method: 'post', path: '/v1/sessions/{id}/interact', extraStatuses: ['504'] },
  { method: 'post', path: '/v1/sessions/{id}/wait', extraStatuses: [] },
  { method: 'get', path: '/v1/sessions/{id}/state', extraStatuses: [] },
  { method: 'post', path: '/v1/sessions/{id}/capture', extraStatuses: [] },
  { method: 'post', path: '/v1/sessions/{id}/extract', extraStatuses: [] },
  { method: 'post', path: '/v1/sessions/{id}/search', extraStatuses: [] },
  { method: 'post', path: '/v1/sessions/{id}/login', extraStatuses: [] },
] as const;

const COMMON_STATUSES = ['200', '400', '401', '403', '404', '409', '410', '429', '502', '503'];

function object(value: unknown, label: string): JsonObject {
  expect(value, label).not.toBeNull();
  expect(typeof value, label).toBe('object');
  expect(Array.isArray(value), label).toBe(false);
  return value as JsonObject;
}

function responsesOf(spec: JsonObject, path: string, method: string): JsonObject {
  const paths = object(spec.paths, 'paths');
  const pathItem = object(paths[path], path);
  const operation = object(pathItem[method], `${method.toUpperCase()} ${path}`);
  return object(operation.responses, `${method.toUpperCase()} ${path} responses`);
}

function sortedStatuses(responses: JsonObject): string[] {
  return Object.keys(responses).sort((left, right) => Number(left) - Number(right));
}

function expectProblemResponse(response: JsonObject, label: string): void {
  const content = object(response.content, `${label} content`);
  const media = object(content['application/problem+json'], `${label} problem media`);
  const schema = object(media.schema, `${label} problem schema`);
  expect(schema.$ref).toBe('#/components/schemas/Problem');
}

describe('direct-session operation OpenAPI error truth', () => {
  const live = generateOpenApiSpec() as unknown as JsonObject;
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as JsonObject;

  it.each(DIRECT_OPERATIONS)(
    '$method $path publishes exact live and frozen response status sets',
    ({ method, path, extraStatuses }) => {
      const liveResponses = responsesOf(live, path, method);
      const snapshotResponses = responsesOf(snapshot, path, method);
      const expected = [...COMMON_STATUSES, ...extraStatuses].sort(
        (left, right) => Number(left) - Number(right),
      );

      expect(sortedStatuses(liveResponses)).toEqual(expected);
      expect(sortedStatuses(snapshotResponses)).toEqual(expected);
      for (const status of expected) {
        const liveResponse = object(liveResponses[status], `${method} ${path} live ${status}`);
        const snapshotResponse = object(
          snapshotResponses[status],
          `${method} ${path} snapshot ${status}`,
        );
        expect(snapshotResponse.description).toBe(liveResponse.description);
      }
    },
  );

  it.each(DIRECT_OPERATIONS)(
    '$method $path distinguishes bounded 409 wait from terminal 410 recovery in both contracts',
    ({ method, path }) => {
      const liveResponses = responsesOf(live, path, method);
      const snapshotResponses = responsesOf(snapshot, path, method);
      const live409 = object(liveResponses['409'], `${method} ${path} live 409`);
      const live410 = object(liveResponses['410'], `${method} ${path} live 410`);
      const snapshot409 = object(snapshotResponses['409'], `${method} ${path} snapshot 409`);
      const snapshot410 = object(snapshotResponses['410'], `${method} ${path} snapshot 410`);

      expect(live409.description).toMatch(/creating/);
      expect(live409.description).toMatch(/busy/);
      expect(live409.description).toMatch(/ready/);
      expect(live409.description).toMatch(/retrying/);
      expect(live410.description).toMatch(/terminal/);
      expect(live410.description).toMatch(/fresh session/);
      expect(live410.description).toMatch(/instead of retrying/);
      expectProblemResponse(live409, `${method} ${path} live 409`);
      expectProblemResponse(live410, `${method} ${path} live 410`);
      expect(snapshot409.description).toBe(live409.description);
      expect(snapshot410.description).toBe(live410.description);
      expect(snapshot409.content).toEqual(live409.content);
      expect(snapshot410.content).toEqual(live410.content);
    },
  );

  it.each(DIRECT_OPERATIONS)(
    '$method $path publishes driver failure/unavailable and only truthful timeout outcomes',
    ({ method, path, extraStatuses }) => {
      const liveResponses = responsesOf(live, path, method);
      const driverFailure = object(liveResponses['502'], `${method} ${path} live 502`);
      const unavailable = object(liveResponses['503'], `${method} ${path} live 503`);

      expect(driverFailure.description).toMatch(/browser driver failed/);
      expect(driverFailure.description).toMatch(/terminal/);
      expect(unavailable.description).toMatch(/unavailable in this deployment/);
      expect(unavailable.description).toMatch(/terminal/);
      expect(unavailable.description).toMatch(/fresh session/);
      expectProblemResponse(driverFailure, `${method} ${path} live 502`);
      expectProblemResponse(unavailable, `${method} ${path} live 503`);

      if (extraStatuses.length > 0) {
        const timeout = object(liveResponses['504'], `${method} ${path} live 504`);
        expect(timeout.description).toMatch(/time budget/);
        expect(timeout.description).toMatch(/terminal/);
        expectProblemResponse(timeout, `${method} ${path} live 504`);
      } else {
        expect(liveResponses).not.toHaveProperty('504');
      }
    },
  );

  it.each([
    { method: 'get', path: '/v1/sessions/{id}' },
    { method: 'delete', path: '/v1/sessions/{id}' },
  ])('$method $path does not inherit direct-operation 409/410 responses', ({ method, path }) => {
    for (const spec of [live, snapshot]) {
      const responses = responsesOf(spec, path, method);
      expect(responses).not.toHaveProperty('409');
      expect(responses).not.toHaveProperty('410');
    }
  });
});
