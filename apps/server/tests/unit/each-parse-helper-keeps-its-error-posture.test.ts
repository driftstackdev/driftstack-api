// V-1922. `parseOrThrow` is copy-pasted into six route files, and the six do not
// agree on what a failed parse tells the caller. That disagreement is correct:
//
//   • staff-scoped routes (driftstack_internal_admin) pass `result.error.message`
//     through — an operator reading a raw Zod message is fine.
//   • customer-scoped routes (read:billing) replace it with a fixed sentence, and
//     both say why: "Don't leak the raw serialized zod error (full issue/path
//     JSON) into the customer-facing problem detail".
//   • oauth.ts serves PUBLIC endpoints and passes the message deliberately, with
//     an RFC 6749 `error` code attached — V-753, so integrators can branch on
//     `error` rather than string-matching Zod prose.
//
// Nothing pinned any of that. A seventh copy, or a customer route pasting the
// staff form, changes the posture silently — and it is not cosmetic: a Zod
// message can carry the REJECTED VALUE (`z.enum` puts it in `received`, and it
// survives `.flatten()` — V-1920), so the difference between these two branches
// is the difference between echoing a caller's rejected input and not.
//
// The set is frozen by name AND posture, so both directions red: a new copy, and
// a changed one. Adding a route is meant to fail this test — the fix is to choose
// a posture deliberately and record it here.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');

type Posture = 'raw-zod-message' | 'fixed-sentence';

/**
 * What this copy hands the caller when the parse fails: the Zod message itself,
 * or a sentence written by hand. Judged from the AST — a `throw` whose argument
 * list reaches `result.error.message` is raw; one built only from string literals
 * is fixed.
 */
function postureOf(fn: ts.FunctionDeclaration): Posture {
  let reachesZodMessage = false;
  const walk = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'message' &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'error'
    ) {
      reachesZodMessage = true;
    }
    ts.forEachChild(node, walk);
  };
  const findThrows = (node: ts.Node): void => {
    if (ts.isThrowStatement(node)) walk(node);
    ts.forEachChild(node, findThrows);
  };
  if (fn.body !== undefined) findThrows(fn.body);
  return reachesZodMessage ? 'raw-zod-message' : 'fixed-sentence';
}

export function parseHelperPostures(
  sources: { file: string; text: string }[],
): [string, Posture][] {
  const rows: [string, Posture][] = [];
  for (const { file, text } of sources) {
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'parseOrThrow') {
        rows.push([file, postureOf(node)]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return rows.sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Frozen 2026-08-27. Each posture is a decision, not an accident — see the header.
 * Changing one, or adding a seventh copy, must be deliberate.
 */
const EXPECTED: [string, Posture][] = [
  ['account-cost.ts', 'fixed-sentence'],
  ['admin-cost.ts', 'raw-zod-message'],
  ['admin-crypto-orders.ts', 'raw-zod-message'],
  ['admin-usage.ts', 'raw-zod-message'],
  ['billing-crypto-orders.ts', 'fixed-sentence'],
  ['oauth.ts', 'raw-zod-message'],
];

function routeSources(): { file: string; text: string }[] {
  return EXPECTED.map(([file]) => ({
    file,
    text: readFileSync(resolve(ROUTES_DIR, file), 'utf8'),
  }));
}

describe('each parseOrThrow copy keeps its error posture', () => {
  it('every copy still answers the way it was recorded', () => {
    expect(parseHelperPostures(routeSources())).toEqual(EXPECTED);
  });

  it('no SEVENTH copy has appeared in routes/', () => {
    // Read from disk rather than from EXPECTED, or the arm above could never
    // notice a new file: it only opens the six it already knows.
    const withHelper = readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) =>
        readFileSync(resolve(ROUTES_DIR, f), 'utf8').includes('function parseOrThrow<T>'),
      )
      .sort();
    expect(withHelper).toEqual(EXPECTED.map(([file]) => file));
  });

  // Without these the arms above cannot tell a working classifier from one that
  // returns the same answer for everything.
  it('classifies both postures from source, and finds nothing where there is no helper', () => {
    const raw = `function parseOrThrow<T>(s: any, i: unknown): T {
  const result = s.safeParse(i);
  if (!result.success) throw new BadRequestError(result.error.message);
  return result.data;
}`;
    const fixed = `function parseOrThrow<T>(s: any, i: unknown): T {
  const result = s.safeParse(i);
  if (!result.success) throw new BadRequestError('Invalid request parameters.');
  return result.data;
}`;
    expect(parseHelperPostures([{ file: 'a.ts', text: raw }])).toEqual([
      ['a.ts', 'raw-zod-message'],
    ]);
    expect(parseHelperPostures([{ file: 'b.ts', text: fixed }])).toEqual([
      ['b.ts', 'fixed-sentence'],
    ]);
    expect(parseHelperPostures([{ file: 'c.ts', text: 'export const x = 1;' }])).toEqual([]);
  });
});
