# @driftstack/api-types

Zod schemas + TypeScript types for the public [Driftstack](https://driftstack.io) API. The single source of truth for the API contract — the OpenAPI 3.1 spec is generated from these schemas, the official TypeScript SDK ([@driftstack/sdk](https://www.npmjs.com/package/@driftstack/sdk)) re-exports the inferred types, and other-language SDKs (Python, Go) generate types from the OpenAPI spec.

> **Status:** pre-1.0. While the package is `0.x`, a minor version can change the surface and a patch never does; all supported schemas and compatibility rules are documented below.

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
- **Auth flow:** `SignupRequest` / `SignupResponse`, `LoginRequest` / `LoginResponse`, `VerifyEmailRequest` / `VerifyEmailResponse`, `MagicLinkRequest` / `MagicLinkConsumeRequest`, `PasswordResetRequest` / `PasswordResetConfirmRequest`, `RefreshSessionRequest`, `LogoutRequest`, `WebSession`.
- **Billing:** `CreateCheckoutSessionRequest` / `CreateCheckoutSessionResponse`, `StartTrialPackRequest` / `StartTrialPackResponse`, `CreatePortalSessionResponse`, `GetBillingStateResponse`, `Subscription`, `TrialPackState`, `BillingPeriod`, `SubscriptionStatus`.
- **Discriminated unions:** `InteractAction`, `WaitCondition`.
- **Common shapes:** `Problem` (RFC 7807 error envelope), `PaginationQuery`, prefixed-id branded types (`AccountId`, `SessionId`, `ApiKeyId`, `ProfileId`, `WebhookEndpointId`, `WebhookDeliveryId`).
- **Closed enums:** `AccountTier`, `AccountStatus`, `ApiKeyScope`, `SessionStatus`, `WebhookEventType`, `WebhookDeliveryStatus`, `SubscriptionStatus`.
- **Stable problem-type URIs:** `PROBLEM_TYPES` (21 stable types: BadRequest, Unauthorized, Forbidden, NotFound, Conflict, RateLimited, ConcurrencyLimit, TierLimit, RevokedKey, ExpiredKey, InvalidKey, SessionDestroyed, SessionTimeout, LegalAcceptanceRequired, DriverError, DriverNotIntegrated, ValidationFailed, Internal, EmailAlreadyRegistered, InvalidCredentials, InvalidAuthToken, EmailNotVerified).
- **OpenVPN config helpers:** `DANGEROUS_OPENVPN_DIRECTIVES`, `findUnsupportedOpenvpnLines`, `stripUnsupportedOpenvpnLines` — the directive list the API refuses inside an OpenVPN `config_blob` (script-executing directives, `script-security` 2+) plus the line-level finder / stripper the server and the desktop client share, so a client can name the line the API will refuse before sending it.
- **`*Input` variants** (per the `z.input` / `z.output` distinction) for shapes with server-side defaults — see the SDK README for the full pattern.

## Versioning

`0.x.y` follows SemVer's pre-1.0 rules: breaking changes use a minor version and compatible fixes use a patch version.

Install normally. `npm install @driftstack/api-types` writes a caret range, and
for a `0.x` package npm resolves a caret to PATCH releases only — which is what
you want, because a minor version can change the surface and a patch never does.
Read the changelog before moving to a new minor. Pin an exact version only if
you need a byte-for-byte reproducible build, and note that your lockfile already
gives you one.

## License

MIT.
