// Drift guard for apps/docs/src/pages/api/byok-anthropic.md. Pins
// the BYOK Anthropic customer-facing docs surface — 4-verb endpoint
// roster + plaintext-never-echoed contract + Q4=A BYOK-always-wins
// founder verdict + AES-256-GCM at-rest + 90-day staleness window +
// test-response { ok } / { ok, reason } shape.

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

  it("Q4=A design verdict 2026-05-16 framing pinned: 'BYOK always wins over bundled-LLM in the resolution chain — per Driftstack design verdict Q4=A (2026-05-16), BYOK is the v1.0 primary path; bundled-LLM is the no-BYOK fallback.' — V-211 anonymity rewrote 'founder verdict' to 'Driftstack design verdict' in customer-facing copy; pinned so the Q4=A verdict-date + BYOK-primary-path + bundled-LLM-fallback contract stays documented.", () => {
    expect(body).toMatch(
      /BYOK always wins over bundled-LLM\s*\n?\s*in the resolution chain — per Driftstack design verdict Q4=A\s*\n?\s*\(2026-05-16\), BYOK is the v1\.0 primary path; bundled-LLM is the\s*\n?\s*no-BYOK fallback\./,
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

  it('AES-256-GCM at-rest envelope, storage column, and shared GUI-control-key authority stay documented without internal work-item labels', () => {
    expect(body).toMatch(
      /encrypted at rest via AES-256-GCM \(sealed\s*\n?\s*with `MFA_ENCRYPTION_KEY`\)/,
    );
    expect(body).toMatch(
      /The\s*\n?\s*canonical blob shape is `\[12-byte IV \| 16-byte auth tag \|\s*\n?\s*ciphertext\]`\. Storage column: `accounts\.byok_anthropic_key_blob`\s*\n?\s*\(bytea\)\./,
    );
    expect(body).toMatch(
      /deployment's `MFA_ENCRYPTION_KEY` env var \(shared with encrypted\s*\n?\s*GUI control keys\)/,
    );
  });

  it('Q3 account_owner-vs-members framing pinned for mutations; GET requires broad read because credential timestamps are account-wide metadata', () => {
    expect(body).toMatch(
      /Required scope: `account_owner` \(team members can USE the resolved\s*\n?\s*key but cannot manage it — Q3 verdict\)\./,
    );
    expect(body).toMatch(
      /Required scope:\s*\n?\s*`account_owner` \(team members would otherwise consume the owner's provider\s*\n?\s*request budget\)\./,
    );
    expect(body).toMatch(
      /Required scope: broad `read` \(also satisfied by `account_owner`\)\. The\s*\n?\s*set\/use timestamps are account-wide credential metadata, so a\s*\n?\s*resource-granular or zero-scope key cannot query them\. The plaintext\s*\n?\s*stays inaccessible regardless\./,
    );
  });

  it('90-day staleness, 60-day reminder, and PUT refresh behavior stay documented', () => {
    expect(body).toMatch(
      /## TTL \+ rotation reminders\s*\n?\s*\s*\n?\s*Stored keys carry an implicit 90-day staleness window\. After 60\s*\n?\s*days the customer receives a one-time Postmark reminder email\s*\n?\s*\(`sendByokAnthropicKeyRotationReminder`\)\. After 90 days the\s*\n?\s*`BYOKAnthropicService\.getPlaintext\(\{ now \}\)` call returns null/,
    );
    expect(body).toMatch(
      /Customers can refresh the staleness window by PUTting the same\s*\n?\s*key \(resets `set_at`\)/,
    );
  });

  it('test-response shape pinned: { ok: true } on success + { ok: false, reason } on failure (reason is advisory, not a stable enum) + 400 Bad Request when no key set — pinned so the live route contract (account-byok-anthropic.ts:241 + :219) stays documented; drift to a fabricated tested_at/error_kind/error_detail enum would mislead SDK error-routing logic', () => {
    expect(body).toMatch(/```json\s*\n\{ "ok": true \}\s*\n```/);
    expect(body).toMatch(/"ok": false,\s*\n\s*"reason":/);
    expect(body).toMatch(
      /it is not a stable enum, so do\s*\n?\s*not branch on its exact contents\./,
    );
    expect(body).toMatch(
      /If no key is set on the account,\s*\n?\s*the endpoint instead returns `400 Bad Request` \(type `…\/bad-request`\)/,
    );
  });

  it('test response never echoes provider material and the server probe stays fixed, no-inference, and body-blind', () => {
    expect(body).toMatch(
      /The test response NEVER echoes any part of the key, Anthropic response\s*\n?\s*body, or native transport error\./,
    );
    expect(body).toMatch(
      /- The API server sends the connection-test request only to the fixed\s*\n?\s*Anthropic model-list endpoint\. It does not run inference, read or proxy\s*\n?\s*the response body, or cache the response\./,
    );
    expect(body).toMatch(/Audit and metrics retain\s*\n?\s*only a bounded outcome/);
  });

  it('Errors table 5-row roster pinned: 400 bad-request + 401 unauthorized + 403 forbidden + 502 byok-anthropic-required + 503 feature-unavailable — pinned so the 5-error-status roster (each with its trigger condition) stays stable', () => {
    expect(body).toMatch(/\|\s*400 \| bad-request/);
    expect(body).toMatch(/\|\s*401 \| unauthorized/);
    expect(body).toMatch(/\|\s*403 \| forbidden/);
    expect(body).toMatch(/\|\s*502 \| byok-anthropic-required/);
    expect(body).toMatch(/\|\s*503 \| feature-unavailable/);
  });

  it('secret-redaction framing keeps plaintext out of logs and Sentry breadcrumbs', () => {
    expect(body).toMatch(
      /- The plaintext key is encrypted at rest \+ never logged\. Sentry\s*\n?\s*breadcrumbs around the route paths use the shared secret-redaction\s*\n?\s*filter\./,
    );
  });
});
