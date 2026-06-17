// OpenAPI parity — BYOK Anthropic + Bundled LLM endpoint surfaces.
// The v2-#6 + v2-#8 routes were wired into the runtime months ago
// but the OpenAPI registrations only landed with this slice. Pins
// the 7 endpoints (4 BYOK + 3 bundled-LLM) so a future refactor
// can't drop them from the spec without breaking CI.
//
// The spec is the contract for SDK consumers + the surface
// rendered at /docs/ (Scalar UI). Drift here = generated SDKs
// missing typed surfaces for live endpoints.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const OPENAPI_SRC = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');

describe('OpenAPI — BYOK Anthropic + Bundled LLM endpoints', () => {
  const src = readFileSync(OPENAPI_SRC, 'utf8');

  it('registers GET /v1/account/me/byok-anthropic-key (metadata)', () => {
    expect(src).toMatch(/method:\s*'get',\s*\n\s*path:\s*'\/v1\/account\/me\/byok-anthropic-key'/);
  });

  it('registers PUT /v1/account/me/byok-anthropic-key (set / rotate)', () => {
    expect(src).toMatch(/method:\s*'put',\s*\n\s*path:\s*'\/v1\/account\/me\/byok-anthropic-key'/);
  });

  it('registers DELETE /v1/account/me/byok-anthropic-key (clear, 204)', () => {
    expect(src).toMatch(
      /method:\s*'delete',\s*\n\s*path:\s*'\/v1\/account\/me\/byok-anthropic-key'/,
    );
  });

  it('registers POST /v1/account/me/byok-anthropic-key/test (connection test)', () => {
    expect(src).toMatch(
      /method:\s*'post',\s*\n\s*path:\s*'\/v1\/account\/me\/byok-anthropic-key\/test'/,
    );
  });

  it('registers GET /v1/account/me/bundled-llm-settings', () => {
    expect(src).toMatch(
      /method:\s*'get',\s*\n\s*path:\s*'\/v1\/account\/me\/bundled-llm-settings'/,
    );
  });

  it('registers PATCH /v1/account/me/bundled-llm-settings', () => {
    expect(src).toMatch(
      /method:\s*'patch',\s*\n\s*path:\s*'\/v1\/account\/me\/bundled-llm-settings'/,
    );
  });

  it('registers GET /v1/account/me/bundled-llm-status', () => {
    expect(src).toMatch(/method:\s*'get',\s*\n\s*path:\s*'\/v1\/account\/me\/bundled-llm-status'/);
  });

  it('BYOK request schema documents the api_key field (plaintext, never echoed)', () => {
    expect(src).toMatch(/PutByokAnthropicRequestOpenApi[\s\S]{0,300}api_key:\s*z\.string\(\)/);
  });

  it('BYOK metadata response uses has_key + set_at + last_used_at (NOT plaintext)', () => {
    expect(src).toMatch(
      /ByokAnthropicMetadataOpenApi[\s\S]{0,300}has_key:\s*z\.boolean\(\)[\s\S]{0,300}set_at[\s\S]{0,300}last_used_at/,
    );
  });

  it('BYOK test endpoint response is a discriminated union (ok=true | ok=false+reason)', () => {
    expect(src).toMatch(
      /TestByokAnthropicResponseOpenApi[\s\S]{0,500}z\.literal\(true\)[\s\S]{0,300}z\.literal\(false\)/,
    );
  });

  it('Bundled-LLM settings schema bounds monthly_cap_usd_cents to [0, 1_000_000] (matches CHECK constraint)', () => {
    expect(src).toMatch(
      /BundledLlmSettingsOpenApi[\s\S]{0,300}monthly_cap_usd_cents:\s*z\.number\(\)\.int\(\)\.min\(0\)\.max\(1_000_000\)/,
    );
  });

  it('Bundled-LLM status response includes all 6 fields (consent, cap_cents, used_this_month_cents, remaining_cents, refused_count_this_month, month_started_at)', () => {
    expect(src).toMatch(
      /BundledLlmStatusOpenApi[\s\S]{0,500}consent[\s\S]{0,100}cap_cents[\s\S]{0,100}used_this_month_cents[\s\S]{0,100}remaining_cents[\s\S]{0,100}refused_count_this_month[\s\S]{0,100}month_started_at/,
    );
  });

  it('BYOK endpoints tag = "account" (consistent with the rest of /v1/account/me/*)', () => {
    // "account" tags across BYOK (4) + bundled-LLM (3) + org GET/PUT (2) +
    // ARC A proxies GET/POST/PUT/DELETE/test (5) = 14 — count the registration
    // block's tags entries inside the section. Bounded count check ensures the
    // tag isn't accidentally changed to a different namespace. (org added
    // 2026-06-16; proxies CRUD slice 2 + test endpoint slice 4b.)
    const slice = src.slice(
      src.indexOf('Arc 7 docs.openapi'),
      src.indexOf('RateLimitBucketOpenApi'),
    );
    const tagOccurrences = (slice.match(/tags:\s*\['account'\]/g) ?? []).length;
    expect(tagOccurrences).toBe(14);
  });
});
