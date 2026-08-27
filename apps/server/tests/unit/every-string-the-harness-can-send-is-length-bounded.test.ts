// V-1930. Every string a fleet node can put on the wire is length-bounded.
//
// `harness-control-protocol.ts` carries BOTH directions of the control channel,
// and the distinction is the whole point of this test:
//
//   ControlInbound  (server ENCODES → harness) — sessionAssign, intentDispatch,
//                   sessionEnd, ping, and the CP→node request frames.
//   HarnessOutbound (server DECODES ← harness) — heartbeat, sessionStatus,
//                   intentResult, capabilityReport, errorEvent, and the rest.
//
// Only the DECODE side is ingress. A schema we construct ourselves needs no
// length cap; a schema a node fills does, because an unbounded string there is
// whatever the node chooses to send, landing in memory, in logs, and in customer
// state.
//
// Counting `z.string()` across the FILE says 68 look unbounded and means nothing:
// almost all of them are outbound frames we build. Scoped to the transitive
// closure of HarnessOutbound — 66 schemas — the count is ZERO, which is the
// property worth keeping.
//
// "Bounded" here means `.max(...)`, `.length(...)`, or a `.regex(...)` whose
// pattern carries an upper length quantifier: `code` is bounded by
// `/^[a-z][a-z0-9_]{0,127}$/` with no `.max()` at all, and a checker that missed
// that would report a false positive on the most carefully written field in the
// file.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL = resolve(HERE, '..', '..', 'src', 'schemas', 'harness-control-protocol.ts');

interface Finding {
  schema: string;
  line: number;
  snippet: string;
}

interface Analysis {
  reachable: Set<string>;
  unbounded: Finding[];
}

function analyse(root: string): Analysis {
  const sourceFile = ts.createSourceFile(
    PROTOCOL,
    readFileSync(PROTOCOL, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );

  const declarations = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  // Transitive closure: a member schema reached through another still carries
  // whatever the node sends, so following only the top level would check the
  // envelope and miss every payload inside it.
  const reachable = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const name = stack.pop();
    if (name === undefined || reachable.has(name)) continue;
    reachable.add(name);
    const init = declarations.get(name);
    if (init === undefined) continue;
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && declarations.has(node.text) && !reachable.has(node.text)) {
        stack.push(node.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(init);
  }

  const unbounded: Finding[] = [];
  for (const name of reachable) {
    const init = declarations.get(name);
    if (init === undefined) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'string' &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'z'
      ) {
        let top: ts.Node = node;
        while (
          top.parent !== undefined &&
          (ts.isPropertyAccessExpression(top.parent) || ts.isCallExpression(top.parent))
        ) {
          top = top.parent;
        }
        const chain = top.getText().replace(/\s+/g, ' ');
        const bounded =
          /\.max\(/.test(chain) ||
          /\.length\(/.test(chain) ||
          /\.regex\(\s*\/[^/]*\{\d*,?\s*\d+\}/.test(chain);
        if (!bounded) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          unbounded.push({ schema: name, line: line + 1, snippet: chain.slice(0, 70) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(init);
  }
  return { reachable, unbounded };
}

describe('every string the harness can send is length-bounded', () => {
  const outbound = analyse('HarnessOutboundSchema');

  it('no string reachable from HarnessOutbound is unbounded', () => {
    expect(outbound.unbounded).toEqual([]);
  });

  // Without these the arm above passes just as happily if the closure walked
  // nothing at all, or walked the wrong direction.
  it('the closure reached the decode side and excluded the encode side', () => {
    expect(outbound.reachable.size).toBeGreaterThan(20);
    // a genuine HarnessOutbound member payload
    expect(outbound.reachable.has('ErrorEventPayloadSchema')).toBe(true);
    // server → harness: we build it, so it is deliberately out of scope
    expect(outbound.reachable.has('IntentDispatchSchema')).toBe(false);
  });

  it('counts a regex length quantifier as a bound, not a miss', () => {
    // `code` is bounded by /^[a-z][a-z0-9_]{0,127}$/ and carries no .max().
    const source = readFileSync(PROTOCOL, 'utf8');
    expect(source).toMatch(/code: z\.string\(\)\.regex\(\/\^\[a-z\]\[a-z0-9_\]\{0,127\}\$\/\)/);
    expect(outbound.unbounded.some((f) => f.snippet.includes('a-z0-9_'))).toBe(false);
  });
});
