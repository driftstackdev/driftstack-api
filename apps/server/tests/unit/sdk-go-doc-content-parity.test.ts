// W534.C — drift guard for packages/sdk-go/doc.go.
// Go SDK package-level doc comment (rendered as godoc/pkg.go.dev landing
// page). Drift here either changes the customer-facing Quickstart code
// snippet (would mislead Go consumers on the canonical session
// lifecycle) or breaks the typed-errors / retry-policy / webhook-
// signature pointers that customers rely on.
//
//   • 'Package driftstack is the official Go SDK for the Driftstack
//     API — stealth iPhone Safari automation, called from Go.'.
//   • Quickstart: 4-step (New + Sessions.Create + Sessions.Navigate +
//     Sessions.Destroy) with ds_live_ key + example.com URL + defer
//     client.Close().
//   • Typed errors framing: every server problem-type maps to a
//     concrete error type, switchable via errors.As.
//   • Retry policy: applied automatically, configurable via [WithRetry],
//     honours Retry-After.
//   • Webhook signature verification: [VerifyWebhookSignature].
//   • Module path: github.com/driftstackdev/driftstack-api/packages/sdk-go.
//   • package driftstack (NOT package sdk_go — Go consumers import as
//     `driftstack`, matching the Python SDK's import-as-driftstack
//     convention).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/doc.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W534.C packages/sdk-go/doc.go content parity', () => {
  const body = read(LIB);

  it("Package framing + stealth-iPhone-Safari positioning pinned: 'Package driftstack is the official Go SDK for the Driftstack API — stealth iPhone Safari automation, called from Go.' — pinned so the canonical Go-SDK package-level framing + stealth-iPhone-Safari positioning (parity with sdk-python pyproject 'stealth iPhone Safari automation' description) commitment survives", () => {
    expect(body).toMatch(
      /\/\/ Package driftstack is the official Go SDK for the Driftstack API —\s*\n?\s*\/\/ stealth iPhone Safari automation, called from Go\./,
    );
  });

  it("4-step Quickstart framing pinned: 'client := driftstack.New(\"ds_live_…\")' + 'defer client.Close()' + 'ctx := context.Background()' + 'session, err := client.Sessions.Create(ctx, nil)' + 'client.Sessions.Navigate(ctx, session.ID, &driftstack.NavigateRequest{ URL: \"https://example.com/\" })' + 'client.Sessions.Destroy(ctx, session.ID)' — pinned so the canonical Go-SDK Quickstart (4-step session lifecycle: New → Create → Navigate → Destroy + defer-Close pattern + context.Background pattern + ds_live_ key prefix + example.com canonical URL) commitment survives (drift to a different code snippet would mislead Go consumers on the canonical session lifecycle)", () => {
    expect(body).toMatch(/\/\/\tclient := driftstack\.New\("ds_live_…"\)/);
    expect(body).toMatch(/\/\/\tdefer client\.Close\(\)/);
    expect(body).toMatch(/\/\/\tctx := context\.Background\(\)/);
    expect(body).toMatch(/\/\/\tsession, err := client\.Sessions\.Create\(ctx, nil\)/);
    expect(body).toMatch(
      /\/\/\tif _, err := client\.Sessions\.Navigate\(ctx, session\.ID, &driftstack\.NavigateRequest\{/,
    );
    expect(body).toMatch(/\/\/\t\tURL: "https:\/\/example\.com\/",/);
    expect(body).toMatch(/\/\/\t_ = client\.Sessions\.Destroy\(ctx, session\.ID\)/);
  });

  it("V-1060 typed errors + retry + webhook-signature framing pinned, with the retry set matching IsRetryable rather than contradicting it: 'Errors are typed: every server problem-type maps to a concrete error type customers can switch on with errors.As. The retry policy is applied automatically (configurable via [WithRetry]) and honours Retry-After.' + 'Webhook signature verification is in [VerifyWebhookSignature].' — pinned so the typed-errors + errors.As-switch + retry-policy + WithRetry-configurable + Retry-After-honoured + VerifyWebhookSignature-pointer commitment survives (drift to dropping errors.As guidance would lose the canonical Go-idiom error-handling pattern; drift to silent-Retry-After-ignore would break server-side rate-limit cooperation)", () => {
    expect(body).toMatch(
      /\/\/ Errors are typed: every server problem-type maps to a concrete error\s*\n?\s*\/\/ type customers can switch on with errors\.As\. The retry policy is\s*\n?\s*\/\/ applied automatically \(configurable via \[WithRetry\]\) and honours\s*\n?\s*\/\/ Retry-After\./,
    );
    expect(body).toMatch(/\/\/ Webhook signature verification is in \[VerifyWebhookSignature\]\./);
    // Retry-safety guidance: transport+429 retried (not 4xx/5xx bodies) + the
    // duplicate-POST warning tied to IdempotencyKey. Pinned so a customer is
    // never silently left to discover that a retried create/charge can double-
    // execute — dropping this re-exposes the duplicate-side-effect footgun.
    // V-1056/V-1060 — the retry set, stated the way the code implements it.
    expect(body).toMatch(
      /Retries fire on transport errors, on 429 rate limits,[\s\S]*?and on InternalError — the plain 500/,
    );
    expect(body).toMatch(
      /Every other typed error is[\s\S]*?terminal, including the other 5xx kinds such as DriverError \(502\)/,
    );
    // The cross-SDK claim is load-bearing: TS's retry.ts says its set matches Go's,
    // so the two must not describe different sets.
    expect(body).toMatch(/the same[\s\S]*?set the TypeScript and Python SDKs retry/);

    // The retracted claim does not come back. It told a Go customer that a 500
    // would not be retried, which is the case where they would add their own
    // loop on top of one that is already running.
    expect(
      body,
      'doc.go again tells customers 5xx responses are terminal in the Go SDK; IsRetryable ' +
        'returns true for InternalError and withRetry uses it',
    ).not.toMatch(/not on 4xx or 5xx response bodies/);
    expect(body).toMatch(
      /an automatically-retried create\s*\n?\s*\/\/ or charge can execute twice — pass an IdempotencyKey[\s\S]*?collapses the retry/,
    );
  });

  it("Module path + package-name framing pinned: 'Module path: github.com/driftstackdev/driftstack-api/packages/sdk-go' + 'package driftstack' (NOT package sdk_go — Go consumers import as `driftstack`, matching sdk-python's import-as-driftstack convention) — pinned so the GitHub-monorepo-subdir module-path + bare-driftstack-package-name commitment survives (drift to a different module path would break `go get`; drift to package sdk_go would break the cross-SDK import-as-driftstack convention)", () => {
    expect(body).toMatch(
      /\/\/ Module path: github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go/,
    );
    expect(body).toMatch(/^package driftstack$/m);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
