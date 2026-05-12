// W296.C — drift guard for SDK error class names across the three
// languages. Each SDK exposes a hierarchy of typed errors derived
// from problem+json type slugs. The shared subset (AuthError,
// ValidationError, NotFoundError, ConflictError, ForbiddenError,
// InvalidKeyError, ExpiredKeyError, RevokedKeyError) must exist in
// all three SDKs. Catches drift where one SDK invents a new class
// without backports.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/errors.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/errors.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SHARED_ERRORS = [
  'AuthError',
  'ValidationError',
  'NotFoundError',
  'ConflictError',
  'ForbiddenError',
  'InvalidKeyError',
  'ExpiredKeyError',
  'RevokedKeyError',
];

describe('W296.C SDK error-class name parity', () => {
  const ts = read(TS);
  const py = read(PY);
  const go = read(GO);

  for (const name of SHARED_ERRORS) {
    it(`TypeScript SDK exports ${name}`, () => {
      expect(ts).toMatch(new RegExp(`export class ${name}\\b`));
    });

    it(`Python SDK declares ${name}`, () => {
      expect(py).toMatch(new RegExp(`class ${name}\\(`));
    });

    it(`Go SDK declares ${name}`, () => {
      expect(go).toMatch(new RegExp(`type ${name}\\b`));
    });
  }
});
