// Every SDK call the docs teach is a call the SDK actually has.
//
// The docs contain 70 TypeScript blocks and they are the first thing a customer
// runs. A renamed or removed resource method leaves the page teaching a call
// that throws `is not a function` — which reads to the reader as the SDK being
// broken, not the documentation being stale. Renaming a method is an ordinary
// refactor, so nothing about that failure is exotic.
//
// This is deliberately narrow. It checks that `client.<resource>.<method>(`
// resolves against the SDK's own class surface, and nothing about arguments or
// return types. That narrowness is why it is worth having: measured across the
// whole docs tree it finds 94 distinct calls and needs ZERO exemptions today.
//
// The wider check was measured and rejected. Comparing every field name in the
// 197 published JSON examples against the OpenAPI property vocabulary turns up
// 21 names absent from every schema, and all 21 are legitimate — webhook
// payloads are not API operations, `current_sessions` and `retry_after_seconds`
// are RFC 7807 extensions rather than schema properties, and `profile_name`,
// `requestedAt` and `href` live inside free-form or passthrough containers the
// server really does emit. A guard needing 21 hand-written exemptions on its
// first day is one nobody will trust on its hundredth, so it was not built.
//
// The resource map is read from `client.ts` rather than restated, and the
// methods from the resource classes, so adding a resource needs no edit here.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const SDK = join(REPO, 'packages', 'sdk-typescript', 'src');
const DOCS = join(REPO, 'apps', 'docs', 'src', 'pages');

/** `client.<prop>` -> the Resource class backing it, read off the client. */
function resourceClasses(): Map<string, string> {
  const src = readFileSync(join(SDK, 'client.ts'), 'utf8');
  return new Map(
    [...src.matchAll(/readonly\s+([a-zA-Z]+):\s*([A-Za-z]+Resource)/g)].map((m) => [m[1]!, m[2]!]),
  );
}

/** Resource class -> the method names it defines. */
function classMethods(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const dir = join(SDK, 'resources');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(join(dir, file), 'utf8');
    for (const cls of src.matchAll(
      /export class ([A-Za-z]+Resource)\b([\s\S]*?)(?=\nexport class |$)/g,
    )) {
      const body = cls[2] ?? '';
      const names = new Set<string>();
      for (const m of body.matchAll(/\n {2}(?:async\s+)?\*?([a-zA-Z_][\w]*)\s*[(<]/g)) {
        names.add(m[1]!);
      }
      for (const m of body.matchAll(/\n {2}([a-zA-Z_][\w]*)\s*=\s*(?:async\s*)?\(/g)) {
        names.add(m[1]!);
      }
      names.delete('constructor');
      out.set(cls[1]!, names);
    }
  }
  return out;
}

interface DocCall {
  resource: string;
  method: string;
  file: string;
}

/** Every `client.<resource>.<method>(` in a TS/JS block across the docs. */
function documentedCalls(): DocCall[] {
  const out: DocCall[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.mdx?$/.test(entry.name)) continue;
      const text = readFileSync(full, 'utf8');
      for (const block of text.matchAll(/```(?:ts|js|typescript)\n([\s\S]*?)```/g)) {
        for (const call of (block[1] ?? '').matchAll(
          /\b(?:client|driftstack|ds)\.([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\s*\(/g,
        )) {
          out.push({ resource: call[1]!, method: call[2]!, file: full.slice(DOCS.length + 1) });
        }
      }
    }
  };
  walk(DOCS);
  return out;
}

describe('every SDK call the docs teach exists in the SDK', () => {
  it('CRITICAL both sides parsed into real populations. Each assertion below reports an ABSENCE, so a regex that stopped matching — a renamed client field, a reformatted resource class — would report a clean pass having compared nothing.', () => {
    const classes = resourceClasses();
    const methods = classMethods();
    const calls = documentedCalls();

    // MEASURED: 19 resources on the client, 19 resource classes, 94 distinct
    // calls across the docs tree.
    expect(classes.size, 'resources declared on the client').toBeGreaterThanOrEqual(15);
    expect(methods.size, 'resource classes parsed').toBeGreaterThanOrEqual(15);
    expect(
      calls.length,
      'documented client.<resource>.<method>( call sites',
    ).toBeGreaterThanOrEqual(80);
    // Every declared resource must have yielded methods, or a parse that
    // returned empty sets would make every call below trivially "unknown"
    // — or, worse, trivially fine if the check were inverted.
    expect(
      [...classes.values()].filter((c) => (methods.get(c)?.size ?? 0) === 0),
      'resource class(es) that parsed to zero methods:',
    ).toEqual([]);
  });

  it('CRITICAL every documented resource exists on the client. A page reaching for `client.somethingRemoved` teaches a property that is undefined at runtime.', () => {
    const classes = resourceClasses();
    const unknown = [
      ...new Set(
        documentedCalls()
          .filter((c) => !classes.has(c.resource))
          .map((c) => `client.${c.resource} (${c.file})`),
      ),
    ].sort();
    expect(unknown, 'documented resource(s) the client does not expose:').toEqual([]);
  });

  it('CRITICAL every documented method exists on its resource. This is the one a rename breaks: the docs keep teaching the old name, the call throws "is not a function", and the reader concludes the SDK is broken rather than the page being stale.', () => {
    const classes = resourceClasses();
    const methods = classMethods();
    const unknown = [
      ...new Set(
        documentedCalls()
          .filter((c) => classes.has(c.resource))
          .filter((c) => !(methods.get(classes.get(c.resource) ?? '') ?? new Set()).has(c.method))
          .map((c) => `client.${c.resource}.${c.method}() (${c.file})`),
      ),
    ].sort();
    expect(unknown, 'documented call(s) with no such method on the SDK resource:').toEqual([]);
  });
});
