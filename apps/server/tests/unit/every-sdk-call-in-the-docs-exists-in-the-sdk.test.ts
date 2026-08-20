// V-1174 — a customer copies a code sample out of the docs. Every method it calls has to
// exist in the SDK it is written for.
//
// There are already fifteen guards over the SDK documentation pages, and every one of them
// is a CONTENT-PARITY PIN: it freezes the text of the page. That is the wrong shape for this
// property. Rename `SessionsResource.navigate` in the TypeScript SDK, touch no documentation,
// and every one of those pins still passes — the page text did not change, so nothing that
// checks page text can notice. The sample is now uncopyable and the suite is green.
//
// So this resolves instead of freezing: 259 `client.<resource>.<method>(` calls, extracted
// from fenced code blocks across 64 documentation pages, each looked up in the surface of the
// SDK that the fence language names. TypeScript, Go and Python are separate populations with
// separate naming conventions (`client.sessions.create` / `client.Sessions.Create` /
// `client.sessions.create`), and a call is only ever checked against its own language.
//
// Measured when written: 19 resources and ~140 methods per SDK, 259 calls, all resolving.
// This ships as an honest negative — nothing in the docs was broken. It earns its place by
// what it will catch: the rename above, which today nothing would.
//
// ── Completeness, because "zero broken" is worthless without it ────────────
//
// Two blind spots were measured rather than assumed:
//
//   • Every sample in all three languages binds the client to a variable named `client`
//     (`const client = new Driftstack` / `client := driftstack.New` / `client = Driftstack(`).
//     A search for resource calls through ANY other receiver returned nothing, so the
//     `client.` pattern is the whole population and not a convenient slice of it.
//   • A fenced block whose language tag is not mapped below would be skipped in silence.
//     The last arm fails on any such block that carries calls, so a new tag (`tsx`, `bash`
//     with a heredoc) cannot quietly remove pages from the population.
//
// ── Why the Python client is read twice ────────────────────────────────────
//
// `client.py` declares BOTH `Driftstack` and `AsyncDriftstack`, and each assigns the same
// nineteen attribute names to different classes — `self.sessions = SessionsResource(...)` in
// one, `AsyncSessionsResource(...)` in the other. Collecting those assignments into a single
// map keeps whichever came last, which is the async one. A first version of this did exactly
// that, and the consequence was invisible: doc samples are synchronous, so they were being
// validated against the ASYNC surface. It passed. It would also have passed with the sync
// method deleted, which is precisely the failure it exists to catch.
//
// The fix is to scope each assignment to the class that encloses it. The arm asserting the
// two surfaces are identical is what makes the mistake loud rather than silent next time —
// and it is a real customer-facing property besides, since a method present on only one of
// them breaks anyone moving a working script from sync to async.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

function filesIn(rel: string, ext: string): string[] {
  const dir = resolve(REPO_ROOT, rel);
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => `${rel}/${f}`);
}

/** resource property on the client → the set of methods it exposes. */
type Surface = Map<string, Set<string>>;

/** Method names declared directly in a class body, stopping at the next class. */
function methodsOf(source: string, className: string, decl: RegExp): Set<string> {
  const at = new RegExp(`^(?:export )?class ${className}\\b`, 'm').exec(source);
  if (at === null) return new Set();
  let body = source.slice(at.index + at[0].length);
  const next = /\n(?:export )?class /.exec(body);
  if (next !== null) body = body.slice(0, next.index);
  const out = new Set<string>();
  for (const m of body.matchAll(decl)) {
    const name = m[1] ?? '';
    if (name !== 'constructor' && !name.startsWith('_')) out.add(name);
  }
  return out;
}

function typescriptSurface(): Surface {
  const client = read('packages/sdk-typescript/src/client.ts');
  const sources = filesIn('packages/sdk-typescript/src/resources', '.ts').map(read).join('\n');
  const out: Surface = new Map();
  for (const m of client.matchAll(/readonly (\w+):\s*(\w+Resource);/g)) {
    const methods = methodsOf(
      sources,
      m[2] ?? '',
      /^ {2}(?:public\s+)?(?:async\s+)?(?:\*\s*)?(\w+)\s*[(<]/gm,
    );
    for (const extra of methodsOf(
      sources,
      m[2] ?? '',
      /^ {2}(?:readonly\s+)?(\w+)\s*=\s*(?:async\s*)?\(/gm,
    )) {
      methods.add(extra);
    }
    out.set(m[1] ?? '', methods);
  }
  return out;
}

function goSurface(): Surface {
  const blob = filesIn('packages/sdk-go', '.go').map(read).join('\n');
  const byClass = new Map<string, Set<string>>();
  for (const m of blob.matchAll(/^func \(\w+ \*(\w+Resource)\) (\w+)\(/gm)) {
    const set = byClass.get(m[1] ?? '') ?? new Set<string>();
    set.add(m[2] ?? '');
    byClass.set(m[1] ?? '', set);
  }
  const out: Surface = new Map();
  for (const m of blob.matchAll(/^\t(\w+)\s+\*(\w+Resource)$/gm)) {
    out.set(m[1] ?? '', byClass.get(m[2] ?? '') ?? new Set());
  }
  return out;
}

/**
 * The Python client file declares a sync and an async client. Each assignment is attributed
 * to the class that encloses it, so `Driftstack` and `AsyncDriftstack` do not overwrite each
 * other — see the header note; collapsing them validated the docs against the wrong surface.
 */
function pythonSurfaces(): { sync: Surface; async: Surface } {
  const client = read('packages/sdk-python/src/driftstack/client.py');
  const sources = filesIn('packages/sdk-python/src/driftstack/resources', '.py')
    .map(read)
    .join('\n');
  const classAt = [...client.matchAll(/^class (\w+)/gm)].map((m) => ({
    name: m[1] ?? '',
    at: m.index,
  }));

  const built = new Map<string, Surface>();
  for (const m of client.matchAll(/self\.(\w+)\s*=\s*(\w+Resource)\(/g)) {
    const enclosing = [...classAt].reverse().find((c) => c.at < m.index)?.name ?? '';
    const surface: Surface = built.get(enclosing) ?? new Map<string, Set<string>>();
    surface.set(m[1] ?? '', methodsOf(sources, m[2] ?? '', /^ {4}(?:async\s+)?def (\w+)\s*\(/gm));
    built.set(enclosing, surface);
  }
  const syncName = [...built.keys()].find((k) => !k.startsWith('Async')) ?? '';
  const asyncName = [...built.keys()].find((k) => k.startsWith('Async')) ?? '';
  return { sync: built.get(syncName) ?? new Map(), async: built.get(asyncName) ?? new Map() };
}

/** Fence language tag → which SDK surface a call inside it belongs to. */
const LANGUAGES: Readonly<Record<string, 'ts' | 'go' | 'python'>> = {
  ts: 'ts',
  typescript: 'ts',
  js: 'ts',
  javascript: 'ts',
  go: 'go',
  python: 'python',
  py: 'python',
};

const FENCE = /```(\w+)\b([\s\S]*?)```/g;
const CALL = /\bclient\.(\w+)\.(\w+)\s*\(/g;

function docPages(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(resolve(REPO_ROOT, rel))) {
      const child = `${rel}/${entry}`;
      if (statSync(resolve(REPO_ROOT, child)).isDirectory()) walk(child);
      else if (/\.mdx?$/.test(entry)) out.push(child);
    }
  };
  walk('apps/docs/src/pages');
  walk('apps/marketing-site/src/pages');
  return out;
}

interface Call {
  page: string;
  lang: string;
  resource: string;
  method: string;
}

function docCalls(): { calls: Call[]; unmapped: string[] } {
  const calls: Call[] = [];
  const unmapped: string[] = [];
  for (const page of docPages()) {
    for (const block of read(page).matchAll(FENCE)) {
      const tag = (block[1] ?? '').toLowerCase();
      const inside = [...(block[2] ?? '').matchAll(CALL)];
      if (inside.length === 0) continue;
      const lang = LANGUAGES[tag];
      if (lang === undefined) {
        unmapped.push(`${page}: \`\`\`${tag} carries ${inside.length} SDK call(s)`);
        continue;
      }
      for (const m of inside) {
        calls.push({ page, lang, resource: m[1] ?? '', method: m[2] ?? '' });
      }
    }
  }
  return { calls, unmapped };
}

describe('V-1174 every SDK call in the docs exists in the SDK', () => {
  it('CRITICAL all three SDK surfaces extract non-vacuously. An extractor that yielded an empty surface would report every documented call broken, and one that yielded a superset would report them all fine — so this pins the shape of each surface and names methods that must be in it.', () => {
    const ts = typescriptSurface();
    const go = goSurface();
    const { sync } = pythonSurfaces();

    for (const [name, s] of [
      ['typescript', ts],
      ['go', go],
      ['python', sync],
    ] as const) {
      expect(s.size, `${name}: no client resources extracted`).toBeGreaterThan(15);
      expect(
        [...s.values()].reduce((n, v) => n + v.size, 0),
        `${name}: resources extracted but no methods`,
      ).toBeGreaterThan(100);
    }

    expect([...(ts.get('sessions') ?? [])].sort()).toContain('navigate');
    expect([...(go.get('Sessions') ?? [])].sort()).toContain('Navigate');
    expect([...(sync.get('sessions') ?? [])].sort()).toContain('navigate');
  });

  it('CRITICAL the Python sync and async clients expose the same resources and the same methods. A method on only one of them breaks anyone moving a working script from sync to async — and collapsing the two is what silently validated these docs against the async surface in the first version of this file.', () => {
    const { sync, async } = pythonSurfaces();
    expect(sync.size, 'no sync client resources found').toBeGreaterThan(15);
    expect([...async.keys()].sort(), 'the async client exposes a different resource set').toEqual(
      [...sync.keys()].sort(),
    );
    const differing = [...sync.entries()]
      .map(([name, s]) => {
        const a = async.get(name) ?? new Set<string>();
        const only = [...s].filter((x) => !a.has(x));
        const other = [...a].filter((x) => !s.has(x));
        return only.length + other.length === 0
          ? null
          : `${name}: sync-only=[${only.sort().join(', ')}] async-only=[${other.sort().join(', ')}]`;
      })
      .filter((x): x is string => x !== null);
    expect(differing.sort(), 'resources whose sync and async method sets disagree').toEqual([]);
  });

  it('CRITICAL every fenced block carrying an SDK call has a language this guard understands. An unmapped tag is skipped in silence, which would quietly shrink the population and make the arm below easier to satisfy rather than more true.', () => {
    const { calls, unmapped } = docCalls();
    expect(unmapped.sort(), 'code blocks whose fence language is not mapped to an SDK').toEqual([]);
    expect(calls.length, 'no SDK calls extracted from the documentation').toBeGreaterThan(200);
    // All three languages must actually be represented; a regression that dropped one
    // would otherwise leave this green on the remaining two.
    for (const lang of ['ts', 'go', 'python']) {
      expect(
        calls.some((c) => c.lang === lang),
        `no ${lang} SDK calls found in any documentation page`,
      ).toBe(true);
    }
  });

  it('CRITICAL every documented SDK call resolves to a method that exists in that SDK. The fifteen existing guards over these pages freeze the page TEXT, so renaming an SDK method without touching the docs leaves every one of them green and every sample uncopyable.', () => {
    const surfaces = {
      ts: typescriptSurface(),
      go: goSurface(),
      python: pythonSurfaces().sync,
    } as const;

    const broken = docCalls()
      .calls.filter((c) => {
        const methods = surfaces[c.lang as keyof typeof surfaces].get(c.resource);
        return methods === undefined || !methods.has(c.method);
      })
      .map((c) => `${c.page}: client.${c.resource}.${c.method}() [${c.lang}]`);

    expect([...new Set(broken)].sort(), 'documented SDK calls with no such method').toEqual([]);
  });
});
