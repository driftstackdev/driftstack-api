// W251.D — drift-guard for the repo README's "Repository layout"
// section. Every subdir / package the README advertises must
// actually exist. Catches the case where someone deletes a package
// or renames an app workspace and forgets to update the README.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const README = resolve(REPO_ROOT, 'README.md');

function read(): string {
  return readFileSync(README, 'utf8');
}

describe('W251.D README repository-layout parity', () => {
  const doc = read();

  it('every advertised app workspace exists on disk', () => {
    for (const app of [
      'server',
      'marketing-site',
      'customer-dashboard',
      'admin-panel',
      'docs',
      'status-site',
      'gui-client',
    ]) {
      expect(doc).toContain(app);
      expect(existsSync(resolve(REPO_ROOT, 'apps', app))).toBe(true);
    }
  });

  it('every advertised package exists on disk', () => {
    for (const pkg of ['api-types', 'sdk-typescript', 'sdk-python', 'sdk-go']) {
      expect(doc).toContain(pkg);
      expect(existsSync(resolve(REPO_ROOT, 'packages', pkg))).toBe(true);
    }
  });

  it('engines.node matches README "Node.js 22 LTS"', () => {
    expect(doc).toMatch(/Node\.js 22 LTS/);
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    expect(pkg.engines?.node).toMatch(/>=22/);
  });

  it('cites Fastify + Drizzle + Postgres 17 + Redis 7 as the stack', () => {
    expect(doc).toMatch(/Fastify/);
    expect(doc).toMatch(/Drizzle/);
    expect(doc).toMatch(/Postgres 17/);
    expect(doc).toMatch(/Redis 7/);
  });

  it('every docs/ sub-pointer exists', () => {
    for (const f of ['architecture.md', 'decisions.md']) {
      expect(existsSync(resolve(REPO_ROOT, 'docs', f))).toBe(true);
    }
  });
});
