// W594.C — drift guard for packages/sdk-go/version.go + doc.go.
// Tiny boilerplate close-out for sdk-go parity sweep.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const VERSION = resolve(REPO_ROOT, 'packages/sdk-go/version.go');
const DOC = resolve(REPO_ROOT, 'packages/sdk-go/doc.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W594.C packages/sdk-go/version.go + doc.go content parity', () => {
  it('version.go: Version constant = 0.2.0 (lockstep with git tag on release)', () => {
    const body = read(VERSION);
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/\/\/ Version is the Driftstack Go SDK semver string\. Bump in lockstep/);
    expect(body).toMatch(/\/\/ with the git tag on release\./);
    expect(body).toMatch(/^const Version = "0\.2\.0"$/m);
    expect(existsSync(VERSION)).toBe(true);
  });

  it('doc.go: Package driftstack godoc surface + quickstart example + typed-errors framing + Retry-After auto-honour + module path pinned', () => {
    const body = read(DOC);
    expect(body).toMatch(/\/\/ Package driftstack is the official Go SDK for the Driftstack API —/);
    expect(body).toMatch(/\/\/ stealth iPhone Safari automation, called from Go\./);
    expect(body).toMatch(/\/\/ Quickstart:/);
    expect(body).toMatch(/\/\/\s+client := driftstack\.New\("ds_live_…"\)/);
    expect(body).toMatch(/\/\/\s+defer client\.Close\(\)/);
    expect(body).toMatch(/\/\/\s+ctx := context\.Background\(\)/);
    expect(body).toMatch(/\/\/\s+session, err := client\.Sessions\.Create\(ctx, nil\)/);
    expect(body).toMatch(
      /\/\/\s+if _, err := client\.Sessions\.Navigate\(ctx, session\.ID, &driftstack\.NavigateRequest\{/,
    );
    expect(body).toMatch(/\/\/\s+_ = client\.Sessions\.Destroy\(ctx, session\.ID\)/);
    expect(body).toMatch(
      /\/\/ Errors are typed: every server problem-type maps to a concrete error/,
    );
    expect(body).toMatch(/\/\/ type customers can switch on with errors\.As\./);
    expect(body).toMatch(
      /\/\/ applied automatically \(configurable via \[WithRetry\]\) and honours/,
    );
    expect(body).toMatch(/\/\/ Retry-After\./);
    expect(body).toMatch(/\/\/ Webhook signature verification is in \[VerifyWebhookSignature\]\./);
    expect(body).toMatch(
      /\/\/ Module path: github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go/,
    );
    expect(body).toMatch(/^package driftstack$/m);
    expect(existsSync(DOC)).toBe(true);
  });
});
