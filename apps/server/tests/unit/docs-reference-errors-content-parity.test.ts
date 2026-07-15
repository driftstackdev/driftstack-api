// Drift guard for apps/docs/src/pages/reference/errors.md. Pins
// the RFC 9457 problem-type framing + the 26-row mapping table +
// the 3 retryable classes (rate-limited / internal / transport).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/errors.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs reference/errors content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: Error reference/);
    expect(body).toMatch(/description: Every Driftstack RFC 9457 problem-type/);
  });

  it('RFC 9457 Problem Details framing pinned: the load-bearing contract anchor (every error follows RFC 9457). Drift to dropping the standards reference would orphan customers from understanding the response shape', () => {
    expect(body).toMatch(
      /\[RFC 9457 Problem Details\]\(https:\/\/www\.rfc-editor\.org\/rfc\/rfc9457\)/,
    );
    expect(body).toMatch(/The `type` URI uniquely identifies the error class/);
  });

  it('8-row sampling of the 26-row mapping table covers each HTTP class (400 / 401 / 403 / 404 / 409 / 429 / 502 / 503) — drift to dropping a row breaks SDK consumers whose error handling branches on that class', () => {
    // Sample each HTTP class with one representative row.
    expect(body).toMatch(/`errors\.driftstack\.dev\/bad-request`\s+\|\s+400/);
    expect(body).toMatch(/`errors\.driftstack\.dev\/unauthorized`\s+\|\s+401/);
    expect(body).toMatch(/`errors\.driftstack\.dev\/forbidden`\s+\|\s+403/);
    expect(body).toMatch(/`errors\.driftstack\.dev\/not-found`\s+\|\s+404/);
    expect(body).toMatch(/`errors\.driftstack\.dev\/conflict`\s+\|\s+409/);
    expect(body).toMatch(/`errors\.driftstack\.dev\/rate-limited`\s+\|\s+429/);
    expect(body).toMatch(/`errors\.driftstack\.dev\/driver-error`\s+\|\s+502/);
    expect(body).toMatch(/`errors\.driftstack\.dev\/feature-unavailable`\s+\|\s+503/);
  });

  it('3 retryable classes pinned with **yes** marker: rate-limited / internal / transport (network failure). Drift would silently let SDK consumers retry non-retryable classes or miss legitimate retry opportunities', () => {
    expect(body).toMatch(/`errors\.driftstack\.dev\/rate-limited`[\s\S]{0,300}\*\*yes\*\*/);
    expect(body).toMatch(/`errors\.driftstack\.dev\/internal`[\s\S]{0,300}\*\*yes\*\*/);
    expect(body).toMatch(/`TransportError`[\s\S]{0,300}\*\*yes\*\*/);
  });

  it('cross-SDK isRetryable predicate naming pinned: isRetryable (TS) / is_retryable (Python) / IsRetryable (Go) — drift to renaming any would break the 3-language parity contract pinned by slices 126-128 BYOK test work', () => {
    expect(body).toMatch(/`isRetryable\(err\)` \/ `is_retryable` \/\s+`IsRetryable`/);
  });

  it('ships copy-ready retry loops that use the server default archetype and define the Go request', () => {
    expect(body).toContain('return await client.sessions.create();');
    expect(body).toContain('return client.sessions.create()');
    expect(body).toContain('request := &driftstack.CreateSessionRequest{}');
    expect(body).toContain('client.Sessions.Create(ctx, request)');
    expect(body).not.toMatch(/archetype:\s*['"]…['"]|archetype=['"]…['"]|\bopts\b|V-NNN/);
    expect(body).toMatch(
      /Any new problem-type must update `PROBLEM_TYPES`, all three SDK error\s+tables, this reference, and the integration test covering its server-side\s+route in the same change\./,
    );
  });

  it("BYOK + Feature-unavailable rows pinned: byok-anthropic-required (502) + feature-unavailable (503). These are the activation-gate signals consumed by 7 features (slice 131 framing); drift to dropping would orphan SDK consumers from handling the 'feature not wired' case", () => {
    expect(body).toMatch(/`errors\.driftstack\.dev\/byok-anthropic-required`\s+\|\s+502/);
    expect(body).toMatch(/`errors\.driftstack\.dev\/feature-unavailable`\s+\|\s+503/);
  });
});
