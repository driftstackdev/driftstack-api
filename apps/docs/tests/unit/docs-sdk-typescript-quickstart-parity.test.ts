// W259.C — drift-guard for docs.driftstack.dev/sdk/typescript-quickstart.
// Previous revision:
//   - claimed `err.problem.type` / `err.problem.detail` / `err.requestId`
//     but the live DriftstackError exposes `type` / `detail` / no requestId.
//   - cross-linked to /webhooks/signature-rotation which doesn't exist.
//   - claimed Node 20+ while package.json declares engines >=18.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaptureResponseSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/typescript-quickstart.md');
const ERRORS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts');
const PKG = resolve(REPO_ROOT, 'packages/sdk-typescript/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W259.C docs/sdk/typescript-quickstart ↔ live TS SDK parity', () => {
  const doc = read(DOC);
  const errors = read(ERRORS);

  it('does not invent err.problem / err.requestId fields', () => {
    expect(doc).not.toMatch(/err\.problem\b/);
    expect(doc).not.toMatch(/err\.requestId\b/);
  });

  it('error-handling sample uses fields that actually exist on DriftstackError', () => {
    for (const field of ['err.status', 'err.type', 'err.detail']) {
      expect(doc).toContain(field);
    }
    // Verify the live class declares these.
    expect(errors).toMatch(/readonly\s+status:\s*number/);
    expect(errors).toMatch(/readonly\s+type:\s*string/);
    expect(errors).toMatch(/readonly\s+detail:\s*string\s*\|\s*undefined/);
  });

  it('does not link to the fictional /webhooks/signature-rotation page', () => {
    expect(doc).not.toMatch(/\/webhooks\/signature-rotation/);
  });

  it('every /webhooks/* + /guides/* + /sdk/* cross-link resolves to a real page', () => {
    const links = [...doc.matchAll(/\]\((\/[a-z0-9/-]+\/?)\)/g)]
      .map((m) => m[1]!)
      .filter((href) => /^\/(guides|webhooks|sdk|api|reference|quickstart)/.test(href));
    expect(links.length).toBeGreaterThan(2);
    const missing: string[] = [];
    for (const href of links) {
      const stem = href.replace(/^\//, '').replace(/\/$/, '');
      const candidates = [`${stem}.md`, `${stem}.astro`, `${stem}/index.md`, `${stem}/index.astro`];
      if (!candidates.some((c) => existsSync(resolve(REPO_ROOT, 'apps/docs/src/pages', c)))) {
        missing.push(href);
      }
    }
    expect(missing).toEqual([]);
  });

  it('Node.js minimum matches engines.node in package.json', () => {
    const pkg = JSON.parse(read(PKG));
    expect(pkg.engines?.node).toBe('>=18');
    // Doc claim must reflect ≥ 18 (not ≥ 20).
    expect(doc).toMatch(/Node\.js 18\+/);
    expect(doc).not.toMatch(/Node\.js 20\+/);
  });

  it('cites verifyWebhookSignature export by exact name', () => {
    expect(doc).toMatch(/verifyWebhookSignature/);
    const sig = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/webhook-signature.ts'));
    expect(sig).toMatch(/export\s+(?:async\s+)?function\s+verifyWebhookSignature\b/);
  });

  it('W565: capture-result log uses a real CaptureResponse field, not the phantom .id', () => {
    // The previous example logged `screenshot.id`, which CaptureResponse has
    // no field for (it is { kind, data, encoding, byte_size, duration_ms }) —
    // so the snippet logged `undefined`. Guard against that field + any other
    // not on the schema.
    expect(CaptureResponseSchema.shape).not.toHaveProperty('id');
    expect(doc).not.toMatch(/screenshot\.id/);
    // The field the example now logs must be real.
    expect(Object.keys(CaptureResponseSchema.shape)).toContain('byte_size');
    expect(doc).toMatch(/screenshot\.byte_size/);
  });

  it('pins the paid SDK prerequisite and actionable Free 403 branch', () => {
    expect(doc).toMatch(/Any paid Driftstack tier, including Manual/);
    expect(doc).toMatch(/A `ds_live_…` customer API key/);
    expect(doc).toMatch(/restricted\s*`ds_test_…` device credential/);
    expect(doc).toMatch(/err\.status === 403 && err\.detail\?\.includes\('apiAccess'\) === true/);
    expect(doc).toMatch(
      /Upgrade to\s*\/\/ resume this key unless it was separately revoked or expired/,
    );
  });
});
