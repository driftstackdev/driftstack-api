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

  it('Re-imports: __version__ + clients + 23 errors + V-359 verify_webhook_signature pinned', () => {
    expect(body).toMatch(/^from driftstack\._version import __version__$/m);
    expect(body).toMatch(/^from driftstack\.client import AsyncDriftstack, Driftstack$/m);
    expect(body).toMatch(
      /^from driftstack\.errors import \(\s*\n\s*AuthError,\s*\n\s*ConcurrencyLimitError,\s*\n\s*ConflictError,\s*\n\s*DriftstackError,\s*\n\s*DriverError,\s*\n\s*EmailAlreadyRegisteredError,\s*\n\s*EmailNotVerifiedError,\s*\n\s*ExpiredKeyError,\s*\n\s*FeatureUnavailableError,\s*\n\s*ForbiddenError,\s*\n\s*InternalError,\s*\n\s*InvalidAuthTokenError,\s*\n\s*InvalidCredentialsError,\s*\n\s*InvalidKeyError,\s*\n\s*LegalAcceptanceRequiredError,\s*\n\s*MfaStepUpRequiredError,\s*\n\s*NotFoundError,\s*\n\s*QuotaExceededError,\s*\n\s*RateLimitError,\s*\n\s*RevokedKeyError,\s*\n\s*SessionDestroyedError,\s*\n\s*SessionNotFoundError,\s*\n\s*SessionTimeoutError,\s*\n\s*TransportError,\s*\n\s*ValidationError,\s*\n\s*is_retryable,\s*\n\)$/m,
    );
    expect(body).toMatch(/^from driftstack\.webhook_signature import verify_webhook_signature$/m);
  });

  it('__all__ catalogue: 29 entries pinned in declaration order — drift here breaks star-imports + IDE autocomplete', () => {
    expect(body).toMatch(
      /^__all__ = \[\s*\n\s*"__version__",\s*\n\s*"Driftstack",\s*\n\s*"AsyncDriftstack",\s*\n\s*"DriftstackError",\s*\n\s*"AuthError",\s*\n\s*"ForbiddenError",\s*\n\s*"InvalidKeyError",\s*\n\s*"ExpiredKeyError",\s*\n\s*"RevokedKeyError",\s*\n\s*"ConflictError",\s*\n\s*"NotFoundError",\s*\n\s*"RateLimitError",\s*\n\s*"QuotaExceededError",\s*\n\s*"ConcurrencyLimitError",\s*\n\s*"SessionNotFoundError",\s*\n\s*"SessionDestroyedError",\s*\n\s*"SessionTimeoutError",\s*\n\s*"LegalAcceptanceRequiredError",\s*\n\s*"DriverError",\s*\n\s*"ValidationError",\s*\n\s*"TransportError",\s*\n\s*"EmailAlreadyRegisteredError",\s*\n\s*"EmailNotVerifiedError",\s*\n\s*"InvalidAuthTokenError",\s*\n\s*"InvalidCredentialsError",\s*\n\s*"FeatureUnavailableError",\s*\n\s*"InternalError",\s*\n\s*"MfaStepUpRequiredError",\s*\n\s*"is_retryable",\s*\n\s*"verify_webhook_signature",\s*\n\]$/m,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
