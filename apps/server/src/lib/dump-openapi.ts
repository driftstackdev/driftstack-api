// Dump the generated OpenAPI 3.1 spec to disk. Used by SDK build
// pipelines (Python, Go) as the input to their codegen tooling.
// Run with: tsx src/lib/dump-openapi.ts <output-path>

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateOpenApiSpec } from './openapi.js';

async function main(): Promise<void> {
  const outArg = process.argv[2];
  if (!outArg) {
    console.error('Usage: tsx src/lib/dump-openapi.ts <output-path>');
    process.exit(1);
  }
  const outPath = resolve(outArg);
  const spec = generateOpenApiSpec();
  await writeFile(outPath, JSON.stringify(spec, null, 2), 'utf8');
  console.warn(JSON.stringify({ msg: 'openapi spec written', path: outPath }));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
