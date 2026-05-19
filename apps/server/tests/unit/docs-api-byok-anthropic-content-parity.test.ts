// Drift guard for apps/docs/src/pages/api/byok-anthropic.md. Pins
// the BYOK Anthropic customer-facing docs surface — 4-verb endpoint
// roster + plaintext-never-echoed contract + Q4=A BYOK-always-wins
// founder verdict + AES-256-GCM at-rest + 90-day staleness window +
// 5-error_kind enum.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/src/pages/api/byok-anthropic.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs/api/byok-anthropic content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Q4=A founder verdict 2026-05-16 framing pinned: 'BYOK always wins over bundled-LLM in the resolution chain — per founder verdict Q4=A (2026-05-16), BYOK is the v1.0 primary path; bundled-LLM is the no-BYOK fallback.' — pinned so the Q4=A verdict-date + BYOK-primary-path + bundled-LLM-fallback contract all stay documented (drift to flipping the priority would break the customer-trust contract codified at Tier-3 lock)", () => {
    expect(body).toMatch(
      /BYOK always wins over bundled-LLM\s*\n?\s*in the resolution chain — per founder verdict Q4=A \(2026-05-16\),\s*\n?\s*BYOK is the v1\.0 primary path; bundled-LLM is the no-BYOK fallback\./,
    );
  });

  it("4-verb endpoint roster pinned: GET /v1/account/me/byok-anthropic-key (metadata) + PUT (set/rotate) + DELETE (clear) + POST /test (connection test). + 'plaintext NEVER returned in any response — even after a successful PUT' + 'has_key is the only stable signal' — pinned so the 4-endpoint surface + plaintext-never-echoed + has_key-is-stable-signal contract all stay documented", () => {
    expect(body).toMatch(/`GET \/v1\/account\/me\/byok-anthropic-key`/);
    expect(body).toMatch(/`PUT \/v1\/account\/me\/byok-anthropic-key`/);
    expect(body).toMatch(/`DELETE \/v1\/account\/me\/byok-anthropic-key`/);
    expect(body).toMatch(/`POST \/v1\/account\/me\/byok-anthropic-key\/test`/);
    expect(body).toMatch(/the actual API key plaintext is\s*\n?\s*NEVER returned in any response/);
    expect(body).toMatch(/`has_key` is the only stable signal\./);
  });

  it("AES-256-GCM at-rest framing pinned: 'encrypted at rest via AES-256-GCM (sealed with MFA_ENCRYPTION_KEY)' + '[12-byte IV | 16-byte auth tag | ciphertext]' canonical blob shape + 'accounts.byok_anthropic_key_blob (bytea)' storage column + 'shared with the v2-#8 sub-slice 8.4 gui_control_key encryption per Q2=C' — pinned so the AES-256-GCM + IV/tag/ciphertext envelope + Q2=C shared-key-with-gui_control_key contract all stay documented", () => {
    expect(body).toMatch(
      /encrypted at rest via AES-256-GCM \(sealed\s*\n?\s*with `MFA_ENCRYPTION_KEY`\)/,
    );
    expect(body).toMatch(
      /The\s*\n?\s*canonical blob shape is `\[12-byte IV \| 16-byte auth tag \|\s*\n?\s*ciphertext\]`\. Storage column: `accounts\.byok_anthropic_key_blob`\s*\n?\s*\(bytea\)\./,
    );
    expect(body).toMatch(/Q2=C/);
  });

  it("Q3 account_owner-vs-members framing pinned: PUT 'Required scope: account_owner (team members can USE the resolved key but cannot manage it — Q3 verdict)' + DELETE 'Required scope: account_owner' + POST /test 'Required scope: account_owner (team members would otherwise burn the owner's quota)'. + 'Auth: account_holder scope is sufficient (any account member can check whether the account has a BYOK key set; the plaintext stays inaccessible regardless)' for GET — pinned so the GET-open-PUT/DELETE/POST-owner + quota-burn-protection + Q3-verdict contract all stay documented", () => {
    expect(body).toMatch(
      /Required scope: `account_owner` \(team members can USE the resolved\s*\n?\s*key but cannot manage it — Q3 verdict\)\./,
    );
    expect(body).toMatch(
      /Required scope: `account_owner`\s*\n?\s*\(team members would otherwise burn the owner's quota\)\./,
    );
    expect(body).toMatch(
      /Auth: account_holder scope is sufficient \(any account member can\s*\n?\s*check whether the account has a BYOK key set; the plaintext stays\s*\n?\s*inaccessible regardless\)\./,
    );
  });

  it("90-day-staleness + 60-day-reminder TTL framing pinned (v2-#21): 'Stored keys carry an implicit 90-day staleness window. After 60 days the customer receives a one-time Postmark reminder email (sendByokAnthropicKeyRotationReminder). After 90 days the BYOKAnthropicService.getPlaintext({ now }) call returns null (treats the stored key as absent), forcing the resolution chain to fall through to header / bundled / fallback per the agent session route's posture.' + 'Customers can refresh the staleness window by PUTting the same key (resets set_at) — the timestamp update is enough to satisfy the 90-day gate.' — pinned so the v2-#21 + 90d-staleness + 60d-reminder + getPlaintext-returns-null-on-stale + PUT-resets-set_at contract all stay documented", () => {
    expect(body).toMatch(
      /## TTL \+ rotation reminders \(v2-#21\)\s*\n?\s*\s*\n?\s*Stored keys carry an implicit 90-day staleness window\. After 60\s*\n?\s*days the customer receives a one-time Postmark reminder email\s*\n?\s*\(`sendByokAnthropicKeyRotationReminder`\)\. After 90 days the\s*\n?\s*`BYOKAnthropicService\.getPlaintext\(\{ now \}\)` call returns null/,
    );
    expect(body).toMatch(
      /Customers can refresh the staleness window by PUTting the same\s*\n?\s*key \(resets `set_at`\)/,
    );
  });

  it('5-error_kind enum pinned: no_key_set + anthropic_unauthorized + anthropic_rate_limited + anthropic_server_error + network_error — pinned so the 5-error-class taxonomy stays stable (drift to a different enum would break dashboard error-routing logic + customer SDK retry classification)', () => {
    expect(body).toMatch(/- `no_key_set` — `has_key: false`; nothing to test\./);
    expect(body).toMatch(/- `anthropic_unauthorized` — Anthropic returned 401 \/ 403\./);
    expect(body).toMatch(/- `anthropic_rate_limited` — Anthropic returned 429\./);
    expect(body).toMatch(/- `anthropic_server_error` — Anthropic returned 5xx\./);
    expect(body).toMatch(/- `network_error` — TCP \/ TLS \/ DNS failure reaching Anthropic\./);
  });

  it("Test-response-never-echoes-key + Driftstack-does-NOT-proxy framing pinned: 'The test response NEVER echoes any part of the key (prefix or otherwise) — the customer's only audit trail is set_at / last_used_at plus this test result.' + 'Driftstack does NOT proxy or cache responses from the Anthropic API; the customer's BYOK key talks directly to Anthropic from the agent-runtime fork.' — pinned so the no-prefix-echo + direct-talk-no-proxy contract stays documented (privacy commitment to customer)", () => {
    expect(body).toMatch(
      /The test response NEVER echoes any part of the key \(prefix or\s*\n?\s*otherwise\) — the customer's only audit trail is `set_at` \/\s*\n?\s*`last_used_at` plus this test result\./,
    );
    expect(body).toMatch(
      /- Driftstack does NOT proxy or cache responses from the Anthropic\s*\n?\s*API; the customer's BYOK key talks directly to Anthropic from\s*\n?\s*the agent-runtime fork\./,
    );
  });

  it('Errors table 5-row roster pinned: 400 invalid-key-format + 401 unauthorized + 403 forbidden + 502 byok-anthropic-required + 503 feature-unavailable — pinned so the 5-error-status roster (each with its trigger condition) stays stable', () => {
    expect(body).toMatch(/\|\s*400 \| invalid-key-format/);
    expect(body).toMatch(/\|\s*401 \| unauthorized/);
    expect(body).toMatch(/\|\s*403 \| forbidden/);
    expect(body).toMatch(/\|\s*502 \| byok-anthropic-required/);
    expect(body).toMatch(/\|\s*503 \| feature-unavailable/);
  });

  it("V-494 secret-filter Sentry-breadcrumb framing pinned: 'The plaintext key is encrypted at rest + never logged. Sentry breadcrumbs around the route paths scrub via the V-494 secret filter.' — pinned so the V-494 + Sentry-breadcrumb scrubbing contract stays documented", () => {
    expect(body).toMatch(
      /- The plaintext key is encrypted at rest \+ never logged\. Sentry\s*\n?\s*breadcrumbs around the route paths scrub via the V-494 secret\s*\n?\s*filter\./,
    );
  });
});
