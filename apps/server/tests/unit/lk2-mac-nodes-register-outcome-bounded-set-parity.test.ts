// LK.2 — bounded-cardinality contract for the
// `driftstack_mac_node_livekit_register_total{outcome}` counter as
// emitted by POST /v1/mac-nodes/register.
//
// Outcome label is one of 4 values:
//
//   validation        — Zod body parse failed (missing/invalid input)
//   encryption_error  — encryptLivekitSecret threw (key wrong length etc.)
//   not_found         — well-formed mac_node_id, but not in fleet_nodes
//   ok                — happy path, credentials persisted
//
// Companion to the integration metric test at
// lk2-mac-nodes-register-metrics.test.ts (5 fixture cases pinning
// each outcome path). This pure-source parity test reads the route
// .ts file and pins that ONLY the 4 documented outcome labels appear
// inside `bumpOutcome('...')` calls — same two-layer coverage as
// lk3-livekit-token-outcome-bounded-set-parity.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/mac-nodes-register.ts');

const ALLOWED_OUTCOMES = ['validation', 'encryption_error', 'not_found', 'ok'] as const;

describe('LK.2 mac-nodes-register outcome bounded-set parity', () => {
  it('route file exists at the canonical path', () => {
    const body = readFileSync(ROUTE, 'utf8');
    expect(body.length).toBeGreaterThan(0);
  });

  it('every `bumpOutcome(...)` call uses a label from the 4-element allowed set', () => {
    const body = readFileSync(ROUTE, 'utf8');
    // Match `bumpOutcome('label')` — single-quoted label.
    const matches = [...body.matchAll(/\bbumpOutcome\(\s*'([a-z_]+)'\s*\)/g)];
    expect(matches.length, 'expected at least one bumpOutcome() call').toBeGreaterThan(0);
    const observed = new Set(matches.map((m) => m[1]!));
    for (const label of observed) {
      expect(
        ALLOWED_OUTCOMES.includes(label as (typeof ALLOWED_OUTCOMES)[number]),
        `bumpOutcome('${label}') not in allowed set [${ALLOWED_OUTCOMES.join(', ')}] — drift would explode Prometheus cardinality`,
      ).toBe(true);
    }
  });

  it('all 4 documented outcomes are wired (validation + encryption_error + not_found + ok)', () => {
    const body = readFileSync(ROUTE, 'utf8');
    for (const label of ALLOWED_OUTCOMES) {
      expect(
        body,
        `bumpOutcome('${label}') wiring missing — orphans the documented outcome path`,
      ).toMatch(new RegExp(`bumpOutcome\\('${label}'\\)`));
    }
  });
});
