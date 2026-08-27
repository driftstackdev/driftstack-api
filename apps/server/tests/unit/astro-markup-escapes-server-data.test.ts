// Server data must not reach browser-parsed markup unescaped.
//
// The three browser-facing apps build markup as strings and assign it to
// `innerHTML`. The practice is already right — an `escapeHtml` helper exists and
// 256 interpolated operands pass through one — and no live defect was found.
// What was missing is a guard, and its absence was MEASURED, not assumed:
//
//   * deleting `escapeHtml` from the incident-update message on the PUBLIC,
//     unauthenticated status page left all 1224 tests in that area passing;
//   * deleting it from `data-rotate-name="' + escapeHtml(k.name) + '"` on the
//     customer dashboard — a customer-controlled API-key name landing inside an
//     HTML attribute, so a `"` in the name breaks out of it — left all 1424
//     customer-dashboard tests passing.
//
// WHY THIS PARSES INSTEAD OF PATTERN-MATCHING. Two earlier regex attempts were
// each wrong in a way that reported LESS than the truth, which is the one
// failure mode a security scan must never have:
//
//   * scanning whole .astro files reported English comment prose as unescaped
//     operands, and missed the dashboard entirely — it builds markup by `+`
//     concatenation, so a check written for `${...}` inspected none of its 108
//     escapes;
//   * hand-rolling a quote tracker desynchronised on `escapeHtml`'s own
//     implementation, which contains the regex literal `/'/g` — one apostrophe,
//     and every subsequent character of the file counts as inside a string. It
//     found 5 concat chains in a codebase that has 155.
//
// The AST also unifies the two markup styles: a TemplateExpression and a `+`
// BinaryExpression are both just nodes.
//
// SCOPE, STATED PLAINLY. This judges an operand's provenance through local
// declarations, page-local helper returns, and object properties. It does NOT
// track a value through a helper PARAMETER, so removing an escape from inside a
// helper that its caller relies on is not caught here. That is a real limit,
// not an oversight: it needs call-site binding, and claiming otherwise would be
// the more dangerous error.
//
// WHAT THE LIMIT COST, MEASURED. The scan judges an operand unsafe and then
// reports it only if it is a data access or an unknown callee. Everything else
// it looks at and says nothing about — 60 operands, against the 6 it names. So
// the limit above was not merely un-tracked, it was INVISIBLE: nothing showed
// how much of the surface fell into it.
//
// The sharp end of that set is a parameter written raw into markup, because
// there the value does reach the page and the safety argument is entirely about
// the CALLER. `PARAMETERS_WRITTEN_RAW` pins it as an exact roster, so a new
// helper of that shape has to be looked at rather than joining a silent
// majority. It does not need call-site binding to be worth having: it does not
// claim the roster is safe, it claims the roster is CHECKED.
//
// Fixed while measuring it: `badge(text, classes)` on the public status page.
// Three copies of that helper exist; incident.astro escaped `text` and
// index.astro and history.astro did not. Every argument is `inc.severity` or
// `inc.status` — postgres enum columns, zod enums on write — so nothing
// markup-shaped could reach them and there was no live defect. But the page is
// public and unauthenticated, the helper is named for its shape rather than its
// argument, and the escape was three layers away in a DB column. Both copies now
// escape, which is why they are absent from the roster below.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
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
const REPO = resolve(HERE, '..', '..', '..', '..');

const APP_ROOTS = ['apps/status-site/src', 'apps/customer-dashboard/src', 'apps/admin-panel/src'];
/**
 * Names whose output is treated as safe to place in markup.
 *
 * This is a TRUST LIST inside a security guard: anything passed through one of
 * these is credited as escaped and never reported. It previously held two names
 * that earn nothing. `escapeHTML` (capital HTML) is used zero times. `esc`
 * appears once in these apps, as the text inside a `<kbd>esc</kbd>` label —
 * never as an identifier. That one is worse than dead weight: it is a standing
 * rule that ANY future variable named `esc` is an escaper, and `esc` is short
 * and generic enough to be reached for as a loop alias or a parameter.
 *
 * `dsQrSvg` stays, and the reason was read rather than assumed: it feeds its
 * input to a QR encoder and builds the SVG only from a numeric dimension and a
 * path of integer coordinates, so the input never reaches the markup at all.
 *
 * The arm below asserts every entry is actually used, so this cannot silently
 * accumulate names that widen the trust boundary without buying anything.
 */
const ESCAPERS = new Set(['escapeHtml', 'encodeURIComponent', 'dsQrSvg']);
/**
 * Built-ins a page may call without the guard knowing them. Anything else that
 * is neither declared in the page nor in ESCAPERS is UNKNOWN, and an unknown
 * callee wrapping a value on its way into markup is the case that quietly
 * escaped this guard: swapping `escapeHtml(k.name)` for `myOwnEscaper(k.name)`
 * used to produce no finding at all, because a call operand was out of scope
 * and an unrecognised name credits nothing either way.
 */
const JS_GLOBALS = new Set([
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'JSON',
  'Math',
  'Date',
  'RegExp',
  'parseInt',
  'parseFloat',
  'isFinite',
  'isNaN',
  'encodeURI',
  'decodeURI',
  'decodeURIComponent',
  'URL',
  'URLSearchParams',
  'btoa',
  'atob',
  'structuredClone',
  'fetch',
  'setTimeout',
  'clearTimeout',
]);

const HTML_TAG = /<\/?[a-zA-Z][\s\S]*?>|<\/?[a-zA-Z]$|<[a-zA-Z][\w-]*\s/;

/**
 * Numeric counts an API response supplies, written into markup without an
 * escape. Every one was read by hand and is a COUNT — the surrounding code does
 * `feed.total === 0`, `counts.dlq > 0`, `String(metadata.openTotal)` — so no
 * attacker-authored text reaches these positions.
 *
 * This is an exact roster, not an allowlist: a site that disappears fails this
 * assertion just as a new one does, so an entry cannot quietly stop meaning
 * "checked" and start meaning "ignored".
 */
const NUMERIC_COUNTS_WRITTEN_RAW = [
  'apps/admin-panel/src/pages/incidents/index.astro: metadata.openTotal',
  'apps/admin-panel/src/pages/incidents/index.astro: metadata.resolvedTotal',
  'apps/customer-dashboard/src/pages/webhooks.astro: counts.dlq',
  // Surfaced by the `(x || 0)` unwrap below, not by a new call site.
  // `z.number().int().nonnegative()` in api-types/webhooks.ts.
  'apps/customer-dashboard/src/pages/webhooks.astro: e.consecutive_failures',
  'apps/status-site/src/pages/history.astro: feed.open_count',
  'apps/status-site/src/pages/history.astro: feed.total',
  'apps/status-site/src/pages/index.astro: feed.total',
];

/**
 * Helper parameters written into markup with no escape, each read by hand.
 *
 * Every one is safe for the same reason — the helper is called only with
 * page-local string literals — and that reason is the one this analysis cannot
 * see, so it is recorded rather than inferred:
 *
 *   mk(cmd) / mk(label)      four calls, all `mk('cordon', 'Cordon', warn)`
 *                            shaped. The node id in the same template IS
 *                            escaped, so the raw operands here are a deliberate
 *                            distinction, not an oversight.
 *   renderUnavailable(message) x2, renderAuditsUnavailable(message)
 *                            error copy, every call site a literal. Notably NOT
 *                            an API error body: `window.driftstackRequestError-
 *                            Message(...)` output goes to showBanner, which sets
 *                            textContent.
 *   bar(label)               'Compute' / 'Egress' / 'Storage' / 'Sub-processor'.
 *   emptyState(iconPath)     an SVG path literal placed inside a `d="…"`
 *                            attribute; the headline and body beside it are
 *                            escaped.
 *
 * An exact roster, not an allowlist: an entry that stops matching fails too, so
 * it cannot quietly turn from "checked" into "ignored".
 */
const PARAMETERS_WRITTEN_RAW = [
  'apps/admin-panel/src/pages/fleet.astro: mk(cmd)',
  'apps/admin-panel/src/pages/fleet.astro: mk(label)',
  'apps/admin-panel/src/pages/incidents/index.astro: renderUnavailable(message)',
  'apps/admin-panel/src/pages/index.astro: renderAuditsUnavailable(message)',
  'apps/admin-panel/src/pages/shells/account-detail.astro: bar(label)',
  'apps/customer-dashboard/src/pages/api-keys.astro: renderUnavailable(message)',
  'apps/customer-dashboard/src/pages/team.astro: emptyState(iconPath)',
];

/**
 * Every argument a page passes at `fn`'s `param` position, described by node
 * kind. The roster above rests on "all its call sites pass a page-local
 * literal", and that sentence was hand-verified once and then trusted — the
 * same shape of claim that turned out wrong twice in other rosters this week.
 * It is checkable, so it is checked.
 */
function argumentsAtParameter(rel: string, fn: string, param: string): ts.Node[] {
  const src = readFileSync(resolve(REPO, rel), 'utf8');
  const out: ts.Node[] = [];
  for (const body of scriptBodies(src)) {
    const sf = ts.createSourceFile('page.ts', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let index = -1;
    const findDecl = (n: ts.Node): void => {
      const fnNode: LocalFunction | undefined =
        ts.isFunctionDeclaration(n) && n.name?.text === fn
          ? n
          : ts.isVariableDeclaration(n) &&
              ts.isIdentifier(n.name) &&
              n.name.text === fn &&
              n.initializer &&
              (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
            ? n.initializer
            : undefined;
      if (fnNode) {
        fnNode.parameters.forEach((p, i) => {
          if (ts.isIdentifier(p.name) && p.name.text === param) index = i;
        });
      }
      ts.forEachChild(n, findDecl);
    };
    findDecl(sf);
    if (index < 0) continue;
    const findCalls = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === fn) {
        const a = n.arguments[index];
        if (a) out.push(a);
      }
      ts.forEachChild(n, findCalls);
    };
    findCalls(sf);
  }
  return out;
}

/** A literal, or a `?:` / `||` whose every branch is one. */
function isLiteralThroughout(n: ts.Node): boolean {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true;
  if (ts.isParenthesizedExpression(n)) return isLiteralThroughout(n.expression);
  if (ts.isConditionalExpression(n))
    return isLiteralThroughout(n.whenTrue) && isLiteralThroughout(n.whenFalse);
  if (
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  )
    return isLiteralThroughout(n.left) && isLiteralThroughout(n.right);
  return false;
}

function astroFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.astro')) out.push(full);
    }
  };
  for (const root of APP_ROOTS) walk(resolve(REPO, root));
  return out;
}

/**
 * Client `<script>` bodies.
 *
 * Astro frontmatter and HTML comments are removed FIRST. Several pages describe
 * themselves in a frontmatter line comment — `inline <script> fetches live
 * state` — and a naive scan begins its capture at that mention: the "body" then
 * starts with prose, runs through the `---` fence, and parses into a garbled
 * tree. TypeScript's parser is error-tolerant, so this produced an AST and
 * partial findings rather than an obvious failure. It affected 14 of 45 bodies,
 * including the very page this guard was written for, and fixing it raised the
 * escapes actually checked from 139 to 256. `parses cleanly` below is the
 * standing assertion that it stays fixed.
 */
function scriptBodies(src: string): string[] {
  const noFrontmatter = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const noComments = noFrontmatter.replace(/<!--[\s\S]*?-->/g, '');
  return [...noComments.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

const parseBody = (body: string): ts.SourceFile =>
  ts.createSourceFile('page.ts', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/**
 * `parseDiagnostics` is where the parser records syntax errors, and it is the
 * only way to learn that a body did not parse — `createSourceFile` returns a
 * tree either way. It is not on the public `SourceFile` type, so it is named
 * here rather than reached for through `any`.
 */
interface ParsedSourceFile extends ts.SourceFile {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
}

/** The function forms a page actually declares — each has a well-typed body. */
type LocalFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

/** Every operand of a left-nested `+` chain, flattened. */
function flattenPlus(node: ts.Node, out: ts.Node[] = []): ts.Node[] {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    flattenPlus(node.left, out);
    flattenPlus(node.right, out);
  } else out.push(node);
  return out;
}

const isStringish = (n: ts.Node): boolean =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);

function literalText(n: ts.Node): string {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n))
    return n.head.text + n.templateSpans.map((s) => s.literal.text).join('');
  return '';
}

/**
 * The values an operand can actually evaluate to, unwrapping the wrappers that
 * carry no markup of their own: parentheses, `||`/`??` defaults, and `?:`.
 *
 * The reporting step used to test the operand NODE — so `data.x` was reported
 * and `(data.x || '—')` was not, and `(x || '—')` is the more common way to
 * write it. Four server values were being written into markup unescaped and
 * named by nothing, including `b.billing_cycle`, which the admin panel echoes
 * back from a query parameter. `safe()` already saw through this — it judged all
 * four unsafe — so the miss was purely in what got REPORTED, which is the worst
 * place for it: the guard knew and said nothing.
 */
function defaultChainLeaves(n: ts.Node, out: ts.Node[] = []): ts.Node[] {
  if (ts.isParenthesizedExpression(n)) return defaultChainLeaves(n.expression, out);
  if (
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    defaultChainLeaves(n.left, out);
    defaultChainLeaves(n.right, out);
    return out;
  }
  if (ts.isConditionalExpression(n)) {
    defaultChainLeaves(n.whenTrue, out);
    defaultChainLeaves(n.whenFalse, out);
    return out;
  }
  out.push(n);
  return out;
}

/** Any escaping call — or point-free reference, as in `.map(escapeHtml)`. */
function containsEscaper(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && ESCAPERS.has(n.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** Values whose type cannot carry markup. */
function structurallySafe(n: ts.Node): boolean {
  if (ts.isNumericLiteral(n)) return true;
  if (
    n.kind === ts.SyntaxKind.TrueKeyword ||
    n.kind === ts.SyntaxKind.FalseKeyword ||
    n.kind === ts.SyntaxKind.NullKeyword
  )
    return true;
  if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) return true;
  if (ts.isParenthesizedExpression(n)) return structurallySafe(n.expression);
  if (ts.isBinaryExpression(n)) {
    const k = n.operatorToken.kind;
    if (
      k === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      k === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      k === ts.SyntaxKind.LessThanToken ||
      k === ts.SyntaxKind.GreaterThanToken ||
      k === ts.SyntaxKind.MinusToken ||
      k === ts.SyntaxKind.AsteriskToken ||
      k === ts.SyntaxKind.SlashToken
    )
      return true;
  }
  if (ts.isPropertyAccessExpression(n) && n.name.text === 'length') return true;
  if (ts.isCallExpression(n)) {
    const callee = n.expression;
    if (ts.isIdentifier(callee) && (callee.text === 'Number' || callee.text === 'String'))
      return structurallySafe(n.arguments[0] ?? n);
    if (ts.isPropertyAccessExpression(callee) && ['toFixed', 'toString'].includes(callee.name.text))
      return true;
  }
  // SCREAMING_CASE constants, and lookups into them, are page-local literals.
  if (ts.isIdentifier(n) && /^[A-Z][A-Z0-9_]*$/.test(n.text)) return true;
  if (ts.isElementAccessExpression(n) || ts.isPropertyAccessExpression(n)) {
    let root: ts.Node = n;
    while (ts.isElementAccessExpression(root) || ts.isPropertyAccessExpression(root))
      root = root.expression;
    if (ts.isIdentifier(root) && /^[A-Z][A-Z0-9_]*$/.test(root.text)) return true;
  }
  return false;
}

/**
 * `fn(param)` for the nearest enclosing function that declares `id` as a
 * parameter, or null if `id` is not a parameter of anything containing it.
 * Walking OUT from the identifier is what makes this exact — a page-wide map of
 * declarations cannot tell one `message` from another, and this guard already
 * has a first-wins `decls` map that conflates them.
 */
function enclosingParameterOwner(id: ts.Identifier): string | null {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (!ts.isFunctionDeclaration(n) && !ts.isFunctionExpression(n) && !ts.isArrowFunction(n))
      continue;
    if (!n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === id.text)) continue;
    if (ts.isFunctionDeclaration(n) && n.name) return `${n.name.text}(${id.text})`;
    const { parent } = n;
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
      return `${parent.name.text}(${id.text})`;
    return `<anonymous>(${id.text})`;
  }
  return null;
}

interface Scan {
  readonly markupExpressions: number;
  readonly operandsJudged: number;
  readonly operandsEscaped: number;
  readonly perApp: Record<string, number>;
  readonly parseFailures: string[];
  readonly rawDataAccess: string[];
  readonly unknownCallees: string[];
  readonly rawParameters: string[];
}

function scan(): Scan {
  let markupExpressions = 0;
  let operandsJudged = 0;
  let operandsEscaped = 0;
  const perApp: Record<string, number> = {};
  const parseFailures: string[] = [];
  const rawDataAccess: string[] = [];
  const unknownCallees: string[] = [];
  const rawParameters: string[] = [];

  for (const file of astroFiles()) {
    const rel = relative(REPO, file);
    for (const body of scriptBodies(readFileSync(file, 'utf8'))) {
      const sf = parseBody(body);
      const { parseDiagnostics } = sf as ParsedSourceFile;
      if (parseDiagnostics !== undefined && parseDiagnostics.length > 0) parseFailures.push(rel);

      const decls = new Map<string, ts.Expression>();
      const fns = new Map<string, LocalFunction>();
      const collect = (n: ts.Node): void => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
          if (!decls.has(n.name.text)) decls.set(n.name.text, n.initializer);
          if (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
            fns.set(n.name.text, n.initializer);
        }
        if (ts.isFunctionDeclaration(n) && n.name) fns.set(n.name.text, n);
        ts.forEachChild(n, collect);
      };
      collect(sf);

      /** A property/element access rooted at a lowercase local — i.e. DATA. */
      const isDataAccess = (n: ts.Node): boolean => {
        if (!ts.isPropertyAccessExpression(n) && !ts.isElementAccessExpression(n)) return false;
        let root: ts.Node = n;
        while (
          ts.isPropertyAccessExpression(root) ||
          ts.isElementAccessExpression(root) ||
          ts.isCallExpression(root)
        )
          root = root.expression;
        return ts.isIdentifier(root) && !/^[A-Z][A-Z0-9_]*$/.test(root.text);
      };

      /** Every value a function hands back: `return`s plus concise arrow bodies. */
      const returnExpressions = (fn: LocalFunction): ts.Expression[] => {
        const out: ts.Expression[] = [];
        if (ts.isArrowFunction(fn) && fn.body && !ts.isBlock(fn.body)) out.push(fn.body);
        const walk = (n: ts.Node): void => {
          if (
            n !== fn &&
            (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))
          )
            return; // a nested function's returns belong to it, not to this one
          if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
          ts.forEachChild(n, walk);
        };
        if (fn.body) walk(fn.body);
        return out;
      };

      /** The initializer of `name` on whatever `node` evaluates to, if visible. */
      const propertyInitializer = (
        node: ts.Node,
        name: string,
        depth: number,
      ): ts.Expression | undefined => {
        if (depth > 3) return undefined;
        let obj: ts.Node = node;
        if (
          ts.isCallExpression(obj) &&
          ts.isIdentifier(obj.expression) &&
          fns.has(obj.expression.text)
        ) {
          const rets = returnExpressions(fns.get(obj.expression.text)!);
          if (rets.length !== 1) return undefined;
          obj = rets[0]!;
        }
        if (!ts.isObjectLiteralExpression(obj)) return undefined;
        for (const pr of obj.properties)
          if (ts.isPropertyAssignment(pr) && ts.isIdentifier(pr.name) && pr.name.text === name)
            return pr.initializer;
        return undefined;
      };

      const returnsSafe = (fn: LocalFunction, depth: number): boolean => {
        const rets = returnExpressions(fn);
        if (rets.length === 0) return false;
        return rets.every((r) => {
          if (ts.isObjectLiteralExpression(r))
            return r.properties.every(
              (pr) => !ts.isPropertyAssignment(pr) || safe(pr.initializer, depth + 1),
            );
          return safe(r, depth + 1);
        });
      };

      const safe = (n: ts.Node, depth = 0): boolean => {
        if (isStringish(n) && !ts.isTemplateExpression(n)) return true;
        if (containsEscaper(n)) return true;
        if (structurallySafe(n)) return true;
        if (ts.isParenthesizedExpression(n)) return safe(n.expression, depth);
        if (ts.isConditionalExpression(n))
          return safe(n.whenTrue, depth) && safe(n.whenFalse, depth);
        if (
          ts.isBinaryExpression(n) &&
          (n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
        )
          return safe(n.left, depth) && safe(n.right, depth);
        // A concatenation is safe when every one of its operands is.
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)
          return flattenPlus(n).every((o) => safe(o, depth + 1));
        if (depth < 4 && ts.isIdentifier(n) && decls.has(n.text))
          return safe(decls.get(n.text)!, depth + 1);
        // A property read off a locally-built object: judge the PROPERTY that is
        // actually read, not the whole object. `revokeControlState` returns
        // `{ leased, attrs, label }`; `leased` is a Set lookup this analysis
        // cannot reason about, but only `attrs` and `label` are written into
        // markup and both are built from string literals. Judging the object as
        // a unit would condemn them for a sibling they do not touch.
        if (depth < 4 && ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
          const base = decls.get(n.expression.text);
          if (base) {
            const prop = propertyInitializer(base, n.name.text, depth);
            return safe(prop ?? base, depth + 1);
          }
        }
        if (depth < 4 && ts.isCallExpression(n)) {
          const callee = n.expression;
          const name = ts.isIdentifier(callee) ? callee.text : '';
          if (fns.has(name)) {
            const fn = fns.get(name)!;
            if (containsEscaper(fn)) return true;
            // What the helper RETURNS, with its parameters treated as unknown.
            // A helper returning only literals is safe whatever it is handed:
            // `revokeControlState(k.id)` builds disabled-attribute strings and
            // never puts the id it was given into them.
            if (returnsSafe(fn, depth)) return true;
            return n.arguments.every((a) => safe(a, depth + 1));
          }
          if (ts.isPropertyAccessExpression(callee) && ['join', 'map'].includes(callee.name.text)) {
            const inner = n.arguments[0];
            if (
              inner &&
              ts.isIdentifier(inner) &&
              fns.has(inner.text) &&
              containsEscaper(fns.get(inner.text)!)
            )
              return true;
            return safe(callee.expression, depth + 1);
          }
        }
        // An identifier with no visible declaration is a PARAMETER: unknown,
        // which is not the same as safe.
        return false;
      };

      const walk = (n: ts.Node): void => {
        let parts: ts.Node[] | null = null;
        let literals = '';
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          // Only the OUTERMOST node of a chain, so operands aren't judged twice.
          const p = n.parent;
          const nested =
            p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken;
          if (!nested) {
            parts = flattenPlus(n);
            literals = parts.map((x) => (isStringish(x) ? literalText(x) : '')).join('');
          }
        } else if (ts.isTemplateExpression(n)) {
          parts = n.templateSpans.map((s) => s.expression);
          literals = n.head.text + n.templateSpans.map((s) => s.literal.text).join('');
        }

        if (parts && HTML_TAG.test(literals)) {
          markupExpressions++;
          const app = rel.split('/')[1]!;
          perApp[app] = (perApp[app] ?? 0) + 1;
          for (const part of parts) {
            if (isStringish(part)) continue;
            operandsJudged++;
            if (containsEscaper(part)) operandsEscaped++;
            if (safe(part)) continue;
            // Report on what the operand can EVALUATE TO, not on its outermost
            // node — `(data.x || '—')` reaches the page exactly as `data.x` does.
            for (const leaf of defaultChainLeaves(part)) {
              if (safe(leaf)) continue;
              // A helper call or a bare local is a different question — does the
              // helper escape what it is handed? — and is out of scope above.
              if (
                ts.isCallExpression(leaf) &&
                ts.isIdentifier(leaf.expression) &&
                !fns.has(leaf.expression.text) &&
                !ESCAPERS.has(leaf.expression.text) &&
                !JS_GLOBALS.has(leaf.expression.text)
              ) {
                unknownCallees.push(`${rel}: ${leaf.expression.text}()`);
              }
              if (
                (ts.isPropertyAccessExpression(leaf) || ts.isElementAccessExpression(leaf)) &&
                isDataAccess(leaf)
              )
                rawDataAccess.push(`${rel}: ${leaf.getText(sf).replace(/\s+/g, ' ')}`);
              // The stated limit of this guard, made countable: the value lands
              // in markup here, and every argument for its safety is about the
              // CALLER.
              if (ts.isIdentifier(leaf)) {
                const owner = enclosingParameterOwner(leaf);
                if (owner !== null) rawParameters.push(`${rel}: ${owner}`);
              }
            }
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(sf);
    }
  }

  return {
    markupExpressions,
    operandsJudged,
    operandsEscaped,
    perApp,
    parseFailures,
    rawDataAccess,
    unknownCallees,
    rawParameters,
  };
}

describe('server data reaching browser-parsed markup is escaped', () => {
  it('CRITICAL every client script parses cleanly. A body captured from a frontmatter comment still yields an error-tolerant AST, so this fails quietly: it under-reports instead of erroring, and a security scan that silently examines less than it claims is worse than none. This exact bug hid 40% of the surface.', () => {
    const { parseFailures } = scan();
    expect(parseFailures, 'client <script> bodies that did not parse').toEqual([]);
  });

  it('CRITICAL every name in the trust list is actually used. This set decides what counts as escaped, so an entry that matches nothing is not harmless — it is a standing rule waiting for a name collision, and `esc` (which sat here while appearing only as the text in a <kbd>esc</kbd> label) is exactly the kind of short, generic identifier a future loop alias or parameter would reuse and be silently trusted for.', () => {
    const sources = astroFiles().map((f) => readFileSync(f, 'utf8'));
    const unused = [...ESCAPERS].filter(
      (name) =>
        !sources.some((src) =>
          new RegExp(`\\b${name}\\s*\\(|\\.\\s*map\\(\\s*${name}\\s*\\)`).test(src),
        ),
    );
    expect(unused, 'trusted name(s) never called or passed by reference — remove them').toEqual([]);
  });

  it('CRITICAL the scan reaches all three apps, and reaches the dashboard in particular. Every assertion here reports an absence, so a scan that collected nothing reports every page safe. The dashboard is the specific trap: it builds markup by concatenation, so an earlier check written for `${...}` interpolation found 44 sinks there and judged zero operands.', () => {
    const { markupExpressions, operandsJudged, operandsEscaped, perApp } = scan();
    expect(markupExpressions, 'markup-building expressions found').toBeGreaterThan(140);
    expect(operandsJudged, 'operands judged').toBeGreaterThan(400);
    expect(operandsEscaped, 'operands credited to an escaper').toBeGreaterThan(230);
    expect(perApp['status-site'], 'status-site markup expressions').toBeGreaterThan(10);
    expect(perApp['customer-dashboard'], 'customer-dashboard markup expressions').toBeGreaterThan(
      40,
    );
    expect(perApp['admin-panel'], 'admin-panel markup expressions').toBeGreaterThan(70);
  });

  it('CRITICAL no markup operand calls a helper this guard does not recognise. A call operand is otherwise out of scope entirely — neither credited as escaping nor reported — so renaming the escaper to something unrecognised made the value vanish from coverage rather than fail. There are zero such calls today, which is what makes an exact-empty assertion the right shape: page-local formatters are resolved by name, so anything left is genuinely unknown.', () => {
    const { unknownCallees } = scan();
    expect(
      [...new Set(unknownCallees)].sort(),
      'markup built by a callee that is neither declared in the page, trusted as an escaper, nor a JS built-in:',
    ).toEqual([]);
  });

  it("CRITICAL every helper parameter written raw into markup is one that was checked. This is the guard's own stated limit turned into a roster: it cannot bind a parameter to its call sites, so it cannot judge these — but it CAN insist that the set stays the hand-read one. Before this arm the set was not merely unjudged, it was invisible: 60 operands were looked at and passed over in silence against the 6 the guard names, and `badge(text)` on the public status page sat among them, unescaped in two of its three copies.", () => {
    const { rawParameters } = scan();
    expect(
      [...new Set(rawParameters)].sort(),
      'a helper writes a parameter into markup with no escape. Read every call site: if they are ' +
        'all page-local literals, add it here with that reason. If any passes server or ' +
        'customer-supplied data, escape it in the helper — the call sites are the wrong place, ' +
        'because the next caller will not know:',
    ).toEqual(PARAMETERS_WRITTEN_RAW);
  });

  it('CRITICAL the roster\'s own safety argument holds: every call site of a raw-parameter helper passes a literal. The entries above are exempt because "all its call sites pass page-local literals" — a sentence I verified by reading once. Two rosters elsewhere this week had a hand-written reason that the code contradicted, so this one is derived. A future call site handing one of these helpers a customer value is a live XSS with an exemption already written for it.', () => {
    const offenders: string[] = [];
    for (const entry of PARAMETERS_WRITTEN_RAW) {
      const m = /^(.+): (\w+)\((\w+)\)$/.exec(entry);
      expect(m, `unparseable roster entry: ${entry}`).not.toBeNull();
      const [, rel, fn, param] = m!;
      const args = argumentsAtParameter(rel ?? '', fn ?? '', param ?? '');
      if (args.length === 0) {
        offenders.push(`${entry} — no call sites found; the exemption describes nothing`);
        continue;
      }
      for (const a of args) {
        if (!isLiteralThroughout(a)) offenders.push(`${entry} ← ${a.getText().slice(0, 70)}`);
      }
    }
    expect(
      offenders.sort(),
      'a helper that writes this parameter straight into markup is called with something other ' +
        'than a literal. Escape it inside the helper — the call sites are the wrong place, ' +
        'because the next caller will not know:',
    ).toEqual([]);
  });

  it('CRITICAL isLiteralThroughout actually rejects a data branch. The arm above is only as good as this predicate, and the corpus cannot prove it: every conditional a roster helper is called with today has literal branches on BOTH sides, so a predicate that waved conditionals through unconditionally passed the whole suite. Exercised directly, because the mutation that broke it survived otherwise.', () => {
    const parse = (expr: string): ts.Node => {
      const sf = ts.createSourceFile(
        'x.ts',
        `const v = ${expr};`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const decl = sf.statements[0] as ts.VariableStatement;
      return decl.declarationList.declarations[0]!.initializer!;
    };
    expect(isLiteralThroughout(parse("'a plain literal'")), 'a literal is literal').toBe(true);
    expect(
      isLiteralThroughout(parse("cond ? 'one' : 'two'")),
      'a conditional with two literal branches is literal throughout',
    ).toBe(true);
    expect(
      isLiteralThroughout(parse("cond ? err.message : 'two'")),
      'a conditional with a DATA branch is not',
    ).toBe(false);
    expect(
      isLiteralThroughout(parse("data.name || 'fallback'")),
      'a `||` whose left side is data is not',
    ).toBe(false);
    expect(isLiteralThroughout(parse('data.name')), 'a bare data access is not').toBe(false);
  });

  it('CRITICAL no server-supplied value is written into markup unescaped. The status page is unauthenticated and its incident feed is operator-authored; the dashboard renders customer-authored key names into HTML attributes. Deleting either escape today fails nothing.', () => {
    const { rawDataAccess } = scan();
    expect(
      [...new Set(rawDataAccess)].sort(),
      'data written into markup with no escaping in its provenance:',
    ).toEqual(NUMERIC_COUNTS_WRITTEN_RAW);
  });
});
