// V-1926. `NotificationEventBus.publishBroadcast` fans one frame to EVERY account
// with a live SSE stream, stamping each copy with that subscriber's own
// `accountId` (DistributiveOmit drops the sender's). That is correct for public
// platform data — an incident is the same fact for everyone — and it is exactly
// how a cross-tenant leak would look if the wrong kind went through it: account
// A's `audit.high_severity` would arrive at account B carrying B's own id, so
// nothing downstream, in the route or the client, could tell it was misaddressed.
//
// Of the four NotificationEvent kinds, three are account-scoped facts —
// `cost.threshold_alert`, `audit.high_severity`, `session.errored` — and all
// three correctly use `publish(...)`. Only `incident.broadcast` is
// account-agnostic, and it is the only broadcaster today.
//
// What was pinned before this: `notification-bus-cross-source-invariant` asserts
// the bootstrap's broadcast call carries `kind: 'incident.broadcast'`. That is a
// positive pin on ONE site — it keeps that publisher wired, and says nothing
// about a SECOND site appearing with an account-scoped kind. This closes that
// direction: every publishBroadcast call in the tree, whatever file it is in,
// must carry a kind from the frozen account-agnostic set.
//
// Adding a broadcaster is meant to fail here. The fix is to decide whether the
// kind is genuinely the same fact for every account, and record it below.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, '..', '..', 'src');

/** Kinds that are the same fact for every account. Frozen 2026-08-27. */
const BROADCAST_SAFE = ['incident.broadcast'] as const;

interface BroadcastCall {
  file: string;
  line: number;
  kind: string | null;
}

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) tsFilesUnder(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Every `<x>.publishBroadcast({ kind: '…' })` call, with the literal kind it
 * carries. `kind: null` means the argument was not an object literal with a
 * string-literal `kind` — which the arms below treat as a failure rather than a
 * pass, since an unreadable broadcaster is exactly what this must not wave
 * through.
 */
export function broadcastCalls(sources: { file: string; text: string }[]): BroadcastCall[] {
  const calls: BroadcastCall[] = [];
  for (const { file, text } of sources) {
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'publishBroadcast'
      ) {
        const [arg] = node.arguments;
        let kind: string | null = null;
        if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === 'kind' &&
              ts.isStringLiteral(prop.initializer)
            ) {
              kind = prop.initializer.text;
            }
          }
        }
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        calls.push({ file, line: line + 1, kind });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return calls;
}

function serverSources(): { file: string; text: string }[] {
  return tsFilesUnder(SRC_DIR).map((file) => ({
    file: file.split(`${SRC_DIR}/`)[1] ?? file,
    text: readFileSync(file, 'utf8'),
  }));
}

describe('only account-agnostic kinds may be broadcast', () => {
  it('every publishBroadcast call in apps/server/src carries a broadcast-safe kind', () => {
    const calls = broadcastCalls(serverSources());
    // The walk found the call site that exists; a zero here would mean the
    // detector stopped working, not that the tree became safe.
    expect(calls.length).toBeGreaterThan(0);
    const unsafe = calls.filter(
      (c) => c.kind === null || !BROADCAST_SAFE.includes(c.kind as (typeof BROADCAST_SAFE)[number]),
    );
    expect(unsafe).toEqual([]);
  });

  it('accuses a broadcaster carrying an account-scoped kind, wherever it lives', () => {
    const found = broadcastCalls([
      {
        file: 'probe.ts',
        text: `declare const bus: any;
bus.publishBroadcast({ kind: 'audit.high_severity', action: 'x', at: 'y' });
`,
      },
    ]);
    expect(found.map((c) => c.kind)).toEqual(['audit.high_severity']);
    expect(
      found.filter((c) => !BROADCAST_SAFE.includes(c.kind as (typeof BROADCAST_SAFE)[number])),
    ).toHaveLength(1);
  });

  it('accuses a broadcaster whose kind it cannot read, rather than waving it through', () => {
    const found = broadcastCalls([
      {
        file: 'probe.ts',
        text: `declare const bus: any; declare const frame: any;
bus.publishBroadcast(frame);
`,
      },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBeNull();
  });

  it('acquits the account-scoped publish path, which this guard does not judge', () => {
    const found = broadcastCalls([
      {
        file: 'probe.ts',
        text: `declare const bus: any;
bus.publish({ kind: 'audit.high_severity', accountId: 'acc_1', at: 'y' });
`,
      },
    ]);
    expect(found).toEqual([]);
  });
});
