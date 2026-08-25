// W429.C — drift guard for apps/server/src/lib/dump-openapi.ts.
// Tiny CLI wrapper that writes the generated OpenAPI 3.1 spec to disk
// for downstream SDK build pipelines (Python, Go). Drift here either
// silently changes the CLI argument shape (SDK codegen breaks) or
// breaks the JSON indentation convention (diffs in checked-in specs
// explode).
//
//   • Framing pinned: SDK build-pipeline input; tsx invocation.
//   • Argument: process.argv[2] = output path; usage line pinned.
//   • Writes via generateOpenApiSpec from ./openapi.js.
//   • JSON.stringify(spec, null, 2) — 2-space indent, no trailing
//     newline.
//   • Exit code 1 on missing arg / async error.
//   • Success line logs at warn level (NOT info — kept above the
//     dev-mode info threshold so CI captures it).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/dump-openapi.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W429.C apps/server/src/lib/dump-openapi.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: SDK build-pipeline input (Python, Go codegen); tsx invocation', () => {
    expect(body).toMatch(
      /\/\/ Dump the generated OpenAPI 3\.1 spec to disk\. Used by SDK build\s*\/\/ pipelines \(Python, Go\) as the input to their codegen tooling\.\s*\/\/ Run with: tsx src\/lib\/dump-openapi\.ts <output-path>/,
    );
  });

  it("imports: writeFile from 'node:fs/promises' + resolve from 'node:path' + generateOpenApiSpec from './openapi.js'", () => {
    expect(body).toMatch(/import \{ writeFile \} from 'node:fs\/promises';/);
    expect(body).toMatch(/import \{ resolve \} from 'node:path';/);
    expect(body).toMatch(/import \{ generateOpenApiSpec \} from '\.\/openapi\.js';/);
  });

  it('main(): pulls process.argv[2]; missing-arg branch prints usage to stderr + process.exit(1)', () => {
    expect(body).toMatch(/async function main\(\): Promise<void> \{/);
    expect(body).toMatch(/const outArg = process\.argv\[2\];/);
    expect(body).toMatch(
      /if \(!outArg\) \{\s*console\.error\('Usage: tsx src\/lib\/dump-openapi\.ts <output-path>'\);\s*process\.exit\(1\);\s*\}/,
    );
  });

  it('Write path: path.resolve(outArg) + JSON.stringify(spec, null, 2) (2-space indent) + utf8 encoding', () => {
    expect(body).toMatch(/const outPath = resolve\(outArg\);/);
    expect(body).toMatch(/const spec = generateOpenApiSpec\(\);/);
    expect(body).toMatch(/await writeFile\(outPath, JSON\.stringify\(spec, null, 2\), 'utf8'\);/);
  });

  it("Success log at warn level: structured JSON {msg: 'openapi spec written', path}", () => {
    expect(body).toMatch(
      /console\.warn\(JSON\.stringify\(\{ msg: 'openapi spec written', path: outPath \}\)\);/,
    );
  });

  it('top-level invocation: main().catch logs err to stderr + process.exit(1)', () => {
    expect(body).toMatch(
      /main\(\)\.catch\(\(err: unknown\) => \{\s*console\.error\(err\);\s*process\.exit\(1\);\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
