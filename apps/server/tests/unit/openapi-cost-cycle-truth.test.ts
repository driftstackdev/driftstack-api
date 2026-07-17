// Public-contract invariant for the runtime's strict cost-month authority.
// Impossible calendar months must not remain client-valid in OpenAPI after the
// customer/admin routes reject them.

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

function refName(value: unknown, label: string): string {
  const ref = object(value, label).$ref;
  expect(typeof ref, `${label} $ref`).toBe('string');
  return (ref as string).split('/').at(-1) as string;
}

describe('cost billing-cycle OpenAPI truth', () => {
  const spec = generateOpenApiSpec() as unknown as JsonObject;
  const paths = object(spec.paths, 'paths');
  const schemas = object(object(spec.components, 'components').schemas, 'component schemas');

  it('publishes one named strict UTC calendar-month component', () => {
    const cycle = object(schemas.BillingCycle, 'BillingCycle');
    expect(cycle.type).toBe('string');
    expect(cycle.pattern).toBe('^\\d{4}-(?:0[1-9]|1[0-2])$');
    expect(cycle.example).toBe('2026-07');
    expect(cycle.description).toMatch(/UTC calendar month/);
  });

  it.each(['/v1/account/cost', '/v1/admin/cost/accounts/{id}', '/v1/admin/cost/overview'] as const)(
    'uses BillingCycle for the %s query',
    (path) => {
      const operation = object(object(paths[path], path).get, `${path} GET`);
      const parameters = array(operation.parameters, `${path} parameters`);
      const parameterValue = parameters.find(
        (candidate) => object(candidate, `${path} parameter`).name === 'billing_cycle',
      );
      const parameter = object(parameterValue, `${path} billing_cycle parameter`);
      expect(parameter.name).toBe('billing_cycle');
      expect(refName(parameter.schema, `${path} billing_cycle schema`)).toBe('BillingCycle');
    },
  );

  it('uses BillingCycle in both customer and admin response rows', () => {
    const customer = object(schemas.AccountCostResponse, 'AccountCostResponse');
    expect(
      refName(
        object(customer.properties, 'AccountCostResponse properties').billing_cycle,
        'customer billing_cycle',
      ),
    ).toBe('BillingCycle');

    const adminPath = object(paths['/v1/admin/cost/accounts/{id}'], 'admin cost path');
    const response = object(
      object(object(adminPath.get, 'admin cost GET').responses, 'admin responses')['200'],
      'admin 200',
    );
    const media = object(
      object(response.content, 'admin content')['application/json'],
      'admin JSON',
    );
    const summary = object(media.schema, 'admin summary');
    expect(
      refName(object(summary.properties, 'admin summary properties').billing_cycle, 'admin cycle'),
    ).toBe('BillingCycle');
  });
});
