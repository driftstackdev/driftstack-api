import { describe, expect, it } from 'vitest';
import { fixedApiErrorMessage, validationFieldNames } from '../../src/lib/api-errors';
import { humanizeError } from '../../src/lib/humanize-error';

/**
 * The owner hit `POST /v1/agent-sessions → 400` whose only customer-facing text
 * was "Some information was not accepted. Check your input and try again."
 * True, and unactionable. The cause was a `model` the deployed server's enum did
 * not know, and finding it took reading the route's Zod schema and comparing the
 * deployed SHA against main.
 *
 * ⭐ The server HAD said which field — `ValidationError.issues` carries the Zod
 * `flatten()` — and the GUI never read it. The message read identically whether
 * the model, the proxy id or the token budget was rejected.
 */

describe('a 400 names the field it rejected', () => {
  it('extracts field names from a Zod flatten()', () => {
    expect(
      validationFieldNames({ formErrors: [], fieldErrors: { model: ['Invalid enum value'] } }),
    ).toEqual(['model']);
  });

  it('puts the field into the customer-facing message', () => {
    const msg = fixedApiErrorMessage(
      'https://errors.driftstack.dev/validation-failed',
      400,
      undefined,
      ['model'],
    );
    expect(msg).toContain('model');
    // Still ends with an instruction; naming the field replaces nothing.
    expect(msg).toMatch(/try again/i);
  });

  it('falls back to the generic message when the server named nothing', () => {
    const msg = fixedApiErrorMessage('https://errors.driftstack.dev/validation-failed', 400);
    expect(msg).toBe('Some information was not accepted. Check your input and try again.');
  });

  it('⛔ never reflects server PROSE into customer copy — names only', () => {
    // humanize-error.ts refuses to surface remote `detail`/`title` strings, and
    // that rule is right: a message is attacker-influenced in a way a field key
    // is not. So a hostile or malformed key is DROPPED, not rendered.
    expect(
      validationFieldNames({
        fieldErrors: {
          '<script>alert(1)</script>': ['x'],
          'Something went terribly wrong, call this number': ['x'],
          UPPER: ['x'],
          'has spaces': ['x'],
        },
      }),
    ).toEqual([]);
  });

  it('bounds how many fields it will name', () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`field_${String(i)}`, ['x']]),
    );
    expect(validationFieldNames({ fieldErrors: many })).toHaveLength(3);
  });

  it('survives every shape a server might actually send', () => {
    for (const junk of [
      null,
      undefined,
      42,
      'nope',
      [],
      { fieldErrors: null },
      { fieldErrors: [] },
    ]) {
      expect(validationFieldNames(junk)).toEqual([]);
    }
  });

  it('end-to-end: a ValidationError from the SDK names its field', () => {
    // The exact shape the owner's failure produced.
    const err = Object.assign(new Error('validation'), {
      name: 'ValidationError',
      kind: 'validation',
      status: 400,
      issues: { formErrors: [], fieldErrors: { model: ['Invalid enum value'] } },
    });
    expect(humanizeError(err)).toContain('model');
  });
});
