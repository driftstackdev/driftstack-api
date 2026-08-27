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
import { describe, expect, it } from 'vitest';

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

export function bodiesReachingALogger(sources: { file: string; text: string }[]): Offender[] {
  const offenders: Offender[] = [];
  for (const { file, text } of sources) {
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isLoggerCall(node)) {
        let found = false;
        const scan = (inner: ts.Node): void => {
          if (found) return;
          if (isRequestBody(inner)) {
            found = true;
            return;
          }
          ts.forEachChild(inner, scan);
        };
        for (const arg of node.arguments) scan(arg);
        if (found) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          offenders.push({
            file,
            line: line + 1,
            snippet: node.getText().replace(/\s+/g, ' ').slice(0, 80),
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
