# @driftstack/api-types

Zod schemas + TypeScript types for the public [Driftstack](https://driftstack.dev) API. The single source of truth for the API contract — the OpenAPI 3.1 spec is generated from these schemas, the official TypeScript SDK ([@driftstack/sdk](https://www.npmjs.com/package/@driftstack/sdk)) re-exports the inferred types, and other-language SDKs (Python, Go) generate types from the OpenAPI spec.

> **Status:** alpha. Pre-launch contract; subject to change before `1.0.0`. Pin a specific version in production usage until then.

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

- **Resource schemas + types:** `Account`, `ApiKey`, `Session`, `SessionState`, `WebhookEndpoint`, `WebhookDelivery`, `UsagePeriodSummary`.
- **Request / response schemas:** `CreateSessionRequest`, `NavigateRequest`, `InteractRequest`, `WaitRequest`, `CaptureRequest`, `CreateApiKeyRequest`, `CreateWebhookRequest`, etc., plus their `*Response` counterparts.
- **Discriminated unions:** `InteractAction`, `WaitCondition`.
- **Common shapes:** `Problem` (RFC 7807 error envelope), `PaginationQuery`, prefixed-id branded types (`AccountId`, `SessionId`, `ApiKeyId`, `WebhookEndpointId`, `WebhookDeliveryId`).
- **Closed enums:** `AccountTier`, `AccountStatus`, `ApiKeyScope`, `SessionStatus`, `WebhookEventType`, `WebhookDeliveryStatus`.
- **Stable problem-type URIs:** `PROBLEM_TYPES`.
- **`*Input` variants** (per the `z.input` / `z.output` distinction) for shapes with server-side defaults — see the SDK README for the full pattern.

## Versioning

`0.x.y` — breaking changes can land in any minor version while we're below `1.0`. Pin to a specific version in production. Once we're at `1.0`, semver applies normally; breaking schema changes mean a major bump.

## License

MIT.
