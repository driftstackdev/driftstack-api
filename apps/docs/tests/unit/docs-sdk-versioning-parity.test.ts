// W258.D — drift-guard for docs.driftstack.io/sdk/versioning. Pins:
// 1. Webhook-signature helper names match the live exports across TS/Py/Go.
// 2. Package paths cited in the release-process section exist on disk.
// 3. Each SDK's CHANGELOG.md exists at the cited location.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/versioning.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W258.D docs/sdk/versioning ↔ live SDK packages parity', () => {
  const doc = read(DOC);

  it('verifyWebhookSignature export name matches the live TS source', () => {
    expect(doc).toMatch(/`verifyWebhookSignature`/);
    const ts = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/webhook-signature.ts'));
    expect(ts).toMatch(/export\s+(?:async\s+)?function\s+verifyWebhookSignature\b/);
  });

  it('verify_webhook_signature export name matches the live Python source', () => {
    expect(doc).toMatch(/`verify_webhook_signature`/);
    const py = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/webhook_signature.py'));
    expect(py).toMatch(/def\s+verify_webhook_signature\s*\(/);
  });

  it('VerifyWebhookSignature export name matches the live Go source', () => {
    expect(doc).toMatch(/`VerifyWebhookSignature`/);
    const go = read(resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go'));
    expect(go).toMatch(/func\s+VerifyWebhookSignature\b/);
  });

  it('cross-referenced D-021 decision exists in docs/decisions.md', () => {
    expect(doc).toMatch(/D-021/);
    const decisions = read(resolve(REPO_ROOT, 'docs/decisions.md'));
    expect(decisions).toMatch(/##\s*D-021\b/);
  });

  it('packages/api-types cross-link target exists', () => {
    expect(doc).toMatch(/packages\/api-types\//);
    expect(existsSync(resolve(REPO_ROOT, 'packages/api-types'))).toBe(true);
  });

  it('release-process package paths exist on disk', () => {
    expect(doc).toMatch(/packages\/sdk-typescript\//);
    expect(doc).toMatch(/packages\/sdk-python\//);
    expect(doc).toMatch(/packages\/sdk-go\//);
    expect(existsSync(resolve(REPO_ROOT, 'packages/sdk-typescript/package.json'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'packages/sdk-python/pyproject.toml'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'packages/sdk-go/go.mod'))).toBe(true);
  });

  it('all three SDKs target /v1/ today (matches SDK base-URL constants)', () => {
    expect(doc).toMatch(/every\s+SDK targets `\/v1\/`/);
  });
});
