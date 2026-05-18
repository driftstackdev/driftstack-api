// V-531.B legacy session-livekit-token route — bounded-cardinality
// contract on the `driftstack_livekit_token_mint_total{role,outcome}`
// counter, mirroring the LK.3 parity test at
// lk3-livekit-token-outcome-bounded-set-parity.test.ts (slice 73).
//
// Both routes share the same Prometheus counter. The LK.3 path
// emits 5 outcomes (not_found / forbidden / no_mac / secret_unreadable
// / ok). This legacy /v1/sessions/:id/livekit-token route emits a
// different (smaller) set:
//
//   not_found    — session id shape rejected OR not owned by caller
//   validation   — body Zod-parse failed
//   ok           — happy path; JWT minted + returned
//
// Role labels are also distinct: this route accepts 'publisher' OR
// 'subscriber' from the request body (the role label is the body's
// own value), plus 'unknown' for pre-body-parse early rejections.
//
// Same drift-guard pattern as slice 73: every `bump()` call must use
// a label from the bounded sets — drift to a new label without a
// fixture trips this guard before silently inflating Prometheus
// cardinality.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts');

const ALLOWED_OUTCOMES = ['not_found', 'validation', 'ok'] as const;
const ALLOWED_ROLES = ['publisher', 'subscriber', 'unknown'] as const;

describe('V-531.B legacy session-livekit-token outcome + role bounded-set parity', () => {
  it('route file exists at the canonical path', () => {
    const body = readFileSync(ROUTE, 'utf8');
    expect(body.length).toBeGreaterThan(0);
  });

  it('every `bump(role, outcome)` call uses an outcome from the 3-element allowed set', () => {
    const body = readFileSync(ROUTE, 'utf8');
    // Match `bump('role', 'outcome')` OR `bump(parsed.data.role, 'outcome')`.
    const outcomeMatches = [...body.matchAll(/\bbump\([^,]+,\s*'([a-z_]+)'\)/g)];
    expect(outcomeMatches.length, 'expected at least one bump() call').toBeGreaterThan(0);
    const observed = new Set(outcomeMatches.map((m) => m[1]!));
    for (const label of observed) {
      expect(
        ALLOWED_OUTCOMES.includes(label as (typeof ALLOWED_OUTCOMES)[number]),
        `bump(_, '${label}') not in allowed outcome set [${ALLOWED_OUTCOMES.join(', ')}] — drift would explode Prometheus cardinality`,
      ).toBe(true);
    }
  });

  it("every literal-string role label in `bump('role', 'outcome')` uses a role from the 3-element allowed set", () => {
    const body = readFileSync(ROUTE, 'utf8');
    // Only matches `bump('role-string', ...)` — the dynamic
    // `parsed.data.role` calls are bounded by the route's Zod
    // schema `z.enum(['publisher', 'subscriber'])` separately.
    const roleMatches = [...body.matchAll(/\bbump\('([a-z_]+)'\s*,/g)];
    const observed = new Set(roleMatches.map((m) => m[1]!));
    for (const label of observed) {
      expect(
        ALLOWED_ROLES.includes(label as (typeof ALLOWED_ROLES)[number]),
        `bump('${label}', _) not in allowed role set [${ALLOWED_ROLES.join(', ')}] — drift would explode Prometheus cardinality`,
      ).toBe(true);
    }
  });

  it('all 3 documented outcomes are wired (not_found + validation + ok)', () => {
    const body = readFileSync(ROUTE, 'utf8');
    for (const label of ALLOWED_OUTCOMES) {
      expect(
        body,
        `bump(_, '${label}') wiring missing — orphans the documented outcome path`,
      ).toMatch(new RegExp(`bump\\([^,]+,\\s*'${label}'\\)`));
    }
  });

  it("Zod request-body schema enforces role enum is exactly ['publisher', 'subscriber']", () => {
    // Defense-in-depth: the role label that reaches the counter
    // comes from `parsed.data.role`. If the Zod schema ever opened
    // up the enum (e.g. accepting an arbitrary string), unbounded
    // role values would leak into the counter labels.
    const body = readFileSync(ROUTE, 'utf8');
    expect(body).toMatch(/role:\s*z\.enum\(\['publisher', 'subscriber'\]\)/);
  });
});
