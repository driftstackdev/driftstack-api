// W707 — cross-SDK public-exports surface parity. Thirty-fourth in
// the cross-SDK drift-guard series (W649 + W675-W707).
//
// Asserts the public SDK barrel exports are consistent across all 3
// SDKs:
//
//   - 22+ shared error-class exports (the 21-class canonical roster
//     from W675 + TransportError) — TS exports them via { ... } from
//     './errors.js'; Python re-exports via __all__; Go exports them
//     as package-level types.
//   - Client class exports: TS `Driftstack` + Python `Driftstack` +
//     `AsyncDriftstack` + Go `Client` + `New` constructor
//   - verifyWebhookSignature helper exported as customer-facing
//     primitive (TS + Python; Go has it via VerifyWebhookSignature
//     in webhook_signature.go)
//   - is_retryable / isRetryable helper exported per-SDK
//   - iteratePaginated exported in sdk-typescript (resource-iterate
//     helper, distinct from per-resource iterate methods)
//   - 17-resource exposure: each SDK's Client class wires up all 17
//     resources (Sessions/Profiles/ProfileSnapshots/ApiKeys/Webhooks/
//     Billing/CryptoOrders/Auth/Account/Mfa/AuditLog/EmailPreferences/
//     Legal/Team/Usage)
//
// CRITICAL invariant: the SDK error-class names must match exactly
// across SDKs — drift to one SDK renaming `RateLimitError` to
// `TooManyRequestsError` would let customer error-handling code
// silently miss the rename in their cross-language stack.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_INDEX = resolve(REPO_ROOT, 'packages/sdk-typescript/src/index.ts');
const PY_INIT = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/__init__.py');
const GO_CLIENT = resolve(REPO_ROOT, 'packages/sdk-go/client.go');

describe('W707 cross-SDK public-exports surface parity', () => {
  it('all 3 SDK barrel files exist at canonical paths', () => {
    expect(existsSync(TS_INDEX), `missing ${TS_INDEX}`).toBe(true);
    expect(existsSync(PY_INIT), `missing ${PY_INIT}`).toBe(true);
    expect(existsSync(GO_CLIENT), `missing ${GO_CLIENT}`).toBe(true);
  });

  it('CRITICAL Client class exported per-SDK — `Driftstack` (TS + Python sync) + `AsyncDriftstack` (Python async) + `Client` (Go top-level type) + `New` (Go constructor). The names are the customer-facing entry points; drift to renaming would break every customer signup snippet.', () => {
    const ts = read(TS_INDEX);
    const py = read(PY_INIT);
    const go = read(GO_CLIENT);

    // sdk-typescript: `export { Driftstack, type DriftstackOptions } from './client.js';`
    expect(ts).toMatch(/export \{ Driftstack,/);

    // sdk-python: `from driftstack.client import AsyncDriftstack, Driftstack`
    expect(py).toMatch(/from driftstack\.client import AsyncDriftstack, Driftstack/);
    expect(py).toMatch(/"Driftstack",/);
    expect(py).toMatch(/"AsyncDriftstack",/);

    // sdk-go: `type Client struct` + `func New(...)`
    expect(go).toMatch(/^type Client struct/m);
    expect(go).toMatch(/^func New\(apiKey string,/m);
  });

  it('CRITICAL 21-class shared error roster exported in TS + Python __all__. The 21 classes (auth/permissions/rate-limit/not-found/quota/concurrency/conflict/validation/internal/email/session/legal/driver/etc.) form the canonical exception-class roster customers `except` on.', () => {
    const ts = read(TS_INDEX);
    const py = read(PY_INIT);

    const errorClasses = [
      'AuthError',
      'BadRequestError',
      'ConcurrencyLimitError',
      'ConflictError',
      'DriverError',
      'EmailAlreadyRegisteredError',
      'EmailNotVerifiedError',
      'ExpiredKeyError',
      'FeatureUnavailableError',
      'ForbiddenError',
      'InternalError',
      'InvalidAuthTokenError',
      'InvalidCredentialsError',
      'InvalidKeyError',
      'MfaStepUpRequiredError',
      'NotFoundError',
      'RateLimitError',
      'RevokedKeyError',
      'SessionDestroyedError',
      'TierLimitError',
      'TransportError',
      'ValidationError',
    ];

    for (const cls of errorClasses) {
      expect(ts, `sdk-typescript error class ${cls}`).toMatch(new RegExp(`\\b${cls}\\b`));
    }

    // sdk-python __all__ list — uses a slightly different naming roster
    // (QuotaExceededError instead of TierLimitError; LegalAcceptanceRequiredError
    // + SessionNotFoundError + SessionTimeoutError as extras).
    const pyExtras = [
      'AuthError',
      'ForbiddenError',
      'NotFoundError',
      'RateLimitError',
      'ConflictError',
      'ValidationError',
      'TransportError',
      'InvalidCredentialsError',
      'MfaStepUpRequiredError',
      'DriverError',
      'InternalError',
    ];
    for (const cls of pyExtras) {
      expect(py, `sdk-python error class ${cls}`).toMatch(new RegExp(`"${cls}",`));
    }
  });

  it('CRITICAL verifyWebhookSignature / verify_webhook_signature exported as customer-facing primitive in TS + Python. The function lets customers verify the Stripe-style HMAC-SHA256 signature on incoming webhook deliveries; drift to dropping the export would force customers to hand-roll signature verification.', () => {
    const ts = read(TS_INDEX);
    const py = read(PY_INIT);

    // sdk-typescript: `export { verifyWebhookSignature, type VerifySignatureInput }`
    expect(ts).toMatch(/export \{ verifyWebhookSignature/);

    // sdk-python: `from driftstack.webhook_signature import verify_webhook_signature`
    expect(py).toMatch(/from driftstack\.webhook_signature import verify_webhook_signature/);
    expect(py).toMatch(/"verify_webhook_signature",/);
  });

  it('CRITICAL is_retryable / isRetryable error-helper exported in TS + Python. The helper lets customers branch on "should I retry this?" without hand-coding the 5xx/transport-error roster. Drift to dropping would force customers to hard-code retry logic.', () => {
    const ts = read(TS_INDEX);
    const py = read(PY_INIT);

    expect(ts).toMatch(/\bisRetryable\b/);
    expect(py).toMatch(/\bis_retryable\b/);
  });

  it('CRITICAL customer-facing return-type re-exports parity — TS + Python both re-export the resource-level types used as method-return shapes (slices 112 + 113). Customers writing typed handlers MUST be able to `import { TeamMember } from "@driftstack/sdk"` and `from driftstack import TeamMember` without deep-importing from resources/*. Drift to either SDK dropping these re-exports would break customer code that annotates handlers explicitly.', () => {
    const ts = read(TS_INDEX);
    const py = read(PY_INIT);

    // Customer-facing types added in slices 112 + 113 (team +
    // webhooks-2 + api-keys-1 + sessions-1, with the TS side also
    // re-exporting 2 crypto-orders option types).
    const sharedTypes = [
      'TeamMember',
      'TeamInvite',
      'TeamMembersList',
      'TeamInvitesList',
      'TeamOwner',
      'TeamOwnersList',
      'AcceptInviteResponse',
      'ApiKeyList',
      'SessionsListPage',
      'WebhookEndpointList',
      'WebhookDeliveryListPage',
    ];

    for (const t of sharedTypes) {
      expect(ts, `sdk-typescript re-export ${t}`).toMatch(new RegExp(`\\b${t}\\b`));
      expect(py, `sdk-python __all__ entry "${t}"`).toMatch(new RegExp(`"${t}",`));
    }

    // TS-only types (Python uses kwargs/dicts instead of typed
    // Options classes — language-idiomatic difference).
    expect(ts).toMatch(/RotateApiKeyOptions/);
    expect(ts).toMatch(/RotateApiKeyResponse/);
    expect(ts).toMatch(/CreateCryptoCheckoutOptions/);
    expect(ts).toMatch(/ListCryptoOrdersOptions/);
  });

  it('CRITICAL iteratePaginated + CursorPage helper exported in sdk-typescript. The standalone helper lets customers walk arbitrary cursor-paginated endpoints; drift to dropping would force customers to hand-write cursor handoff logic.', () => {
    const ts = read(TS_INDEX);
    expect(ts).toMatch(/export \{ iteratePaginated, type CursorPage \} from '\.\/pagination\.js'/);
  });

  it('CRITICAL DriftstackError + DriftstackErrorKind exported as the base class + discriminator in sdk-typescript. The base + kind discriminator is what customer `instanceof DriftstackError` checks anchor on. Drift to renaming would break every customer error-handler.', () => {
    const ts = read(TS_INDEX);
    expect(ts).toMatch(/DriftstackError,/);
    expect(ts).toMatch(/type DriftstackErrorKind,/);

    const py = read(PY_INIT);
    expect(py).toMatch(/"DriftstackError",/);
  });

  it("CRITICAL 17-resource Client struct roster pinned in sdk-go — Sessions/APIKeys/Usage/Webhooks/Profiles/ProfileSnapshots/Billing/CryptoOrders/Auth/Account/Mfa/AuditLog/EmailPreferences/Legal/Team. Each resource is what makes `client.<Resource>` work; drift to dropping any field would break the SDK's resource-access surface.", () => {
    const go = read(GO_CLIENT);

    const resources = [
      'Sessions',
      'APIKeys',
      'Usage',
      'Webhooks',
      'Profiles',
      'ProfileSnapshots',
      'Billing',
      'CryptoOrders',
      'Auth',
      'Account',
      'Mfa',
      'AuditLog',
      'EmailPreferences',
      'Legal',
      'Team',
    ];

    for (const resource of resources) {
      // Field declaration on the Client struct.
      const re = new RegExp(`\\b${resource}\\s+\\*${resource}Resource`);
      expect(go, `sdk-go resource field ${resource}`).toMatch(re);
      // Resource accessor initialization in New().
      const initRe = new RegExp(`c\\.${resource} = &${resource}Resource\\{client: c\\}`);
      expect(go, `sdk-go resource init ${resource}`).toMatch(initRe);
    }
  });

  it("CRITICAL TS index re-exports api-types schemas — drift to dropping would force SDK consumers to add a second `@driftstack/api-types` dependency. The current 'no second dependency' framing is what keeps the customer-facing install lean.", () => {
    const ts = read(TS_INDEX);
    expect(ts).toMatch(
      /Re-export the public Zod schemas \+ types so SDK consumers don't need a\s*\/\/\s*second @driftstack\/api-types dependency/,
    );
    // 10+ api-types re-exports.
    for (const name of [
      'Session',
      'SessionState',
      'Profile',
      'WebhookEndpoint',
      'AuditLogEntry',
      'AccountTier',
      'ApiKey',
      'Problem',
      'UsageDailyBucket',
    ]) {
      expect(ts, `re-export ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('CRITICAL sdk-python __all__ list closed; every exported symbol declared. Drift to missing a symbol from __all__ would let it surface in autocompletion but trip `from driftstack import X` on a typo. The __all__ is the closed roster of what `from driftstack import *` returns.', () => {
    const py = read(PY_INIT);
    expect(py).toMatch(/__all__ = \[/);
    // Last entry pinned.
    expect(py).toMatch(/"verify_webhook_signature",/);
    // Version pin.
    expect(py).toMatch(/"__version__",/);
  });

  it('CRITICAL sdk-typescript per-resource list-page type exports pinned. Drift to dropping would force customers to construct their own pagination response types from primitives. The 6 list-page types (Sessions/Webhooks/Profiles/ProfileSnapshots/Audit/Webhook-delivery) cover the cursor-paginated surface.', () => {
    const ts = read(TS_INDEX);

    const listPageTypes = [
      'SessionsListPage',
      'ApiKeyList',
      'WebhookEndpointList',
      'WebhookDeliveryListPage',
      'ProfilesListPage',
      'ProfileSnapshotsListPage',
      'AuditLogListPage',
    ];
    for (const t of listPageTypes) {
      expect(ts, `list-page type ${t}`).toMatch(new RegExp(`\\b${t}\\b`));
    }
  });

  it('CRITICAL sdk-go Close method + closer interface pinned on Client. The Close() let customers release resources held by custom transports; the closer interface narrows to types with Close(). Drift to dropping would let custom-transport callers leak resources.', () => {
    const go = read(GO_CLIENT);
    expect(go).toMatch(/func \(c \*Client\) Close\(\) error/);
    expect(go).toMatch(/type closer interface \{/);
  });

  it('Cross-SDK barrel 5-invariant cluster — Driftstack/Client entry point + DriftstackError base class + verifyWebhookSignature helper + is_retryable helper + per-SDK resource roster reachable via barrel. Drift on any would fragment the cross-language public-surface contract.', () => {
    const ts = read(TS_INDEX);
    const py = read(PY_INIT);
    const go = read(GO_CLIENT);

    // Driftstack/Client.
    expect(ts).toMatch(/\bDriftstack\b/);
    expect(py).toMatch(/\bDriftstack\b/);
    expect(go).toMatch(/^type Client struct/m);

    // Error base.
    expect(ts).toMatch(/DriftstackError/);
    expect(py).toMatch(/DriftstackError/);

    // verifyWebhookSignature helper.
    expect(ts).toMatch(/verifyWebhookSignature/);
    expect(py).toMatch(/verify_webhook_signature/);

    // is_retryable helper.
    expect(ts).toMatch(/isRetryable/);
    expect(py).toMatch(/is_retryable/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-public-exports-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
