// V-1012 — the comment-stripper that three drift-guards decide with.
//
// `_helpers/code-only.ts` exists because a guard that matches text in a source
// file cannot tell prose from code, and several were failing in both directions:
// a route that documented WHY it opts out of a shared helper was discovered as a
// consumer of it, and a negative sentinel could be satisfied by a comment quoting
// the very thing it forbids.
//
// A stripper is a bad thing to get wrong quietly. Strip too little and a guard
// widens — it starts matching prose again, and nothing fails. Strip too much and
// a guard narrows — real code disappears and the arm passes because it now sees
// an empty file. The naive two-regex version did the second: `//` and `/*` were
// handled in separate passes, so the `/*` inside `// AI-D — /v1/agent-sessions/*
// routes` opened a block comment that closed 7962 characters later, taking the
// imports with it. That is not a corner case in this repo — eighteen files under
// `apps/server/src` put a wildcard route path in a line comment.
//
// So the property asserted here is the one that catches BOTH directions on real
// input rather than on examples: across every server source file, no line that is
// actually code may be lost, and no line that is actually a comment may survive.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/server/src');

function serverSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(SRC);
  return out;
}

describe('V-1012 codeOnly strips comments and nothing else', () => {
  const files = serverSources();

  it('CRITICAL a wildcard route path in a line comment does not open a block comment. This is the regression: the `/*` in `/v1/agent-sessions/*` is inside a `//` comment, and a stripper that runs the block pass first deletes everything up to the next `*/` — in that file, the imports.', () => {
    const out = codeOnly(
      '// AI-D — /v1/agent-sessions/* routes\nimport { runtime } from "./x.js";\n/** doc */\n',
    );
    expect(out, 'the import after a wildcard-bearing line comment was eaten').toContain(
      'import { runtime }',
    );
    expect(out, 'the line comment survived').not.toContain('AI-D');
    expect(out, 'the real block comment survived').not.toContain('doc');
  });

  it('CRITICAL a comment marker inside a string literal is not a comment. Route paths and URLs live in string literals all over this server, and treating `https://` as a comment would silently delete the rest of the line.', () => {
    expect(codeOnly(`const u = 'https://api.driftstack.dev/v1'; const a = 1;`)).toContain(
      'https://api.driftstack.dev/v1',
    );
    expect(codeOnly('const s = "/* not a comment */"; const b = 2;')).toContain('const b = 2');
    expect(codeOnly('const t = `a // b`; const c = 3;')).toContain('a // b');
  });

  it('CRITICAL it still removes what it is for: both comment forms, including one that quotes code.', () => {
    expect(codeOnly('const a = 1; // readClientIp is deliberately not used here')).not.toContain(
      'readClientIp',
    );
    expect(codeOnly('/*\n * function clientIp(request) {}\n */\nconst a = 1;')).not.toContain(
      'function clientIp',
    );
    expect(codeOnly('/* a */ const keep = 1; /* b */')).toContain('const keep = 1');
  });

  it('CRITICAL across every server source file, no import statement is lost. An import line is unambiguously code, so losing one means the stripper ate past a comment — which is how a guard silently starts asserting over an empty file.', () => {
    expect(files.length, 'no server sources walked').toBeGreaterThanOrEqual(100);
    const lost: string[] = [];
    for (const path of files) {
      const raw = readFileSync(path, 'utf8');
      const out = codeOnly(raw);
      for (const line of raw.split('\n')) {
        if (/^import .*from '/.test(line) && !out.includes(line.trim())) {
          lost.push(`${path.slice(REPO_ROOT.length + 1)}: ${line.trim().slice(0, 60)}`);
        }
      }
    }
    expect(lost, 'these import statements were deleted by the stripper:').toEqual([]);
  });

  it('CRITICAL across every server source file, no whole-line comment survives. The other direction: a stripper that misses comments lets prose satisfy a guard, which is the failure V-1011 and V-1012 were both written for.', () => {
    const survived: string[] = [];
    for (const path of files) {
      const out = codeOnly(readFileSync(path, 'utf8'));
      for (const line of out.split('\n')) {
        if (/^\s*\/\//.test(line))
          survived.push(`${path.slice(REPO_ROOT.length + 1)}: ${line.trim().slice(0, 60)}`);
      }
    }
    expect(survived, 'these comment lines survived stripping:').toEqual([]);
  });
});
