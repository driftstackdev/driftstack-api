// W587.A — drift guard for packages/sdk-python/src/driftstack/__init__.py.
// Top-level package __init__. Drift here either drops a re-export
// (callers' `from driftstack import X` break) or breaks the
// canonical __all__ catalogue customers rely on for star-imports.
//
//   • 29-entry __all__: __version__, Driftstack, AsyncDriftstack,
//     DriftstackError + 21 typed-error subclasses + is_retryable +
//     verify_webhook_signature.
//   • Re-exports: __version__ + clients + entire errors taxonomy +
//     V-359 webhook verifier.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/__init__.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W587.A packages/sdk-python/src/driftstack/__init__.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + customer-facing-re-exports + usage example pinned', () => {
    expect(body).toMatch(/^"""Driftstack Python SDK\.\n/);
    expect(body).toMatch(/Customer-facing entry points re-exported here so callers can write::/);
    expect(body).toMatch(/from driftstack import Driftstack, AsyncDriftstack, DriftstackError/);
    expect(body).toMatch(/Resource accessors live on the client instance::/);
    expect(body).toMatch(/client = Driftstack\(api_key="ds_live_\.\.\."\)/);
    expect(body).toMatch(/session = client\.sessions\.create\(\)/);
    expect(body).toMatch(/client\.sessions\.navigate\(session\.id, url="https:\/\/example\.com"\)/);
    expect(body).toMatch(/client\.sessions\.destroy\(session\.id\)/);
  });

  it('Re-imports: __version__ + clients + errors block (Q.1.d / Arc 1 / Arc 3 additions included) + V-359 verify_webhook_signature pinned', () => {
    expect(body).toMatch(/^from driftstack\._version import __version__$/m);
    expect(body).toMatch(/^from driftstack\.client import AsyncDriftstack, Driftstack$/m);
    // Errors block — pin the head + tail of the import statement + a
    // sample of the post-Q.1.d additions. The exact alphabetised order
    // grows whenever a new error class lands; pin the SHAPE not the
    // exact closed roster.
    expect(body).toMatch(/^from driftstack\.errors import \(/m);
    expect(body).toMatch(/^\s*ByokAnthropicRequiredError,$/m);
    expect(body).toMatch(/^\s*BundledLlmBudgetExhaustedError,$/m);
    expect(body).toMatch(/^\s*PairModeConflictError,$/m);
    expect(body).toMatch(/^\s*is_retryable,$/m);
    expect(body).toMatch(/^from driftstack\.webhook_signature import verify_webhook_signature$/m);
  });

  it('__all__ catalogue: customer-facing roster anchored by __version__ + Driftstack/AsyncDriftstack clients + error classes + V-359 verify_webhook_signature. Growth-tolerant; pins the head/tail bookends + load-bearing post-2026-05 additions instead of an exact-order closed list.', () => {
    expect(body).toMatch(/^__all__ = \[$/m);
    expect(body).toMatch(/^\s*"__version__",$/m);
    expect(body).toMatch(/^\s*"Driftstack",$/m);
    expect(body).toMatch(/^\s*"AsyncDriftstack",$/m);
    expect(body).toMatch(/^\s*"DriftstackError",$/m);
    expect(body).toMatch(/^\s*"ByokAnthropicRequiredError",$/m);
    expect(body).toMatch(/^\s*"BundledLlmBudgetExhaustedError",$/m);
    expect(body).toMatch(/^\s*"PairModeConflictError",$/m);
    expect(body).toMatch(/^\s*"is_retryable",$/m);
    expect(body).toMatch(/^\s*"verify_webhook_signature",$/m);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
