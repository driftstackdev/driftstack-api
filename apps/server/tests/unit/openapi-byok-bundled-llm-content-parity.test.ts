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

  // REWRITTEN 2026-08-14 from a chain of `[\s\S]{0,100}` gaps between the field
  // names. Documenting `refused_count_this_month` — a ~370-char `.describe()`
  // saying the field is unimplemented — pushed `month_started_at` past the
  // hundred-character bound and failed a pin about which FIELDS EXIST. Raising
  // the number would only move the tripwire, and each raise silently weakens the
  // ordering claim for every other gap.
  //
  // So the block is sliced at its own delimiters and the names are compared by
  // position. That states the claim directly and does not care how much prose
  // sits between two fields. The slice is bounded at BOTH ends: a slice that
  // grew to the whole file would still contain all six names in order and pass
  // having verified nothing about this schema.
  it('Bundled-LLM status response includes all 6 fields, in order (consent, cap_cents, used_this_month_cents, remaining_cents, refused_count_this_month, month_started_at)', () => {
    const start = src.indexOf('BundledLlmStatusOpenApi');
    expect(start, 'the schema declaration was found').toBeGreaterThan(-1);
    const end = src.indexOf(".openapi('BundledLlmStatus')", start);
    expect(end, 'its closing .openapi() call was found').toBeGreaterThan(start);

    const block = src.slice(start, end);
    // MEASURED: 705 chars. A floor catches an anchor that stopped matching; the
    // ceiling catches a slice that swallowed neighbouring schemas.
    expect(block.length, 'the sliced schema block is a plausible size').toBeGreaterThan(200);
    expect(block.length, 'and did not run past this schema').toBeLessThan(3000);

    const FIELDS = [
      'consent',
      'cap_cents',
      'used_this_month_cents',
      'remaining_cents',
      'refused_count_this_month',
      'month_started_at',
    ];
    const missing = FIELDS.filter((f) => !new RegExp(`^\\s*${f}:`, 'm').test(block));
    expect(missing, 'field(s) the status schema no longer declares:').toEqual([]);

    const positions = FIELDS.map((f) => block.search(new RegExp(`^\\s*${f}:`, 'm')));
    expect(positions, 'the fields are declared in the documented order').toEqual(
      [...positions].sort((a, b) => a - b),
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
