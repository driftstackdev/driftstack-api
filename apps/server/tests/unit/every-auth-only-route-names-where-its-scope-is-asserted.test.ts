// Every route registered with `requireAuth` but NO scope in its preHandler
// names where its scope IS asserted — and that place is re-read every run.
//
// "Gated" is not a property of the route registration. In this codebase scope
// enforcement often lives in the SERVICE method (`throwIfMissingScope(ctx,
// 'read:audit')` at services/account-audit.ts, not in routes/account-audit.ts),
// so an audit that reads preHandler lists reports the most sensitive account
// endpoints as the least gated. That near-miss happened (V-1792). This guard
// makes the audit's answer sit in one map: for each auth-only route, the file
// and method that assert, or the handler token that refuses a credential kind,
// or the reason no scope is required. Measured 2026-08-28: 219 registrations,
// 22 auth-only, every one accounted for (V-2139).
//
// Checked both ways. A route that gains a preHandler scope, or is retired, makes
// its entry stale (red — delete the entry). An asserting method that loses its
// assertion, or moves, goes red at the entry that names it. A NEW auth-only
// route not in the map goes red with the consequence spelled out.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');
const ROUTES = resolve(SRC, 'routes');

type Where =
  | { enforcedIn: string; method: string; asserts: string }
  | { handlerRefuses: string }
  | { anyAuthenticatedByDesign: string };

/** `METHOD /v1/path` with every `:param` as `{}`. */
const ENFORCED_AT: ReadonlyMap<string, Where> = new Map<string, Where>([
  // Service-layer assertions.
  [
    'GET /v1/account/audit-log',
    {
      enforcedIn: 'services/account-audit.ts',
      method: 'list',
      asserts: "throwIfMissingScope(ctx, 'read:audit')",
    },
  ],
  [
    'GET /v1/account/audit-log/export',
    {
      enforcedIn: 'services/account-audit.ts',
      method: 'list',
      asserts: "throwIfMissingScope(ctx, 'read:audit')",
    },
  ],
  [
    'POST /v1/api-keys',
    {
      enforcedIn: 'services/api-keys.ts',
      method: 'create',
      asserts: "throwIfMissingScope(ctx, 'account_owner')",
    },
  ],
  [
    'GET /v1/api-keys',
    {
      enforcedIn: 'services/api-keys.ts',
      method: 'list',
      asserts: "throwIfMissingScope(ctx, 'read:api-keys')",
    },
  ],
  [
    'DELETE /v1/api-keys/{}',
    {
      enforcedIn: 'services/api-keys.ts',
      method: 'revoke',
      asserts: "throwIfMissingScope(ctx, 'account_owner')",
    },
  ],
  [
    'POST /v1/api-keys/{}/rotate',
    {
      enforcedIn: 'services/api-keys.ts',
      method: 'rotate',
      asserts: "throwIfMissingScope(ctx, 'account_owner')",
    },
  ],
  [
    'GET /v1/account/email-preferences',
    {
      enforcedIn: 'services/email-preferences.ts',
      method: 'list',
      asserts: "throwIfMissingScope(ctx, 'account_owner')",
    },
  ],
  [
    'PUT /v1/account/email-preferences',
    {
      enforcedIn: 'services/email-preferences.ts',
      method: 'set',
      asserts: "throwIfMissingScope(ctx, 'account_owner')",
    },
  ],
  [
    'POST /v1/webhooks',
    {
      enforcedIn: 'services/webhooks.ts',
      method: 'create',
      asserts: "throwIfMissingScope(ctx, 'account_owner')",
    },
  ],
  [
    'GET /v1/webhooks',
    {
      enforcedIn: 'services/webhooks.ts',
      method: 'listWithCounts',
      asserts: "throwIfMissingScope(ctx, 'read:webhooks')",
    },
  ],
  // getWithCounts delegates to get(), which asserts.
  [
    'GET /v1/webhooks/{}',
    {
      enforcedIn: 'services/webhooks.ts',
      method: 'get',
      asserts: "throwIfMissingScope(ctx, 'read:webhooks')",
    },
  ],
  [
    'DELETE /v1/webhooks/{}',
    {
      enforcedIn: 'services/webhooks.ts',
      method: 'delete',
      asserts: "throwIfMissingScope(ctx, 'account_owner')",
    },
  ],
  [
    'PATCH /v1/webhooks/{}',
    {
      enforcedIn: 'services/webhooks.ts',
      method: 'update',
      asserts: "throwIfMissingScope(ctx, 'account_owner')",
    },
  ],
  [
    'GET /v1/webhooks/{}/deliveries',
    {
      enforcedIn: 'services/webhooks.ts',
      method: 'listDeliveries',
      asserts: "throwIfMissingScope(ctx, 'read:webhooks')",
    },
  ],
  [
    'POST /v1/webhook-deliveries/{}/replay',
    {
      enforcedIn: 'services/webhooks.ts',
      method: 'replayDeliveryAsCustomer',
      asserts: "throwIfMissingScope(ctx, 'account_owner')",
    },
  ],
  [
    'POST /v1/webhooks/{}/rotate-secret',
    {
      enforcedIn: 'services/webhooks.ts',
      method: 'rotateSecret',
      asserts: "throwIfMissingScope(ctx, 'account_owner')",
    },
  ],
  [
    'POST /v1/webhooks/{}/test',
    {
      enforcedIn: 'services/webhooks.ts',
      method: 'sendTestEvent',
      asserts: "throwIfMissingScope(ctx, 'account_owner')",
    },
  ],
  // Handler-level refusals of a credential KIND — interactive flows.
  ['POST /v1/auth/cli-authorize/bind-device-code', { handlerRefuses: 'ctx.webSession === null' }],
  ['POST /v1/auth/mfa/step-up', { handlerRefuses: 'ctx.webSession === null' }],
  ['POST /v1/oauth/authorize/complete', { handlerRefuses: 'ctx.webSession === null' }],
  // No scope by design.
  [
    'GET /v1/legal/documents',
    {
      anyAuthenticatedByDesign:
        'public document catalogue metadata; the text is served by the marketing site',
    },
  ],
  [
    'GET /v1/legal/required',
    {
      anyAuthenticatedByDesign:
        "the calling account's own acceptance status, needed before any scoped action",
    },
  ],
]);

const normalize = (p: string): string => p.replace(/:[A-Za-z_]+/g, '{}');
const REGISTRATION =
  /\bapp\.(get|post|put|patch|delete)(?:<(?:[^()<>]|<[^()<>]*>)*>)?\(\s*'(\/v1\/[^']+)'\s*,\s*\{([\s\S]{0,400}?)\}\s*,/g;
const PRE_SCOPE = /requireScope|driftstack_internal_admin|account_owner/;

interface Site {
  key: string;
  file: string;
  line: number;
  /** The registration plus the handler that follows it. */
  handler: string;
}

function authOnlyRoutes(): { sites: Site[]; registrations: number } {
  const sites: Site[] = [];
  let registrations = 0;
  for (const entry of readdirSync(ROUTES)) {
    if (!entry.endsWith('.ts')) continue;
    const file = resolve(ROUTES, entry);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(REGISTRATION)) {
      if (m.index === undefined) continue;
      registrations += 1;
      const opts = m[3] ?? '';
      if (!/requireAuth/.test(opts) || PRE_SCOPE.test(opts)) continue;
      sites.push({
        key: `${(m[1] ?? '').toUpperCase()} ${normalize(m[2] ?? '')}`,
        file: entry,
        line: src.slice(0, m.index).split('\n').length,
        handler: src.slice(m.index, m.index + 4000),
      });
    }
  }
  return { sites, registrations };
}

/**
 * Every body of `<method>(` at class-member indent, up to the next member at the
 * same indent. Every occurrence, because the services declare an INTERFACE with
 * the same member names as the class that implements it — the first hit is a
 * signature with no body, and stopping there reported five live assertions as
 * vanished on the guard's first run.
 */
function methodBodies(src: string, method: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\n  (?:async |)${method}\\(`, 'g');
  for (const m of src.matchAll(re)) {
    if (m.index === undefined) continue;
    const rest = src.slice(m.index + 1);
    const end = rest.search(
      /\n {2}(?:async |private |protected |public |static |readonly |get |set |#)?[a-zA-Z_#][a-zA-Z0-9_]*\s*[(<:=]/,
    );
    out.push(end === -1 ? rest : rest.slice(0, end));
  }
  return out;
}

describe('every auth-only route names where its scope is asserted', () => {
  const { sites, registrations } = authOnlyRoutes();

  it('CRITICAL the census is not vacuous', () => {
    // Measured 2026-08-28: 219 registrations, 22 auth-only.
    expect(registrations).toBeGreaterThan(200);
    expect(sites.length).toBeGreaterThan(15);
  });

  it('CRITICAL every route with requireAuth and no preHandler scope has an entry naming where its scope is asserted', () => {
    const missing = sites
      .filter((s) => !ENFORCED_AT.has(s.key))
      .map((s) => `${s.key}  (${s.file}:${s.line.toString()})`);
    expect(
      missing,
      `auth-only routes with no entry in ENFORCED_AT:\n  ${missing.join('\n  ')}\n` +
        `A route that requires auth but no scope is callable by EVERY key of the account, including a read-only one, ` +
        `unless something below the route asserts. Name the service method + assertion, the handler refusal, or the reason none is needed.`,
    ).toEqual([]);
  });

  it('CRITICAL every entry still describes an auth-only registered route — a stale entry is deleted, not kept', () => {
    const live = new Set(sites.map((s) => s.key));
    const stale = [...ENFORCED_AT.keys()].filter((k) => !live.has(k));
    expect(stale, 'entries whose route is gone or now carries a preHandler scope').toEqual([]);
  });

  it('CRITICAL every named service method still contains its assertion, and every named handler refusal is still there', () => {
    const broken: string[] = [];
    for (const [key, where] of ENFORCED_AT) {
      if ('enforcedIn' in where) {
        const file = resolve(SRC, where.enforcedIn);
        if (!existsSync(file)) {
          broken.push(`${key}: ${where.enforcedIn} is missing`);
          continue;
        }
        const bodies = methodBodies(readFileSync(file, 'utf8'), where.method);
        if (bodies.length === 0)
          broken.push(`${key}: ${where.enforcedIn} has no method ${where.method}()`);
        else if (!bodies.some((b) => b.includes(where.asserts)))
          broken.push(
            `${key}: ${where.enforcedIn} ${where.method}() no longer contains ${where.asserts}`,
          );
      } else if ('handlerRefuses' in where) {
        const site = sites.find((s) => s.key === key);
        if (site && !site.handler.includes(where.handlerRefuses))
          broken.push(`${key}: handler in ${site.file} no longer contains ${where.handlerRefuses}`);
      }
    }
    expect(
      broken,
      `enforcement moved or vanished:\n  ${broken.join('\n  ')}\nThe route is still registered with requireAuth only, so it is now callable by any key of the account.`,
    ).toEqual([]);
  });

  it('the matchers read the registration shape, normalize params, and find a method body', () => {
    const m = REGISTRATION.exec(
      "app.get<{ Params: { id: string } }>(\n  '/v1/x/:id',\n  { preHandler: [app.requireAuth, app.rateLimit('global')] },\n  async () => {}",
    );
    REGISTRATION.lastIndex = 0;
    expect(m?.[2]).toBe('/v1/x/:id');
    expect(normalize('/v1/webhooks/:id/deliveries')).toBe('/v1/webhooks/{}/deliveries');
    const bodies = methodBodies(
      "interface S {\n  list(ctx: C): Promise<R>;\n}\nclass Impl {\n  async list(ctx) {\n    throwIfMissingScope(ctx, 'read:x');\n  }\n\n  async set(ctx) {\n    return 1;\n  }\n}",
      'list',
    );
    // The interface signature AND the implementation — the guard must not stop at the first.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("throwIfMissingScope(ctx, 'read:x')");
    expect(bodies[1]).not.toContain('return 1');
  });
});
