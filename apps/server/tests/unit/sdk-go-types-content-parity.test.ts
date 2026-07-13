// W589.C — drift guard for packages/sdk-go/types.go.
// 868-line shared-types module mirroring api-types Zod schemas.
// Drift here either flips a closed enum, drops a discriminated-
// union constructor (NewTapAction/NewSelectorCondition/etc.), or
// breaks the V-296/V-298c/V-353d/V-359/V-445/V-460 typed surfaces.
//
//   • Naming follows Stripe-Go convention (PascalCase, json
//     underscore_case, omitempty for optional).
//   • Closed enums: AccountTier (8) + AccountStatus (3) +
//     APIKeyScope (6) + SessionStatus (5) + SessionPurpose (3 +
//     DefaultSessionPurpose) + WebhookEventType (6) +
//     WebhookDeliveryStatus (5) + UsageRecordType (6) + TeamRole
//     (2) + SubscriptionStatus (8) + CaptureKind (3).
//   • Discriminated unions: InteractAction (tap/type/scroll/press
//     + 4 constructors) + WaitCondition (selector/selector_hidden/
//     url_matches/time + 4 constructors).
//   • Key V-NNN structs: Account + APIKey + APIKeyList +
//     CreateAPIKeyRequest/Response + V-296 RotateAPIKey* +
//     V-298c TeamMember/Invite/MembersList/InvitesList +
//     V-353d LoginResponse MFA-required branch + V-445 MFA
//     challenge/step-up + V-460 CLI-authorize 3-step +
//     V-359 WebhookEndpoint rotation grace +
//     UpdateWebhookRequest pointer fields (V-351 partial).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/types.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W589.C packages/sdk-go/types.go content parity', () => {
  const body = read(LIB);

  it('Module framing: Zod source-of-truth + Zod→OpenAPI 3.1→types + V-026 hand-written reasoning + Stripe-Go naming convention pinned', () => {
    expect(body).toMatch(/\/\/ This file mirrors the Zod schemas in `packages\/api-types\/`\. The/);
    expect(body).toMatch(
      /\/\/ schemas are the source of truth \(Zod → OpenAPI 3\.1 → these types\)\./,
    );
    expect(body).toMatch(/\/\/ Re-generated when schemas change; tracked manually for now since/);
    expect(body).toMatch(/\/\/ oapi-codegen lacks OpenAPI 3\.1 support \(see V-026 for the/);
    expect(body).toMatch(/\/\/ codegen-vs-hand-written decision\)\./);
    expect(body).toMatch(
      /\/\/ Naming follows the Stripe-Go convention: PascalCase exported types,/,
    );
    expect(body).toMatch(/\/\/ json tags using the underscore_case names the wire uses, omitempty/);
    expect(body).toMatch(/\/\/ on optional fields so customers can construct partial inputs\./);
  });

  it('Closed enums pinned: AccountTier (8) + AccountStatus (3) + APIKeyScope (6 with V-174 split) + SessionStatus (5) + SessionPurpose (3 V-433 server-aligned + DefaultSessionPurpose) + WebhookEventType (6) + WebhookDeliveryStatus (5) + UsageRecordType (6) + CaptureKind (3) + SubscriptionStatus (8) + TeamRole (2)', () => {
    expect(body).toMatch(/^type AccountTier string$/m);
    expect(body).toMatch(/TierFree\s+AccountTier = "free"/);
    expect(body).toMatch(/TierSoloManual\s+AccountTier = "solo_manual"/);
    expect(body).toMatch(/TierAPIBuilder\s+AccountTier = "api_builder"/);
    expect(body).toMatch(/TierEnterprise\s+AccountTier = "enterprise"/);
    expect(body).toMatch(/^type AccountStatus string$/m);
    expect(body).toMatch(/AccountActive\s+AccountStatus = "active"/);
    expect(body).toMatch(/\/\/ APIKeyScope\. V-174 split the legacy single `admin` scope into/);
    expect(body).toMatch(
      /\/\/ `account_owner` \(customer self-serve\) and `driftstack_internal_admin`/,
    );
    expect(body).toMatch(
      /\/\/ \(staff cross-account\)\. The legacy `admin` token remains accepted as/,
    );
    expect(body).toMatch(/ScopeRead\s+APIKeyScope = "read"/);
    expect(body).toMatch(/ScopeAdmin\s+APIKeyScope = "admin" \/\/ compat alias \(V-174\)/);
    expect(body).toMatch(/ScopeAccountOwner\s+APIKeyScope = "account_owner"/);
    expect(body).toMatch(/ScopeDriftstackInternalAdmin APIKeyScope = "driftstack_internal_admin"/);
    expect(body).toMatch(/ScopeGUIControl\s+APIKeyScope = "gui_control"/);
    expect(body).toMatch(/^type SessionStatus string$/m);
    expect(body).toMatch(/SessionCreating\s+SessionStatus = "creating"/);
    expect(body).toMatch(/SessionReady\s+SessionStatus = "ready"/);
    expect(body).toMatch(/SessionDestroyed SessionStatus = "destroyed"/);
    expect(body).toMatch(/SessionErrored\s+SessionStatus = "errored"/);
    expect(body).toMatch(/\/\/ V-433 — these are the only values the server's/);
    expect(body).toMatch(/PurposeProductionCustomer\s+SessionPurpose = "production_customer"/);
    expect(body).toMatch(
      /PurposeCumulativeRigValidation SessionPurpose = "cumulative_rig_validation"/,
    );
    expect(body).toMatch(/PurposeTestDomainProbe\s+SessionPurpose = "test_domain_probe"/);
    expect(body).toMatch(/^const DefaultSessionPurpose = PurposeProductionCustomer$/m);
    expect(body).toMatch(/^type WebhookEventType string$/m);
    expect(body).toMatch(/EventSessionCompleted\s+WebhookEventType = "session\.completed"/);
    expect(body).toMatch(/EventTestPing WebhookEventType = "test\.ping"/);
    expect(body).toMatch(/\/\/ V-356 — synthetic test event sent only via/);
    expect(body).toMatch(/^type WebhookDeliveryStatus string$/m);
    expect(body).toMatch(/DeliveryDLQ\s+WebhookDeliveryStatus = "dlq"/);
    expect(body).toMatch(/^type UsageRecordType string$/m);
    expect(body).toMatch(/UsageSessionMinute\s+UsageRecordType = "session_minute"/);
    expect(body).toMatch(/^type CaptureKind string$/m);
    expect(body).toMatch(/CaptureScreenshot\s+CaptureKind = "screenshot"/);
    expect(body).toMatch(/CaptureDOMSnapshot CaptureKind = "dom_snapshot"/);
    expect(body).toMatch(/CapturePDF\s+CaptureKind = "pdf"/);
    expect(body).toMatch(/^type SubscriptionStatus string$/m);
    expect(body).toMatch(/SubStatusIncompleteExpired SubscriptionStatus = "incomplete_expired"/);
    expect(body).toMatch(/SubStatusPaused\s+SubscriptionStatus = "paused"/);
    expect(body).toMatch(/^type TeamRole string$/m);
    expect(body).toMatch(/TeamRoleMember TeamRole = "member"/);
    expect(body).toMatch(/TeamRoleAdmin\s+TeamRole = "admin"/);
  });

  it('V-296 RotateAPIKey + V-298c Team RBAC types + V-353d LoginResponse MFA-branch + V-445 MFA + V-460 CLI-authorize 3-step pinned', () => {
    expect(body).toMatch(
      /^type CreateAPIKeyResponse struct \{\s*\n\s*APIKey\s*\n\s*Plaintext string `json:"plaintext"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /\/\/ V-296 — RotateAPIKeyRequest is the body for POST \/v1\/api-keys\/:id\/rotate\./,
    );
    expect(body).toMatch(
      /^type RotateAPIKeyResponse struct \{\s*\n\s*CreateAPIKeyResponse\s*\n\s*RotatedFrom\s+string\s+`json:"rotated_from"`\s*\n\s*GracePeriodEndsAt time\.Time `json:"grace_period_ends_at"`\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ V-298c \/ V-309g — Team RBAC v1\./);
    expect(body).toMatch(/^type TeamMember struct \{/m);
    expect(body).toMatch(/^type TeamInvite struct \{/m);
    expect(body).toMatch(/^type TeamOwner struct \{/m);
    expect(body).toMatch(/^type TeamOwnersList struct \{/m);
    expect(body).toMatch(/\/\/ LoginResponse — V-425 \+ V-353d\. The server returns one of two/);
    expect(body).toMatch(
      /\/\/ {3}- MFA-required: `\{ "mfa_required": true, "challenge_token": "\.\.\.",/,
    );
    expect(body).toMatch(/MfaRequired\s+bool\s+`json:"mfa_required,omitempty"`/);
    expect(body).toMatch(/ChallengeToken\s+string `json:"challenge_token,omitempty"`/);
    for (const response of ['MagicLinkConsumeResponse', 'PasswordResetConfirmResponse']) {
      expect(body).toMatch(
        new RegExp(
          'type ' +
            response +
            ' struct \\{[\\s\\S]+?Session\\s+WebSession `json:"session,omitempty"`[\\s\\S]+?MfaRequired\\s+bool\\s+`json:"mfa_required,omitempty"`[\\s\\S]+?ChallengeToken\\s+string\\s+`json:"challenge_token,omitempty"`',
        ),
      );
    }
    expect(body).toMatch(/\/\/ V-445 — MFA challenge \+ step-up shapes\./);
    expect(body).toMatch(/^type MfaChallengeRequest struct \{/m);
    expect(body).toMatch(/^type MfaStepUpRequest struct \{/m);
    expect(body).toMatch(/Via\s+string\s+`json:"via"` \/\/ "totp" \| "recovery"/);
    expect(body).toMatch(/\/\/ V-460 \/ V-266 CLI\/GUI activation flow \(browser-OAuth-style\)\./);
    expect(body).toMatch(/^type CliAuthorizeInitiateRequest struct \{/m);
    expect(body).toMatch(/^type CliAuthorizeBindRequest struct \{/m);
    expect(body).toMatch(/^type CliAuthorizeExchangeRequest struct \{/m);
    expect(body).toMatch(/\/\/ CliAuthorizeExchangeResponse — discriminated on Status:/);
    expect(body).toMatch(/\/\/ {3}- "pending" — keep polling\./);
    expect(body).toMatch(
      /\/\/ {3}- "bound" {3}— one-shot delivery; APIKey \+ AccountID populated\./,
    );
  });

  it('Session API: InteractAction (tap/type/scroll/press) + WaitCondition (selector/selector_hidden/url_matches/time) discriminated unions with 4 constructors each; L-001 gui-input gated framing pinned', () => {
    expect(body).toMatch(/\/\/ InteractAction is a discriminated-union of action kinds\. Use the/);
    expect(body).toMatch(
      /\/\/ This is the customer-facing intent-only surface \(L-001\)\. Coordinate/,
    );
    expect(body).toMatch(/\/\/ primitives \(tap_at \/ type_focused \/ tap\.offset\) live on the/);
    expect(body).toMatch(/\/\/ gui-control plane and are NOT part of this SDK — they're internal/);
    expect(body).toMatch(/\/\/ to the self-hosted GUI workflow and gated behind the `gui_control`/);
    expect(body).toMatch(/^type InteractAction struct \{/m);
    expect(body).toMatch(/Kind\s+string `json:"kind"` {15}\/\/ tap \| type \| scroll \| press/);
    expect(body).toMatch(
      /func NewTapAction\(selector string\) InteractAction \{\s*\n\s*return InteractAction\{Kind: "tap", Selector: selector\}\s*\n\}/,
    );
    expect(body).toMatch(
      /func NewTypeAction\(selector, text string\) InteractAction \{\s*\n\s*return InteractAction\{Kind: "type", Selector: selector, Text: text\}\s*\n\}/,
    );
    expect(body).toMatch(
      /\/\/ NewScrollAction scrolls the viewport \(or selected element\) by the/,
    );
    expect(body).toMatch(/\/\/ given pixel deltas\. Positive Y scrolls down\./);
    expect(body).toMatch(
      /func NewScrollAction\(deltaX, deltaY int\) InteractAction \{\s*\n\s*return InteractAction\{Kind: "scroll", DeltaX: deltaX, DeltaY: deltaY\}\s*\n\}/,
    );
    expect(body).toMatch(
      /func NewPressAction\(key string\) InteractAction \{\s*\n\s*return InteractAction\{Kind: "press", Key: key\}\s*\n\}/,
    );
    expect(body).toMatch(/\/\/ WaitCondition is a discriminated-union of wait conditions\./);
    expect(body).toMatch(
      /Kind\s+string `json:"kind"` \/\/ selector \| selector_hidden \| url_matches \| time/,
    );
    expect(body).toMatch(/func NewSelectorCondition\(selector string\) WaitCondition \{/);
    expect(body).toMatch(/func NewSelectorHiddenCondition\(selector string\) WaitCondition \{/);
    expect(body).toMatch(/func NewURLMatchesCondition\(pattern string\) WaitCondition \{/);
    expect(body).toMatch(/func NewTimeCondition\(ms int\) WaitCondition \{/);
  });

  it('Webhook/billing/profile/event-envelope structures: V-359 WebhookEndpoint rotation grace + V-351 UpdateWebhookRequest pointer fields + V-185 WebhookEndpointDeliveryCounts + V-429 Subscription + Event{Type+Data raw} + V-426 Profile structs pinned', () => {
    expect(body).toMatch(
      /\/\/ V-359 — rotation grace state\. Both null when no rotation in flight\./,
    );
    expect(body).toMatch(/PrevSecretPrefix\s+\*string\s+`json:"prev_secret_prefix"`/);
    expect(body).toMatch(
      /RotationGraceExpiresAt \*time\.Time\s+`json:"rotation_grace_expires_at"`/,
    );
    expect(body).toMatch(
      /\/\/ WebhookEndpointDeliveryCounts — V-185 aggregate per-endpoint delivery/,
    );
    expect(body).toMatch(/\/\/ UpdateWebhookRequest — V-351 partial update\. Pointer fields so/);
    expect(body).toMatch(
      /\/\/ callers can distinguish "leave as-is" \(nil\) from "set explicitly"/,
    );
    expect(body).toMatch(
      /^type UpdateWebhookRequest struct \{\s*\n\s*URL\s+\*string\s+`json:"url,omitempty"`\s*\n\s*Events\s+\*\[\]WebhookEventType `json:"events,omitempty"`\s*\n\s*Description \*string\s+`json:"description,omitempty"`\s*\n\s*Active\s+\*bool\s+`json:"active,omitempty"`\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ Subscription — V-429\./);
    expect(body).toMatch(/\/\/ Event is the envelope every webhook delivery wraps\./);
    expect(body).toMatch(
      /^type Event struct \{\s*\n\s*ID\s+string\s+`json:"id"`\s*\n\s*Type\s+WebhookEventType `json:"type"`\s*\n\s*CreatedAt time\.Time\s+`json:"created_at"`\s*\n\s*Data\s+json\.RawMessage\s+`json:"data"`\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ Profile — V-426\./);
    expect(body).toMatch(/\/\/ CreateProfileRequest — V-426\./);
    expect(body).toMatch(/\/\/ UpdateProfileRequest — V-426\./);
    // doc-150 item 5 — per-profile sealed-store size (*int64, can exceed 2^31)
    // + save-back time on the Profile struct.
    expect(body).toMatch(/SizeBytes\s+\*int64\s+`json:"size_bytes"`/);
    expect(body).toMatch(/LastSavedAt \*time\.Time\s+`json:"last_saved_at"`/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
