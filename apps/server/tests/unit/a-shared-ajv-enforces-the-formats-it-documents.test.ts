// V-1550/V-1551 — the shared spec-conformance Ajv does not validate formats, and
// the reason is that two different Ajv versions are installed.
//
// `createSpecAjv()` passes `validateFormats: false`. V-1550 recorded that as an
// Ajv 8 option inert under Ajv 6, could not explain why formats were off anyway,
// and said so rather than guessing. V-1551 resolved it, and the original reading
// was wrong in the way that matters:
//
//   node_modules/ajv                       6.15.0   hoisted from another dependency
//   apps/server/node_modules/ajv           8.20.0   what apps/server/package.json declares (^8.17.1)
//
// A `require('ajv')` from the repo root gets 6.15.0 and enforces formats; the
// helper, resolving from `apps/server`, gets 8.20.0 where `validateFormats: false`
// is a real option that really disables them. Confirmed from the instance rather
// than from the lockfile: its `opts` carry `strictSchema`, `strictTypes`,
// `loopEnum` and `code`, which are Ajv 8 keys, and `opts.format` is `undefined`
// where Ajv 6 would hold `'fast'`.
//
// So the helper does exactly what its comment says. The three response-conformance
// suites treat format assertions as advisory on purpose, and a `date-time` Ajv
// dislikes is not a contract violation.
//
// What this file guards is the version coupling. Nothing in the helper names a
// version, and the option that carries the intent is silently inert against the
// copy of Ajv one directory up. A dependency bump, a hoist change, or a lockfile
// refresh that makes `apps/server` resolve the 6.x copy switches formats ON and
// makes three response-conformance suites stricter at once, in a diff whose
// subject is dependencies.
//
// Turning formats on may well be the right call. This file does not argue either
// way; it makes the switch a decision instead of a side effect.
//
// ⚠️ NOT established: whether the interop cast the helper performs is still needed
// under Ajv 8. `apps/server/tsconfig.json` sets `exclude: ["tests"]`, so a probe
// importing Ajv directly reports nothing — a deliberate type error in that probe
// produced no diagnostic either. The question is open because the instrument that
// would answer it does not look at this directory.

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
