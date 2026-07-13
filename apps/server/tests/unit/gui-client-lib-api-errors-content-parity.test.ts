// Drift guard for the installed client's central API-error boundary. Stable
// problem types may select fixed copy, but upstream detail/title prose must
// never be reflected into the GUI.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/api-errors.ts');
const body = readFileSync(LIB, 'utf8');

describe('apps/gui-client/src/lib/api-errors.ts content parity', () => {
  it('keeps the canonical async helper and bounded body reader', () => {
    expect(body).toContain(
      'export async function readApiErrorMessage(res: Response): Promise<string>',
    );
    expect(body).toContain('readBoundedDiagnosticJson<{ type?: unknown }>(res)');
    expect(body).toContain("const PROBLEM_TYPE_PREFIX = 'https://errors.driftstack.dev/'");
  });

  it('classifies only the stable problem namespace and status', () => {
    expect(body).toContain('body.type.startsWith(PROBLEM_TYPE_PREFIX)');
    expect(body).toContain('return fixedApiErrorMessage(problemType, res.status)');
    expect(body).toContain('function fixedApiErrorMessage(problemType: string, status: number)');
  });

  it('never reads or returns upstream detail/title prose', () => {
    expect(body).not.toMatch(/body\.(?:detail|title)/);
    expect(body).not.toMatch(/return\s+body\./);
    expect(body).not.toMatch(/`HTTP\s+\$\{/);
    expect(body).toContain('upstream prose is never reflected');
  });

  it('keeps fixed auth, limit, input, conflict, and service recovery classes', () => {
    for (const copy of [
      'Your sign-in or API key was not accepted.',
      'A usage limit was reached.',
      'Some information was not accepted.',
      'The item changed or is busy.',
      'The service is temporarily unavailable.',
    ]) {
      expect(body).toContain(copy);
    }
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
