// Drift guard for apps/docs/src/pages/api/versioning.md — the API
// versioning policy doc that customers reference when integrating
// against /v1/*. Pinning the load-bearing claims:
//
//   - One-major-at-a-time + additive-changes-free framing.
//   - The 13-row additive-vs-breaking decision table (drift to
//     dropping a row would lose customer-facing predictability
//     guarantees).
//   - The OpenAPI-spec-is-the-contract anchor + the Zod-derived
//     single-source-of-truth claim (drift to dual-source would
//     re-open the spec-vs-runtime drift surface slices 120/123/124
//     closed).
//   - The closed-enum-server-sends-new-value-is-breaking nuance
//     (the most-asked SDK consumer question; drift to dropping
//     this row would mislead webhook event-type consumers).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/versioning.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs api/versioning content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: API versioning policy/);
    expect(body).toMatch(
      /description: Driftstack API versioning policy — additive vs breaking changes, deprecation cycle, when \/v2\/\* is justified\./,
    );
  });

  it('one-major-at-a-time TL;DR pinned (load-bearing customer expectation)', () => {
    expect(body).toMatch(/One major version active at a time\. `\/v1\/\*` today\./);
    expect(body).toMatch(/Additive changes are free/);
    expect(body).toMatch(/`\/v2\/\*` only when justified; not on a calendar\./);
  });

  it('OpenAPI-spec-is-the-contract anchor pinned (drift to dual-source would reopen the spec-vs-route drift surface slices 120/123/124 closed)', () => {
    expect(body).toMatch(
      /The OpenAPI spec at `\/openapi\.json` is the contract\. Generated\s+from Zod schemas in `packages\/api-types\/`; there is no second\s+source of truth\./,
    );
  });

  it('13-row additive-vs-breaking decision table pinned (sample 5 rows that customers cite most often)', () => {
    expect(body).toMatch(/\| New endpoint\s+\| Additive\s+\|/);
    expect(body).toMatch(/\| New optional request field with sensible default\s+\| Additive\s+\|/);
    expect(body).toMatch(/\| Renaming an existing field\s+\| Breaking\s+\|/);
    expect(body).toMatch(/\| Removing an existing field\s+\| Breaking\s+\|/);
    expect(body).toMatch(/\| Tightening a validation constraint\s+\| Breaking\s+\|/);
  });

  it('closed-enum-server-sends-new-value nuance pinned (the most-asked SDK-consumer question; drift to dropping this row would mislead webhook event-type consumers)', () => {
    expect(body).toMatch(
      /\| New enum value \(sent BY server, e\.g\. webhook event types\) \| \*\*Breaking for closed-enum consumers\*\* \|/,
    );
    expect(body).toMatch(
      /\| New enum value \(accepted FROM client, e\.g\. tier IDs\)\s+\| Additive \(server is permissive\)\s+\|/,
    );
  });
});
