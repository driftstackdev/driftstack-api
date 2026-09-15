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

  // 2026-09-15 plain words — the customer page no longer points at the internal
  // decision log or monorepo package paths; the only cross-reference a customer
  // can act on is each SDK's CHANGELOG, which must exist where the page says.
  it('cross-reference footer keeps only the CHANGELOG pointer, and every SDK has one', () => {
    expect(doc).toMatch(/Each SDK's `CHANGELOG\.md` for the running history\./);
    expect(doc).not.toMatch(/D-021|docs\/decisions\.md|packages\/api-types/);
    for (const pkg of ['sdk-typescript', 'sdk-python', 'sdk-go']) {
      expect(existsSync(resolve(REPO_ROOT, `packages/${pkg}/CHANGELOG.md`))).toBe(true);
    }
  });

  it('the Go module path the page cites exists on disk, and the Releases section promises only what customers see', () => {
    expect(doc).toMatch(/github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go/);
    expect(existsSync(resolve(REPO_ROOT, 'packages/sdk-go/go.mod'))).toBe(true);
    expect(doc).toMatch(/^## Releases$/m);
    expect(doc).toMatch(
      /Each SDK release ships with a CHANGELOG entry and a GitHub release\s*\n?post that includes a migration guide when the release is breaking\./,
    );
    // Publish commands, branch conventions and approval gates are how we run it.
    expect(doc).not.toMatch(/npm publish|twine upload|push-to-main|release approval/);
  });

  it('all three SDKs target /v1/ today (matches SDK base-URL constants)', () => {
    expect(doc).toMatch(/every\s+SDK targets `\/v1\/`/);
  });
});
