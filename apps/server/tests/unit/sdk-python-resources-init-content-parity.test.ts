// W587.B — drift guard for packages/sdk-python/src/driftstack/resources/__init__.py.
// Resource package __init__. Drift here either drops a resource
// re-export or shifts the documented Driftstack/AsyncDriftstack
// dual-client wiring posture.
//
//   • Re-exports 4 resource pairs at package level (ApiKeys +
//     Sessions + Usage + Webhooks) — the workhorse set.
//   • 8-entry __all__ for those 4 sync+async pairs.
//   • Customers don't import these directly per the docstring; they
//     reach them via client.* on the top-level Driftstack instance.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/__init__.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W587.B packages/sdk-python/src/driftstack/resources/__init__.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + sync/async dual-client framing + customer-routes-through-client.* pinned', () => {
    expect(body).toMatch(/^"""Resource accessors mounted on the top-level Driftstack clients\.\n/);
    expect(body).toMatch(/Each module exposes two classes — a sync resource and an async one —/);
    expect(body).toMatch(/that share the same method signatures but back onto :class:`HttpClient`/);
    expect(body).toMatch(/or :class:`AsyncHttpClient` respectively\./);
    expect(body).toMatch(/Customers don't import these directly; they reach them through the/);
    expect(body).toMatch(/client::/);
    expect(body).toMatch(/client = Driftstack\(api_key="…"\)/);
    expect(body).toMatch(/client\.sessions\.create\(\) {7}# sync/);
    expect(body).toMatch(/await async_client\.sessions\.create\(\) {3}# async \(separate client\)/);
  });

  it('Re-exports + __all__: 4 paired resources (ApiKeys + Sessions + Usage + Webhooks) — workhorse customer-facing set', () => {
    expect(body).toMatch(
      /^from driftstack\.resources\.api_keys import ApiKeysResource, AsyncApiKeysResource$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.sessions import AsyncSessionsResource, SessionsResource$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.usage import AsyncUsageResource, UsageResource$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.webhooks import AsyncWebhooksResource, WebhooksResource$/m,
    );
    expect(body).toMatch(
      /^__all__ = \[\s*\n\s*"ApiKeysResource",\s*\n\s*"AsyncApiKeysResource",\s*\n\s*"SessionsResource",\s*\n\s*"AsyncSessionsResource",\s*\n\s*"UsageResource",\s*\n\s*"AsyncUsageResource",\s*\n\s*"WebhooksResource",\s*\n\s*"AsyncWebhooksResource",\s*\n\]$/m,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
