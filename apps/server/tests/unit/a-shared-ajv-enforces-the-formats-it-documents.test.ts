// V-1550 — the shared spec-conformance Ajv does not validate formats, and the
// option it names is not what stops it.
//
// `createSpecAjv()` passes `validateFormats: false`, which is an **Ajv 8** option.
// This repo runs Ajv 6.15, and Ajv 6 ignores it: constructed directly,
// `new Ajv({ allErrors: true, strict: false, validateFormats: false })` still
// rejects `not-a-uuid`. The only Ajv 6 option that turns formats off is
// `format: false`, which the helper does not pass.
//
// The helper's instance nonetheless accepts `not-a-uuid`, and its `_opts.format`
// reads `undefined` where a real Ajv 6 instance carries `'fast'`. WHAT disables
// them is not established here: the obvious suspect is the interop cast this
// helper exists to perform, and resolving `.default` off the module before
// constructing did NOT switch formats on, so that guess is unproven and is not
// asserted. The measurement stands on its own — through this helper, formats are
// not enforced; constructed directly with the same options, they are.
//
// The BEHAVIOUR matches the helper's stated intent, so nothing is wrong to fix:
// format assertions are advisory, and a `date-time` Ajv dislikes is not a
// contract violation. What is fragile is that the intent rests on something other
// than the option that documents it. Whatever is holding formats off is not named
// anywhere, so a future edit to this helper can switch them ON and make three
// response-conformance suites stricter at once, with no line in that diff
// mentioning formats.
//
// This file pins the behaviour so that change cannot arrive silently. It is
// deliberately NOT a claim that formats should stay off — it is a claim that
// turning them on is a decision someone makes on purpose.

import { describe, expect, it } from 'vitest';
import { createSpecAjv } from '../integration/_helpers/ajv.js';

const FORMAT_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ['uuid', 'not-a-uuid', '5f2b1c3d-4e5a-4b6c-8d9e-0f1a2b3c4d5e'],
  ['email', 'nope', 'someone@driftstack.dev'],
  ['date-time', 'yesterday', '2026-08-24T12:00:00Z'],
];

describe('the shared spec Ajv and the formats it does not enforce', () => {
  it('CRITICAL compiles and validates at all, so the arm below is not passing because every schema is inert. A validator that accepted everything would satisfy an assertion about acceptance perfectly, which is the shape this whole helper could silently become.', () => {
    const ajv = createSpecAjv();
    const typeCheck = ajv.compile({ type: 'string' });
    expect(typeCheck('a string'), 'a valid string is accepted').toBe(true);
    expect(typeCheck(42), 'a number is rejected against type: string').toBe(false);

    for (const [format, , good] of FORMAT_CASES) {
      expect(
        ajv.compile({ type: 'string', format })(good),
        `a well-formed ${format} is accepted`,
      ).toBe(true);
    }
  });

  it("CRITICAL format assertions are NOT enforced, which is the helper's stated intent reached by an accident rather than by the option it names. `validateFormats` is an Ajv 8 key and this is Ajv 6.15, and constructing Ajv directly with the same options DOES enforce formats — so something in this helper's module resolution holds them off, and this file does not guess which. If that changes, three response-conformance suites begin rejecting a `date-time` Ajv dislikes — a real behaviour change that would otherwise appear in a diff about module interop.", () => {
    const ajv = createSpecAjv();
    const enforced: string[] = [];
    for (const [format, bad] of FORMAT_CASES) {
      if (ajv.compile({ type: 'string', format })(bad) === false) enforced.push(format);
    }
    expect(
      enforced.sort(),
      'the shared Ajv started enforcing formats — three spec-conformance suites just got stricter; ' +
        'confirm that was intended and update this file in the same commit',
    ).toEqual([]);
  });
});
