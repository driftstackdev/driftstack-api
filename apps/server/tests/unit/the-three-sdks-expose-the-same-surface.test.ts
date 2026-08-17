// The TypeScript, Python and Go SDKs must expose the same operations.
//
// Three hand-maintained codebases implement one product surface. A method added
// to one and forgotten in the others is invisible: each SDK's own tests pass,
// the docs cite whichever one the author had open, and a customer on the other
// two simply cannot perform an operation the product advertises.
//
// Nothing compared them. The closest existing guard,
// marketing-site/api-reference-sdk-class-parity, states the assumption out
// loud — "Python + Go SDKs share the same class names ... so pinning against
// the TS export is load-bearing for all three" — and then checks only the TS
// export. This turns that assumption into a check, for the resource surface
// rather than the error classes.
//
// Measured when this landed: all 19 resources exist in all three SDKs, and
// every method set matches except two, both deliberate and documented in
// source:
//
//   • cryptoOrders.listAll — a TS-only convenience that materialises every
//     page into one array. Python and Go expose `iterate`/`Iterate`, which TS
//     has too; streaming is the idiomatic shape in those languages.
//   • usage.current — the historical TS name. Its own doc comment records that
//     `currentPeriod` exists as the cross-SDK synonym precisely so a customer
//     porting between SDKs does not hit a rename, and all three carry that.
//
// Those two are an EXACT allowance, not a skip: a third divergence has to be
// justified here rather than quietly joining them.
//
// Names are compared case- and separator-insensitively, because the three
// languages disagree about casing by convention and that is not drift:
// `createCheckout` / `create_checkout` / `CreateCheckout` are one operation.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function tracked(pathspec: string): string[] {
  return execFileSync('git', ['ls-files', pathspec], { cwd: REPO, encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean);
}

const read = (f: string): string => readFileSync(resolve(REPO, f), 'utf-8');

/** Case and separators carry no meaning across these three languages. */
const key = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

type Surface = Map<string, Set<string>>;

function add(surface: Surface, resource: string, method: string): void {
  const bucket = surface.get(resource) ?? new Set<string>();
  bucket.add(method);
  surface.set(resource, bucket);
}

function typescriptSurface(): Surface {
  const surface: Surface = new Map();
  for (const file of tracked('packages/sdk-typescript/src/resources').filter((f) =>
    f.endsWith('.ts'),
  )) {
    const resource = key(basename(file, '.ts'));
    for (const [, method] of read(file).matchAll(/^ {2}(?:async\s+)?([a-zA-Z][A-Za-z0-9]*)\s*\(/gm))
      if (method !== 'constructor') add(surface, resource, key(method!));
  }
  return surface;
}

function pythonSurface(): Surface {
  const surface: Surface = new Map();
  for (const file of tracked('packages/sdk-python/src').filter(
    (f) => f.endsWith('.py') && f.includes('/resources/'),
  )) {
    const resource = key(basename(file, '.py'));
    for (const [, method] of read(file).matchAll(
      /^ {4}(?:async\s+)?def\s+([a-zA-Z][A-Za-z0-9_]*)\s*\(/gm,
    ))
      if (!method!.startsWith('__')) add(surface, resource, key(method!));
  }
  return surface;
}

function goSurface(): Surface {
  const surface: Surface = new Map();
  for (const file of tracked('packages/sdk-go').filter(
    (f) => f.endsWith('.go') && !f.endsWith('_test.go'),
  ))
    for (const [, resource, method] of read(file).matchAll(
      /func \(\w+ \*?(\w+?)Resource\) ([A-Z]\w*)\(/g,
    ))
      add(surface, key(resource!), key(method!));
  return surface;
}

/** Deliberate, source-documented single-language extras. */
const ALLOWED_EXTRAS: Readonly<Record<string, readonly string[]>> = {
  cryptoorders: ['listall'],
  usage: ['current'],
};

describe('the three SDKs expose the same surface', () => {
  const ts = typescriptSurface();
  const py = pythonSurface();
  const go = goSurface();

  it('CRITICAL all three extractors found a real surface', () => {
    for (const [label, surface] of [
      ['typescript', ts],
      ['python', py],
      ['go', go],
    ] as const)
      expect(
        surface.size,
        `${label}: no resources parsed — that extractor is broken`,
      ).toBeGreaterThanOrEqual(15);
    // Known operations, so a pass is not three empty sets agreeing.
    expect(ts.get('cryptoorders')).toContain('createcheckout');
    expect(py.get('cryptoorders')).toContain('createcheckout');
    expect(go.get('cryptoorders')).toContain('createcheckout');
    expect(ts.get('cryptoorders')).not.toContain('methodthatdoesnotexist');
  });

  it('CRITICAL every resource exists in all three SDKs', () => {
    const all = [...new Set([...ts.keys(), ...py.keys(), ...go.keys()])].sort();
    const partial = all
      .filter((r) => !(ts.has(r) && py.has(r) && go.has(r)))
      .map(
        (r) =>
          `${r}: ${[ts.has(r) && 'ts', py.has(r) && 'py', go.has(r) && 'go'].filter(Boolean).join('+')} only`,
      );
    expect(
      partial,
      'a resource is missing from at least one SDK — customers on that language cannot reach it',
    ).toEqual([]);
  });

  it('CRITICAL every operation exists in all three, apart from the documented extras', () => {
    const divergent: string[] = [];
    for (const resource of [...ts.keys()].filter((r) => py.has(r) && go.has(r)).sort()) {
      const allowed = new Set(ALLOWED_EXTRAS[resource] ?? []);
      const inAll = [
        ...new Set([...ts.get(resource)!, ...py.get(resource)!, ...go.get(resource)!]),
      ].sort();
      for (const method of inAll) {
        if (allowed.has(method)) continue;
        const missing = [
          !ts.get(resource)!.has(method) && 'ts',
          !py.get(resource)!.has(method) && 'py',
          !go.get(resource)!.has(method) && 'go',
        ].filter(Boolean);
        if (missing.length > 0)
          divergent.push(`${resource}.${method}: missing from ${missing.join('+')}`);
      }
    }
    expect(
      divergent.sort(),
      'an operation exists in some SDKs but not others. If that is deliberate it belongs in ' +
        'ALLOWED_EXTRAS with the reason, next to cryptoOrders.listAll and usage.current',
    ).toEqual([]);
  });

  it('CRITICAL the allowance is exact — each entry is still a real single-language extra', () => {
    for (const [resource, methods] of Object.entries(ALLOWED_EXTRAS))
      for (const method of methods) {
        const present = [ts, py, go].filter((s) => s.get(resource)?.has(method)).length;
        expect(
          present,
          `${resource}.${method} is allowed as a single-language extra, but ${present} SDKs have ` +
            'it. If the others caught up, delete the allowance so the comparison covers it',
        ).toBe(1);
      }
  });
});
