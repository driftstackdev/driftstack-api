// V-1920. A request body must not be passed to a logger.
//
// Pino's `redact.paths` is keyed on exact paths, which is why
// `every-credential-header-is-redacted-in-logs` exists for headers. Bodies have
// no such list at all: a logged body is scrubbed by nothing except whatever
// `redactText` happens to recognise, and that knows Driftstack's OWN minted
// prefixes — not a third party's. `POST /v1/mac-nodes/register` carries a
// LiveKit `api_secret` in its body and encrypts it on arrival precisely so the
// plaintext never leaves that scope; one `req.log.warn({ body: req.body })`
// anywhere in the request lifecycle undoes that, silently, for every route at
// once.
//
// The header guard's own reasoning is what generalises: the BYOK key and the
// GUI control key are scrubbed "even though the route never logs req.headers
// explicitly", against "a future refactor that adds a request-trace log". The
// body is the larger surface and had no equivalent.
//
// Measured clean when written: 137 `req.body` / `request.body` references in
// apps/server/src, none of them an argument to a logger call.
//
// This walks the AST rather than matching text, because the shape it must catch
// spans lines — `req.log.warn(\n  { body: req.body },\n  'msg',\n)` is the form a
// single-line grep misses, and it is the form a real refactor produces.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
// ⛔ TIMEOUT — this file is an I/O-bound census: it walks the source tree and
// parses every file with the TypeScript compiler. Its runtime scales with
// machine load, not with anything it asserts, so under contention it fails with
// "Test timed out" rather than an assertion — which reads as a regression in the
// thing being checked and is not one. Measured 2026-08-27: the nine census tests
// in this family run in 4.7s of test time COMBINED (~0.5s each) on a quiet box,
// and one of them still exceeded the 10s default during a full-suite run while a
// second workload held the machine at load 50.
//
// ⚠️ A test that only fails under load is the kind that gets re-run until green
// rather than fixed. The clock is not what protects this file: a wall-clock
// timeout fires on a busy box and passes on an idle one regardless of the code.
// What detects a walk that stopped finding things is the census assertion this
// file already carries — an exact count pin or a non-vacuity floor over the
// walked population. Because that assertion is doing the real work, giving the
// clock enough room to absorb contention costs no coverage. See V-1975.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, '..', '..', 'src');

const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

interface Offender {
  file: string;
  line: number;
  snippet: string;
}

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) tsFilesUnder(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** `<something>.body` where the object is a request-ish identifier. */
function isRequestBody(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  if (node.name.text !== 'body') return false;
  const target = node.expression;
  return ts.isIdentifier(target) && /^(req|request)$/.test(target.text);
}

/** `<x>.log.warn(...)` / `<x>.logger.info(...)` / `log.error(...)`. */
function isLoggerCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!LOG_METHODS.has(callee.name.text)) return false;
  const owner = callee.expression;
  if (ts.isIdentifier(owner)) return /^(log|logger)$/.test(owner.text);
  if (ts.isPropertyAccessExpression(owner)) return /^(log|logger)$/.test(owner.name.text);
  return false;
}

/**
 * Names that hold the request body, or something derived from it.
 *
 * Seeded from any declaration whose initializer mentions `req.body` — which
 * catches `const parsed = Schema.safeParse(req.body)` as well as a direct alias —
 * then extended to `const body = parsed.data` and repeated to a fixpoint, because
 * the parsed body is the object that actually carries the credential:
 * `mac-nodes-register` reads `body.livekit.api_secret` out of exactly that value.
 */
function bodyDerivedNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      declarations.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  for (const declaration of declarations) {
    if (!ts.isIdentifier(declaration.name)) continue;
    let mentionsBody = false;
    const scan = (n: ts.Node): void => {
      if (isRequestBody(n)) mentionsBody = true;
      ts.forEachChild(n, scan);
    };
    scan(declaration.initializer as ts.Node);
    if (mentionsBody) names.add(declaration.name.text);
  }

  // `const body = parsed.data`, and onwards, until nothing new is learned.
  for (let pass = 0; pass < 5; pass += 1) {
    const before = names.size;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const init = declaration.initializer;
      if (init === undefined || !ts.isPropertyAccessExpression(init)) continue;
      if (ts.isIdentifier(init.expression) && names.has(init.expression.text)) {
        names.add(declaration.name.text);
      }
    }
    if (names.size === before) break;
  }
  return names;
}

/**
 * A WHOLE-OBJECT use of a name. `body.mac_node_id` is how every route reads its
 * fields and must stay legal; `{ ...body }`, `{ body }`, `{ b: body }` and
 * `log.warn(body)` all hand over everything the schema allows — the shape V-1886
 * identified as the real risk, since a field added tomorrow rides along unseen.
 */
function isWholeObjectUse(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return false;
  if (ts.isElementAccessExpression(parent) && parent.expression === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  return true;
}

export function bodiesReachingALogger(sources: { file: string; text: string }[]): Offender[] {
  const offenders: Offender[] = [];
  for (const { file, text } of sources) {
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const derived = bodyDerivedNames(sourceFile);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isLoggerCall(node)) {
        // Collected rather than assigned to a `let`: TypeScript does not track
        // assignments made inside a closure, so a narrowed `string | null` reads
        // back as `never` at the use site.
        const reasons: string[] = [];
        const scan = (inner: ts.Node): void => {
          if (reasons.length > 0) return;
          if (isRequestBody(inner)) {
            reasons.push('req.body');
            return;
          }
          if (ts.isIdentifier(inner) && derived.has(inner.text) && isWholeObjectUse(inner)) {
            reasons.push(`body-derived '${inner.text}' passed whole`);
            return;
          }
          ts.forEachChild(inner, scan);
        };
        for (const arg of node.arguments) scan(arg);
        const reason = reasons[0];
        if (reason !== undefined) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          offenders.push({
            file,
            line: line + 1,
            snippet: `${reason} — ${node.getText().replace(/\s+/g, ' ').slice(0, 60)}`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return offenders;
}

describe('no request body reaches a logger', () => {
  it('finds no logger call carrying req.body anywhere in apps/server/src', () => {
    const sources = tsFilesUnder(SRC_DIR).map((file) => ({
      file: file.split(`${SRC_DIR}/`)[1] ?? file,
      text: readFileSync(file, 'utf8'),
    }));
    expect(sources.length).toBeGreaterThan(200); // the walk found the tree, not nothing
    expect(bodiesReachingALogger(sources)).toEqual([]);
  });

  // Without these the arm above is indistinguishable from a detector that
  // inspects nothing. The multi-line case is the one a single-line grep misses,
  // and it is the form a real refactor produces.
  it('accuses a body logged on one line and a body logged across several', () => {
    const found = bodiesReachingALogger([
      {
        file: 'probe.ts',
        text: `declare const req: any;
req.log.warn({ b: req.body }, 'inline');
req.log.error(
  { component: 'x', body: request.body },
  'across lines',
);
`,
      },
    ]);
    expect(found.map((o) => o.line)).toEqual([2, 3]);
  });

  it('accuses a PARSED body handed over whole — the spread, the shorthand, the bare argument', () => {
    const found = bodiesReachingALogger([
      {
        file: 'probe.ts',
        text: `declare const req: any; declare const Schema: any;
const parsed = Schema.safeParse(req.body);
const body = parsed.data;
req.log.info({ component: 'x', ...body }, 'spread');
req.log.info({ body }, 'shorthand');
req.log.info(body, 'bare argument');
`,
      },
    ]);
    expect(found.map((o) => o.line)).toEqual([4, 5, 6]);
    expect(found[0]?.snippet.startsWith("body-derived 'body' passed whole")).toBe(true);
  });

  it('acquits reading FIELDS off a parsed body, which is how every route uses it', () => {
    const found = bodiesReachingALogger([
      {
        file: 'probe.ts',
        text: `declare const req: any; declare const Schema: any;
const parsed = Schema.safeParse(req.body);
const body = parsed.data;
req.log.warn({ macNodeId: body.mac_node_id, host: body.livekit.ws_url }, 'fields only');
req.log.warn({ id: body['mac_node_id'] }, 'element access');
`,
      },
    ]);
    expect(found).toEqual([]);
  });

  it('acquits a body that never reaches a logger, and a logger that never sees a body', () => {
    const found = bodiesReachingALogger([
      {
        file: 'probe.ts',
        text: `declare const req: any;
const parsed = Schema.safeParse(req.body);
req.log.warn({ component: 'x', id: parsed.data.id }, 'safe');
somethingElse.body = req.body;
`,
      },
    ]);
    expect(found).toEqual([]);
  });
});
