// One correctly-typed Ajv constructor for the spec-conformance suites.
//
// Three tests validate live response bodies against the published OpenAPI
// schemas, and all three set Ajv up identically. All three also failed `tsc`
// identically — twelve errors between them — which is why the typecheck guard
// covers server source only and excludes tests.
//
// The cause is not a mistake in those tests. Ajv 6 ships CommonJS declarations
// that merge a `var` with a namespace and `export =` the pair:
//
//     declare var ajv: { new (opts?): Ajv; ... };
//     declare namespace ajv { interface Ajv { ... } }
//     export = ajv;
//
// Under `module: NodeNext` a default import of that binds the NAMESPACE, so
// `Ajv` is not usable as a type (TS2709) and `new Ajv(...)` is not constructable
// (TS2351). Both complaints are about the declarations predating ESM, not about
// the runtime: the code works, and the suite has been green throughout.
//
// So the interop cast is the fix, and the point of this file is that it is
// written ONCE, next to the reason, instead of three times with none. A cast
// repeated across files is where someone eventually widens one of them.
//
// THE TYPES COME IN BY NAME, and that detail is not cosmetic. `tsc` runs on
// `tsconfig.test.json` (NodeNext) while eslint runs on `tsconfig.eslint.json`
// (`moduleResolution: bundler`), and the two disagree about this package:
// reaching the instance type through the namespace — `AjvModule.Ajv` — satisfies
// NodeNext and becomes an unresolvable `error` type under bundler, which then
// spreads through every member access as no-unsafe-call / no-unsafe-member-access.
// A named type import satisfies BOTH. Verified against each toolchain rather
// than reasoned about; the namespace form passed tsc and produced 38 eslint
// errors.

import AjvModule from 'ajv';
import type { Ajv as AjvNamed, Options as AjvOptions, ErrorObject } from 'ajv';

/** The instance type — reachable only through the namespace, per the above. */
export type AjvInstance = AjvNamed;

/** Validation error shape, likewise namespace-scoped. */
export type AjvErrorObject = ErrorObject;

/**
 * The constructor, typed. The cast is confined to this line: `AjvModule` is the
 * namespace binding in type space but the callable at runtime, and only an
 * assertion can say so.
 */
const AjvConstructor = AjvModule as unknown as new (options?: AjvOptions) => AjvInstance;

/**
 * An Ajv configured the way every spec-conformance suite here needs it.
 *
 * `strict: false` because the published spec is OpenAPI 3.1, whose keywords Ajv
 * 6 does not all recognise; `validateFormats: false` because format assertions
 * are advisory in JSON Schema and a `date-time` that Ajv rejects is not a
 * contract violation. Both were already set identically at all three call
 * sites — centralised rather than changed.
 */
export function createSpecAjv(): AjvInstance {
  return new AjvConstructor({ allErrors: true, strict: false, validateFormats: false });
}
