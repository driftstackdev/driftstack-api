// The AI surface's doc comments ship to customers: every JSDoc block in
// src/resources/agent-sessions.ts is in dist/index.d.ts and shows on hover in
// their editor, and the AI example is copied into their code. So that text must
// say what the product does, never how it is built inside — no internal
// infrastructure names, no internal ticket or work ids, no agent names.
//
// Comments are collected with the TypeScript compiler (leading and trailing
// comment ranges of every node), so a `//` inside a string or a URL is never
// mistaken for a comment. The example is checked whole, because its printed
// strings are customer-facing too.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..', '..');

/** Words and id shapes that describe how Driftstack is built, not what it does. */
const INTERNAL: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bharness\b/i, 'infrastructure name "harness"'],
  [/\bfleet\b/i, 'infrastructure name "fleet"'],
  [/\bcontrol[ -]plane\b/i, 'infrastructure name "control plane"'],
  [/\bobserver\b/i, 'infrastructure name "observer"'],
  [/\bvantage\b/i, 'infrastructure name "vantage"'],
  [/\bnodes?\b(?!\.js|:[a-z])/i, 'infrastructure name "node"'],
  [/\bMacs?\b/, 'infrastructure name "Mac"'],
  [/\b8443\b/, 'an internal port number'],
  [/\b[VW]-?\d{2,5}\b/, 'an internal ticket id'],
  [/\b(?:sub-)?slice \d/i, 'an internal work item'],
  [/\bArc \d/, 'an internal work item'],
  [/\bWave \d/, 'an internal work item'],
  [/\bLK\.\d/, 'an internal work item'],
  [/\bv2-#\d/, 'an internal work item'],
  [/\bQ\.\d/, 'an internal work item'],
  [/\b[PT]-\d+\b/, 'an internal work item'],
  [/\bdoc-\d+/, 'an internal planning document'],
  [/\bplanning \d+/i, 'an internal planning document'],
  [/\bTier-3\b/, 'an internal decision label'],
  [/\bA[1-3]\b/, 'an agent name'],
  [/\bfounder\b/i, 'a personal role'],
];

function findings(label: string, text: string): string[] {
  const out: string[] = [];
  for (const [re, why] of INTERNAL) {
    const m = re.exec(text);
    if (m !== null) out.push(`${label}: ${why} — "${m[0]}"`);
  }
  return out;
}

/** Every comment in a TypeScript file, each with its 1-based line. */
function commentsOf(path: string): Array<{ line: number; text: string }> {
  const src = readFileSync(path, 'utf8');
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true);
  const seen = new Map<number, { line: number; text: string }>();
  const collect = (ranges: ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue;
      seen.set(r.pos, {
        line: sf.getLineAndCharacterOfPosition(r.pos).line + 1,
        text: src.slice(r.pos, r.end),
      });
    }
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(src, node.pos));
    collect(ts.getTrailingCommentRanges(src, node.end));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  collect(ts.getLeadingCommentRanges(src, sf.endOfFileToken.pos));
  return [...seen.values()];
}

/** The leading comments of the named classes only. */
function classDocsOf(
  path: string,
  names: ReadonlySet<string>,
): Array<{ name: string; text: string }> {
  const src = readFileSync(path, 'utf8');
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true);
  const out: Array<{ name: string; text: string }> = [];
  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt) || stmt.name === undefined) continue;
    if (!names.has(stmt.name.text)) continue;
    const text = (ts.getLeadingCommentRanges(src, stmt.pos) ?? [])
      .map((r) => src.slice(r.pos, r.end))
      .join('\n');
    out.push({ name: stmt.name.text, text });
  }
  return out;
}

const AI_ERROR_CLASSES = new Set([
  'ForbiddenError',
  'ConflictError',
  'BundledLlmBudgetExhaustedError',
  'BundledLlmConsentRequiredError',
  'ByokAnthropicRequiredError',
]);

describe('the AI docs say what the product does, not how it is built', () => {
  it('CONTROL the matcher flags each kind of internal reference, and passes plain product copy', () => {
    expect(findings('planted', 'the harness on node W1234 (Slice 3)')).toHaveLength(4);
    expect(findings('planted', 'see LK.3 and doc-132, agreed with A3')).toHaveLength(3);
    expect(
      findings(
        'plain',
        "Stop the running task. Node.js 18 or later; import from 'node:crypto'. The browser runs your session.",
      ),
    ).toEqual([]);
  });

  it('the collectors read real text, so an empty scan cannot pass for a clean one', () => {
    const comments = commentsOf(resolve(PKG, 'src/resources/agent-sessions.ts'));
    expect(comments.length).toBeGreaterThan(40);
    expect(comments.some((c) => c.text.includes('Stop the session'))).toBe(true);
    const docs = classDocsOf(resolve(PKG, 'src/errors.ts'), AI_ERROR_CLASSES);
    expect(docs.map((d) => d.name).sort()).toEqual([...AI_ERROR_CLASSES].sort());
    expect(docs.every((d) => d.text.length > 40)).toBe(true);
  });

  it('every comment in the agent-sessions resource is free of internal references', () => {
    const path = resolve(PKG, 'src/resources/agent-sessions.ts');
    const hits = commentsOf(path).flatMap((c) =>
      findings(`agent-sessions.ts:${String(c.line)}`, c.text),
    );
    expect(hits).toEqual([]);
  });

  it('the AI error classes document themselves without internal references', () => {
    const hits = classDocsOf(resolve(PKG, 'src/errors.ts'), AI_ERROR_CLASSES).flatMap((d) =>
      findings(`errors.ts ${d.name}`, d.text),
    );
    expect(hits).toEqual([]);
  });

  it('the AI example — comments and printed text alike — is free of internal references', () => {
    const src = readFileSync(resolve(PKG, 'examples/agent-chat.ts'), 'utf8');
    const hits = src
      .split('\n')
      .flatMap((line, i) => findings(`agent-chat.ts:${String(i + 1)}`, line));
    expect(hits).toEqual([]);
  });
});
