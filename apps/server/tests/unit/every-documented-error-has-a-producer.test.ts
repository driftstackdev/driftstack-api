// Every error we publish is an error something can actually raise.
//
// The problem-type roster is customer-facing twice over: `/docs/error-codes`
// lists it, and all three SDKs branch on it. An entry nobody raises is a
// documented failure mode that cannot occur — customers write a handler for it,
// the handler is dead, and nothing says so.
//
// THE DOCS DIRECTION IS ALREADY GUARDED. `docs-problem-type-uris-parity` checks
// that every URI cited in a docs page exists in `PROBLEM_TYPES`, so we cannot
// document a type that does not exist. The reverse was not checked: a roster
// entry with no producer passed everything.
//
// That gap has been exploited once already. `docs-oauth-content-parity` required
// the docs to list every OAuth code and verified it with
// `expect(serviceSource).toMatch(/'code'/)` — which the TYPE UNION satisfies on
// its own. So it read as "the service can emit this" while proving only "the
// identifier appears in the file", and pushed an unreachable
// `401 unauthorized_client` row into customer docs.
//
// The same shape is available here, because every `PROBLEM_TYPES.X` in this
// codebase appears exactly ONCE outside the roster — inside an error class in
// `lib/errors.ts`. That single reference is a MAPPING, not a producer: it says
// "if this class is raised, it carries this type". Counting those references
// would report 23 of 23 covered while proving nothing about whether any of them
// can occur.
//
// So this follows the chain to the end: roster entry → error class → a `new`
// somewhere that is not the class's own definition.
//
// MEASURED at the time of writing: 33 classes, every one constructed in
// production source, the busiest being NotFoundError (145) and BadRequestError
// (127), the quietest ByokAnthropicRequired / BundledLlmConsentRequired /
// LegalAcceptanceRequired / the auth-flow four at 2 each. A count of 2 is thin
// but real; a count of 0 is fiction, and that is the line this draws.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ERRORS = resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');

/** Every error class declared in the taxonomy. */
function declaredErrorClasses(): string[] {
  return [...readFileSync(ERRORS, 'utf8').matchAll(/^export class ([A-Za-z]+)/gm)]
    .map(([, name]) => name)
    .filter((n): n is string => n !== undefined);
}

/**
 * Production source, excluding the taxonomy itself.
 *
 * `lib/errors.ts` is excluded because a class constructing itself — a subclass
 * calling `super`, or a factory beside the definition — is not evidence that
 * anything raises it. Tests are excluded for the same reason: a class raised
 * only by its own unit test is still unreachable in production.
 */
function productionSourceOutsideTaxonomy(): string {
  const chunks: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'migrations') walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || full === ERRORS) continue;
      chunks.push(readFileSync(full, 'utf8'));
    }
  };
  walk(SERVER_SRC);
  return chunks.join('\n');
}

/** Which error class carries each problem type, per the taxonomy. */
function classByProblemType(): Map<string, string> {
  const source = readFileSync(ERRORS, 'utf8');
  const byType = new Map<string, string>();
  let current: string | undefined;
  for (const line of source.split('\n')) {
    const declared = /^export class ([A-Za-z]+)/.exec(line)?.[1];
    if (declared !== undefined) current = declared;
    const used = /PROBLEM_TYPES\.([A-Za-z]+)/.exec(line)?.[1];
    if (used !== undefined && current !== undefined && !byType.has(used)) byType.set(used, current);
  }
  return byType;
}

describe('every documented error has a producer', () => {
  it('CRITICAL the taxonomy and the production scan were both read. The arm below asks "which classes are never constructed", and an empty class list has none — while an empty source scan would report every class unreachable. Both failure directions are silent, so both are measured.', () => {
    const classes = declaredErrorClasses();
    // MEASURED: 33 exported error classes.
    expect(classes.length, 'error classes declared in lib/errors.ts').toBeGreaterThanOrEqual(30);
    const source = productionSourceOutsideTaxonomy();
    expect(source.length, 'bytes of production source scanned').toBeGreaterThan(500_000);
    // The scan must be able to see a construction it is looking for.
    expect(source, 'and it contains real construction sites').toMatch(/new NotFoundError\(/);
  });

  it('CRITICAL every error class is raised somewhere in production. A class nobody constructs is a failure mode customers are told to handle and can never receive — and all three SDKs branch on this roster, so the dead handler is written three times.', () => {
    const source = productionSourceOutsideTaxonomy();
    const unraised = declaredErrorClasses()
      .filter((name) => !source.includes(`new ${name}(`))
      .sort();
    expect(
      unraised,
      'error class(es) declared but never constructed outside the taxonomy:',
    ).toEqual([]);
  });

  it('CRITICAL every roster entry maps to a class. A `PROBLEM_TYPES` entry with no error class carrying it can only reach a customer if some route hand-builds the problem body — which bypasses the taxonomy, and with it the title/status pairing the error handler applies.', () => {
    const mapped = classByProblemType();
    const orphaned = Object.keys(PROBLEM_TYPES)
      .filter((key) => !mapped.has(key))
      .sort();
    expect(orphaned, 'roster entr(ies) no error class carries:').toEqual([]);
  });

  it('CRITICAL the mapping is not vacuous — it resolved real class names. If the scan paired every type with `undefined`, the arm above would still report nothing orphaned, having matched nothing at all.', () => {
    const mapped = classByProblemType();
    // MEASURED: 23 roster entries, each carried by exactly one class.
    expect(mapped.size, 'problem types mapped to a class').toBeGreaterThanOrEqual(20);
    const declared = new Set(declaredErrorClasses());
    const bogus = [...mapped.entries()]
      .filter(([, cls]) => !declared.has(cls))
      .map(([type, cls]) => `${type} -> ${cls}`)
      .sort();
    expect(bogus, 'type(s) mapped to something that is not a declared class:').toEqual([]);
  });
});
