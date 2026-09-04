# @driftstack/api-types

Zod schemas + TypeScript types for the public [Driftstack](https://driftstack.io) API. The single source of truth for the API contract — the OpenAPI 3.1 spec is generated from these schemas, the official TypeScript SDK ([@driftstack/sdk](https://www.npmjs.com/package/@driftstack/sdk)) re-exports the inferred types, and other-language SDKs (Python, Go) generate types from the OpenAPI spec.

> **Status:** pre-1.0. Pin an exact package version in production; all supported schemas and compatibility rules are documented below.

## Install

```bash
npm install @driftstack/api-types
```

You usually don't need to install this directly — it's a transitive dependency of `@driftstack/sdk`. Install it explicitly only if you want to:

- Use the Zod schemas to validate API responses you receive through your own HTTP client.
- Generate code (other languages, custom clients) from the inferred types.
- Build server-side adapters or middleware that conform to the same contract.

## Usage

```ts
import { CreateSessionRequestSchema, type Session, type Problem } from '@driftstack/api-types';

// Validate an inbound request body before passing it to your handler.
const parsed = CreateSessionRequestSchema.parse(req.body);

// Use the inferred type as a function parameter.
function handle(session: Session) {
  console.log(session.id, session.status);
}
```

## What's exported

- **Resource schemas + types:** `Account`, `ApiKey`, `Session`, `SessionState`, `Profile`, `Subscription`, `WebhookEndpoint`, `WebhookDelivery`, `UsagePeriodSummary`.
- **Request / response schemas:** `CreateSessionRequest`, `NavigateRequest`, `InteractRequest`, `WaitRequest`, `CaptureRequest`, `CreateProfileRequest` / `UpdateProfileRequest`, `CreateApiKeyRequest`, `CreateWebhookRequest`, plus their `*Response` counterparts.
- **Auth flow** (V-079): `SignupRequest` / `SignupResponse`, `LoginRequest` / `LoginResponse`, `VerifyEmailRequest` / `VerifyEmailResponse`, `MagicLinkRequest` / `MagicLinkConsumeRequest`, `PasswordResetRequest` / `PasswordResetConfirmRequest`, `RefreshSessionRequest`, `LogoutRequest`, `WebSession`.
- **Billing** (V-082): `CreateCheckoutSessionRequest` / `CreateCheckoutSessionResponse`, `StartTrialPackRequest` / `StartTrialPackResponse`, `CreatePortalSessionResponse`, `GetBillingStateResponse`, `Subscription`, `TrialPackState`, `BillingPeriod`, `SubscriptionStatus`.
- **Discriminated unions:** `InteractAction`, `WaitCondition`.
- **Common shapes:** `Problem` (RFC 7807 error envelope), `PaginationQuery`, prefixed-id branded types (`AccountId`, `SessionId`, `ApiKeyId`, `ProfileId`, `WebhookEndpointId`, `WebhookDeliveryId`).
- **Closed enums:** `AccountTier`, `AccountStatus`, `ApiKeyScope`, `SessionStatus`, `WebhookEventType`, `WebhookDeliveryStatus`, `SubscriptionStatus`.
- **Stable problem-type URIs:** `PROBLEM_TYPES` (21 stable types as of V-079: BadRequest, Unauthorized, Forbidden, NotFound, Conflict, RateLimited, ConcurrencyLimit, TierLimit, RevokedKey, ExpiredKey, InvalidKey, SessionDestroyed, SessionTimeout, LegalAcceptanceRequired, DriverError, DriverNotIntegrated, ValidationFailed, Internal, EmailAlreadyRegistered, InvalidCredentials, InvalidAuthToken, EmailNotVerified).
- **`*Input` variants** (per the `z.input` / `z.output` distinction) for shapes with server-side defaults — see the SDK README for the full pattern.

## Versioning

`0.x.y` follows SemVer's pre-1.0 rules: breaking changes use a minor version and compatible fixes use a patch version. Pin an exact version in production and review the changelog before upgrading.

## License

MIT.
