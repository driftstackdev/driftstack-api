// Security sweep E-9 (2026-09-24) — the production deploy builds on the host, as
// root, on the machine that holds every production secret. `npm ci` there ran every
// package's lifecycle scripts, so a compromised upstream version reaching the
// lockfile would have run as root at the next deploy. The install must pass
// --ignore-scripts (the server build is plain tsc; nothing on the host needs an
// install step — measured on a fresh clone: install, tsc build and dist import all
// succeed with scripts off).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = readFileSync(
  resolve(HERE, '..', '..', '..', '..', 'scripts', 'deploy-bridge.sh'),
  'utf8',
);

describe('the production install runs no package scripts as root', () => {
  const installs = [...BRIDGE.matchAll(/^\s*npm (?:ci|install)\b[^\n]*/gm)].map((m) => m[0]);

  it('reads the install it guards', () => {
    expect(installs.length).toBeGreaterThanOrEqual(1);
  });

  it('CRITICAL every npm install on the host passes --ignore-scripts', () => {
    expect(installs.filter((line) => !line.includes('--ignore-scripts'))).toEqual([]);
  });
});
