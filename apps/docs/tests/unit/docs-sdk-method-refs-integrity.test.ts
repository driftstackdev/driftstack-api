// Doc SDK-example reference integrity.
//
// The docs are full of `client.<resource>.<method>(...)` snippets in
// two casings: TypeScript (`client.apiKeys.create`) and Go
// (`client.APIKeys.Create`). Nothing pinned that these reference REAL
// SDK methods — a renamed/removed SDK method would leave the docs
// pointing at a method that doesn't exist, and no parity test catches
// it (the SDK content-parity tests pin the SDK source, not the docs'
// references to it). This guard validates every doc reference against
// the actual SDK method definitions.
//
// Scope: TS-style (camelCase resource) → packages/sdk-typescript; Go-
// style (PascalCase resource) → packages/sdk-go. Python snake_case
// refs are not currently emitted in docs; add a branch if that changes.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');
const TS_RES = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources');
const GO_DIR = resolve(REPO_ROOT, 'packages/sdk-go');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    throw new Error(
      `walk root is missing: ${dir} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
    );
  for (const e of readdirSync(dir)) {
    const full = resolve(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const read = (p: string): string => readFileSync(p, 'utf8');

// camelCase TS resource → kebab source file (agentSessions → agent-sessions).
const tsFile = (res: string): string => res.replace(/([A-Z])/g, '-$1').toLowerCase();

// PascalCase Go resource → snake source file. Generic boundary rule,
// plus explicit overrides for consecutive-caps acronyms.
const GO_OVERRIDE: Record<string, string> = { APIKeys: 'api_keys' };
const goFile = (res: string): string =>
  GO_OVERRIDE[res] ?? res.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

describe('docs SDK-example method-reference integrity', () => {
  const docFiles = walk(DOCS_PAGES).filter((f) => /\.(md|astro)$/.test(f));
  const corpus = docFiles.map(read).join('\n');

  it('finds SDK references in the docs', () => {
    expect(/client\.[A-Za-z]+\.[A-Za-z]+\(/.test(corpus)).toBe(true);
  });

  it('every TS-style client.<resource>.<method>( reference exists in the TS SDK', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const m of corpus.matchAll(/client\.([a-z][a-zA-Z]*)\.([a-zA-Z]+)\(/g)) {
      const res = m[1]!;
      const meth = m[2]!;
      const key = `${res}.${meth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const file = resolve(TS_RES, `${tsFile(res)}.ts`);
      if (!existsSync(file)) {
        offenders.push(`client.${key} → no TS resource ${tsFile(res)}.ts`);
        continue;
      }
      if (!new RegExp(`^\\s+(async )?${meth}(\\(|<)`, 'm').test(read(file))) {
        offenders.push(`client.${key} → ${meth}() not in ${tsFile(res)}.ts`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every Go-style client.<Resource>.<Method>( reference exists in the Go SDK', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const m of corpus.matchAll(/client\.([A-Z][a-zA-Z]*)\.([A-Z][a-zA-Z]+)\(/g)) {
      const res = m[1]!;
      const meth = m[2]!;
      const key = `${res}.${meth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const file = resolve(GO_DIR, `${goFile(res)}.go`);
      if (!existsSync(file)) {
        offenders.push(`client.${key} → no Go file ${goFile(res)}.go`);
        continue;
      }
      if (!new RegExp(`func \\(r \\*[A-Za-z]+Resource\\) ${meth}\\(`).test(read(file))) {
        offenders.push(`client.${key} → ${meth}() not in ${goFile(res)}.go`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
