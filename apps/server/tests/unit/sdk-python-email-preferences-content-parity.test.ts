// Drift guard for packages/sdk-python/src/driftstack/resources/
// email_preferences.py. Pins the V-204 / V-449 framing + sync/async
// mirror + 4-method surface (list, set, opt_out, opt_in) + the
// 204-No-Content semantics on set.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(
  REPO_ROOT,
  'packages/sdk-python/src/driftstack/resources/email_preferences.py',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sdk-python resources/email_preferences content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('Module-level docstring framing pinned: V-204 / V-449 anchor + critical-emails-NOT-opt-outable framing. Drift to dropping the V-anchors would orphan the engineering history; drift to weakening the critical-email exclusion would mislead customers about which emails can be opted out of', () => {
    expect(body).toMatch(
      /Email preferences resource — \/v1\/account\/email-preferences \(V-204 \/ V-449\)/,
    );
    // S44 2026-07-07 (founder-approved trim) — the critical roster is
    // 3 (the never-wired subscription-cancellation + support-ack
    // templates were deleted outright).
    expect(body).toMatch(/Critical emails \(verification \/ password-reset \/ billing-failure\)/);
    expect(body).toMatch(/aren't in the OptOutableEmailEvent enum on purpose\./);
    expect(body).not.toMatch(/subscription-cancellation|support-ack/);
  });

  it('Sync resource class pinned: EmailPreferencesResource with 4-method surface (list / set / opt_out / opt_in). Drift to dropping the convenience methods (opt_out / opt_in) would make customers write more boilerplate; drift to renaming would break SDK consumers', () => {
    expect(body).toMatch(/class EmailPreferencesResource:/);
    expect(body).toMatch(/def list\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/def set\(self, body: dict\[str, Any\]\) -> None:/);
    expect(body).toMatch(/def opt_out\(self, event_type: str\) -> None:/);
    expect(body).toMatch(/def opt_in\(self, event_type: str\) -> None:/);
  });

  it('Async resource class pinned: AsyncEmailPreferencesResource mirrors the sync surface. Drift to async dropping a method would break FastAPI/asyncio consumers; drift to a different signature would break the cross-class call-shape parity contract', () => {
    expect(body).toMatch(/class AsyncEmailPreferencesResource:/);
    expect(body).toMatch(/async def list\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/async def set\(self, body: dict\[str, Any\]\) -> None:/);
    expect(body).toMatch(/async def opt_out\(self, event_type: str\) -> None:/);
    expect(body).toMatch(/async def opt_in\(self, event_type: str\) -> None:/);
  });

  it('204-No-Content semantic on set() pinned (drift to expecting a response body would break the SDK on the 204 response that the server actually returns): "the server replies 204 No Content with an empty body"', () => {
    expect(body).toMatch(/the server replies ``204 No Content``/);
    expect(body).toMatch(/with an empty body/);
  });

  it('set() body shape pinned: { event_type, opted_in } — drift to a different shape would break the SDK wire-shape contract with the route validator', () => {
    expect(body).toMatch(/``body``: ``\{"event_type": "\.\.\.", "opted_in": True\|False\}``/);
  });

  it('Endpoint paths pinned: /v1/account/email-preferences (both GET + PUT). Drift to a different path would break the SDK against the server route', () => {
    const getMatches = (body.match(/"GET", "\/v1\/account\/email-preferences"/g) ?? []).length;
    const putMatches = (body.match(/"PUT", "\/v1\/account\/email-preferences"/g) ?? []).length;
    // 1 sync GET + 1 async GET = 2 ; 1 sync PUT + 1 async PUT = 2.
    expect(getMatches).toBeGreaterThanOrEqual(2);
    expect(putMatches).toBeGreaterThanOrEqual(2);
  });
});
