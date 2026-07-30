// Public-surface resolution guard (A2, 2026-07-30).
//
// Content-parity guards prove a page matches what the guard EXPECTS. They
// cannot prove the page is TRUE. This one closes that gap for the two claims a
// customer acts on directly:
//
//   1. every `/v1/...` path printed in customer docs resolves to a route the
//      server actually registers, and
//   2. every `client.<resource>.<method>(` call shown in customer docs resolves
//      to a real method on at least one of the three shipped SDKs.
//
// Written after an audit found `apps/docs/src/pages/api/sessions.md` telling
// customers that "recipe-based login for a known site is the separate
// `execute_recipe` surface" — a surface that exists NOWHERE in the codebase
// (`/v1/recipes` is create/list/read/delete only) — and a reference page naming
// `/v1/admin/fleet-nodes/{id}`, which is not registered either. Both drifted in
// unguarded because no test compared docs against the real surface.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const DOC_ROOTS = ['apps/docs/src/pages', 'apps/marketing-site/src/pages'];
const DOC_EXTENSIONS = ['.md', '.astro'];

/**
 * Paths that legitimately appear in our docs but are NOT Driftstack routes.
 * Each entry must say whose API it is — an unexplained exemption here would
 * defeat the whole guard.
 */
const FOREIGN_PATH_EXEMPTIONS: ReadonlyArray<{ path: string; owner: string }> = [
  { path: '/v1/models', owner: "Anthropic's API — cited by the BYOK key-test doc" },
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (DOC_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

function docFiles(): string[] {
  return DOC_ROOTS.flatMap((root) => walk(resolve(REPO_ROOT, root)));
}

function rel(path: string): string {
  return path.slice(REPO_ROOT.length + 1);
}

/** `/v1/x/{id}/y` and `/v1/x/:id/y` normalise to the same shape. */
function normalisePath(route: string): string {
  return route.replace(/\{[^}]+\}/g, ':id').replace(/\/:[A-Za-z_]+/g, '/:id');
}

function registeredRoutes(): Set<string> {
  const dir = resolve(REPO_ROOT, 'apps/server/src/routes');
  let src = '';
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.ts')) src += readFileSync(resolve(dir, file), 'utf8');
  }
  const found = new Set<string>();
  const re = /\.(get|post|put|patch|delete)\b[^(]*\(\s*['"`](\/v1\/[^'"`]+)['"`]/g;
  for (const m of src.matchAll(re)) found.add(normalisePath(m[2]!));
  return found;
}

type Surface = Map<string, Set<string>>;

function typescriptSurface(): Surface {
  const clientSrc = readFileSync(
    resolve(REPO_ROOT, 'packages/sdk-typescript/src/client.ts'),
    'utf8',
  );
  const propToClass = new Map<string, string>();
  for (const m of clientSrc.matchAll(/readonly\s+(\w+)\s*:\s*(\w+Resource)\b/g)) {
    propToClass.set(m[1]!, m[2]!);
  }
  const classMethods = new Map<string, Set<string>>();
  const srcDir = resolve(REPO_ROOT, 'packages/sdk-typescript/src');
  const files: string[] = [];
  (function collect(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) collect(full);
      else if (entry.endsWith('.ts')) files.push(full);
    }
  })(srcDir);
  for (const file of files) {
    const txt = readFileSync(file, 'utf8');
    for (const cm of txt.matchAll(/export class (\w+Resource)\b([\s\S]*?)(?=\nexport class |$)/g)) {
      const set = classMethods.get(cm[1]!) ?? new Set<string>();
      for (const mm of cm[2]!.matchAll(/^ {2}(?:async\s+)?\*?\s*([a-zA-Z_]\w*)\s*[(<]/gm)) {
        set.add(mm[1]!);
      }
      classMethods.set(cm[1]!, set);
    }
  }
  const surface: Surface = new Map();
  for (const [prop, cls] of propToClass) surface.set(prop, classMethods.get(cls) ?? new Set());
  return surface;
}

function pythonSurface(): Surface {
  const root = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack');
  const files: string[] = [];
  (function collect(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== '_generated') collect(full);
      } else if (entry.endsWith('.py')) files.push(full);
    }
  })(root);
  const classMethods = new Map<string, Set<string>>();
  for (const file of files) {
    const txt = readFileSync(file, 'utf8');
    for (const cm of txt.matchAll(/class (\w+)[:(]([\s\S]*?)(?=\nclass |$)/g)) {
      const set = classMethods.get(cm[1]!) ?? new Set<string>();
      for (const mm of cm[2]!.matchAll(/^ {4}(?:async )?def (\w+)\(/gm)) set.add(mm[1]!);
      classMethods.set(cm[1]!, set);
    }
  }
  const clientSrc = readFileSync(resolve(root, 'client.py'), 'utf8');
  const surface: Surface = new Map();
  for (const m of clientSrc.matchAll(/self\.(\w+)\s*[:=]\s*[^\n]*?(\w+Resource)\(/g)) {
    surface.set(m[1]!, classMethods.get(m[2]!) ?? new Set());
  }
  return surface;
}

function goSurface(): Surface {
  const dir = resolve(REPO_ROOT, 'packages/sdk-go');
  let src = '';
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.go')) src += readFileSync(resolve(dir, file), 'utf8');
  }
  const typeMethods = new Map<string, Set<string>>();
  for (const m of src.matchAll(/func \(\w+ \*(\w+Resource)\) (\w+)\(/g)) {
    const set = typeMethods.get(m[1]!) ?? new Set<string>();
    set.add(m[2]!);
    typeMethods.set(m[1]!, set);
  }
  const surface: Surface = new Map();
  for (const m of src.matchAll(/^\t(\w+)\s+\*?(\w+Resource)\b/gm)) {
    surface.set(m[1]!, typeMethods.get(m[2]!) ?? new Set());
  }
  return surface;
}

function resolvesIn(surface: Surface, resource: string, method: string): boolean {
  return surface.get(resource)?.has(method) === true;
}

describe('public docs reference only surfaces that actually exist', () => {
  const files = docFiles();

  it('the doc corpus is non-empty (a broken walk would make every assertion vacuous)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('CRITICAL every `/v1/...` path printed in customer docs resolves to a registered route. A documented endpoint that does not exist is a 404 for a paying customer following our own reference.', () => {
    const registered = registeredRoutes();
    expect(registered.size).toBeGreaterThan(150);

    const exempt = new Set(FOREIGN_PATH_EXEMPTIONS.map((e) => normalisePath(e.path)));
    const unresolved: string[] = [];

    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      for (const m of body.matchAll(/\/v1\/[A-Za-z0-9_\-/:{}.]+/g)) {
        const raw = m[0].replace(/[.,)`"']+$/, '').replace(/\/$/, '');
        const path = normalisePath(raw);
        if (exempt.has(path)) continue;
        // A doc may cite a family (`/v1/sessions`) or a sub-path of a real
        // route; either direction of prefix containment is a real surface.
        const known = [...registered].some(
          (route) => route === path || route.startsWith(`${path}/`) || path.startsWith(`${route}/`),
        );
        if (!known) unresolved.push(`${path}  (${rel(file)})`);
      }
    }

    expect(
      [...new Set(unresolved)].sort(),
      'Documented path(s) with no registered route — fix the docs or register the route:',
    ).toEqual([]);
  });

  it('CRITICAL every `client.<resource>.<method>()` shown in customer docs resolves in at least one shipped SDK. A copy-pasteable example that does not compile or run is a broken promise on the page teaching the product.', () => {
    const surfaces = [typescriptSurface(), pythonSurface(), goSurface()];
    for (const surface of surfaces) expect(surface.size).toBeGreaterThan(10);

    const unresolved: string[] = [];
    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      for (const m of body.matchAll(/\bclient\.(\w+)\.(\w+)\s*\(/g)) {
        const [resource, method] = [m[1]!, m[2]!];
        if (!surfaces.some((s) => resolvesIn(s, resource, method))) {
          unresolved.push(`client.${resource}.${method}()  (${rel(file)})`);
        }
      }
    }

    expect(
      [...new Set(unresolved)].sort(),
      'Documented SDK call(s) that exist in no SDK — fix the docs or ship the method:',
    ).toEqual([]);
  });

  it('every foreign-path exemption names whose API it is, so the list cannot quietly become a dumping ground', () => {
    for (const entry of FOREIGN_PATH_EXEMPTIONS) {
      expect(entry.path).toMatch(/^\/v1\//);
      expect(entry.owner.length, `exemption ${entry.path} must explain itself`).toBeGreaterThan(15);
    }
  });
});
