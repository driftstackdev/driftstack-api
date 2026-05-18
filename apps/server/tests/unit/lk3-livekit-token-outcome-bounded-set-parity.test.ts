// LK.3 — bounded-cardinality contract for the
// `driftstack_livekit_token_mint_total{role,outcome}` counter as
// emitted by /v1/agent-sessions/{id}/livekit-token.
//
// The role label is always 'subscriber' on this route (LK.3 is
// gui-client-side, so the JWT is canSubscribe=true/canPublish=false).
// The outcome label is one of 6 values:
//
//   not_found        — session unknown OR cross-account access
//   forbidden        — caller owns the session but it's not active
//   no_mac           — no Mac in the fleet has registered LK creds
//   secret_unreadable — MFA_ENCRYPTION_KEY rotated without re-register
//   ok               — happy path, JWT minted
//   (no other values; any future drift must be intentional + recorded)
//
// Companion to the integration metric test at
// lk3-agent-sessions-livekit-token.test.ts which exercises each
// outcome via injected fixtures. This pure-source parity test
// reads the route .ts file and pins that ONLY the 5 documented
// outcome labels appear inside `bump('...')` calls — a textual
// drift-guard against an unintentional 6th label leaking in.
//
// Why both layers: the integration test fails when a new label
// breaks an existing fixture; this parity test fails when a NEW
// label is added without an accompanying fixture. Two-layer
// coverage prevents the silent-cardinality-creep failure mode.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions-livekit-token.ts');

const ALLOWED_OUTCOMES = ['not_found', 'forbidden', 'no_mac', 'secret_unreadable', 'ok'] as const;

describe('LK.3 livekit-token outcome bounded-set parity', () => {
  it('route file exists at the canonical path', () => {
    const body = readFileSync(ROUTE, 'utf8');
    expect(body.length).toBeGreaterThan(0);
  });

  it('every `bump(...)` call uses a label from the 5-element allowed set', () => {
    const body = readFileSync(ROUTE, 'utf8');
    // Match `bump('label')` — single-quoted label between bump( and ).
    const matches = [...body.matchAll(/\bbump\(\s*'([a-z_]+)'\s*\)/g)];
    expect(matches.length, 'expected at least one bump() call').toBeGreaterThan(0);
    const observed = new Set(matches.map((m) => m[1]!));
    for (const label of observed) {
      expect(
        ALLOWED_OUTCOMES.includes(label as (typeof ALLOWED_OUTCOMES)[number]),
        `bump('${label}') not in allowed set [${ALLOWED_OUTCOMES.join(', ')}] — drift would explode Prometheus cardinality`,
      ).toBe(true);
    }
  });

  it('all 5 documented outcomes are wired (not_found + forbidden + no_mac + secret_unreadable + ok)', () => {
    const body = readFileSync(ROUTE, 'utf8');
    for (const label of ALLOWED_OUTCOMES) {
      expect(body, `bump('${label}') wiring missing — orphans the documented outcome path`).toMatch(
        new RegExp(`bump\\('${label}'\\)`),
      );
    }
  });

  it("role label is hardcoded to 'subscriber' (LK.3 mints subscriber-only JWTs)", () => {
    const body = readFileSync(ROUTE, 'utf8');
    expect(body).toMatch(/role:\s*'subscriber'/);
    // Defensive — the publisher role belongs to the legacy V-531.B
    // /v1/sessions/:id/livekit-token surface, NOT to LK.3.
    expect(body).not.toMatch(/role:\s*'publisher'/);
    expect(body).not.toMatch(/role:\s*'unknown'/);
  });

  it('canSubscribe=true + canPublish=false (gui-client is a subscriber, Mac is the publisher)', () => {
    const body = readFileSync(ROUTE, 'utf8');
    expect(body).toMatch(/canPublish:\s*false/);
    expect(body).toMatch(/canSubscribe:\s*true/);
  });
});
