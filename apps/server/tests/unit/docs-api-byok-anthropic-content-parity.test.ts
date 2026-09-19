// Drift guard for apps/docs/src/pages/api/byok-anthropic.md. Pins
// the BYOK Anthropic customer-facing docs surface — 4-verb endpoint
// roster + plaintext-never-echoed contract + Q4=A BYOK-always-wins
// founder verdict + AES-256-GCM at-rest + 90-day staleness window +
// test-response { ok } / { ok, reason } shape.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BYOK_ANTHROPIC_KEY_TTL_MS } from '../../src/services/byok-anthropic.js';

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
      /A stored key is always used instead\s*of the bundled LLM; the bundled LLM is used only when no key is set\s*\(and the customer has opted in to it\)\./,
    );
  });

  it("4-verb endpoint roster pinned: GET /v1/account/me/byok-anthropic-key (metadata) + PUT (set/rotate) + DELETE (clear) + POST /test (connection test), the plaintext is never returned, and `has_key` is documented as 'a key is stored' — not as proof the key is used, because a stored key past its age limit still reads has_key:true while turns treat it as absent", () => {
    expect(body).toMatch(/`GET \/v1\/account\/me\/byok-anthropic-key`/);
    expect(body).toMatch(/`PUT \/v1\/account\/me\/byok-anthropic-key`/);
    expect(body).toMatch(/`DELETE \/v1\/account\/me\/byok-anthropic-key`/);
    expect(body).toMatch(/`POST \/v1\/account\/me\/byok-anthropic-key\/test`/);
    expect(body).toMatch(/the actual API key plaintext is\s*NEVER returned in any response/);
    const days = BYOK_ANTHROPIC_KEY_TTL_MS / (24 * 60 * 60 * 1000);
    expect(days, 'the stored-key age limit is a whole number of days').toBe(Math.round(days));
    expect(body).toMatch(/`has_key` says a key is stored\./);
    expect(body).toMatch(
      new RegExp(
        `A stored key is used only while \`set_at\`\\s*is less than ${String(days)} days old`,
      ),
    );
    expect(body).toMatch(/turns treat it as absent even though\s*`has_key` stays `true`/);
    expect(body, 'the old "only stable signal" claim is back').not.toMatch(/only stable signal/);
  });

  it('AES-256-GCM at-rest encryption and the key-rotation consequence stay documented without internal env-var or storage names', () => {
    expect(body).toMatch(
      /On success the key is stored encrypted and the response is the new\s*`set_at`:/,
    );
    expect(body).toMatch(
      /The key is encrypted at rest with AES-256-GCM and is never returned\s*in any response\./,
    );
    expect(body).toMatch(
      /If Driftstack rotates its encryption key, existing\s*stored keys stop working and customers need to set their key again\./,
    );
    expect(body).not.toMatch(/MFA_ENCRYPTION_KEY|byok_anthropic_key_blob/);
  });

  it('Q3 account_owner-vs-members framing pinned for mutations; GET requires broad read because credential timestamps are account-wide metadata', () => {
    expect(body).toMatch(
      /Required scope: `account_owner` \(team members can use the key but\s*cannot manage it\)\./,
    );
    expect(body).toMatch(
      /Required scope:\s*`account_owner` \(team members would otherwise consume the owner's provider\s*request budget\)\./,
    );
    expect(body).toMatch(
      /Required scope: broad `read` \(also satisfied by `account_owner`\)\. The\s*set\/use timestamps are account-wide credential metadata, so a\s*resource-granular or zero-scope key cannot query them\. The plaintext\s*stays inaccessible regardless\./,
    );
  });

  it('90-day staleness, 60-day reminder, and PUT refresh behavior stay documented', () => {
    expect(body).toMatch(
      /## TTL \+ rotation reminders\s*Stored keys carry an implicit 90-day staleness window\. After 60 days\s*the customer receives a one-time reminder email\. After 90 days the\s*stored key is treated as absent/,
    );
    expect(body).toMatch(
      /Customers can refresh the staleness window by PUTting the same\s*key \(resets `set_at`\)/,
    );
  });

  it('test-response shape pinned: { ok: true } on success + { ok: false, reason } on failure (reason is advisory, not a stable enum) + 400 Bad Request when no key set — pinned so the live route contract (account-byok-anthropic.ts:241 + :219) stays documented; drift to a fabricated tested_at/error_kind/error_detail enum would mislead SDK error-routing logic', () => {
    expect(body).toMatch(/```json\s*\n\{ "ok": true \}\s*\n```/);
    expect(body).toMatch(/"ok": false,\s*\n\s*"reason":/);
    expect(body).toMatch(/it is not a stable enum, so do\s*not branch on its exact contents\./);
    expect(body).toMatch(
      /If no key is set on the account,\s*the endpoint instead returns `400 Bad Request` \(type `…\/bad-request`\)/,
    );
  });

  it('test response never echoes provider material and the server probe stays fixed, no-inference, and body-blind', () => {
    expect(body).toMatch(
      /The test response NEVER echoes any part of the key, Anthropic's response\s*body, or a low-level network error\./,
    );
    expect(body).toMatch(
      /- The API server sends the connection-test request only to the fixed\s*Anthropic model-list endpoint\. It does not run inference, read or proxy\s*the response body, or cache the response\./,
    );
    expect(body).toMatch(/The audit\s*log records only the outcome, never Anthropic's response\./);
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
      /- The plaintext key is encrypted at rest \+ never logged\. It never\s*appears in our error reports\./,
    );
  });
});
