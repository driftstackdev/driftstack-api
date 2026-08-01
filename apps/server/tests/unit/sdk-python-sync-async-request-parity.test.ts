// Every Python resource's async mirror must issue the SAME requests as its sync
// twin — not merely expose the same method names.
//
// The Python SDK ships each resource twice: `MfaResource` and
// `AsyncMfaResource`, `SessionsResource` and `AsyncSessionsResource`, and so on
// for nineteen pairs covering 138 public methods. The two are written out
// separately rather than generated, so keeping them in step is a copy-editing
// task, and copy-editing tasks drift.
//
// Being exact about what this adds, because the obvious claim is wrong and was
// tested rather than assumed. Three divergences were introduced with this file
// deleted — an async path pointing elsewhere, an async DELETE becoming POST, and
// two async paths SWAPPED so the file's path set stayed identical — and the
// existing suite red every one. The per-resource content-parity pins are
// exhaustive: they hold each async method's exact method-and-path pairing, not
// just the set. So this guard catches nothing today that the repo would miss.
//
// What it adds is uniformity. Those pins are hand-written, one file per
// resource, nineteen of them. This derives the comparison from source for every
// pair at once, so a resource added later is covered on the day it lands rather
// than on the day someone remembers to write its pin. A probe resource added
// with a sync/async divergence was caught by the existing suite too — but for
// incidental reasons (its route did not resolve, and it was missing from the
// other two SDKs), neither of which is about the divergence.
//
// All 138 pairs agree today; measured before this was written, so what is pinned
// is a property that holds rather than a repair.
//
// Parsing is per METHOD rather than per class body. An earlier draft matched
// from `def <name>(` to the first `_http.request(` anywhere after it, which
// attributed `status`'s call to `__init__` — a method that issues no request at
// all. A parser that mis-attributes calls would compare the wrong things and
// still report zero divergence, which is the failure mode this guard is least
// able to notice on its own. Hence the count assertions below.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOURCES = resolve(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'sdk-python',
  'src',
  'driftstack',
  'resources',
);

interface Call {
  readonly httpMethod: string;
  readonly path: string;
}

/** `{ methodName: [{httpMethod, path}, ...] }` for one class body. */
function methodsOf(classBody: string): Map<string, Call[]> {
  const out = new Map<string, Call[]>();
  // Split on a top-level `def` / `async def` at four-space indent.
  const chunks = classBody.split(/\n {4}(?:async )?def (\w+)\(/);
  for (let i = 1; i < chunks.length; i += 2) {
    const name = chunks[i]!;
    const body = chunks[i + 1] ?? '';
    const calls: Call[] = [];
    for (const m of body.matchAll(/_http\.request\(\s*"(\w+)",\s*f?"([^"]+)"/g)) {
      calls.push({ httpMethod: m[1]!, path: m[2]! });
    }
    out.set(name, calls);
  }
  return out;
}

function classesOf(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const chunks = src.split(/\nclass (\w+)/);
  for (let i = 1; i < chunks.length; i += 2) out.set(chunks[i]!, chunks[i + 1] ?? '');
  return out;
}

interface Pair {
  readonly file: string;
  readonly syncClass: string;
  readonly sync: Map<string, Call[]>;
  readonly async: Map<string, Call[]>;
}

function pairs(): Pair[] {
  const out: Pair[] = [];
  for (const entry of readdirSync(RESOURCES)) {
    if (!entry.endsWith('.py') || entry.startsWith('_')) continue;
    const classes = classesOf(readFileSync(resolve(RESOURCES, entry), 'utf8'));
    for (const [name, body] of classes) {
      if (name.startsWith('Async')) continue;
      const mirror = classes.get(`Async${name}`);
      if (mirror === undefined) continue;
      out.push({
        file: entry,
        syncClass: name,
        sync: methodsOf(body),
        async: methodsOf(mirror),
      });
    }
  }
  return out;
}

const publicMethods = (m: Map<string, Call[]>): string[] =>
  [...m.keys()].filter((k) => !k.startsWith('_'));

const describeCalls = (c: Call[] | undefined): string =>
  c === undefined
    ? 'ABSENT'
    : c.map((x) => `${x.httpMethod} ${x.path}`).join(' + ') || 'no request';

describe('sdk-python sync and async resources issue the same requests', () => {
  it('CRITICAL the parse found the real resource pairs. The comparison below reports divergence, so a parser that produced nothing — or attributed calls to the wrong methods — would report perfect agreement. That is the one failure this guard cannot see from the inside.', () => {
    const all = pairs();
    expect(all.length, 'sync/async class pairs').toBeGreaterThanOrEqual(19);
    expect(
      all.reduce((n, p) => n + publicMethods(p.sync).length, 0),
      'public sync methods parsed',
    ).toBeGreaterThanOrEqual(130);
  });

  it("CRITICAL the parser attributes calls to the method that makes them. `__init__` stores the client and issues no request; an earlier draft credited it with the next method's call, which would compare the wrong pairs and still find them equal.", () => {
    const mfa = pairs().find((p) => p.file === 'mfa.py');
    expect(mfa, 'mfa.py must yield a pair').toBeDefined();
    expect(mfa!.sync.get('__init__'), '__init__ issues no request').toEqual([]);
    expect(mfa!.sync.get('status'), 'status issues exactly its own GET').toEqual([
      { httpMethod: 'GET', path: '/v1/account/mfa' },
    ]);
  });

  it('CRITICAL every async mirror issues the same method and path as its sync twin. The existing cross-SDK guards pin that the async verb EXISTS; a verb that exists and calls the wrong route keeps them green while asyncio callers reach a different endpoint than sync callers.', () => {
    const mismatches: string[] = [];
    for (const p of pairs()) {
      for (const name of new Set([...publicMethods(p.sync), ...publicMethods(p.async)])) {
        const s = p.sync.get(name);
        const a = p.async.get(name);
        if (JSON.stringify(s) !== JSON.stringify(a)) {
          mismatches.push(
            `${p.file} ${p.syncClass}.${name}: sync=[${describeCalls(s)}] async=[${describeCalls(a)}]`,
          );
        }
      }
    }
    expect(
      mismatches.sort(),
      'sync/async request divergence — an asyncio caller would reach a different endpoint:',
    ).toEqual([]);
  });

  it('CRITICAL each pair exposes the same public method set. This overlaps the cross-SDK lifecycle guards deliberately: those cover two resources, this covers all nineteen, and an added-to-one-only method is how the request divergence above starts.', () => {
    const asymmetric: string[] = [];
    for (const p of pairs()) {
      const s = new Set(publicMethods(p.sync));
      const a = new Set(publicMethods(p.async));
      for (const n of s) if (!a.has(n)) asymmetric.push(`${p.file} ${p.syncClass}.${n}: sync only`);
      for (const n of a)
        if (!s.has(n)) asymmetric.push(`${p.file} ${p.syncClass}.${n}: async only`);
    }
    expect(asymmetric.sort(), 'method(s) present on only one side of a pair:').toEqual([]);
  });
});
