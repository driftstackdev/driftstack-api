// Drift-guard: the install commands in apps/docs/src/pages/sdk/installation.md
// must reference the SDKs' actual package identities and current install source.
//
// Why: if a package is renamed (npm name, PyPI dist name, or Go module
// path) without updating the install doc, customers literally cannot
// install the SDK — `npm install <wrong>` 404s. There was no parity test
// pinning the doc's install commands to the real manifests. This reads the
// identity from each manifest (source of truth) and asserts it appears in
// the installation doc.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO, rel), 'utf8');
}

const DOC = read('apps/docs/src/pages/sdk/installation.md');

describe('sdk/installation.md ↔ actual published package identities', () => {
  it('TypeScript: documents the real npm package name from package.json', () => {
    const pkg = JSON.parse(read('packages/sdk-typescript/package.json')) as { name?: string };
    expect(pkg.name, 'sdk-typescript package.json must have a name').toBeTruthy();
    const name = pkg.name as string;
    // Appears in an npm install command + the import example.
    expect(DOC, `installation.md must document npm install ${name}`).toContain(
      `npm install ${name}`,
    );
    expect(DOC, `installation.md import example must use ${name}`).toContain(`from '${name}'`);
  });

  it('Python: documents the real published dist name in the PyPI install command', () => {
    const py = read('packages/sdk-python/pyproject.toml');
    const m = py.match(/^name\s*=\s*"([^"]+)"/m);
    const distName = m?.[1];
    expect(distName, 'pyproject.toml must declare a name').toBeTruthy();
    expect(DOC).toContain(`pip install ${distName as string}`);
    expect(DOC).toContain(
      'Use requirements constraints or a lockfile for reproducible deployments',
    );
    expect(DOC).not.toContain('@<commit>#subdirectory=packages/sdk-python');
  });

  it('Go: documents the real module path from go.mod', () => {
    const mod = read('packages/sdk-go/go.mod').match(/^module\s+(\S+)/m);
    const modPath = mod?.[1];
    expect(modPath, 'go.mod must declare a module path').toBeTruthy();
    expect(DOC, `installation.md must document go get ${modPath}`).toContain(
      `go get ${modPath as string}@latest`,
    );
    expect(DOC).toContain('Commit `go.mod` and `go.sum` for reproducible deployments');
  });
});
