// W331.A — drift guard for /sdk/typescript-quickstart. Pins:
//   • @driftstack/sdk package name + canonical install commands
//   • DRIFTSTACK_API_KEY env var
//   • try/finally session lifecycle (create → navigate → destroy)
//   • DriftstackError + verifyWebhookSignature exports cited
//   • Real SDK package.json carries the same exports

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/typescript-quickstart.md');
const SDK_INDEX = resolve(REPO_ROOT, 'packages/sdk-typescript/src/index.ts');
const SDK_PKG = resolve(REPO_ROOT, 'packages/sdk-typescript/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W331.A /sdk/typescript-quickstart baseline', () => {
  const body = read(PAGE);
  const sdkIndex = read(SDK_INDEX);
  const sdkPkg = JSON.parse(read(SDK_PKG)) as { name: string };

  it('package name matches canonical @driftstack/sdk', () => {
    expect(sdkPkg.name).toBe('@driftstack/sdk');
    expect(body).toContain('@driftstack/sdk');
  });

  it('lists npm/pnpm/yarn install commands', () => {
    expect(body).toMatch(/npm install @driftstack\/sdk/);
    expect(body).toMatch(/pnpm add @driftstack\/sdk/);
    expect(body).toMatch(/yarn add @driftstack\/sdk/);
  });

  it('cites DRIFTSTACK_API_KEY (canonical env var)', () => {
    expect(body).toContain('DRIFTSTACK_API_KEY');
  });

  it('cites sessions.create / .navigate / .destroy lifecycle', () => {
    expect(body).toMatch(/client\.sessions\.create/);
    expect(body).toMatch(/client\.sessions\.navigate/);
    expect(body).toMatch(/client\.sessions\.destroy/);
  });

  it('cites DriftstackError + verifyWebhookSignature (both re-exported by SDK)', () => {
    expect(body).toContain('DriftstackError');
    expect(body).toContain('verifyWebhookSignature');
    expect(sdkIndex).toContain('DriftstackError');
    expect(sdkIndex).toContain('verifyWebhookSignature');
  });
});
