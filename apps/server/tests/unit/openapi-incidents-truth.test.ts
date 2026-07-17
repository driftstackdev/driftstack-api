// Public-contract invariant for the incident/status lifecycle. The admin GUI,
// public status site and generated SDKs must see the executable field names,
// aggregate completeness signals and idempotent create surface.

import { describe, expect, it } from 'vitest';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  expect(value, label).not.toBeNull();
  expect(typeof value, label).toBe('object');
  expect(Array.isArray(value), label).toBe(false);
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
}

describe('incident lifecycle OpenAPI truth', () => {
  const spec = generateOpenApiSpec() as unknown as JsonObject;
  const paths = object(spec.paths, 'paths');

  function operation(path: string, method: string): JsonObject {
    return object(object(paths[path], path)[method], `${method.toUpperCase()} ${path}`);
  }

  function responseSchema(path: string, method: string, status: string): JsonObject {
    const responses = object(operation(path, method).responses, `${path} responses`);
    const response = object(responses[status], `${path} ${status}`);
    const content = object(response.content, `${path} ${status} content`);
    return object(
      object(content['application/json'], `${path} ${status} JSON`).schema,
      `${path} ${status} schema`,
    );
  }

  function bodySchema(path: string, method: string): JsonObject {
    const requestBody = object(operation(path, method).requestBody, `${path} request body`);
    const content = object(requestBody.content, `${path} request content`);
    return object(
      object(content['application/json'], `${path} request JSON`).schema,
      `${path} body schema`,
    );
  }

  function query(path: string, method: string): Map<string, JsonObject> {
    const parameters = array(operation(path, method).parameters, `${path} parameters`).map(
      (value, index) => object(value, `${path} parameter ${index.toString()}`),
    );
    return new Map(
      parameters
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) => [parameter.name as string, object(parameter.schema, 'query schema')]),
    );
  }

  it('publishes executable incident field names and active-only initial status', () => {
    for (const method of ['post', 'put']) {
      const schema = bodySchema('/v1/admin/incidents' + (method === 'put' ? '/{id}' : ''), method);
      const properties = object(schema.properties, `${method} create properties`);
      expect(properties).toHaveProperty('description');
      expect(properties).toHaveProperty('affected_components');
      expect(properties).not.toHaveProperty('body');
      expect(properties).not.toHaveProperty('components_affected');
      expect(array(object(properties.status, 'create status').enum, 'create status enum')).toEqual([
        'investigating',
        'identified',
        'monitoring',
      ]);
      const required = array(schema.required, `${method} create required`);
      expect(required).toContain('description');
      if (method === 'put') expect(required).toContain('started_at');
      else expect(required).not.toContain('started_at');
    }

    const created = responseSchema('/v1/admin/incidents', 'post', '201');
    const incident = object(object(created.properties, 'create response').incident, 'incident');
    const incidentProperties = object(incident.properties, 'incident properties');
    expect(incidentProperties).toHaveProperty('description');
    expect(incidentProperties).toHaveProperty('affected_components');
    expect(incidentProperties).toHaveProperty('created_at');
    expect(incidentProperties).toHaveProperty('updated_at');
  });

  it('publishes exact admin pagination/open aggregates and excludes public-only window', () => {
    const parameters = query('/v1/admin/incidents', 'get');
    expect([...parameters.keys()].sort()).toEqual(['cursor', 'limit', 'scope', 'since', 'state']);
    expect(array(object(parameters.get('state'), 'state schema').enum, 'state enum')).toEqual([
      'open',
      'resolved',
      'all',
    ]);

    const response = responseSchema('/v1/admin/incidents', 'get', '200');
    const properties = object(response.properties, 'admin list properties');
    expect(Object.keys(properties).sort()).toEqual([
      'data',
      'has_more',
      'next_cursor',
      'open_count',
      'total',
    ]);
    expect(array(response.required, 'admin list required').sort()).toEqual(
      Object.keys(properties).sort(),
    );
  });

  it('publishes idempotent same-id create/replay and exact mutation bodies', () => {
    const put = operation('/v1/admin/incidents/{id}', 'put');
    const responses = object(put.responses, 'PUT incident responses');
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '201', '409']));
    for (const status of ['200', '201']) {
      const schema = responseSchema('/v1/admin/incidents/{id}', 'put', status);
      const properties = object(schema.properties, `PUT ${status} properties`);
      expect(array(object(properties.outcome, 'outcome').enum, 'outcome enum')).toEqual([
        'created',
        'replayed',
      ]);
      expect(properties).toHaveProperty('incident');
      expect(properties).toHaveProperty('updates');
    }

    const update = bodySchema('/v1/admin/incidents/{id}/updates', 'post');
    expect(Object.keys(object(update.properties, 'update properties')).sort()).toEqual([
      'message',
      'status',
    ]);
    const resolve = bodySchema('/v1/admin/incidents/{id}/resolve', 'post');
    const reopen = bodySchema('/v1/admin/incidents/{id}/reopen', 'post');
    expect(Object.keys(object(resolve.properties, 'resolve properties'))).toEqual(['message']);
    expect(Object.keys(object(reopen.properties, 'reopen properties'))).toEqual(['message']);
  });

  it('publishes all-time public-open aggregates and bounded resolved-history controls', () => {
    const parameters = query('/v1/status/incidents', 'get');
    expect([...parameters.keys()].sort()).toEqual(['limit', 'since', 'window']);
    expect(array(object(parameters.get('window'), 'window schema').enum, 'window enum')).toEqual([
      '30d',
      '90d',
    ]);

    const response = responseSchema('/v1/status/incidents', 'get', '200');
    const properties = object(response.properties, 'public feed properties');
    expect(Object.keys(properties).sort()).toEqual([
      'data',
      'open_count',
      'open_outage_count',
      'total',
      'truncated',
    ]);
    const item = object(object(properties.data, 'public data').items, 'public incident item');
    expect(object(item.properties, 'public incident properties')).toHaveProperty('description');
  });

  it('withholds operational all-clear when incident storage is incomplete', () => {
    const response = responseSchema('/v1/status', 'get', '200');
    const properties = object(response.properties, 'status properties');
    expect(properties).toHaveProperty('open_incidents');
    expect(properties).toHaveProperty('incident_data_complete');
    expect(array(response.required, 'status required')).toEqual(
      expect.arrayContaining(['open_incidents', 'incident_data_complete']),
    );
  });
});
