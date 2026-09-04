// W772 — apps/docs api/versioning.md content parity. Ninety-eighth
// in the cross-SDK drift-guard series.
//
// /api/versioning is the canonical reference for additive vs breaking
// changes + the deprecation cycle. Drift to the policy framing would
// let SDK consumers misjudge when their code might break + when
// Driftstack will ship /v2/*.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/versioning.md');

describe('W772 docs /api/versioning content parity', () => {
  it('api/versioning.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned. Description threads additive vs breaking + deprecation cycle + when /v2/* is justified.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: API versioning policy\n/,
    );
    expect(p).toMatch(
      /description: Driftstack API versioning policy — additive vs breaking changes, deprecation cycle, when \/v2\/\* is justified\./,
    );
  });

  it("CRITICAL distinct-from-SDK-versioning framing pinned. The 'Versioning policy for the HTTP API surface (/v1/*, eventually /v2/*). Distinct from the SDK versioning policy at docs.driftstack.io/sdk/versioning: SDKs version independently of the API; this doc covers the API endpoint contract' wording is the load-bearing scope-discrimination.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Versioning policy for the HTTP API surface \(`\/v1\/\*` and any later\s*\n?major prefix\)\. Distinct from the SDK versioning policy at/,
    );
    expect(p).toMatch(
      /SDKs version\s*\n?independently of the API; this doc covers the API endpoint contract\./,
    );
  });

  it('CRITICAL TL;DR 4-bullet set pinned — single-major + additive-free + breaking→deprecation-cycle + OpenAPI canonical source.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/- One major version active at a time\. `\/v1\/\*` today\./);
    expect(p).toMatch(
      /- Additive changes are free — new endpoints, new optional request\s*\n?\s+fields, new response fields, new enum values\. Customers don't\s*\n?\s+break\./,
    );
    expect(p).toMatch(
      /- Breaking changes go through a deprecation cycle, then a new\s*\n?\s+major version\. `\/v2\/\*` only when justified; not on a calendar\./,
    );
    expect(p).toMatch(
      /- The OpenAPI spec at `\/openapi\.json` is the contract\. Generated\s*\n?\s+from Zod schemas in `packages\/api-types\/`; there is no second\s*\n?\s+source of truth\./,
    );
  });

  it('CRITICAL additive vs breaking 14-row table pinned. Drift to dropping any row would lose load-bearing classification guidance.', () => {
    const p = read(PAGE);

    for (const row of [
      'New endpoint',
      'New optional request field with sensible default',
      'New response field',
      'New enum value \\(sent BY server, e\\.g\\. webhook event types\\)',
      'New enum value \\(accepted FROM client, e\\.g\\. tier IDs\\)',
      'Renaming an existing field',
      'Removing an existing field',
      "Changing a field's type \\(e\\.g\\. number → string\\)",
      'Tightening a validation constraint',
      'Loosening a validation constraint',
      'Changing default behaviour of an existing endpoint',
      'Changing HTTP status code returned',
      'Changing error type URI in problem-detail',
      'Adding a new error type URI',
      'Changing rate-limit caps',
    ]) {
      expect(p, `row ${row}`).toMatch(new RegExp(`\\| ${row}`));
    }
  });

  it("CRITICAL closed-enum-server-sends-new-value-IS-breaking framing pinned. The 'when the **server** sends a closed enum value the **client** doesn\\'t know about (e.g. a new webhook_event_type), strictly-typed clients break' wording is the load-bearing enum-change framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /when the \*\*server\*\*\s*\n?sends a closed enum value the \*\*client\*\* doesn't know about \(e\.g\.\s*\n?a new `webhook_event_type`\), strictly-typed clients break\./,
    );
  });

  it('CRITICAL 5-step deprecation cycle pinned. (1) Deprecation/Sunset headers per RFC 8594, (2) OpenAPI deprecated:true, (3) email customers from audit log, (4) min 90 days, (5) remove in next major or sunset-in-place.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/1\. \*\*Announce the deprecation\*\* in a `Deprecation` HTTP response/);
    expect(p).toMatch(/`Sunset` header\s*\n?\s+pointing at the declared removal date \(RFC 8594\)/);
    expect(p).toMatch(/2\. \*\*Document the migration path\*\* in the OpenAPI spec via/);
    expect(p).toMatch(/`deprecated: true`/);
    expect(p).toMatch(/3\. \*\*Email customers\*\* using the deprecated surface\./);
    expect(p).toMatch(/4\. \*\*Minimum 90 days\*\* between announcement and removal/);
    expect(p).toMatch(/5\. \*\*Remove the surface\*\* in the next major version OR — if the/);
  });

  it("CRITICAL 3-condition '/v2/* ships when' framing pinned — breaking can't be avoided / multiple-breaking-batch / new-architectural-shape. The numbered conditions are the canonical gating for a major-version cut.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/A breaking change can't be avoided/);
    expect(p).toMatch(/Multiple breaking changes batch sensibly/);
    expect(p).toMatch(/An entirely new architectural shape requires a distinct contract/);
  });

  it("CRITICAL '/v2/* does NOT ship when' framing pinned — pre-1.0-restlessness + single-field-rename. The 2-counter set explains common false-justifications.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Pre-1\.0-style restlessness wants to "clean things up\."/);
    expect(p).toMatch(/A single field rename is desired/);
  });

  it("CRITICAL '/v1 + /v2 simultaneously' 12-month sunset window framing pinned. Drift to a different window would mismatch customer-comms expectations.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`\/v1\/\*` continues to work for the announced sunset window\s*\n?\s+\(typically 12\+ months\)/,
    );
    expect(p).toMatch(/Both versions share the same auth \+ rate-limit infrastructure\./);
    expect(p).toMatch(/no header-based\s*\n?\s+versioning today\./);
  });

  it('CRITICAL per-resource versioning notes pinned. Drift to dropping any resource section would lose canonical risk-area guidance.', () => {
    const p = read(PAGE);

    for (const res of [
      '/v1/sessions',
      '/v1/api-keys',
      '/v1/webhooks',
      '/v1/billing',
      '/v1/admin',
      '/v1/account',
    ]) {
      expect(p, `resource section ${res}`).toMatch(
        new RegExp(`\\*\\*\`${res.replace(/\//g, '\\/')}\\/\\*\`\\*\\*`),
      );
    }
  });

  it("CRITICAL WebhookEventType closed-enum mitigation framing pinned. The 'subscribe with explicit events: [...] arrays so the server only ever sends event types the customer already opted into. New event types are then additive at the wire level; subscription is opt-in' wording is the load-bearing escape-hatch.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`WebhookEventType` enum is closed\. Adding\s*\n?\s+a new event type IS technically breaking for strictly-typed/,
    );
    expect(p).toMatch(
      /Customers are\s*\n?\s+encouraged to subscribe with explicit `events: \[\.\.\.\]` arrays so the\s*\n?\s+server only ever sends event types the customer already opted into\./,
    );
    expect(p).toMatch(
      /New event types are then additive at the wire level; subscription is\s*\n?\s+opt-in\./,
    );
  });

  it('CRITICAL customer-guidance 4-bullet set pinned — pin to major + subscribe-explicitly + watch-Deprecation/Sunset + read-SDK-CHANGELOG. Drift to dropping any would lose load-bearing customer-action framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Pin to a specific major in their integration\./);
    expect(p).toMatch(/Subscribe explicitly to webhook events they handle; ignore \+/);
    expect(p).toMatch(/Watch the `Deprecation` \+ `Sunset` response headers/);
    expect(p).toMatch(/Read the CHANGELOG for the SDK they use/);
  });

  it("CRITICAL 'What we don't do' 3-bullet rejection list pinned — header-based + date-based-per-account + continuous-breaking-changes. The rejection framing is the canonical pricing-the-tradeoffs.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Header-based versioning\*\* \(`API-Version: 2024-05-01`\) —/);
    expect(p).toMatch(/considered but rejected\./);
    expect(p).toMatch(/\*\*Date-based versioning per-account\*\* \(Stripe's "API version/);
    expect(p).toMatch(/pinning"\)/);
    expect(p).toMatch(/\*\*Continuous breaking changes\*\* —/);
  });

  it("CRITICAL pre-launch-but-post-1.0 framing pinned. The 'The HTTP API itself is post-1.0 from the customer\\'s perspective even though Driftstack is pre-launch — customers pinning to /v1/* should see additive-only changes' wording is the load-bearing pre-launch-vs-stability customer-promise.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /pre-1\.0 SDKs ship them\s*\n?\s+under their published SemVer policy\. Customers pinned to the\s*\n?\s+HTTP `\/v1\/\*` contract receive additive-only changes\./,
    );
    expect(p).not.toMatch(/pre-launch|post-launch/);
  });

  it("CRITICAL URL-prefix vs header-versioning decision framing pinned. The 'URL-prefix is more discoverable, easier to debug in logs, and matches industry convention (Stripe-style /v1/)' wording is the canonical justification.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /URL-prefix is more discoverable, easier\s*\n?\s+to debug in logs, and matches industry convention \(Stripe-style\s*\n?\s+`\/v1\/`\)\./,
    );
  });

  it('CRITICAL Related-section cross-references pinned — webhook events + rate-limits + error-handling + OpenAPI live URL. The 4-link footer is the load-bearing cross-page nav.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Webhook event catalog: \[`docs\.driftstack\.io\/webhooks\/events`\]\(\/webhooks\/events\/\)/,
    );
    expect(p).toMatch(
      /Rate-limit policy: \[`docs\.driftstack\.io\/reference\/rate-limits`\]\(\/reference\/rate-limits\/\)/,
    );
    expect(p).toMatch(
      /Error handling: \[`docs\.driftstack\.io\/sdk\/error-handling`\]\(\/sdk\/error-handling\/\)/,
    );
    expect(p).not.toMatch(
      /\]\(\/(?:webhooks\/events|reference\/rate-limits|sdk\/error-handling)\)/,
    );
    expect(p).toMatch(/`api\.driftstack\.dev\/openapi\.json`/);
    expect(p).toMatch(/Scalar UI at `api\.driftstack\.dev\/docs`/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-api-versioning-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
