import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FREE_DESKTOP_ROUTE_DENIED_DETAIL } from '@driftstack/api-types';
import { ForbiddenError } from '../../src/lib/errors.js';
import { DEVICE_KEY_DENY_ROUTES } from '../../src/middleware/device-key-deny.js';
import {
  FREE_DESKTOP_ALLOWED_ROUTES,
  requireFreeDesktopRouteAccess,
} from '../../src/middleware/free-desktop-route-policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');

const EXPECTED_GUI_ROUTES = [
  'GET:/v1/account/me',
  'GET:/v1/account/me/notifications',
  'GET:/v1/account/audit-log',
  'GET:/v1/account/cost',
  'GET:/v1/account/me/organization',
  'PUT:/v1/account/me/organization',
  'POST:/v1/account/me/proxies',
  'PUT:/v1/account/me/proxies/:id',
  'DELETE:/v1/account/me/proxies/:id',
  'GET:/v1/account/me/bundled-llm-settings',
  'PATCH:/v1/account/me/bundled-llm-settings',
  'GET:/v1/account/me/bundled-llm-status',
  'GET:/v1/account/me/byok-anthropic-key',
  'GET:/v1/profiles',
  'POST:/v1/profiles',
  'PATCH:/v1/profiles/:id',
  'DELETE:/v1/profiles/:id',
  'GET:/v1/profiles/trash',
  'POST:/v1/profiles/:id/restore',
  'DELETE:/v1/profiles/:id/purge',
  'POST:/v1/profiles/:id/trim',
  'GET:/v1/profiles/:id/activity',
  'GET:/v1/profiles/:id/export',
  'POST:/v1/profiles/:id/clone',
  'POST:/v1/profiles/import',
  'GET:/v1/sessions',
  'POST:/v1/sessions',
  'DELETE:/v1/sessions/:id',
  'GET:/v1/agent-sessions',
  'POST:/v1/agent-sessions',
  'GET:/v1/agent-sessions/:id',
  'DELETE:/v1/agent-sessions/:id',
  'POST:/v1/agent-sessions/:id/message',
  'POST:/v1/agent-sessions/:id/livekit-token',
  'GET:/v1/agent-sessions/:id/gui-control-key',
  'POST:/v1/agent-sessions/:id/transport-report',
  'GET:/v1/agent-sessions/:id/page-state',
  'GET:/v1/agent-sessions/:id/cookies',
  'POST:/v1/agent-sessions/:id/cookies/set',
  'POST:/v1/agent-sessions/:id/egress',
  'POST:/v1/agent-sessions/:id/history',
  'POST:/v1/agent-sessions/:id/files',
  'GET:/v1/agent-sessions/:id/downloads',
  'GET:/v1/agent-sessions/:id/downloads/content',
  'POST:/v1/agent-sessions/:id/mode',
  'POST:/v1/agent-sessions/:id/takeover',
  'POST:/v1/agent-sessions/:id/input-event',
  'POST:/v1/agent-sessions/:id/handback',
  'GET:/v1/recipes',
  'GET:/v1/recipes/:id',
  'POST:/v1/recipes',
  'GET:/v1/team/members',
  'GET:/v1/team/invites',
  'POST:/v1/billing/crypto-checkout/quote',
  'POST:/v1/billing/crypto-checkout',
  'GET:/v1/billing/crypto-orders',
  'GET:/v1/billing/crypto-orders/:order_id',
  'POST:/v1/billing/crypto-orders/:order_id/cancel',
  'GET:/v1/billing/crypto-orders/:order_id/receipt',
  'GET:/v1/billing/crypto-orders/:order_id/receipt.pdf',
  'GET:/v1/billing/crypto-orders/:order_id/receipt.txt',
] as const;

function registeredRouteCalls(): ReadonlySet<string> {
  const found = new Set<string>();
  const shorthand = /app\.(get|post|put|patch|delete)(?:<[\s\S]*?>)?\(\s*['"]([^'"]+)['"]/g;
  for (const filename of readdirSync(ROUTES_DIR).filter((name) => name.endsWith('.ts'))) {
    const body = readFileSync(resolve(ROUTES_DIR, filename), 'utf8');
    let match: RegExpExecArray | null;
    while ((match = shorthand.exec(body)) !== null) {
      found.add(`${match[1]!.toUpperCase()}:${match[2]!}`);
    }
  }
  return found;
}

describe('Free desktop route policy', () => {
  // ⚠️ The title said 59 while the assertion said 60 — the number in the title had
  // drifted, which is how a count pin stops being readable. Both say 61 now: +1 for
  // P-17's `POST /v1/agent-sessions/:id/egress`.
  it('pins exactly the 61 current non-denied GUI route templates', () => {
    expect(FREE_DESKTOP_ALLOWED_ROUTES.size).toBe(61);
    expect([...FREE_DESKTOP_ALLOWED_ROUTES].sort()).toEqual([...EXPECTED_GUI_ROUTES].sort());
  });

  it('keeps the allowlist disjoint from the independent device-key deny-set', () => {
    for (const route of FREE_DESKTOP_ALLOWED_ROUTES) {
      expect(DEVICE_KEY_DENY_ROUTES.has(route), route).toBe(false);
    }
    for (const deniedGuiMutation of [
      'POST:/v1/team/invites',
      'DELETE:/v1/team/members/:id',
      'PUT:/v1/account/me/byok-anthropic-key',
      'DELETE:/v1/account/me/byok-anthropic-key',
      'POST:/v1/account/me/byok-anthropic-key/test',
    ]) {
      expect(DEVICE_KEY_DENY_ROUTES.has(deniedGuiMutation)).toBe(true);
      expect(FREE_DESKTOP_ALLOWED_ROUTES.has(deniedGuiMutation)).toBe(false);
    }
  });

  it('pins every allowlisted template to a concrete Fastify route registration', () => {
    const registered = registeredRouteCalls();
    for (const route of FREE_DESKTOP_ALLOWED_ROUTES) {
      expect(registered.has(route), `${route} must remain registered`).toBe(true);
    }
  });

  it('admits only an exact method + Fastify template match', () => {
    expect(() => requireFreeDesktopRouteAccess('GET', '/v1/sessions')).not.toThrow();
    expect(() => requireFreeDesktopRouteAccess('get', '/v1/sessions')).toThrow(ForbiddenError);
    expect(() => requireFreeDesktopRouteAccess('POST', '/v1/sessions')).not.toThrow();
    expect(() => requireFreeDesktopRouteAccess('GET', '/v1/sessions/:id')).toThrow(ForbiddenError);
    expect(() => requireFreeDesktopRouteAccess('GET', undefined)).toThrow(ForbiddenError);
  });

  it.each([
    ['GET', '/v1/api-keys'],
    ['GET', '/v1/webhooks'],
    ['GET', '/v1/account/web-sessions'],
    ['GET', '/v1/agent-sessions/:id/transcript'],
  ])('fails closed for the unlisted %s:%s surface', (method, route) => {
    expect(() => requireFreeDesktopRouteAccess(method, route)).toThrowError(
      /Free desktop credential cannot access this API route/,
    );
  });

  it('(k) K1 the refusal detail IS the shared api-types constant — the GUI discriminates this 403 by the sentence, so the two must be one value', () => {
    let thrown: unknown;
    try {
      requireFreeDesktopRouteAccess('GET', '/v1/api-keys');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ForbiddenError);
    expect((thrown as ForbiddenError).detail).toBe(FREE_DESKTOP_ROUTE_DENIED_DETAIL);
    // The constant is a real sentence, not an empty export that toBe would
    // trivially agree with.
    expect(FREE_DESKTOP_ROUTE_DENIED_DETAIL).toMatch(
      /^This Free desktop credential cannot access this API route\. /,
    );
  });

  it('(k) K1 the sentence is declared ONCE, in api-types — the server module restates no copy a GUI pin could drift from', () => {
    const policySource = readFileSync(
      resolve(HERE, '..', '..', 'src', 'middleware', 'free-desktop-route-policy.ts'),
      'utf8',
    );
    expect(policySource).not.toMatch(/cannot access this API route/);
    expect(policySource).toMatch(/FREE_DESKTOP_ROUTE_DENIED_DETAIL/);
    // POSITIVE CONTROL for the absence above: the same reader finds the
    // sentence where it IS declared.
    const contractSource = readFileSync(
      resolve(HERE, '..', '..', '..', '..', 'packages', 'api-types', 'src', 'problem.ts'),
      'utf8',
    );
    expect(contractSource).toMatch(
      /export const FREE_DESKTOP_ROUTE_DENIED_DETAIL =\s*'This Free desktop credential cannot access this API route\./,
    );
  });

  it('retains the established denial for independently forbidden device operations', () => {
    expect(() => requireFreeDesktopRouteAccess('POST', '/v1/team/invites')).toThrowError(
      /not permitted with a device-provisioned key/,
    );
  });
});
