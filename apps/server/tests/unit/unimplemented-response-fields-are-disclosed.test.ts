// A field the server cannot compute says so in the schema customers read.
//
// `GET /v1/account/me/bundled-llm-status` returns `refused_count_this_month`, a
// REQUIRED field in the published `BundledLlmStatus` schema. The handler
// hardcodes it to `0`, and the schema carried no description — so a customer
// read it as a measurement.
//
// It is not one, and refusals are not hypothetical. A turn past the monthly cap
// is rejected with `BundledLlmBudgetExhaustedError`, and the same code path
// increments `bundledLlmErrorTotal{kind:'budget_exhausted'}`. Refusals happen and
// are counted — for OPERATORS, in Prometheus. Nothing persists a per-account
// count, so the customer-facing field has nothing to read and reports zero
// regardless. Someone who exhausts their cap, receives budget-exhausted errors,
// and then opens their status page is told none happened.
//
// Three options were weighed. Computing it truthfully needs per-account
// persistence, which is a feature rather than a fix. Removing the field breaks
// every generated client, because it is `required` and typed `number`. So the
// contract is made honest instead: the schema states the limitation, the handler
// says why the literal is there, and this file keeps the two together.
//
// The rule this encodes: an unimplemented field must be DISCLOSED where it is
// published, not only where it is written. A code comment protects the next
// engineer; the schema description protects the customer, and the customer is
// the one who cannot read the code.
//
// SELF-OBSOLETING. The disclosure is required only while the value is a literal.
// When a real counter lands, the handler stops hardcoding, this file fails, and
// the failure says to remove the disclosure — so the schema cannot keep
// apologising for a limitation that no longer exists.
//
// Swept before writing: exactly ONE response field across every customer-facing
// route is assigned a constant placeholder, so this is an isolated case rather
// than the first of many. Three other candidates turned up as spec properties no
// route appeared to assign; all three were false positives — two were request
// schemas, where the client supplies the value, and the third used optional
// property syntax (`liveness?:`) that the scan could not match.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO, 'packages', 'sdk-python', 'openapi.json');
const HANDLER = resolve(HERE, '..', '..', 'src', 'routes', 'account-bundled-llm.ts');

/** The published description for a property of a component schema. */
function describedAs(schema: string, property: string): string {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    components?: {
      schemas?: Record<string, { properties?: Record<string, { description?: string }> }>;
    };
  };
  const prop = spec.components?.schemas?.[schema]?.properties?.[property];
  expect(prop, `${schema}.${property} exists in the published spec`).toBeDefined();
  return prop?.description ?? '';
}

describe('an unimplemented response field is disclosed where it is published', () => {
  it('CRITICAL the field is still REQUIRED and still published. If it were optional or gone, a customer could not be misled by it and this file would be guarding nothing — the disclosure matters precisely because a generated client types it as always present.', () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
      components?: { schemas?: Record<string, { required?: string[] }> };
    };
    const required = spec.components?.schemas?.BundledLlmStatus?.required ?? [];
    expect(required, 'BundledLlmStatus still marks the field required').toContain(
      'refused_count_this_month',
    );
  });

  it('CRITICAL the handler still hardcodes it, which is what makes the disclosure necessary. A guard for a limitation that has been fixed is worse than no guard: it keeps an apology in the customer-facing schema for behaviour that no longer applies.', () => {
    const src = readFileSync(HANDLER, 'utf8');
    expect(src, 'the value is still a literal rather than computed').toMatch(
      /^\s*refused_count_this_month: 0,\s*$/m,
    );
  });

  it('CRITICAL the published schema DISCLOSES that the field is not implemented. A code comment protects the next engineer; the description protects the customer, who cannot read the code and is the one reconciling this against errors they actually received.', () => {
    const description = describedAs('BundledLlmStatus', 'refused_count_this_month');
    expect(description, 'the description is not empty').not.toBe('');
    expect(description.toUpperCase(), 'it states the field is unimplemented').toContain(
      'NOT YET IMPLEMENTED',
    );
    expect(description, 'and that the value is always zero').toMatch(/always 0/i);
  });

  it('CRITICAL the disclosure says refusals DO happen. "Always 0" alone reads as "nothing was refused", which is the same false impression in fewer words — the description has to distinguish "we did not count" from "there was nothing to count".', () => {
    const description = describedAs('BundledLlmStatus', 'refused_count_this_month');
    expect(description, 'refusals are stated to occur').toMatch(/refusals do occur/i);
    expect(description, 'and the reason the count is unavailable is given').toMatch(
      /no per-account counter/i,
    );
  });
});
