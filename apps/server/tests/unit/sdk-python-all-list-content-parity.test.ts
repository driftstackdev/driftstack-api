// W835 — Python SDK __all__ list content parity. One-hundred-sixty-
// first in the drift-guard series. Pins the Python __init__.py
// __all__ list (canonical 'what gets exported' for star-imports).
// Drift to dropping an entry would silently break customer code
// like `from driftstack import *` or `from driftstack import X`
// (the latter still works if the symbol is defined module-level,
// but __all__ drives __dir__ + ide auto-complete).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PY_INIT = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/__init__.py');
const PY_ERRORS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/errors.py');

// Required entries in __all__. Pinned individually so a drop is
// pinpointed at the test-failure level rather than a fuzzy count.
const REQUIRED_ALL_ENTRIES = [
  '__version__',
  'Driftstack',
  'AsyncDriftstack',
  'DriftstackError',
  'AuthError',
  'BadRequestError',
  'ForbiddenError',
  'InvalidKeyError',
  'ExpiredKeyError',
  'RevokedKeyError',
  'ConflictError',
  'NotFoundError',
  'RateLimitError',
  'QuotaExceededError',
  'ConcurrencyLimitError',
  'StorageQuotaExceededError',
  'SessionNotFoundError',
  'SessionDestroyedError',
  'SessionTimeoutError',
  'LegalAcceptanceRequiredError',
  'DriverError',
  'ValidationError',
  'TransportError',
  'EmailAlreadyRegisteredError',
  'EmailNotVerifiedError',
  'InvalidAuthTokenError',
  'InvalidCredentialsError',
  'FeatureUnavailableError',
  'InternalError',
  'MfaStepUpRequiredError',
  // Q.1.d 2026-05-17 + Arc 1 bundled-LLM + Arc 3 pair-mode error
  // class additions.
  'ByokAnthropicRequiredError',
  'BundledLlmBudgetExhaustedError',
  'BundledLlmConsentRequiredError',
  'PairModeConflictError',
  'PairModeStateInvalidTransitionError',
  'ProfileInUseError',
  'ProxyValidationFailedError',
  // Customer-facing return-type pydantic models (re-exported so
  // callers can annotate handlers without deep-importing via
  // driftstack.resources.*).
  'LiveKitInfo',
  'ListArchetypesResponse',
  'PublicArchetype',
  'AcceptInviteResponse',
  'ApiKeyList',
  'SessionsListPage',
  'TeamInvite',
  'TeamInvitesList',
  'TeamMember',
  'TeamMembersList',
  'TeamOwner',
  'TeamOwnersList',
  'WebhookDeliveryListPage',
  'WebhookEndpointList',
  'is_retryable',
  'verify_webhook_signature',
];

describe('W835 Python SDK __all__ list parity', () => {
  it('Python SDK __init__.py exists at canonical path', () => {
    expect(existsSync(PY_INIT)).toBe(true);
    expect(existsSync(PY_ERRORS)).toBe(true);
  });

  // ─── __all__ list exists + opens correctly ────────────────────

  it('CRITICAL Python __init__.py declares `__all__ = [` list. Drift to dropping __all__ entirely would let unexported helpers leak into customer namespace via `from driftstack import *`.', () => {
    const p = read(PY_INIT);
    expect(p).toMatch(/^__all__ = \[$/m);
  });

  // ─── Each required entry is in __all__ ────────────────────────

  it('CRITICAL all required __all__ entries are present in Python __init__.py. Drift to dropping any would break customer star-imports + IDE autocomplete + sphinx-autoapi rendering. The roster covers: __version__ + 2 clients (Driftstack + AsyncDriftstack) + error classes + customer-facing pydantic models (including public archetype discovery) + 2 helpers.', () => {
    const p = read(PY_INIT);
    for (const entry of REQUIRED_ALL_ENTRIES) {
      // __all__ uses double-quoted strings, one per line, with trailing comma.
      expect(p, `Python __all__ missing "${entry}"`).toMatch(new RegExp(`^\\s+"${entry}",?$`, 'm'));
    }
  });

  // ─── Each __all__ error class is actually defined in errors.py ─

  it("CRITICAL every error class in __all__ is actually defined in errors.py. Drift would let __all__ list a class that doesn't exist — at import time __all__ doesn't fail, but `from driftstack import *` would silently miss the supposed class.", () => {
    const errorsPy = read(PY_ERRORS);
    const errorClasses = REQUIRED_ALL_ENTRIES.filter((e) => e.endsWith('Error'));
    for (const cls of errorClasses) {
      expect(errorsPy, `errors.py missing 'class ${cls}'`).toMatch(
        new RegExp(`^class ${cls}\\(`, 'm'),
      );
    }
  });

  // ─── Helper functions are defined ─────────────────────────────

  it('CRITICAL Python __all__ includes 2 helper functions: is_retryable + verify_webhook_signature. Both are re-exported from their respective modules — drift to dropping the re-export would force customers to import from internal paths.', () => {
    const p = read(PY_INIT);
    expect(p).toMatch(/"is_retryable",?/);
    expect(p).toMatch(/"verify_webhook_signature",?/);
    expect(p).toMatch(/from driftstack\.webhook_signature import verify_webhook_signature/);
  });

  // ─── __all__ ordering: version → clients → errors → helpers ───

  it('CRITICAL Python __all__ entries follow conventional ordering: __version__ first; then 2 clients (Driftstack + AsyncDriftstack); then error classes; then helpers (is_retryable + verify_webhook_signature). Drift to reordering would still work but breaks the canonical sphinx-autoapi reader experience.', () => {
    const p = read(PY_INIT);
    const allMatch = p.match(/__all__ = \[([\s\S]+?)\]/);
    expect(allMatch, '__all__ block must parse').not.toBeNull();
    const entries = ((allMatch![1] ?? '').match(/"([^"]+)"/g) ?? []).map((s) =>
      s.replace(/"/g, ''),
    );

    // __version__ first.
    expect(entries[0]).toBe('__version__');
    // Driftstack + AsyncDriftstack in next 2 slots.
    expect(entries.slice(1, 3)).toEqual(['Driftstack', 'AsyncDriftstack']);
    // DriftstackError is the first error class.
    expect(entries[3]).toBe('DriftstackError');
    // is_retryable + verify_webhook_signature are at the END.
    const lastTwo = entries.slice(-2);
    expect(lastTwo).toContain('is_retryable');
    expect(lastTwo).toContain('verify_webhook_signature');
  });

  // ─── Total count matches expected ─────────────────────────────

  it('CRITICAL Python __all__ exactly matches the required public-export snapshot, including typed team-owner returns', () => {
    const p = read(PY_INIT);
    const allMatch = p.match(/__all__ = \[([\s\S]+?)\]/);
    expect(allMatch).not.toBeNull();
    const entries = ((allMatch![1] ?? '').match(/"([^"]+)"/g) ?? []).map((s) =>
      s.replace(/"/g, ''),
    );
    expect(
      entries.length,
      `Python __all__ has ${entries.length} entries; expected ${REQUIRED_ALL_ENTRIES.length}`,
    ).toBe(REQUIRED_ALL_ENTRIES.length);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-python-all-list-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
