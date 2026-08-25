// W260.B — drift-guard for docs.driftstack.dev/sdk/go-quickstart. Pins:
// 1. Module path matches go.mod (`.../packages/sdk-go`, not a stale
//    `driftstack-go` repo path).
// 2. Error-handling sample switches on real typed errors (no fictional
//    *APIError, no apiErr.RequestID, no apiErr.Problem.Type attribute).
// 3. VerifyWebhookSignature signature matches the live func — positional
//    `(body, header, secret, opts...)`, not a fictional Input struct.
// 4. /webhooks/signature-rotation cross-link is removed.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/go-quickstart.md');
const GO_MOD = resolve(REPO_ROOT, 'packages/sdk-go/go.mod');
const GO_ERRORS = resolve(REPO_ROOT, 'packages/sdk-go/errors.go');
const GO_SIG = resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W260.B docs/sdk/go-quickstart ↔ live Go SDK parity', () => {
  const doc = read(DOC);

  it('module path matches go.mod', () => {
    const goMod = read(GO_MOD);
    const m = goMod.match(/^module\s+(\S+)/m);
    expect(m).not.toBeNull();
    const livePath = m![1]!;
    expect(livePath).toBe('github.com/driftstackdev/driftstack-api/packages/sdk-go');
    expect(doc).toContain(livePath);
    // Doc must not use the stale top-level driftstack-go path.
    expect(doc).not.toMatch(/github\.com\/driftstackdev\/driftstack-go\b/);
  });

  it('W567: capture-result uses real CaptureResponse fields, not the phantom shot.ID (Go would not compile)', () => {
    // CaptureResponse is { Kind, Data, Encoding, ByteSize, DurationMS } — no
    // ID field, so `shot.ID` is a compile error. Guard it + pin a real field.
    expect(doc).not.toMatch(/shot\.ID\b/);
    expect(doc).toMatch(/shot\.ByteSize\b/);
  });

  it('error sample does not invent driftstack.APIError', () => {
    expect(doc).not.toMatch(/\*driftstack\.APIError\b/);
    const errors = read(GO_ERRORS);
    // The live shape is the unexported `apiError`; exported is the typed errors.
    expect(errors).toMatch(/type apiError struct/);
  });

  it('error sample does not access apiErr.Problem.Type or .RequestID', () => {
    expect(doc).not.toMatch(/apiErr\.Problem\.Type/);
    expect(doc).not.toMatch(/apiErr\.RequestID/);
    expect(doc).not.toMatch(/apiErr\.Problem\.Detail/);
  });

  it('error sample uses real typed Go errors via errors.As', () => {
    const errors = read(GO_ERRORS);
    // The doc must cite at least one of the live typed error classes.
    expect(doc).toMatch(
      /driftstack\.RateLimitError|driftstack\.ConcurrencyLimitError|driftstack\.QuotaExceededError/,
    );
    expect(errors).toMatch(/\bErrAuth\b/);
    expect(doc).toMatch(/driftstack\.ErrAuth/);
  });

  it('VerifyWebhookSignature call matches the live positional signature', () => {
    expect(doc).toMatch(/VerifyWebhookSignature\(\s*rawBody,/);
    expect(doc).toMatch(/driftstack\.VerifyWebhookOptions\{/);
    // Live signature: func VerifyWebhookSignature(body []byte, header string, secret string, opts ...VerifyWebhookOptions) bool
    const sig = read(GO_SIG);
    expect(sig).toMatch(
      /func\s+VerifyWebhookSignature\(body\s+\[\]byte,\s*header\s+string,\s*secret\s+string,\s*opts\s+\.\.\.VerifyWebhookOptions\)\s*bool/,
    );
    // Doc must NOT use the fictional Input struct.
    expect(doc).not.toMatch(/VerifyWebhookSignatureInput/);
  });

  it('does not link to /webhooks/signature-rotation (page does not exist)', () => {
    expect(doc).not.toMatch(/\/webhooks\/signature-rotation/);
  });

  it('every internal cross-link resolves to a real page', () => {
    const links = [...doc.matchAll(/\]\((\/[a-z0-9/-]+\/?)\)/g)]
      .map((m) => m[1]!)
      .filter((href) => /^\/(guides|webhooks|sdk|api|reference|quickstart)/.test(href));
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

  it('pins the paid SDK prerequisite and restricted Free desktop credential', () => {
    expect(doc).toMatch(/Any paid Driftstack tier, including Manual/);
    expect(doc).toMatch(/A `ds_live_…` customer API key/);
    expect(doc).toMatch(/restricted\s*`ds_test_…` device credential/);
    expect(doc).toMatch(/not a general SDK or\s*sandbox key/);
    expect(doc).toMatch(/var forbidden \*driftstack\.ForbiddenError/);
    expect(doc).toMatch(/strings\.Contains\(forbidden\.Message, "apiAccess"\)/);
    expect(doc).toMatch(/log\.Print\(forbidden\.Message\)/);
    expect(doc).toMatch(/log\.Printf\("forbidden: %s", forbidden\.Message\)/);
  });
});
