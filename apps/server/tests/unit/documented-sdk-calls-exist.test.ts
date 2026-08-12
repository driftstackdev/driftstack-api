// Every SDK call the docs teach is a call the SDK actually has — in all three
// languages we ship.
//
// The docs contain 70 TypeScript, 24 Python and 23 Go blocks, and they are the
// first thing a customer runs. A renamed or removed resource method leaves the page teaching a call
// that throws `is not a function` — which reads to the reader as the SDK being
// broken, not the documentation being stale. Renaming a method is an ordinary
// refactor, so nothing about that failure is exotic.
//
// This is deliberately narrow. It checks that a documented call resolves
// against the SDK's own surface, and nothing about arguments or return types.
// That narrowness is why it is worth having: measured across the whole docs
// tree it finds 94 TypeScript, 27 Python and 26 Go calls — 147 in total — and
// needs ZERO exemptions in any of the three.
//
// Three languages, three different shapes, so each gets its own reader rather
// than one regex bent to cover all of them. TypeScript resources are classes
// listed on the client; Python resources are attributes assigned in
// `client.py` whose methods are `def` in a class body; Go resources are struct
// fields whose methods are functions with a pointer receiver. A single matcher
// for all three would be the kind that quietly matches nothing in one of them.
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

/**
 * Python: `self.<attr> = <Class>(...)` in client.py, methods are `def` in a class.
 *
 * An attribute maps to a SET of classes, not one. `client.py` builds a sync and
 * an async client and both assign `self.api_keys`, to `ApiKeysResource` and
 * `AsyncApiKeysResource`. Keeping only the last assignment resolved every
 * documented call against the async surface alone — and a rename confined to
 * the sync class passed. That was found by mutating `def rotate` and watching
 * this file stay green, which is the whole reason the mutation is run before
 * the guard is trusted. A documented call must exist on EVERY class bound to
 * the attribute, so a rename in either half fails.
 */
function pythonSurface(): { attrs: Map<string, Set<string>>; methods: Map<string, Set<string>> } {
  const pyRoot = join(REPO, 'packages', 'sdk-python', 'src', 'driftstack');
  const client = readFileSync(join(pyRoot, 'client.py'), 'utf8');
  const attrs = new Map<string, Set<string>>();
  for (const m of client.matchAll(/self\.([a-z_]+)\s*[:=]\s*([A-Za-z]+)\s*\(/g)) {
    const set = attrs.get(m[1]!) ?? new Set<string>();
    set.add(m[2]!);
    attrs.set(m[1]!, set);
  }
  const methods = new Map<string, Set<string>>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.py')) continue;
      const src = readFileSync(full, 'utf8');
      for (const cls of src.matchAll(/class ([A-Za-z]+)[(:]([\s\S]*?)(?=\nclass |$)/g)) {
        const found = new Set<string>();
        for (const d of (cls[2] ?? '').matchAll(/\n {4}(?:async )?def ([a-z_][\w]*)\s*\(/g)) {
          found.add(d[1]!);
        }
        if (found.size > 0) {
          const existing = methods.get(cls[1]!) ?? new Set<string>();
          for (const f of found) existing.add(f);
          methods.set(cls[1]!, existing);
        }
      }
    }
  };
  walk(pyRoot);
  return { attrs, methods };
}

/** Go: exported struct fields on the client, methods with a pointer receiver. */
function goSurface(): { fields: Map<string, string>; methods: Map<string, Set<string>> } {
  const goRoot = join(REPO, 'packages', 'sdk-go');
  let client = '';
  for (const name of ['client.go', 'driftstack.go']) {
    try {
      client += readFileSync(join(goRoot, name), 'utf8');
    } catch {
      /* not every layout has both */
    }
  }
  const fields = new Map<string, string>();
  for (const m of client.matchAll(
    /\n\t([A-Z][A-Za-z]*)\s+\*?([A-Z][A-Za-z]*(?:Service|Resource))\b/g,
  )) {
    fields.set(m[1]!, m[2]!);
  }
  const methods = new Map<string, Set<string>>();
  for (const file of readdirSync(goRoot)) {
    if (!file.endsWith('.go') || file.endsWith('_test.go')) continue;
    const src = readFileSync(join(goRoot, file), 'utf8');
    for (const m of src.matchAll(/func \(\w+ \*?([A-Z][A-Za-z]*)\) ([A-Z][A-Za-z]*)\s*\(/g)) {
      const set = methods.get(m[1]!) ?? new Set<string>();
      set.add(m[2]!);
      methods.set(m[1]!, set);
    }
  }
  return { fields, methods };
}

interface DocCall {
  resource: string;
  method: string;
  file: string;
}

interface Lang {
  /** Fence languages this reader claims. */
  fences: string;
  /** Captures resource then method from a call site. */
  call: RegExp;
}

const TS: Lang = {
  fences: 'ts|js|typescript',
  call: /\b(?:client|driftstack|ds)\.([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\s*\(/g,
};
const PY: Lang = {
  fences: 'python',
  call: /\b(?:client|driftstack|ds)\.([a-z_]\w*)\.([a-z_]\w*)\s*\(/g,
};
const GO: Lang = {
  fences: 'go',
  // Go call sites are `client.Sessions.Create(` — `c` is the idiomatic short
  // receiver used in several examples.
  call: /\b(?:client|ds|c)\.([A-Z][A-Za-z]*)\.([A-Z][A-Za-z]*)\s*\(/g,
};

/** Every documented `<client>.<resource>.<method>(` for one language. */
function documentedCalls(lang: Lang = TS): DocCall[] {
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
      for (const block of text.matchAll(
        new RegExp('```(?:' + lang.fences + ')\\n([\\s\\S]*?)```', 'g'),
      )) {
        for (const call of (block[1] ?? '').matchAll(new RegExp(lang.call.source, 'g'))) {
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

describe('the Python and Go docs teach calls those SDKs have', () => {
  it('CRITICAL both surfaces parsed. Python resources are attributes assigned in client.py and Go resources are struct fields — different shapes from TypeScript, and a reader that silently matched neither would report both languages clean.', () => {
    const py = pythonSurface();
    const go = goSurface();
    // MEASURED: 20 python attributes, 19 go client fields, 54 method-bearing
    // types on each side.
    expect(py.attrs.size, 'python client attributes').toBeGreaterThanOrEqual(15);
    expect(
      [...py.attrs.values()].filter((v) => v.size >= 2).length,
      'attributes bound to BOTH a sync and an async class — if this is 0 the sync half is not being checked',
    ).toBeGreaterThanOrEqual(10);
    expect(py.methods.size, 'python classes with methods').toBeGreaterThanOrEqual(20);
    expect(go.fields.size, 'go client fields').toBeGreaterThanOrEqual(15);
    expect(go.methods.size, 'go types with exported methods').toBeGreaterThanOrEqual(20);
    expect(documentedCalls(PY).length, 'documented python call sites').toBeGreaterThanOrEqual(20);
    expect(documentedCalls(GO).length, 'documented go call sites').toBeGreaterThanOrEqual(20);
  });

  it('CRITICAL every documented PYTHON call exists. The snake_case surface drifts independently of TypeScript — a method renamed in one SDK and not the other is exactly the asymmetry a cross-SDK parity suite is blind to when the docs are the thing that fell behind.', () => {
    const { attrs, methods } = pythonSurface();
    const unknown = [
      ...new Set(
        documentedCalls(PY)
          .filter((c) => {
            const classes = attrs.get(c.resource);
            if (classes === undefined) return true;
            // Every class bound to the attribute must define it — sync AND async.
            return [...classes].some((cls) => !(methods.get(cls) ?? new Set()).has(c.method));
          })
          .map((c) => `client.${c.resource}.${c.method}() (${c.file})`),
      ),
    ].sort();
    expect(unknown, 'documented python call(s) the SDK does not define:').toEqual([]);
  });

  it('CRITICAL every documented GO call exists. Go is the SDK a customer is least likely to have compiled before pasting from the page, so a stale name here is discovered at build time by someone who has not run anything yet.', () => {
    const { fields, methods } = goSurface();
    const unknown = [
      ...new Set(
        documentedCalls(GO)
          .filter(
            (c) =>
              !fields.has(c.resource) ||
              !(methods.get(fields.get(c.resource) ?? '') ?? new Set()).has(c.method),
          )
          .map((c) => `client.${c.resource}.${c.method}() (${c.file})`),
      ),
    ].sort();
    expect(unknown, 'documented go call(s) the SDK does not define:').toEqual([]);
  });
});
